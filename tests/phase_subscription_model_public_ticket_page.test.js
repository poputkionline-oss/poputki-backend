/**
 * tests/phase_subscription_model_public_ticket_page.test.js
 *
 * POPUTKI.ONLINE — Manual Booking Telegram Subscription Model, full carrier
 * entry point into the follower-subscription flow.
 *
 * Covers the additive `ticket_subscribe_url` / `ticketSubscribeUrl` field on
 * the three backend endpoints the carrier's "Передать билет" modal reads
 * from:
 *   - POST /bus-admin/bookings/:id/claim-link   (opening the modal for an
 *     existing booking)
 *   - POST /bus-admin/bookings/:id/handoff      (per-channel share attempt)
 *   - POST /bus-admin/bookings/manual           (new booking creation)
 *
 * None of these ever stop returning claim_url/ticket_url (or claim_url in
 * the handoff object) — the new field is purely additive, present ONLY when
 * MANUAL_BOOKING_SUBSCRIPTION_MODEL_ENABLED=true AND the booking is a manual
 * one (created_by_user_id set). Same fakeSupabaseClient/carrier-JWT harness
 * as tests/phase_subscription_model_carrier_count.test.js.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');

// Installing installFakeServiceRoleModule below preempts dbServiceRole.js's
// module cache entry entirely, so its own `require('dotenv').config()` call
// never runs in this process — load env vars (JWT_SECRET among them)
// explicitly first, exactly as the real module would have.
require('dotenv').config();

const { createFakeSupabaseClient, installFakeDbModule, installFakeServiceRoleModule } = require('./helpers/fakeSupabaseClient');

const tables = {
    users: [
        { id: 11, name: 'Тестовый Перевозчик', phone: '+992900000011', role: 'bus_driver', is_blocked: false, service_fee_percent: 10 }
    ],
    carrier_members: [],
    bus_tickets: [
        { id: 100, operator_id: 11, from_city: 'Душанбе', to_city: 'Худжанд', bus_type: 'single', price: 100, premium_price: 100, reserved_seats: [] },
        { id: 200, operator_id: 999, reserved_seats: [] } // different carrier
    ],
    bus_ticket_bookings: [
        // A manual booking (created_by_user_id set), unclaimed, confirmed.
        { id: 900, bus_ticket_id: 100, status: 'confirmed', claim_status: 'unclaimed', claimed_by_user_id: null, contact_role: 'passenger', phone: '+992900000000', created_by_user_id: 11 },
        // An ONLINE booking (created_by_user_id null) on the SAME carrier's
        // ticket — used to prove the new field stays null even with the
        // flag on, since this booking doesn't qualify as manual.
        { id: 901, bus_ticket_id: 100, status: 'confirmed', claim_status: 'unclaimed', claimed_by_user_id: null, contact_role: 'passenger', phone: '+992900000001', created_by_user_id: null },
        // Belongs to a different carrier — tenant isolation control.
        { id: 902, bus_ticket_id: 200, status: 'confirmed', claim_status: 'unclaimed', claimed_by_user_id: null, contact_role: 'passenger', phone: '+992900000002', created_by_user_id: 999 }
    ]
};

const fakeClient = createFakeSupabaseClient(tables);
installFakeDbModule(fakeClient);
installFakeServiceRoleModule(fakeClient);

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

function authHeaders() {
    return { Authorization: `Bearer ${generateCarrierToken()}`, 'Content-Type': 'application/json' };
}

beforeEach(() => {
    delete process.env.MANUAL_BOOKING_SUBSCRIPTION_MODEL_ENABLED;
});

afterEach(() => {
    delete process.env.MANUAL_BOOKING_SUBSCRIPTION_MODEL_ENABLED;
});

describe('POST /bookings/:id/claim-link — ticket_subscribe_url', () => {
    it('flag off: field is null, claim_url/ticket_url unchanged and still present', async () => {
        await withServer(async (port) => {
            const res = await fetch(`http://127.0.0.1:${port}/api/bus-admin/bookings/900/claim-link`, {
                method: 'POST', headers: authHeaders(), body: '{}'
            });
            const body = await res.json();
            assert.equal(res.status, 200);
            assert.equal(body.ticket_subscribe_url, null);
            assert.ok(body.claim_url.startsWith('https://t.me/'));
            assert.ok(body.ticket_url.startsWith('https://www.poputki.online/ticket-verify/'));
        });
    });

    it('flag on + manual booking: field present, correct /ticket-subscribe/ URL, same verification token as ticket_url', async () => {
        process.env.MANUAL_BOOKING_SUBSCRIPTION_MODEL_ENABLED = 'true';
        await withServer(async (port) => {
            const res = await fetch(`http://127.0.0.1:${port}/api/bus-admin/bookings/900/claim-link`, {
                method: 'POST', headers: authHeaders(), body: '{}'
            });
            const body = await res.json();
            assert.equal(res.status, 200);
            assert.ok(body.ticket_subscribe_url, 'ticket_subscribe_url must be present when flag is on');
            assert.match(body.ticket_subscribe_url, /^https:\/\/www\.poputki\.online\/ticket-subscribe\/900-[a-f0-9]{32}$/);

            const ticketToken = body.ticket_url.split('/ticket-verify/')[1];
            const subscribeToken = body.ticket_subscribe_url.split('/ticket-subscribe/')[1];
            assert.equal(ticketToken, subscribeToken, 'both URLs must carry the exact same verification token');
        });
    });

    it('flag on but booking is NOT manual (created_by_user_id null): field stays null', async () => {
        process.env.MANUAL_BOOKING_SUBSCRIPTION_MODEL_ENABLED = 'true';
        await withServer(async (port) => {
            const res = await fetch(`http://127.0.0.1:${port}/api/bus-admin/bookings/901/claim-link`, {
                method: 'POST', headers: authHeaders(), body: '{}'
            });
            const body = await res.json();
            assert.equal(res.status, 200);
            assert.equal(body.ticket_subscribe_url, null);
        });
    });

    it('tenant isolation is unaffected by the new field: a different carrier\'s booking is still 403', async () => {
        process.env.MANUAL_BOOKING_SUBSCRIPTION_MODEL_ENABLED = 'true';
        await withServer(async (port) => {
            const res = await fetch(`http://127.0.0.1:${port}/api/bus-admin/bookings/902/claim-link`, {
                method: 'POST', headers: authHeaders(), body: '{}'
            });
            assert.equal(res.status, 403);
        });
    });
});

describe('POST /bookings/:id/handoff — ticketSubscribeUrl', () => {
    it('flag off: field is null, ticketUrl unchanged', async () => {
        await withServer(async (port) => {
            const res = await fetch(`http://127.0.0.1:${port}/api/bus-admin/bookings/900/handoff`, {
                method: 'POST', headers: authHeaders(), body: JSON.stringify({ channel: 'telegram' })
            });
            const body = await res.json();
            assert.equal(res.status, 200);
            assert.equal(body.ticketSubscribeUrl, null);
            assert.ok(body.ticketUrl.includes('/ticket-verify/'));
        });
    });

    it('flag on + manual booking: field present, carries the ?h= handoff attribution param like ticketUrl does', async () => {
        process.env.MANUAL_BOOKING_SUBSCRIPTION_MODEL_ENABLED = 'true';
        await withServer(async (port) => {
            const res = await fetch(`http://127.0.0.1:${port}/api/bus-admin/bookings/900/handoff`, {
                method: 'POST', headers: authHeaders(), body: JSON.stringify({ channel: 'telegram' })
            });
            const body = await res.json();
            assert.equal(res.status, 200);
            assert.ok(body.ticketSubscribeUrl.includes('/ticket-subscribe/'));
            assert.ok(body.ticketSubscribeUrl.includes(`?h=${body.handoffId}`), 'handoff attribution query param must be carried over');
        });
    });

    it('flag on but booking is NOT manual: field stays null', async () => {
        process.env.MANUAL_BOOKING_SUBSCRIPTION_MODEL_ENABLED = 'true';
        await withServer(async (port) => {
            const res = await fetch(`http://127.0.0.1:${port}/api/bus-admin/bookings/901/handoff`, {
                method: 'POST', headers: authHeaders(), body: JSON.stringify({ channel: 'copy_link' })
            });
            const body = await res.json();
            assert.equal(res.status, 200);
            assert.equal(body.ticketSubscribeUrl, null);
        });
    });
});

describe('POST /bookings/manual — handoff.ticket_subscribe_url on booking creation', () => {
    it('flag off: handoff.ticket_subscribe_url is null when handoff is required', async () => {
        await withServer(async (port) => {
            const res = await fetch(`http://127.0.0.1:${port}/api/bus-admin/bookings/manual`, {
                method: 'POST', headers: authHeaders(), body: JSON.stringify({
                    bus_ticket_id: 100,
                    seat_numbers: ['5'],
                    passengers_data: [{ firstName: 'Тест', lastName: 'Пассажиров', seatNumber: '5', phone: '+992900000099' }],
                    phone: '+992900000099',
                    contact_role: 'unknown'
                })
            });
            const body = await res.json();
            assert.equal(res.status, 200);
            assert.equal(body.handoff.required, true);
            assert.equal(body.handoff.ticket_subscribe_url, null);
            assert.ok(body.handoff.claim_url.startsWith('https://t.me/'));
        });
    });

    it('flag on: handoff.ticket_subscribe_url present and correctly formed', async () => {
        process.env.MANUAL_BOOKING_SUBSCRIPTION_MODEL_ENABLED = 'true';
        await withServer(async (port) => {
            const res = await fetch(`http://127.0.0.1:${port}/api/bus-admin/bookings/manual`, {
                method: 'POST', headers: authHeaders(), body: JSON.stringify({
                    bus_ticket_id: 100,
                    seat_numbers: ['6'],
                    passengers_data: [{ firstName: 'Тест', lastName: 'Пассажиров', seatNumber: '6', phone: '+992900000098' }],
                    phone: '+992900000098',
                    contact_role: 'unknown'
                })
            });
            const body = await res.json();
            assert.equal(res.status, 200);
            assert.equal(body.handoff.required, true);
            assert.match(body.handoff.ticket_subscribe_url, /^https:\/\/www\.poputki\.online\/ticket-subscribe\/\d+-[a-f0-9]{32}$/);
        });
    });
});
