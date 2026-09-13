/**
 * tests/phase_subscription_model_verify_ticket_canSubscribe.test.js
 *
 * POPUTKI.ONLINE — Manual Booking Telegram Subscription Model.
 *
 * Public GET /bus-tickets/verify/:token (TicketVerificationView.vue's own
 * ticket-load call) gains two INDEPENDENT additive booleans on `ticket`:
 *
 *   - subscriptionModelActive: true whenever
 *     MANUAL_BOOKING_SUBSCRIPTION_MODEL_ENABLED === 'true' AND the booking
 *     is manual (created_by_user_id set — see utils/bookingChannelHelper.js).
 *     Independent of trip status/arrival time: it stays true even when the
 *     booking is no longer subscribable, or when the subscribability check
 *     itself fails — the frontend uses this alone to decide whether the
 *     legacy claim_ flow is ever allowed to run.
 *   - canSubscribe: true only when subscriptionModelActive AND the same
 *     fn_is_booking_subscribable rule /claims/subscribe-preview already
 *     uses (utils/bookingSubscriptionHelper.js's isBookingSubscribable)
 *     currently passes. Any error evaluating that rule collapses to
 *     canSubscribe=false, never surfaced to the client and never allowed to
 *     also flip subscriptionModelActive to false.
 *
 * Neither field ever leaks WHICH underlying condition failed, and neither
 * depends on/mutates claim_status or claimed_by_user_id — those stay
 * exclusively the legacy claim flow's fields.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

require('dotenv').config();

const { createFakeSupabaseClient, installFakeDbModule, installFakeServiceRoleModule } = require('./helpers/fakeSupabaseClient');
const { generateTicketVerificationToken } = require('../utils/ticketHelper');

// Comfortably in the future relative to "now" for every run of this suite.
const FUTURE_DATE = '2099-01-10';
const PAST_DATE = '2020-01-10';

const tables = {
    bus_tickets: [
        // Subscribable trip: confirmed-status booking's route, arrival well
        // in the future.
        { id: 100, operator_id: 11, from_city: 'Душанбе', to_city: 'Худжанд', bus_type: 'single', price: 100, premium_price: 100, reserved_seats: [], status: 'scheduled', arrival_date: FUTURE_DATE, arrival_time: '10:00:00' },
        // Same route, but the trip has already arrived (long past +
        // grace window) — never subscribable regardless of flag/manual.
        { id: 101, operator_id: 11, from_city: 'Душанбе', to_city: 'Худжанд', bus_type: 'single', price: 100, premium_price: 100, reserved_seats: [], status: 'scheduled', arrival_date: PAST_DATE, arrival_time: '10:00:00' }
    ],
    bus_ticket_bookings: [
        // Manual (created_by_user_id set), confirmed, on the subscribable trip.
        { id: 900, bus_ticket_id: 100, status: 'confirmed', claim_status: 'unclaimed', claimed_by_user_id: null, contact_role: 'passenger', passenger_name: 'Тест Пассажиров', seat_numbers: '["5"]', passenger_count: 1, created_by_user_id: 11 },
        // Online booking (created_by_user_id null) on the SAME subscribable trip.
        { id: 901, bus_ticket_id: 100, status: 'confirmed', claim_status: 'unclaimed', claimed_by_user_id: null, contact_role: 'passenger', passenger_name: 'Тест Пассажиров', seat_numbers: '["6"]', passenger_count: 1, created_by_user_id: null },
        // Manual booking, but the trip has already arrived.
        { id: 902, bus_ticket_id: 101, status: 'confirmed', claim_status: 'unclaimed', claimed_by_user_id: null, contact_role: 'passenger', passenger_name: 'Тест Пассажиров', seat_numbers: '["7"]', passenger_count: 1, created_by_user_id: 11 },
        // Manual booking, subscribable trip, but ALREADY claimed — proves
        // both flags are independent of claim_status/claimed_by_user_id.
        { id: 903, bus_ticket_id: 100, status: 'confirmed', claim_status: 'claimed', claimed_by_user_id: 55, contact_role: 'passenger', passenger_name: 'Тест Пассажиров', seat_numbers: '["8"]', passenger_count: 1, created_by_user_id: 11 },
        // Manual booking on the subscribable trip, used only by the
        // "subscribability check throws" test below (separate booking id so
        // the monkey-patched throw never contaminates the other assertions
        // if test ordering ever changes).
        { id: 904, bus_ticket_id: 100, status: 'confirmed', claim_status: 'unclaimed', claimed_by_user_id: null, contact_role: 'passenger', passenger_name: 'Тест Пассажиров', seat_numbers: '["9"]', passenger_count: 1, created_by_user_id: 11 }
    ]
};

const fakeClient = createFakeSupabaseClient(tables);
installFakeDbModule(fakeClient);
installFakeServiceRoleModule(fakeClient);

const busTicketsRouter = require('../routes/busTickets');
const bookingSubscriptionHelper = require('../utils/bookingSubscriptionHelper');

async function withServer(fn) {
    const app = express();
    app.use(express.json());
    app.use('/api/bus-tickets', busTicketsRouter);
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, resolve));
    const port = server.address().port;
    try {
        await fn(port);
    } finally {
        server.close();
    }
}

beforeEach(() => {
    delete process.env.MANUAL_BOOKING_SUBSCRIPTION_MODEL_ENABLED;
});

afterEach(() => {
    delete process.env.MANUAL_BOOKING_SUBSCRIPTION_MODEL_ENABLED;
});

describe('GET /bus-tickets/verify/:token — subscriptionModelActive / canSubscribe', () => {
    it('1. manual + flag on + subscribable trip: both flags true (subscription flow)', async () => {
        process.env.MANUAL_BOOKING_SUBSCRIPTION_MODEL_ENABLED = 'true';
        await withServer(async (port) => {
            const token = generateTicketVerificationToken(900);
            const res = await fetch(`http://127.0.0.1:${port}/api/bus-tickets/verify/${token}`);
            const body = await res.json();
            assert.equal(res.status, 200);
            assert.equal(body.valid, true);
            assert.equal(body.ticket.subscriptionModelActive, true);
            assert.equal(body.ticket.canSubscribe, true);
        });
    });

    it('2. manual + flag on + trip NOT subscribable (already arrived): subscriptionModelActive stays true, canSubscribe false — no legacy allowed', async () => {
        process.env.MANUAL_BOOKING_SUBSCRIPTION_MODEL_ENABLED = 'true';
        await withServer(async (port) => {
            const token = generateTicketVerificationToken(902);
            const res = await fetch(`http://127.0.0.1:${port}/api/bus-tickets/verify/${token}`);
            const body = await res.json();
            assert.equal(res.status, 200);
            assert.equal(body.ticket.subscriptionModelActive, true, 'subscriptionModelActive must stay true — it never depends on trip/arrival status');
            assert.equal(body.ticket.canSubscribe, false);
        });
    });

    it('3. manual + flag on + subscribability check throws: subscriptionModelActive stays true, canSubscribe false, no internal error leaked', async () => {
        process.env.MANUAL_BOOKING_SUBSCRIPTION_MODEL_ENABLED = 'true';
        const original = bookingSubscriptionHelper.isBookingSubscribable;
        bookingSubscriptionHelper.isBookingSubscribable = () => {
            throw new Error('INTERNAL_DETAIL_MUST_NEVER_REACH_THE_CLIENT');
        };
        try {
            await withServer(async (port) => {
                const token = generateTicketVerificationToken(904);
                const res = await fetch(`http://127.0.0.1:${port}/api/bus-tickets/verify/${token}`);
                const bodyText = await res.text();
                assert.equal(res.status, 200);
                assert.ok(!bodyText.includes('INTERNAL_DETAIL_MUST_NEVER_REACH_THE_CLIENT'), 'internal error message must never reach the client');
                const body = JSON.parse(bodyText);
                assert.equal(body.ticket.subscriptionModelActive, true, 'a failure evaluating subscribability must never flip subscriptionModelActive to false');
                assert.equal(body.ticket.canSubscribe, false);
            });
        } finally {
            bookingSubscriptionHelper.isBookingSubscribable = original;
        }
    });

    it('4. manual + flag off: both flags false (legacy flow)', async () => {
        await withServer(async (port) => {
            const token = generateTicketVerificationToken(900);
            const res = await fetch(`http://127.0.0.1:${port}/api/bus-tickets/verify/${token}`);
            const body = await res.json();
            assert.equal(res.status, 200);
            assert.equal(body.ticket.subscriptionModelActive, false);
            assert.equal(body.ticket.canSubscribe, false);
        });
    });

    it('5. non-manual booking (created_by_user_id null), flag on: both flags false regardless of the trip being subscribable (legacy flow)', async () => {
        process.env.MANUAL_BOOKING_SUBSCRIPTION_MODEL_ENABLED = 'true';
        await withServer(async (port) => {
            const token = generateTicketVerificationToken(901);
            const res = await fetch(`http://127.0.0.1:${port}/api/bus-tickets/verify/${token}`);
            const body = await res.json();
            assert.equal(res.status, 200);
            assert.equal(body.ticket.subscriptionModelActive, false);
            assert.equal(body.ticket.canSubscribe, false);
        });
    });

    it('6. claim_status/claimed_by_user_id never influence either flag, and are never mutated by this read-only endpoint', async () => {
        process.env.MANUAL_BOOKING_SUBSCRIPTION_MODEL_ENABLED = 'true';
        const before = tables.bus_ticket_bookings.find(b => b.id === 903);
        const claimStatusBefore = before.claim_status;
        const claimedByBefore = before.claimed_by_user_id;

        await withServer(async (port) => {
            const token = generateTicketVerificationToken(903);
            const res = await fetch(`http://127.0.0.1:${port}/api/bus-tickets/verify/${token}`);
            const body = await res.json();
            assert.equal(res.status, 200);
            assert.equal(body.ticket.subscriptionModelActive, true, 'an already-claimed manual booking must still report subscriptionModelActive');
            assert.equal(body.ticket.canSubscribe, true, 'claim_status must not affect canSubscribe — the trip is still subscribable');
        });

        const after = tables.bus_ticket_bookings.find(b => b.id === 903);
        assert.equal(after.claim_status, claimStatusBefore, 'claim_status must never be mutated by this read-only endpoint');
        assert.equal(after.claimed_by_user_id, claimedByBefore, 'claimed_by_user_id must never be mutated by this read-only endpoint');
    });

    it('never leaks an internal reason code — only the two plain booleans are exposed', async () => {
        process.env.MANUAL_BOOKING_SUBSCRIPTION_MODEL_ENABLED = 'true';
        await withServer(async (port) => {
            const token = generateTicketVerificationToken(901);
            const res = await fetch(`http://127.0.0.1:${port}/api/bus-tickets/verify/${token}`);
            const body = await res.json();
            assert.equal(typeof body.ticket.subscriptionModelActive, 'boolean');
            assert.equal(typeof body.ticket.canSubscribe, 'boolean');
            assert.ok(!('canSubscribeReason' in body.ticket));
            assert.ok(!('subscriptionModelEnabled' in body.ticket));
            assert.ok(!('isManualBooking' in body.ticket));
        });
    });
});
