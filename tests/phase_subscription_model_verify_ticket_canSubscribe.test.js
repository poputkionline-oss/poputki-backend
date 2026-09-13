/**
 * tests/phase_subscription_model_verify_ticket_canSubscribe.test.js
 *
 * POPUTKI.ONLINE — Manual Booking Telegram Subscription Model.
 *
 * Public GET /bus-tickets/verify/:token (TicketVerificationView.vue's own
 * ticket-load call) gains one additive boolean, `ticket.canSubscribe`, true
 * only when ALL of: MANUAL_BOOKING_SUBSCRIPTION_MODEL_ENABLED === 'true',
 * the booking is manual (created_by_user_id set — see
 * utils/bookingChannelHelper.js), and the trip still passes the same
 * fn_is_booking_subscribable rule /claims/subscribe-preview already uses
 * (utils/bookingSubscriptionHelper.js's isBookingSubscribable). This field
 * must never leak WHICH of those three conditions failed, and must never
 * depend on/mutate claim_status or claimed_by_user_id — those stay
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
        // canSubscribe is independent of claim_status/claimed_by_user_id.
        { id: 903, bus_ticket_id: 100, status: 'confirmed', claim_status: 'claimed', claimed_by_user_id: 55, contact_role: 'passenger', passenger_name: 'Тест Пассажиров', seat_numbers: '["8"]', passenger_count: 1, created_by_user_id: 11 }
    ]
};

const fakeClient = createFakeSupabaseClient(tables);
installFakeDbModule(fakeClient);
installFakeServiceRoleModule(fakeClient);

const busTicketsRouter = require('../routes/busTickets');

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

describe('GET /bus-tickets/verify/:token — ticket.canSubscribe', () => {
    it('flag off: canSubscribe is false even for an otherwise-qualifying manual booking', async () => {
        await withServer(async (port) => {
            const token = generateTicketVerificationToken(900);
            const res = await fetch(`http://127.0.0.1:${port}/api/bus-tickets/verify/${token}`);
            const body = await res.json();
            assert.equal(res.status, 200);
            assert.equal(body.valid, true);
            assert.equal(body.ticket.canSubscribe, false);
        });
    });

    it('flag on + manual booking + subscribable trip: canSubscribe is true', async () => {
        process.env.MANUAL_BOOKING_SUBSCRIPTION_MODEL_ENABLED = 'true';
        await withServer(async (port) => {
            const token = generateTicketVerificationToken(900);
            const res = await fetch(`http://127.0.0.1:${port}/api/bus-tickets/verify/${token}`);
            const body = await res.json();
            assert.equal(res.status, 200);
            assert.equal(body.ticket.canSubscribe, true);
        });
    });

    it('flag on but booking is NOT manual (created_by_user_id null): canSubscribe is false', async () => {
        process.env.MANUAL_BOOKING_SUBSCRIPTION_MODEL_ENABLED = 'true';
        await withServer(async (port) => {
            const token = generateTicketVerificationToken(901);
            const res = await fetch(`http://127.0.0.1:${port}/api/bus-tickets/verify/${token}`);
            const body = await res.json();
            assert.equal(res.status, 200);
            assert.equal(body.ticket.canSubscribe, false);
        });
    });

    it('flag on + manual booking, but the trip has already arrived: canSubscribe is false', async () => {
        process.env.MANUAL_BOOKING_SUBSCRIPTION_MODEL_ENABLED = 'true';
        await withServer(async (port) => {
            const token = generateTicketVerificationToken(902);
            const res = await fetch(`http://127.0.0.1:${port}/api/bus-tickets/verify/${token}`);
            const body = await res.json();
            assert.equal(res.status, 200);
            assert.equal(body.ticket.canSubscribe, false);
        });
    });

    it('canSubscribe is independent of claim_status/claimed_by_user_id: an already-claimed manual booking on a subscribable trip still reports true', async () => {
        process.env.MANUAL_BOOKING_SUBSCRIPTION_MODEL_ENABLED = 'true';
        await withServer(async (port) => {
            const token = generateTicketVerificationToken(903);
            const res = await fetch(`http://127.0.0.1:${port}/api/bus-tickets/verify/${token}`);
            const body = await res.json();
            assert.equal(res.status, 200);
            assert.equal(body.ticket.canSubscribe, true, 'canSubscribe must reflect only flag+manual+subscribable, never claim_status');
        });
    });

    it('never leaks an internal reason code, only the plain boolean, and never mutates claim_status/claimed_by_user_id', async () => {
        process.env.MANUAL_BOOKING_SUBSCRIPTION_MODEL_ENABLED = 'true';
        const before = tables.bus_ticket_bookings.find(b => b.id === 901);
        const claimStatusBefore = before.claim_status;
        const claimedByBefore = before.claimed_by_user_id;
        await withServer(async (port) => {
            const token = generateTicketVerificationToken(901);
            const res = await fetch(`http://127.0.0.1:${port}/api/bus-tickets/verify/${token}`);
            const body = await res.json();
            assert.equal(typeof body.ticket.canSubscribe, 'boolean');
            assert.ok(!('canSubscribeReason' in body.ticket));
            assert.ok(!('subscriptionModelEnabled' in body.ticket));
            assert.ok(!('isManualBooking' in body.ticket));
        });
        const after = tables.bus_ticket_bookings.find(b => b.id === 901);
        assert.equal(after.claim_status, claimStatusBefore);
        assert.equal(after.claimed_by_user_id, claimedByBefore);
    });
});
