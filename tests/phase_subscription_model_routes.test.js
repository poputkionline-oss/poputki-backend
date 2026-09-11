/**
 * phase_subscription_model_routes.test.js
 *
 * POPUTKI.ONLINE — Manual Booking Telegram Subscription Model, HTTP routes.
 *
 * Exercises the real Express routes in routes/claims.js over a live HTTP
 * server (no mocked DB — only scenarios that fail before any DB access is
 * reached, exactly like the existing bot-secret/route-shape tests elsewhere
 * in this suite). Deep DB-backed behavior (subscribed/resubscribed/
 * idempotent, availability gating) is covered at the helper level in
 * tests/phase_subscription_model_core.test.js.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

process.env.CLAIM_BOT_SHARED_SECRET = 'test-claim-bot-secret';

const claimsRouter = require('../routes/claims');

let server;
let baseUrl;

before(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/claims', claimsRouter);
    server = http.createServer(app);
    await new Promise(resolve => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}/api/claims`;
});

after(async () => {
    await new Promise(resolve => server.close(resolve));
});

async function post(path, body, headers = {}) {
    const res = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body)
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, body: json };
}

describe('Feature flag MANUAL_BOOKING_SUBSCRIPTION_MODEL_ENABLED=false (default) — every new route is inert', () => {
    before(() => { delete process.env.MANUAL_BOOKING_SUBSCRIPTION_MODEL_ENABLED; });

    it('POST /subscribe-preview -> 404, indistinguishable from a route that does not exist', async () => {
        const { status, body } = await post('/subscribe-preview', { verificationToken: 'irrelevant' });
        assert.equal(status, 404);
        assert.equal(body.error, 'NOT_FOUND');
    });

    it('POST /start-subscription -> 404', async () => {
        const { status, body } = await post('/start-subscription', { verificationToken: 'irrelevant' });
        assert.equal(status, 404);
        assert.equal(body.error, 'NOT_FOUND');
    });

    it('POST /bot/subscribe -> 404 even with a valid bot secret', async () => {
        const { status, body } = await post('/bot/subscribe',
            { sessionToken: 'x', telegramUser: { id: 1 }, telegramContact: { user_id: 1, phone_number: '+992900000000' } },
            { 'X-Claim-Bot-Secret': 'test-claim-bot-secret' });
        assert.equal(status, 404);
        assert.equal(body.code, 'FEATURE_DISABLED');
    });

    it('POST /bot/unsubscribe -> 404 even with a valid bot secret', async () => {
        const { status, body } = await post('/bot/unsubscribe',
            { bookingId: 1, telegramUserId: 1 },
            { 'X-Claim-Bot-Secret': 'test-claim-bot-secret' });
        assert.equal(status, 404);
        assert.equal(body.code, 'FEATURE_DISABLED');
    });

    it('the untouched old claim route (/preview-trip) is completely unaffected by the flag being off', async () => {
        // Not asserting a specific status (this test environment has no
        // SUPABASE_SERVICE_ROLE_KEY configured, so the real route errors
        // out at the DB layer rather than returning a clean 400) — only
        // that the route is NOT swallowed by the new feature-flag gate,
        // proving the two code paths are fully independent.
        const { status, body } = await post('/preview-trip', { sessionToken: 'not-a-real-session-token' });
        assert.notEqual(status, 404);
        assert.notEqual(body.error, 'NOT_FOUND');
    });
});

describe('Feature flag = true — new routes reachable, still fail closed before touching data', () => {
    before(() => { process.env.MANUAL_BOOKING_SUBSCRIPTION_MODEL_ENABLED = 'true'; });
    after(() => { delete process.env.MANUAL_BOOKING_SUBSCRIPTION_MODEL_ENABLED; });

    it('POST /subscribe-preview with a malformed verification token -> 403 INVALID_TOKEN (no DB reached)', async () => {
        const { status, body } = await post('/subscribe-preview', { verificationToken: 'not-a-valid-format' });
        assert.equal(status, 403);
        assert.equal(body.code, 'INVALID_TOKEN');
    });

    it('POST /start-subscription with a malformed verification token -> 403 INVALID_TOKEN', async () => {
        const { status, body } = await post('/start-subscription', { verificationToken: 'not-a-valid-format' });
        assert.equal(status, 403);
        assert.equal(body.code, 'INVALID_TOKEN');
    });

    it('POST /subscribe-preview with no token -> 400', async () => {
        const { status } = await post('/subscribe-preview', {});
        assert.equal(status, 400);
    });

    it('POST /bot/subscribe without X-Claim-Bot-Secret -> 401 (same requireClaimBotSecret middleware as the existing bot/open route)', async () => {
        const { status, body } = await post('/bot/subscribe', { sessionToken: 'x' });
        assert.equal(status, 401);
        assert.equal(body.code, 'BOT_CLAIM_UNAUTHORIZED');
    });

    it('POST /bot/subscribe: telegramContact.user_id spoofed to differ from telegramUser.id -> 400, rejected BEFORE any DB/RPC call', async () => {
        const { status, body } = await post('/bot/subscribe', {
            sessionToken: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            telegramUser: { id: 555000111 },
            telegramContact: { user_id: 999999999, phone_number: '+992900000000' } // spoofed: different from sender
        }, { 'X-Claim-Bot-Secret': 'test-claim-bot-secret' });
        assert.equal(status, 400);
        assert.equal(body.code, 'TELEGRAM_CONTACT_USER_ID_MISMATCH');
    });

    it('POST /bot/subscribe: missing telegramContact.user_id entirely -> 400 mismatch, not a crash', async () => {
        const { status, body } = await post('/bot/subscribe', {
            sessionToken: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            telegramUser: { id: 555000111 },
            telegramContact: { phone_number: '+992900000000' }
        }, { 'X-Claim-Bot-Secret': 'test-claim-bot-secret' });
        assert.equal(status, 400);
        assert.equal(body.code, 'TELEGRAM_CONTACT_USER_ID_MISMATCH');
    });

    it('POST /bot/subscribe without sessionToken -> 400 SESSION_TOKEN_REQUIRED', async () => {
        const { status, body } = await post('/bot/subscribe', {
            telegramUser: { id: 1 },
            telegramContact: { user_id: 1, phone_number: '+992900000000' }
        }, { 'X-Claim-Bot-Secret': 'test-claim-bot-secret' });
        assert.equal(status, 400);
        assert.equal(body.code, 'SESSION_TOKEN_REQUIRED');
    });

    it('POST /bot/unsubscribe without required params -> 400 MISSING_PARAMS', async () => {
        const { status, body } = await post('/bot/unsubscribe', {}, { 'X-Claim-Bot-Secret': 'test-claim-bot-secret' });
        assert.equal(status, 400);
        assert.equal(body.code, 'MISSING_PARAMS');
    });

    it('POST /bot/unsubscribe with the wrong bot secret -> 401, never 400/500', async () => {
        const { status, body } = await post('/bot/unsubscribe', { bookingId: 1, telegramUserId: 1 }, { 'X-Claim-Bot-Secret': 'wrong-secret' });
        assert.equal(status, 401);
        assert.equal(body.code, 'BOT_CLAIM_UNAUTHORIZED');
    });
});

describe('Privacy projection — buildFollowerTicketProjection never carries PII', () => {
    const { buildFollowerTicketProjection } = require('../utils/ticketHelper');

    it('excludes phone, passengers_data, price, commission, and passenger name even when present on the source rows', () => {
        const booking = {
            status: 'confirmed',
            seat_numbers: '[78]',
            phone: '+992900000009',
            passenger_name: 'Иванов Иван',
            passengers_data: '[{"docNumber":"AB123456"}]',
            total_price: 500,
            commission_amount: 50,
            commission_rate: 10
        };
        const ticket = {
            from_city: 'Dushanbe', to_city: 'Moscow',
            departure_date: '2026-09-20', departure_time: '10:00:00',
            transport_company: 'Test Carrier'
        };
        const projection = buildFollowerTicketProjection(booking, ticket);

        const forbidden = ['phone', 'passenger_name', 'passengers_data', 'total_price', 'commission_amount', 'commission_rate', 'passport', 'docNumber'];
        const serialized = JSON.stringify(projection);
        for (const field of forbidden) {
            assert.ok(!serialized.includes(field), `projection leaked forbidden field/value: ${field}`);
        }
        assert.deepEqual(Object.keys(projection).sort(), ['carrierName', 'departureDate', 'departureTime', 'fromCity', 'seatNumbers', 'status', 'toCity'].sort());
    });

    it('handles a malformed seat_numbers string without throwing', () => {
        const projection = buildFollowerTicketProjection({ status: 'confirmed', seat_numbers: 'not-json' }, { from_city: 'A', to_city: 'B' });
        assert.deepEqual(projection.seatNumbers, []);
    });
});
