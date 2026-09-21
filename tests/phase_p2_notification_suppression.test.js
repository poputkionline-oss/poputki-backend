/**
 * tests/phase_p2_notification_suppression.test.js
 *
 * PHASE P.2 (follow-up) — Price-only trip edits must NOT trigger the
 * passenger "trip changed" Telegram notification, because a trip price
 * change never alters any EXISTING booking's own price
 * (bus_ticket_bookings.total_price is an immutable snapshot — see
 * tests/phase_p2_dynamic_trip_price.test.js). Any OTHER changed field
 * (schedule, address, bus, group leader, ...) — alone or together with a
 * price change — must keep using the existing notification flow exactly
 * as before, price fields included in the diff shown to passengers.
 *
 * This suite exercises the REAL routes/busAdmin.js PUT /tickets/:id
 * handler over real HTTP (not a re-implementation of its logic), the same
 * technique used by tests/phase_e47_2_atomic_trip_completion.test.js and
 * tests/helpers/fakeSupabaseClient.js: require.cache injection replaces
 * '../db' and '../dbServiceRole' with a deterministic in-memory fake, so
 * carrierAuth, verifyTicketAccess and the route's own query logic all run
 * unmodified against fake-but-real-shaped data. Only the
 * fn_atomic_bus_trip_update RPC (a Postgres function, unreachable from
 * Node) is simulated — mirroring its observable contract (price update +
 * bus_ticket_change_events insert + bus_ticket_notification_outbox insert,
 * never touching bus_ticket_bookings), the same approach already used by
 * tests/phase_e47_2_atomic_trip_completion.test.js for fn_complete_bus_trip
 * and tests/phase_bus_trip_edit_atomicity_and_worker.test.js for this same
 * RPC. This is not a parallel notification system: the actual
 * outbox-building / suppression decision under test lives entirely in
 * routes/busAdmin.js and runs for real in every case below.
 */

'use strict';

process.env.JWT_SECRET = 'test-secret-key-p2-notification-suppression';
process.env.SUPABASE_URL = 'https://test-local-only.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-local-service-role-key-not-real';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const jwt = require('jsonwebtoken');

const {
    createFakeSupabaseClient,
    installFakeDbModule,
    installFakeServiceRoleModule
} = require('./helpers/fakeSupabaseClient');

const OPERATOR_ID = 501;
const FUTURE_DEPARTURE_DATE = '2027-06-01';
const FUTURE_DEPARTURE_TIME = '10:00:00';

function generateToken(userId, carrierId) {
    return jwt.sign(
        { sub: String(userId), carrierId },
        process.env.JWT_SECRET,
        { algorithm: 'HS256', issuer: 'poputki.online', audience: 'poputki-carrier', expiresIn: '1h' }
    );
}

function freshTables() {
    return {
        users: [
            { id: OPERATOR_ID, name: 'Carrier Owner', phone: '+992900000501', role: 'bus_driver', is_blocked: false, service_fee_percent: 10 },
            { id: 601, name: 'Passenger A', phone: '+992900000601', role: 'passenger', is_blocked: false, telegram_id: 700601, language: 'ru' },
            { id: 602, name: 'Passenger B', phone: '+992900000602', role: 'passenger', is_blocked: false, telegram_id: 700602, language: 'ru' }
        ],
        carrier_members: [],
        bus_tickets: [
            {
                id: 1, operator_id: OPERATOR_ID, status: 'active',
                from_city: 'Душанбе', to_city: 'Худжанд',
                from_address: 'Автовокзал', to_address: 'Автовокзал 2',
                departure_date: FUTURE_DEPARTURE_DATE, departure_time: FUTURE_DEPARTURE_TIME,
                arrival_date: null, arrival_time: null, duration_minutes: null,
                price: 840, premium_price: null,
                bus_type: 'single', total_seats: 40, floor1_seats: null, floor2_seats: null,
                reserved_seats: [1, 2],
                intermediate_stops: [], photos: [],
                group_leader_name: '', group_leader_phone: '', group_leader_whatsapp: ''
            }
        ],
        bus_ticket_bookings: [
            { id: 9001, bus_ticket_id: 1, passenger_id: 601, claimed_by_user_id: null, seat_numbers: [1], status: 'confirmed', total_price: 840, hold_expires_at: null, created_at: '2026-09-01T00:00:00.000Z', passengers_data: [] },
            { id: 9002, bus_ticket_id: 1, passenger_id: 602, claimed_by_user_id: null, seat_numbers: [2], status: 'confirmed', total_price: 840, hold_expires_at: null, created_at: '2026-09-01T00:00:00.000Z', passengers_data: [] }
        ],
        bus_ticket_change_events: [],
        bus_ticket_notification_outbox: [],
        carrier_activity_logs: []
    };
}

/** Mirrors the observable contract of fn_atomic_bus_trip_update — see file header. */
function simulateAtomicBusTripUpdate(tables, params) {
    const { p_ticket_id, p_operator_id, p_update_data, p_event_data, p_outbox_entries } = params;
    const ticket = tables.bus_tickets.find(t => t.id === p_ticket_id);
    if (!ticket) return { data: { success: false, error: 'TICKET_NOT_FOUND' }, error: null };
    if (ticket.operator_id !== p_operator_id) return { data: { success: false, error: 'FORBIDDEN_OPERATOR' }, error: null };
    if (ticket.status !== 'active') return { data: { success: false, error: 'TICKET_NOT_ACTIVE' }, error: null };

    const activeBookings = tables.bus_ticket_bookings.filter(b => b.bus_ticket_id === p_ticket_id && b.status !== 'cancelled');
    if (activeBookings.length > 0) {
        if (
            (Object.prototype.hasOwnProperty.call(p_update_data, 'from_city') && p_update_data.from_city !== ticket.from_city) ||
            (Object.prototype.hasOwnProperty.call(p_update_data, 'to_city') && p_update_data.to_city !== ticket.to_city)
        ) {
            return { data: { success: false, error: 'ROUTE_CHANGE_REQUIRES_SEPARATE_TRIP' }, error: null };
        }
    }

    // Real RPC uses COALESCE(new, old) semantics — only keys actually present are applied.
    Object.keys(p_update_data).forEach(k => {
        if (p_update_data[k] !== undefined) ticket[k] = p_update_data[k];
    });

    const eventId = `evt-${p_ticket_id}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    tables.bus_ticket_change_events.push({
        id: eventId,
        bus_ticket_id: p_ticket_id,
        operator_id: p_operator_id,
        changed_by: p_event_data.changed_by,
        change_type: p_event_data.change_type,
        old_values: p_event_data.old_values,
        new_values: p_event_data.new_values,
        changed_fields: p_event_data.changed_fields,
        created_at: new Date().toISOString()
    });

    (p_outbox_entries || []).forEach(o => {
        tables.bus_ticket_notification_outbox.push({
            id: `outbox-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            event_id: eventId,
            ...o
        });
    });

    return { data: { success: true, event_id: eventId, ticket_id: p_ticket_id }, error: null };
}

function makeApp(tables) {
    const fakeDb = createFakeSupabaseClient(tables);
    // Override rpc: the shared fake's rpc() only knows fn_create_booking_handoff
    // and throws for anything else. fn_atomic_bus_trip_update is simulated
    // here; fn_claim_bus_trip_notification_batch (the outbox worker's own
    // claim RPC, invoked fire-and-forget by busAdmin.js's post-response
    // wake-up call) is answered with a benign error so the worker falls back
    // to its own documented pending-row query path — never a real network
    // call, since NOTIFICATION_DELIVERY_ENABLED is unset here (dry-run).
    fakeDb.rpc = async (name, params) => {
        if (name === 'fn_atomic_bus_trip_update') return simulateAtomicBusTripUpdate(tables, params);
        if (name === 'fn_claim_bus_trip_notification_batch') return { data: null, error: new Error('not supported in test fake') };
        throw new Error(`Unmocked RPC in phase_p2_notification_suppression test: ${name}`);
    };

    installFakeDbModule(fakeDb);
    installFakeServiceRoleModule(fakeDb);

    delete require.cache[require.resolve('../routes/busAdmin')];
    const express = require('express');
    const busAdminRouter = require('../routes/busAdmin');
    const app = express();
    app.use(express.json());
    app.use('/api/bus-admin', busAdminRouter);
    return app;
}

function makeRequest(baseUrl, method, urlPath, headers = {}, body = null) {
    return new Promise((resolve, reject) => {
        const url = new URL(urlPath, baseUrl);
        const options = {
            method, hostname: url.hostname, port: url.port, path: url.pathname + url.search,
            headers: { 'Content-Type': 'application/json', 'Connection': 'close', ...headers }
        };
        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                let parsed = null;
                try { parsed = JSON.parse(data); } catch (e) { parsed = data; }
                resolve({ status: res.statusCode, body: parsed });
            });
        });
        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

describe('Phase P.2 — Price-only trip edits suppress the passenger trip-change notification', () => {
    let server, baseUrl, tables;

    function startServer() {
        tables = freshTables();
        const app = makeApp(tables);
        return new Promise((resolve) => {
            server = http.createServer(app);
            server.listen(0, '127.0.0.1', () => {
                baseUrl = `http://127.0.0.1:${server.address().port}`;
                resolve();
            });
        });
    }

    function stopServer() {
        return new Promise((resolve) => server.close(resolve));
    }

    const authHeaders = () => ({ Authorization: `Bearer ${generateToken(OPERATOR_ID, OPERATOR_ID)}` });

    it('1. price only (840 -> 700): existing bookings unaffected, notification/outbox count = 0', async () => {
        await startServer();
        const res = await makeRequest(baseUrl, 'PUT', '/api/bus-admin/tickets/1', authHeaders(), { price: 700 });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(res.body.notificationsQueued, 0);
        assert.equal(res.body.unreachableCount, 0);
        assert.equal(tables.bus_ticket_notification_outbox.length, 0, 'no outbox rows must be created for a price-only edit');
        assert.equal(tables.bus_tickets.find(t => t.id === 1).price, 700);
        await stopServer();
    });

    it('2. premium_price only: notification/outbox count = 0', async () => {
        await startServer();
        const res = await makeRequest(baseUrl, 'PUT', '/api/bus-admin/tickets/1', authHeaders(), { premium_price: 950 });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(res.body.notificationsQueued, 0);
        assert.equal(tables.bus_ticket_notification_outbox.length, 0);
        assert.equal(tables.bus_tickets.find(t => t.id === 1).premium_price, 950);
        await stopServer();
    });

    it('3. price + premium_price only: notification/outbox count = 0', async () => {
        await startServer();
        const res = await makeRequest(baseUrl, 'PUT', '/api/bus-admin/tickets/1', authHeaders(), { price: 700, premium_price: 950 });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(res.body.notificationsQueued, 0);
        assert.equal(tables.bus_ticket_notification_outbox.length, 0);
        await stopServer();
    });

    it('4. departure_time only: notification is created as before (unchanged behavior)', async () => {
        await startServer();
        const res = await makeRequest(baseUrl, 'PUT', '/api/bus-admin/tickets/1', authHeaders(), { departure_time: '14:00:00' });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(res.body.notificationsQueued, 2, 'both confirmed passengers have a telegram_id -> both queued');
        assert.equal(tables.bus_ticket_notification_outbox.length, 2);
        await stopServer();
    });

    it('5. price + departure_time together: notification is still created as before', async () => {
        await startServer();
        const res = await makeRequest(baseUrl, 'PUT', '/api/bus-admin/tickets/1', authHeaders(), { price: 700, departure_time: '14:00:00' });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(res.body.notificationsQueued, 2, 'a notification-worthy field alongside price must not suppress notifications');
        assert.equal(tables.bus_ticket_notification_outbox.length, 2);
        // The notification payload legitimately still carries the price diff (unchanged pre-existing behavior).
        const outboxRow = tables.bus_ticket_notification_outbox[0];
        assert.equal(outboxRow.payload.changes.newValues.price, 700);
        await stopServer();
    });

    it('6. existing booking price is unchanged after a price-only edit', async () => {
        await startServer();
        await makeRequest(baseUrl, 'PUT', '/api/bus-admin/tickets/1', authHeaders(), { price: 700 });
        assert.equal(tables.bus_ticket_bookings.find(b => b.id === 9001).total_price, 840);
        assert.equal(tables.bus_ticket_bookings.find(b => b.id === 9002).total_price, 840);
        await stopServer();
    });

    it('7. a pending_payment booking\'s price is unchanged after a price-only edit', async () => {
        await startServer();
        tables.bus_ticket_bookings.push({
            id: 9003, bus_ticket_id: 1, passenger_id: 601, claimed_by_user_id: null,
            seat_numbers: [3], status: 'pending_payment', total_price: 840,
            hold_expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
            created_at: new Date().toISOString(), passengers_data: []
        });
        const res = await makeRequest(baseUrl, 'PUT', '/api/bus-admin/tickets/1', authHeaders(), { price: 700 });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(tables.bus_ticket_bookings.find(b => b.id === 9003).total_price, 840);
        assert.equal(res.body.notificationsQueued, 0, 'pending_payment passenger must not be notified of a price-only change either');
        await stopServer();
    });

    it('8. bus_ticket_change_events gets change_type = price_update for a price-only edit', async () => {
        await startServer();
        await makeRequest(baseUrl, 'PUT', '/api/bus-admin/tickets/1', authHeaders(), { price: 700 });
        const event = tables.bus_ticket_change_events.find(e => e.bus_ticket_id === 1);
        assert.ok(event, 'a change event must still be recorded even though no notification was sent');
        assert.equal(event.change_type, 'price_update');
        assert.deepEqual(event.changed_fields, ['price']);
        assert.equal(event.old_values.price, 840);
        assert.equal(event.new_values.price, 700);
        await stopServer();
    });

    it('9. price + a notification-worthy field is NOT classified as price_update (general schedule_update semantics apply)', async () => {
        await startServer();
        await makeRequest(baseUrl, 'PUT', '/api/bus-admin/tickets/1', authHeaders(), { price: 700, departure_time: '14:00:00' });
        const event = tables.bus_ticket_change_events.find(e => e.bus_ticket_id === 1);
        assert.ok(event);
        assert.equal(event.change_type, 'schedule_update', 'mixed price+schedule changes must keep the general change_type, not price_update');
        assert.ok(event.changed_fields.includes('price'));
        assert.ok(event.changed_fields.includes('departure_time'));
        await stopServer();
    });
});
