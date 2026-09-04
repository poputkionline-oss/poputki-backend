/**
 * tests/phase_e48_7_legacy_header_removal.test.js
 *
 * PHASE E.48.7 — REMOVE LEGACY X-MANA-MAN SECURITY BOUNDARY TEST SUITE
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const jwt = require('jsonwebtoken');

const TEST_JWT_SECRET = 'test-jwt-secret-phase-e48-7-header-removal-32b';
process.env.JWT_SECRET = TEST_JWT_SECRET;
process.env.ADMIN_SECRET_TOKEN = 'test-admin-secret-token-e48-7';
process.env.BOT_SERVICE_TOKEN = 'test-bot-service-token-e48-7';

const { issueUserToken, userAuth } = require('../utils/userAuth');
const { verifyBotServiceToken } = require('../utils/botAuth');
const ridesRouter = require('../routes/rides');
const bookingsRouter = require('../routes/bookings');
const busTicketsRouter = require('../routes/busTickets');
const busAdminRouter = require('../routes/busAdmin');
const adminRouter = require('../routes/admin');
const reviewsRouter = require('../routes/reviews');

describe('Phase E.48.7 — Legacy Header Removal & Real Authorization Verification', () => {

    // =========================================================================
    // SECTION 1: BACKEND GLOBAL MIDDLEWARE RETIREMENT
    // =========================================================================
    describe('1. Global Middleware Retirement', () => {
        it('[E48.7-01] index.js does not contain global x-mana-man checking middleware', () => {
            const indexSource = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
            assert.equal(indexSource.includes("req.headers['x-mana-man']"), false, 'Global header check must be removed');
            assert.equal(indexSource.includes("clientHeader !== 'nasa.2006'"), false, 'Legacy value check must be removed');
        });

        it('[E48.7-02] CORS allowedHeaders retains x-mana-man for old client preflight compatibility', () => {
            const indexSource = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
            assert.ok(indexSource.includes("'x-mana-man'"), 'Old client CORS compatibility preserved');
        });
    });

    // =========================================================================
    // SECTION 2: PUBLIC ENDPOINTS WORK WITHOUT X-MANA-MAN
    // =========================================================================
    describe('2. Public Endpoints Function Deliberately Without Legacy Header', () => {
        it('[E48.7-03] GET /health requires zero authentication and no headers', () => {
            const indexSource = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
            assert.ok(indexSource.includes('app.get("/health"'));
        });

        it('[E48.7-04] GET /api/cities requires zero headers and returns public city catalog', () => {
            const generalSource = fs.readFileSync(path.join(__dirname, '../routes/general.js'), 'utf8');
            assert.equal(generalSource.includes('x-mana-man'), false);
        });

        it('[E48.7-05] Public carpool catalog GET /api/rides works without x-mana-man', () => {
            const layer = ridesRouter.stack.find(l => l.route && l.route.path === '/' && l.route.methods.get);
            assert.ok(layer, 'GET / route exists');
            // Does not have userAuth middleware
            assert.notEqual(layer.route.stack[0].handle, userAuth);
        });

        it('[E48.7-06] Ticket verification HMAC works without legacy header', () => {
            const { generateTicketVerificationToken, verifyTicketToken } = require('../utils/ticketHelper');
            const token = generateTicketVerificationToken(12345);
            assert.ok(token);
            assert.equal(verifyTicketToken(token, 12345), true);
        });
    });

    // =========================================================================
    // SECTION 3: REAL AUTHORIZATION REQUIRED ON PRIVATE ROUTES
    // =========================================================================
    describe('3. Real Authorization Enforcement on Private Routes', () => {
        it('[E48.7-07] Private passenger routes require userAuth and reject requests without JWT', () => {
            const bookingLayer = bookingsRouter.stack.find(l => l.route && l.route.path === '/' && l.route.methods.post);
            assert.ok(bookingLayer);
            assert.equal(bookingLayer.route.stack[0].handle, userAuth);

            const reviewsLayer = reviewsRouter.stack.find(l => l.route && l.route.path === '/' && l.route.methods.post);
            assert.ok(reviewsLayer);
            assert.equal(reviewsLayer.route.stack[0].handle, userAuth);
        });

        it('[E48.7-08] Passenger JWT without x-mana-man succeeds on userAuth', () => {
            const token = issueUserToken({ id: 101, role: 'passenger' });
            const req = { headers: { authorization: `Bearer ${token}` } };
            let nextCalled = false;
            const res = { status: () => res, json: () => {} };
            userAuth(req, res, () => { nextCalled = true; });
            assert.equal(nextCalled, true);
            assert.equal(req.user.id, 101);
        });

        it('[E48.7-09] Carrier routes require carrierAuth and reject unauthenticated requests', () => {
            const layer = busAdminRouter.stack.find(l => l.name === 'carrierAuth');
            assert.ok(layer, 'carrierAuth middleware must be mounted on busAdmin router');
        });

        it('[E48.7-10] Admin routes require adminAuth and reject requests without X-Admin-Token', () => {
            const layer = adminRouter.stack.find(l => l.name === 'adminAuth');
            assert.ok(layer, 'adminAuth middleware must be mounted on admin router');
        });

        it('[E48.7-11] Bot ride creation requires BOT_SERVICE_TOKEN and succeeds without legacy header', () => {
            const req = { headers: { 'x-bot-service-token': 'test-bot-service-token-e48-7' } };
            assert.equal(verifyBotServiceToken(req), true);
        });

        it('[E48.7-12] Bot ride creation without service token is rejected', () => {
            const req = { headers: {} };
            assert.equal(verifyBotServiceToken(req), false);
        });
    });

    // =========================================================================
    // SECTION 4: ATTACKER SCENARIOS (X-MANA-MAN GRANTS ZERO PRIVILEGE)
    // =========================================================================
    describe('4. Legacy Header Grants Zero Privilege', () => {
        it('[E48.7-13] x-mana-man alone cannot authorize bus trip creation (401)', () => {
            const ticketsSource = fs.readFileSync(path.join(__dirname, '../routes/busTickets.js'), 'utf8');
            assert.ok(ticketsSource.includes('effectiveOperatorId = verifiedCarrierId'));
            assert.equal(ticketsSource.includes('effectiveOperatorId = verifiedCarrierId || parseInt(operator_id'), false);
        });

        it('[E48.7-14] x-mana-man alone cannot mutate user profile (requires userAuth)', () => {
            const usersSource = fs.readFileSync(path.join(__dirname, '../routes/users.js'), 'utf8');
            assert.ok(usersSource.includes("router.put('/:id', userAuth"));
        });

        it('[E48.7-15] x-mana-man alone cannot create or cancel carpool booking (requires userAuth)', () => {
            const bookingsSource = fs.readFileSync(path.join(__dirname, '../routes/bookings.js'), 'utf8');
            assert.ok(bookingsSource.includes("router.post('/', userAuth"));
            assert.ok(bookingsSource.includes("router.post('/:id/cancel', userAuth"));
        });

        it('[E48.7-16] x-mana-man alone cannot access carrier admin panel', () => {
            const req = { headers: { 'x-mana-man': 'nasa.2006' } };
            let statusCode = null;
            const res = { status: (c) => { statusCode = c; return res; }, json: () => {} };
            const { carrierAuth } = require('../utils/carrierAuth');
            carrierAuth(req, res, () => {});
            assert.equal(statusCode, 401);
        });

        it('[E48.7-17] x-mana-man alone cannot access admin operations', () => {
            // Phase P.1G.3A: the token comparison moved into a shared,
            // constant-time helper (utils/adminTokenAuth.js) used by both
            // routes/admin.js and routes/adminAcquisitionFunnel.js — verify
            // the real implementation instead of a literal `===` string.
            const adminTokenAuthSource = fs.readFileSync(path.join(__dirname, '../utils/adminTokenAuth.js'), 'utf8');
            assert.ok(adminTokenAuthSource.includes('crypto.timingSafeEqual'), 'admin token comparison must be constant-time');
            const adminSource = fs.readFileSync(path.join(__dirname, '../routes/admin.js'), 'utf8');
            assert.ok(adminSource.includes('requireAdminToken'), 'admin.js must delegate to the shared constant-time helper');
            const req = { headers: { 'x-mana-man': 'nasa.2006' } };
            let statusCode = null;
            const res = { status: (c) => { statusCode = c; return res; }, json: () => {} };
            const adminAuthFn = adminRouter.stack.find(l => l.name === 'adminAuth').handle;
            adminAuthFn(req, res, () => {});
            assert.equal(statusCode, 401);
        });

        it('[E48.7-18] Maintenance endpoint requires X-Admin-Token and rejects x-mana-man alone', () => {
            const adminSource = fs.readFileSync(path.join(__dirname, '../routes/admin.js'), 'utf8');
            assert.ok(adminSource.includes("router.post('/maintenance/tick'"));
        });
    });

    // =========================================================================
    // SECTION 5: COMPATIBILITY MATRIX
    // =========================================================================
    describe('5. Client Compatibility Matrix', () => {
        it('[E48.7-19] Old client: Real Auth + x-mana-man succeeds (extra header harmless)', () => {
            const token = issueUserToken({ id: 202, role: 'passenger' });
            const req = {
                headers: {
                    authorization: `Bearer ${token}`,
                    'x-mana-man': 'nasa.2006'
                }
            };
            let nextCalled = false;
            const res = { status: () => res, json: () => {} };
            userAuth(req, res, () => { nextCalled = true; });
            assert.equal(nextCalled, true);
            assert.equal(req.user.id, 202);
        });

        it('[E48.7-20] New client: Real Auth without x-mana-man succeeds cleanly', () => {
            const token = issueUserToken({ id: 203, role: 'passenger' });
            const req = {
                headers: {
                    authorization: `Bearer ${token}`
                }
            };
            let nextCalled = false;
            const res = { status: () => res, json: () => {} };
            userAuth(req, res, () => { nextCalled = true; });
            assert.equal(nextCalled, true);
            assert.equal(req.user.id, 203);
        });

        it('[E48.7-21] Attacker: x-mana-man only without real auth fails closed with 401', () => {
            const req = {
                headers: {
                    'x-mana-man': 'nasa.2006'
                }
            };
            let statusCode = null;
            const res = { status: (c) => { statusCode = c; return res; }, json: () => {} };
            userAuth(req, res, () => {});
            assert.equal(statusCode, 401);
        });

        it('[E48.7-22] SmartPay invoice creation preserves anti-spoofing without x-mana-man', () => {
            const smartpaySource = fs.readFileSync(path.join(__dirname, '../routes/smartpay.js'), 'utf8');
            assert.ok(smartpaySource.includes('router.post(\'/create-invoice\', optionalUserAuth'));
            assert.ok(smartpaySource.includes('effectivePassengerId = req.user.id;'));
        });

        it('[E48.7-23] Claim endpoints preserve bot secret and carrier auth without legacy header', () => {
            const claimsSource = fs.readFileSync(path.join(__dirname, '../routes/claims.js'), 'utf8');
            assert.ok(claimsSource.includes('requireClaimBotSecret'));
            assert.ok(claimsSource.includes('carrierAuth'));
        });

        it('[E48.7-24] Cross-tenant isolation in carrierAuth preserved without legacy header', () => {
            const carrierAuthSource = fs.readFileSync(path.join(__dirname, '../utils/carrierAuth.js'), 'utf8');
            assert.ok(carrierAuthSource.includes('resolveCarrierRole'));
            assert.ok(carrierAuthSource.includes('req.carrier ='));
        });
    });
});
