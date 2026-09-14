/**
 * tests/phase_subscription_model_carrier_single_ticket.test.js
 *
 * POPUTKI.ONLINE — Manual Booking Telegram Subscription Model.
 *
 * GET /bus-admin/bookings/:bookingId/ticket (the carrier's "large ticket"
 * modal — PassengerTicket.vue via CarrierTripBookings.vue) gains three
 * additive fields on top of buildPassengerTicketProjection's existing
 * response:
 *   - isManual: overridden to the CANONICAL isManualBooking(booking)
 *     (created_by_user_id-based), replacing the projection's own
 *     channel/source_type heuristic (which bookingChannelHelper.js's own
 *     doc comment calls unreliable — an online booking can carry
 *     channel='manual' at rest).
 *   - subscriptionModelActive: flag && canonical isManualBooking(booking).
 *     Independent of trip status; a failed subscribability check must
 *     never flip this to false.
 *   - canSubscribe: subscriptionModelActive && isBookingSubscribable(booking,
 *     trip) — trip is the bus_tickets row, not the passenger-facing
 *     projection. Any error evaluating it collapses to false, never
 *     surfaced to the client, never touching subscriptionModelActive.
 *
 * created_by_user_id itself (needed for isManualBooking) must never appear
 * in the JSON response.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');

require('dotenv').config();

const { createFakeSupabaseClient, installFakeDbModule, installFakeServiceRoleModule } = require('./helpers/fakeSupabaseClient');

const FUTURE_DATE = '2099-01-10';
const PAST_DATE = '2020-01-10';

const tables = {
    users: [
        { id: 11, name: 'Тестовый Перевозчик', phone: '+992900000011', role: 'bus_driver', is_blocked: false, service_fee_percent: 10 }
    ],
    carrier_members: [],
    bus_tickets: [
        // Subscribable trip.
        { id: 100, operator_id: 11, from_city: 'Душанбе', to_city: 'Худжанд', bus_type: 'single', price: 100, premium_price: 100, reserved_seats: [], status: 'scheduled', arrival_date: FUTURE_DATE, arrival_time: '10:00:00', departure_date: FUTURE_DATE, departure_time: '06:00:00' },
        // Trip already arrived — never subscribable.
        { id: 101, operator_id: 11, from_city: 'Душанбе', to_city: 'Худжанд', bus_type: 'single', price: 100, premium_price: 100, reserved_seats: [], status: 'scheduled', arrival_date: PAST_DATE, arrival_time: '10:00:00', departure_date: PAST_DATE, departure_time: '06:00:00' }
    ],
    bus_ticket_bookings: [
        // "booking 486-like": created_by_user_id set (canonically manual),
        // but channel/source_type deliberately UNRELIABLE — channel is
        // null and source_type looks like an online booking. The OLD
        // heuristic (channel==='manual' || source_type==='manual') would
        // say false here; the canonical isManualBooking() must still say
        // true because created_by_user_id is set.
        { id: 900, bus_ticket_id: 100, status: 'confirmed', claim_status: 'unclaimed', claimed_by_user_id: null, contact_role: 'passenger', passenger_name: 'Тест Пассажиров', seat_numbers: '["5"]', passenger_count: 1, channel: null, source_type: 'platform', created_by_user_id: 11 },
        // Genuinely online booking: created_by_user_id null, but channel/
        // source_type carry 'manual' at rest (the exact blind spot
        // bookingChannelHelper.js's doc comment warns about) — canonical
        // isManualBooking() must say false despite the old heuristic
        // saying true.
        { id: 901, bus_ticket_id: 100, status: 'confirmed', claim_status: 'unclaimed', claimed_by_user_id: null, contact_role: 'passenger', passenger_name: 'Тест Пассажиров', seat_numbers: '["6"]', passenger_count: 1, channel: 'manual', source_type: 'manual', created_by_user_id: null },
        // Manual booking, but the trip has already arrived.
        { id: 902, bus_ticket_id: 101, status: 'confirmed', claim_status: 'unclaimed', claimed_by_user_id: null, contact_role: 'passenger', passenger_name: 'Тест Пассажиров', seat_numbers: '["7"]', passenger_count: 1, channel: 'manual', source_type: 'manual', created_by_user_id: 11 },
        // Different carrier's booking — tenant isolation control.
        { id: 903, bus_ticket_id: 200, status: 'confirmed', claim_status: 'unclaimed', claimed_by_user_id: null, contact_role: 'passenger', passenger_name: 'Тест Пассажиров', seat_numbers: '["8"]', passenger_count: 1, channel: 'manual', source_type: 'manual', created_by_user_id: 999 }
    ]
};
tables.bus_tickets.push({ id: 200, operator_id: 999, reserved_seats: [] });

const fakeClient = createFakeSupabaseClient(tables);
installFakeDbModule(fakeClient);
installFakeServiceRoleModule(fakeClient);

const busAdminRouter = require('../routes/busAdmin');
const bookingSubscriptionHelper = require('../utils/bookingSubscriptionHelper');

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

describe('GET /bus-admin/bookings/:bookingId/ticket — subscriptionModelActive / canSubscribe / canonical isManual', () => {
    it('1. booking 486-like fixture (created_by_user_id set, channel/source_type unreliable): flag on -> isManual true, subscriptionModelActive true, canSubscribe true', async () => {
        process.env.MANUAL_BOOKING_SUBSCRIPTION_MODEL_ENABLED = 'true';
        await withServer(async (port) => {
            const res = await fetch(`http://127.0.0.1:${port}/api/bus-admin/bookings/900/ticket`, { headers: authHeaders() });
            const body = await res.json();
            assert.equal(res.status, 200);
            assert.equal(body.isManual, true, 'canonical isManualBooking() must classify this as manual despite channel/source_type');
            assert.equal(body.subscriptionModelActive, true);
            assert.equal(body.canSubscribe, true);
        });
    });

    it('2. active=true + canSubscribe=true: booking qualifies fully (redundant confirmation alongside test 1, using the exact field names the frontend reads)', async () => {
        process.env.MANUAL_BOOKING_SUBSCRIPTION_MODEL_ENABLED = 'true';
        await withServer(async (port) => {
            const res = await fetch(`http://127.0.0.1:${port}/api/bus-admin/bookings/900/ticket`, { headers: authHeaders() });
            const body = await res.json();
            assert.equal(body.subscriptionModelActive, true);
            assert.equal(body.canSubscribe, true);
        });
    });

    it('3. active=true + canSubscribe=false (trip already arrived): subscriptionModelActive stays true, canSubscribe false', async () => {
        process.env.MANUAL_BOOKING_SUBSCRIPTION_MODEL_ENABLED = 'true';
        await withServer(async (port) => {
            const res = await fetch(`http://127.0.0.1:${port}/api/bus-admin/bookings/902/ticket`, { headers: authHeaders() });
            const body = await res.json();
            assert.equal(res.status, 200);
            assert.equal(body.isManual, true);
            assert.equal(body.subscriptionModelActive, true, 'subscriptionModelActive must never depend on trip/arrival status');
            assert.equal(body.canSubscribe, false);
        });
    });

    it('4. subscribability check throws: subscriptionModelActive stays true, canSubscribe false, no internal error leaked (legacy never re-enabled)', async () => {
        process.env.MANUAL_BOOKING_SUBSCRIPTION_MODEL_ENABLED = 'true';
        const original = bookingSubscriptionHelper.isBookingSubscribable;
        bookingSubscriptionHelper.isBookingSubscribable = () => {
            throw new Error('INTERNAL_DETAIL_MUST_NEVER_REACH_THE_CLIENT');
        };
        try {
            await withServer(async (port) => {
                const res = await fetch(`http://127.0.0.1:${port}/api/bus-admin/bookings/900/ticket`, { headers: authHeaders() });
                const bodyText = await res.text();
                assert.equal(res.status, 200);
                assert.ok(!bodyText.includes('INTERNAL_DETAIL_MUST_NEVER_REACH_THE_CLIENT'));
                const body = JSON.parse(bodyText);
                assert.equal(body.subscriptionModelActive, true);
                assert.equal(body.canSubscribe, false);
            });
        } finally {
            bookingSubscriptionHelper.isBookingSubscribable = original;
        }
    });

    it('5. flag off: subscriptionModelActive/canSubscribe both false regardless of manual/subscribable (legacy)', async () => {
        await withServer(async (port) => {
            const res = await fetch(`http://127.0.0.1:${port}/api/bus-admin/bookings/900/ticket`, { headers: authHeaders() });
            const body = await res.json();
            assert.equal(res.status, 200);
            assert.equal(body.subscriptionModelActive, false);
            assert.equal(body.canSubscribe, false);
        });
    });

    it('genuinely online booking (created_by_user_id null) with channel/source_type=manual at rest: canonical isManual is false even with flag on', async () => {
        process.env.MANUAL_BOOKING_SUBSCRIPTION_MODEL_ENABLED = 'true';
        await withServer(async (port) => {
            const res = await fetch(`http://127.0.0.1:${port}/api/bus-admin/bookings/901/ticket`, { headers: authHeaders() });
            const body = await res.json();
            assert.equal(res.status, 200);
            assert.equal(body.isManual, false, 'the old channel/source_type heuristic would wrongly say true here — canonical must say false');
            assert.equal(body.subscriptionModelActive, false);
            assert.equal(body.canSubscribe, false);
        });
    });

    it('9. created_by_user_id never appears anywhere in the JSON response', async () => {
        process.env.MANUAL_BOOKING_SUBSCRIPTION_MODEL_ENABLED = 'true';
        await withServer(async (port) => {
            const res = await fetch(`http://127.0.0.1:${port}/api/bus-admin/bookings/900/ticket`, { headers: authHeaders() });
            const bodyText = await res.text();
            assert.equal(res.status, 200);
            assert.ok(!bodyText.includes('created_by_user_id'));
        });
    });

    it('tenant isolation unaffected: a different carrier\'s booking is still 403', async () => {
        process.env.MANUAL_BOOKING_SUBSCRIPTION_MODEL_ENABLED = 'true';
        await withServer(async (port) => {
            const res = await fetch(`http://127.0.0.1:${port}/api/bus-admin/bookings/903/ticket`, { headers: authHeaders() });
            assert.equal(res.status, 403);
        });
    });

    it('7. opening/fetching the ticket (this GET itself) never creates a claim or subscription session', async () => {
        process.env.MANUAL_BOOKING_SUBSCRIPTION_MODEL_ENABLED = 'true';
        const claimSessionsBefore = (tables.booking_claim_sessions || []).length;
        const subscriptionSessionsBefore = (tables.booking_subscription_sessions || []).length;
        await withServer(async (port) => {
            const res = await fetch(`http://127.0.0.1:${port}/api/bus-admin/bookings/900/ticket`, { headers: authHeaders() });
            assert.equal(res.status, 200);
        });
        assert.equal((tables.booking_claim_sessions || []).length, claimSessionsBefore);
        assert.equal((tables.booking_subscription_sessions || []).length, subscriptionSessionsBefore);
    });
});
