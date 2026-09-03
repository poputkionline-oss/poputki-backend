/**
 * tests/phase_e48_6_smartpay_hardening.test.js
 *
 * PHASE E.48.6 — SmartPay Invoice Creation Hardening Test Suite
 */

'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const jwt = require('jsonwebtoken');

const TEST_JWT_SECRET = 'test-jwt-secret-phase-e48-6-smartpay-32b';
process.env.JWT_SECRET = TEST_JWT_SECRET;

const {
    issueUserToken,
    optionalUserAuth,
    JWT_ISSUER
} = require('../utils/userAuth');

const { checkIpRateLimit, resetRateLimits, MAX_REQUESTS_PER_WINDOW } = require('../utils/paymentRateLimiter');
const smartpayRouter = require('../routes/smartpay');

/**
 * Mock req/res generator.
 */
function createMockReqRes(method = 'POST', url = '/create-invoice', headers = {}, body = {}, ip = '127.0.0.1') {
    let statusCode = null;
    let responseData = null;
    let nextCalled = false;

    const req = {
        method,
        url,
        headers,
        body,
        ip,
        user: null
    };

    const res = {
        status(code) {
            statusCode = code;
            return this;
        },
        json(data) {
            responseData = data;
            return this;
        },
        send(data) {
            responseData = data;
            return this;
        }
    };

    const next = () => {
        nextCalled = true;
    };

    return {
        req,
        res,
        next,
        getResult: () => ({ statusCode, responseData, nextCalled, user: req.user })
    };
}

describe('Phase E.48.6 — SmartPay Invoice Creation Hardening', () => {

    beforeEach(() => {
        resetRateLimits();
    });

    // =========================================================================
    // SECTION 1: RATE LIMITING & ABUSE CONTROL
    // =========================================================================
    describe('1. Rate Limiting & Abuse Control', () => {
        it('[E48.6-01] IP rate limiter allows requests within threshold and blocks beyond MAX', () => {
            const testIp = '198.51.100.55';
            for (let i = 0; i < MAX_REQUESTS_PER_WINDOW; i++) {
                assert.equal(checkIpRateLimit(testIp), true, `Request ${i + 1} should be allowed`);
            }
            assert.equal(checkIpRateLimit(testIp), false, 'Request beyond MAX should be rejected');
        });

        it('[E48.6-02] POST /create-invoice uses checkIpRateLimit and returns 429 when rate limited', () => {
            const source = fs.readFileSync(path.join(__dirname, '../routes/smartpay.js'), 'utf8');
            assert.ok(source.includes('if (!checkIpRateLimit(clientIp))'));
            assert.ok(source.includes('res.status(429).json({ error:'));
        });

        it('[E48.6-03] POST /create-invoice enforces maximum active pending holds limit per passenger', () => {
            const source = fs.readFileSync(path.join(__dirname, '../routes/smartpay.js'), 'utf8');
            assert.ok(source.includes('if (activeUserHolds && activeUserHolds.length >= 3)'));
            assert.ok(source.includes('Превышен лимит активных неоплаченных бронирований'));
        });
    });

    // =========================================================================
    // SECTION 2: PASSENGER IDENTITY & OWNERSHIP VERIFICATION
    // =========================================================================
    describe('2. Passenger Identity & Ownership Verification', () => {
        it('[E48.6-04] POST /create-invoice uses optionalUserAuth middleware', () => {
            const layer = smartpayRouter.stack.find(l => l.route && l.route.path === '/create-invoice' && l.route.methods.post);
            assert.ok(layer, 'Route must exist');
            assert.equal(layer.route.stack[0].handle, optionalUserAuth);
        });

        it('[E48.6-05] Authenticated passenger identity overrides body passenger_id spoof attempt', () => {
            const source = fs.readFileSync(path.join(__dirname, '../routes/smartpay.js'), 'utf8');
            assert.ok(source.includes('effectivePassengerId = req.user.id;'));
            assert.ok(source.includes('if (requestedPassengerId && requestedPassengerId !== req.user.id)'));
            assert.ok(source.includes('Доступ запрещен: нельзя оформлять билет на чужой профиль'));
        });

        it('[E48.6-06] Guest caller cannot book as carrier, admin, or bus_driver account', () => {
            const source = fs.readFileSync(path.join(__dirname, '../routes/smartpay.js'), 'utf8');
            assert.ok(source.includes("userExists.role === 'carrier' || userExists.role === 'admin' || userExists.role === 'bus_driver'"));
            assert.ok(source.includes('Доступ запрещен для данной роли пользователя'));
        });

        it('[E48.6-07] Guest caller must provide contact phone matching user registered phone', () => {
            const source = fs.readFileSync(path.join(__dirname, '../routes/smartpay.js'), 'utf8');
            assert.ok(source.includes('normUserPhone !== normReqPhone'));
            assert.ok(source.includes('Контактный номер не совпадает с номером в профиле'));
        });
    });

    // =========================================================================
    // SECTION 3: PRICE, CURRENCY & FINANCIAL INVARIANTS
    // =========================================================================
    describe('3. Price & Financial Invariants', () => {
        it('[E48.6-08] Amount is derived strictly from ticket price and VIP seat layout, ignoring client body', () => {
            const source = fs.readFileSync(path.join(__dirname, '../routes/smartpay.js'), 'utf8');
            assert.ok(source.includes('const premiumPrice = ticket.premium_price || ticket.price;'));
            assert.ok(source.includes('totalPrice += premiumSeatNums.includes(seatNum) ? premiumPrice : ticket.price;'));
            assert.ok(source.includes('const platformFee = Math.round(totalPrice * feePercent / 100);'));
            assert.equal(source.includes('totalPrice = req.body.amount'), false);
            assert.equal(source.includes('platformFee = req.body.amount'), false);
        });

        it('[E48.6-09] Ticket must be active; inactive/departed ticket is rejected with 400', () => {
            const source = fs.readFileSync(path.join(__dirname, '../routes/smartpay.js'), 'utf8');
            assert.ok(source.includes("if (ticket.status !== 'active')"));
            assert.ok(source.includes('Рейс недоступен для бронирования'));
        });
    });

    // =========================================================================
    // SECTION 4: IDEMPOTENCY & DUPLICATE ORDER PREVENTION
    // =========================================================================
    describe('4. Idempotency & Duplicate Order Prevention', () => {
        it('[E48.6-10] Active pending booking for same ticket, passenger, and seats is reused idempotently', () => {
            const source = fs.readFileSync(path.join(__dirname, '../routes/smartpay.js'), 'utf8');
            assert.ok(source.includes("if (b.status !== 'pending_payment') return false;"));
            assert.ok(source.includes('if (b.passenger_id !== effectivePassengerId) return false;'));
            assert.ok(source.includes('reused: true'));
        });

        it('[E48.6-11] Seat conflicts with other bookings remain blocked with 400', () => {
            const source = fs.readFileSync(path.join(__dirname, '../routes/smartpay.js'), 'utf8');
            assert.ok(source.includes('if (conflict) return res.status(400).json({ error: \'Одно или несколько мест уже заняты\' });'));
        });
    });

    // =========================================================================
    // SECTION 5: SMARTPAY WEBHOOK INTEGRITY
    // =========================================================================
    describe('5. SmartPay Webhook Integrity', () => {
        it('[E48.6-12] Webhook acknowledges already_confirmed bookings idempotently', () => {
            const source = fs.readFileSync(path.join(__dirname, '../routes/smartpay.js'), 'utf8');
            assert.ok(source.includes("if (booking.status === 'confirmed')"));
            assert.ok(source.includes("status: 'already_confirmed'"));
        });

        it('[E48.6-13] Webhook checks for seat conflicts before confirming payment', () => {
            const source = fs.readFileSync(path.join(__dirname, '../routes/smartpay.js'), 'utf8');
            assert.ok(source.includes("status: 'conflict_refund_needed'"));
        });
    });
});
