/**
 * phase_subscription_model_carrier_count.test.js
 *
 * POPUTKI.ONLINE — Manual Booking Telegram Subscription Model, carrier-
 * facing follower count endpoint.
 *
 * GET /api/bus-admin/bookings/:bookingId/telegram-subscribers-count must
 * NEVER return user_id/telegram_id/username/phone/name — aggregate only —
 * and must never break the carrier UI's existing response shape when the
 * feature flag is off or the subscription tables aren't reachable.
 *
 * Same fakeSupabaseClient/carrier-JWT harness as
 * tests/phase_p1f_admin_funnel.test.js (this repo's established pattern for
 * exercising the real carrierAuth middleware offline). getActiveFollowerCount
 * itself (the actual count logic against a real/mock booking_followers
 * table) is already unit-tested in tests/phase_subscription_model_core.test.js
 * — this file only proves the route-level contract: gating, tenant
 * isolation, and graceful degradation.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');

const { createFakeSupabaseClient, installFakeDbModule } = require('./helpers/fakeSupabaseClient');
installFakeDbModule(createFakeSupabaseClient({
    users: [
        { id: 11, name: 'Тестовый Перевозчик', phone: '+992900000011', role: 'bus_driver', is_blocked: false, service_fee_percent: 10 }
    ],
    carrier_members: [],
    bus_tickets: [
        { id: 100, operator_id: 11 },
        { id: 200, operator_id: 999 } // belongs to a DIFFERENT carrier
    ],
    bus_ticket_bookings: [
        { id: 900, bus_ticket_id: 100 },
        { id: 901, bus_ticket_id: 200 }
    ]
}));

const busAdminRouter = require('../routes/busAdmin');

function generateCarrierToken(userId = 11, carrierId = 11, role = 'owner') {
    return jwt.sign(
        { sub: String(userId), carrierId, role },
        process.env.JWT_SECRET || 'test-jwt-secret-placeholder',
        { algorithm: 'HS256', issuer: 'poputki.online', audience: 'poputki-carrier', expiresIn: '1h' }
    );
}

async function withServer(fn) {
    const app = express();
    app.use(express.json());
    app.use('/api/bus-admin', busAdminRouter);
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, resolve));
    const port = server.address().port;
    try {
        await fn(port);
    } finally {
        server.close();
    }
}

describe('GET /bookings/:bookingId/telegram-subscribers-count', () => {
    it('feature flag off (default): returns success with count 0, no auth of booking_followers needed', async () => {
        delete process.env.MANUAL_BOOKING_SUBSCRIPTION_MODEL_ENABLED;
        await withServer(async (port) => {
            const token = generateCarrierToken();
            const res = await fetch(`http://127.0.0.1:${port}/api/bus-admin/bookings/900/telegram-subscribers-count`, {
                headers: { Authorization: `Bearer ${token}` }
            });
            const body = await res.json();
            assert.equal(res.status, 200);
            assert.equal(body.success, true);
            assert.equal(body.telegram_subscribers_count, 0);
        });
    });

    it('response never contains user_id/telegram_id/username/phone/name keys', async () => {
        delete process.env.MANUAL_BOOKING_SUBSCRIPTION_MODEL_ENABLED;
        await withServer(async (port) => {
            const token = generateCarrierToken();
            const res = await fetch(`http://127.0.0.1:${port}/api/bus-admin/bookings/900/telegram-subscribers-count`, {
                headers: { Authorization: `Bearer ${token}` }
            });
            const body = await res.json();
            const forbidden = ['user_id', 'telegram_id', 'username', 'phone', 'name'];
            for (const key of forbidden) {
                assert.ok(!(key in body), `response leaked forbidden key: ${key}`);
            }
        });
    });

    it('feature flag ON, no service-role key configured in this test env: still degrades gracefully to count 0, never 500', async () => {
        process.env.MANUAL_BOOKING_SUBSCRIPTION_MODEL_ENABLED = 'true';
        await withServer(async (port) => {
            const token = generateCarrierToken();
            const res = await fetch(`http://127.0.0.1:${port}/api/bus-admin/bookings/900/telegram-subscribers-count`, {
                headers: { Authorization: `Bearer ${token}` }
            });
            const body = await res.json();
            assert.notEqual(res.status, 500);
            assert.equal(body.success, true);
            assert.equal(typeof body.telegram_subscribers_count, 'number');
        });
        delete process.env.MANUAL_BOOKING_SUBSCRIPTION_MODEL_ENABLED;
    });

    it('tenant isolation: a booking belonging to a different carrier is rejected 403, count not leaked', async () => {
        process.env.MANUAL_BOOKING_SUBSCRIPTION_MODEL_ENABLED = 'true';
        await withServer(async (port) => {
            const token = generateCarrierToken(11, 11, 'owner');
            const res = await fetch(`http://127.0.0.1:${port}/api/bus-admin/bookings/901/telegram-subscribers-count`, {
                headers: { Authorization: `Bearer ${token}` }
            });
            const body = await res.json();
            assert.equal(res.status, 403);
            assert.ok(!('telegram_subscribers_count' in body));
        });
        delete process.env.MANUAL_BOOKING_SUBSCRIPTION_MODEL_ENABLED;
    });

    it('unknown booking id -> 404', async () => {
        process.env.MANUAL_BOOKING_SUBSCRIPTION_MODEL_ENABLED = 'true';
        await withServer(async (port) => {
            const token = generateCarrierToken();
            const res = await fetch(`http://127.0.0.1:${port}/api/bus-admin/bookings/999999/telegram-subscribers-count`, {
                headers: { Authorization: `Bearer ${token}` }
            });
            assert.equal(res.status, 404);
        });
        delete process.env.MANUAL_BOOKING_SUBSCRIPTION_MODEL_ENABLED;
    });

    it('no Authorization header -> rejected before reaching the handler (carrierAuth fail-closed)', async () => {
        await withServer(async (port) => {
            const res = await fetch(`http://127.0.0.1:${port}/api/bus-admin/bookings/900/telegram-subscribers-count`);
            assert.notEqual(res.status, 200);
        });
    });
});
