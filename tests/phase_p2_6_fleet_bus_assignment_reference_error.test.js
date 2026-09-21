/**
 * tests/phase_p2_6_fleet_bus_assignment_reference_error.test.js
 *
 * PHASE P.2.6 — FIX FLEET BUS ASSIGNMENT REFERENCEERROR
 *
 * Root cause (found while building P.2.5's Fleet-guard tests, proven by a
 * standalone repro before any edit): routes/busAdmin.js's bus-replacement
 * validation path calls checkBusScheduleConflict(...) (PUT /tickets/:id,
 * ~line 553), but that function was never in the destructure from
 * '../utils/busHelper' at the top of the file (it exports it — see
 * utils/busHelper.js module.exports — but only validateBusPayload,
 * checkDuplicatePlate, verifyBusAccess, getBusActiveTickets and
 * validateBusReplacement were imported). Any real bus_id change reached
 * that line and threw a synchronous ReferenceError, previously falling
 * through to the outer catch as an opaque 500 (made safe/observable, but
 * not fixed, by P.2.5).
 *
 * This is directly relevant to a real production incident: trip id=75,
 * bus_id NULL, bus_type double (78 seats, 22+56), price 840, 5 confirmed
 * bookings (seats 1,2,3,4,30) — the carrier selecting a Fleet bus and
 * saving got "Внутренняя ошибка сервера".
 *
 * The fix is exactly one line: add checkBusScheduleConflict to the
 * existing destructure. Nothing else changes — same function, same
 * semantics, same call site, same arguments.
 *
 * This suite exercises the REAL routes/busAdmin.js PUT /tickets/:id
 * handler over real HTTP, same require.cache-injection technique as
 * tests/phase_p2_5_trip_update_hardening.test.js and
 * tests/phase_p2_notification_suppression.test.js.
 */

'use strict';

process.env.JWT_SECRET = 'test-secret-key-p2-6-fleet-bus';
process.env.SUPABASE_URL = 'https://test-local-only.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-local-service-role-key-not-real';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const jwt = require('jsonwebtoken');

const {
    createFakeSupabaseClient,
    installFakeDbModule,
    installFakeServiceRoleModule
} = require('./helpers/fakeSupabaseClient');

const OPERATOR_ID = 901;
const OTHER_CARRIER_ID = 902;
const FUTURE_DEPARTURE_DATE = '2027-09-23';
const FUTURE_DEPARTURE_TIME = '18:00:00';

function generateToken(userId, carrierId) {
    return jwt.sign(
        { sub: String(userId), carrierId },
        process.env.JWT_SECRET,
        { algorithm: 'HS256', issuer: 'poputki.online', audience: 'poputki-carrier', expiresIn: '1h' }
    );
}

function installThrowingServiceRoleModule() {
    const p = require.resolve('../dbServiceRole');
    require.cache[p] = {
        id: p, filename: p, loaded: true,
        exports: {
            getServiceRoleClient: () => { throw new Error('SUPABASE_SERVICE_ROLE_KEY is required for server-side claim operations'); },
            getServiceRoleDiagnostics: () => ({ serviceRoleEnvPresent: false, serviceRoleClientCached: false, moduleInstanceId: 'fake-throwing', processPid: process.pid }),
            setServiceRoleClient: () => {}
        }
    };
}

// Production-shaped: trip 75 (bus_id NULL, double-decker 78 seats 22+56, price
// 840, 5 confirmed bookings on seats 1,2,3,4,30).
function freshTables() {
    return {
        users: [
            { id: OPERATOR_ID, name: 'Carrier Owner', phone: '+992900000901', role: 'bus_driver', is_blocked: false, service_fee_percent: 10 },
            { id: 1001, name: 'P1', phone: '+992900001001', role: 'passenger', is_blocked: false, telegram_id: 500001, language: 'ru' },
            { id: 1002, name: 'P2', phone: '+992900001002', role: 'passenger', is_blocked: false, telegram_id: 500002, language: 'ru' },
            { id: 1003, name: 'P3', phone: '+992900001003', role: 'passenger', is_blocked: false, telegram_id: 500003, language: 'ru' },
            { id: 1004, name: 'P4', phone: '+992900001004', role: 'passenger', is_blocked: false, telegram_id: 500004, language: 'ru' },
            { id: 1005, name: 'P5', phone: '+992900001005', role: 'passenger', is_blocked: false, telegram_id: 500005, language: 'ru' }
        ],
        carrier_members: [],
        carrier_buses: [
            // Compatible: same carrier, active, double, 78 seats (22+56)
            { id: 10, carrier_id: OPERATOR_ID, status: 'active', bus_type: 'double', total_seats: 78, floor1_seats: 22, floor2_seats: 56, photos: [] },
            // Belongs to a different carrier entirely
            { id: 11, carrier_id: OTHER_CARRIER_ID, status: 'active', bus_type: 'double', total_seats: 78, floor1_seats: 22, floor2_seats: 56, photos: [] },
            // Same carrier, but inactive
            { id: 12, carrier_id: OPERATOR_ID, status: 'inactive', bus_type: 'double', total_seats: 78, floor1_seats: 22, floor2_seats: 56, photos: [] },
            // Same carrier, active, but too small: cannot fit booked seat 30
            { id: 13, carrier_id: OPERATOR_ID, status: 'active', bus_type: 'single', total_seats: 20, floor1_seats: null, floor2_seats: null, photos: [] },
            // A second compatible bus, already assigned to a conflicting ticket
            { id: 14, carrier_id: OPERATOR_ID, status: 'active', bus_type: 'double', total_seats: 78, floor1_seats: 22, floor2_seats: 56, photos: [] }
        ],
        bus_tickets: [
            {
                id: 75, operator_id: OPERATOR_ID, status: 'active',
                from_city: 'Худжанд', to_city: 'Нижневартовск',
                from_address: 'Автовокзал', to_address: 'Автовокзал',
                departure_date: FUTURE_DEPARTURE_DATE, departure_time: FUTURE_DEPARTURE_TIME,
                // Explicit overnight arrival (next day 10:00), matching the real
                // trip-75 shape — required so checkBusScheduleConflict's interval
                // overlap math has a genuine, non-zero-width proposed window
                // (arrival_date/time both null would degenerate to a zero-length
                // instant at departure_time, an existing, out-of-scope quirk of
                // that pre-existing function — not something this phase touches).
                arrival_date: '2027-09-24', arrival_time: '10:00:00', duration_minutes: 960,
                price: 840, premium_price: null,
                bus_type: 'double', total_seats: 78, floor1_seats: 22, floor2_seats: 56, bus_id: null,
                reserved_seats: [1, 2, 3, 4, 30], intermediate_stops: [], photos: [],
                group_leader_name: '', group_leader_phone: '', group_leader_whatsapp: ''
            },
            // Existing ticket already on bus 14, same day, overlapping window -> real schedule conflict.
            {
                id: 76, operator_id: OPERATOR_ID, status: 'active',
                from_city: 'Душанбе', to_city: 'Куляб',
                from_address: 'Автовокзал', to_address: 'Автовокзал',
                departure_date: FUTURE_DEPARTURE_DATE, departure_time: '19:00:00',
                arrival_date: FUTURE_DEPARTURE_DATE, arrival_time: '23:00:00', duration_minutes: 240,
                price: 500, premium_price: null,
                bus_type: 'double', total_seats: 78, floor1_seats: 22, floor2_seats: 56, bus_id: 14,
                reserved_seats: [], intermediate_stops: [], photos: [],
                group_leader_name: '', group_leader_phone: '', group_leader_whatsapp: ''
            }
        ],
        bus_ticket_bookings: [
            { id: 20001, bus_ticket_id: 75, passenger_id: 1001, claimed_by_user_id: null, seat_numbers: [1], status: 'confirmed', total_price: 840, hold_expires_at: null, created_at: '2026-09-01T00:00:00.000Z', passengers_data: [] },
            { id: 20002, bus_ticket_id: 75, passenger_id: 1002, claimed_by_user_id: null, seat_numbers: [2], status: 'confirmed', total_price: 840, hold_expires_at: null, created_at: '2026-09-01T00:00:00.000Z', passengers_data: [] },
            { id: 20003, bus_ticket_id: 75, passenger_id: 1003, claimed_by_user_id: null, seat_numbers: [3], status: 'confirmed', total_price: 840, hold_expires_at: null, created_at: '2026-09-01T00:00:00.000Z', passengers_data: [] },
            { id: 20004, bus_ticket_id: 75, passenger_id: 1004, claimed_by_user_id: null, seat_numbers: [4], status: 'confirmed', total_price: 840, hold_expires_at: null, created_at: '2026-09-01T00:00:00.000Z', passengers_data: [] },
            { id: 20005, bus_ticket_id: 75, passenger_id: 1005, claimed_by_user_id: null, seat_numbers: [30], status: 'confirmed', total_price: 840, hold_expires_at: null, created_at: '2026-09-01T00:00:00.000Z', passengers_data: [] }
        ],
        bus_ticket_change_events: [],
        bus_ticket_notification_outbox: [],
        carrier_activity_logs: []
    };
}

function simulateAtomicBusTripUpdate(tables, params) {
    const { p_ticket_id, p_operator_id, p_update_data, p_event_data, p_outbox_entries } = params;
    const ticket = tables.bus_tickets.find(t => t.id === p_ticket_id);
    if (!ticket) return { data: { success: false, error: 'TICKET_NOT_FOUND' }, error: null };
    if (ticket.operator_id !== p_operator_id) return { data: { success: false, error: 'FORBIDDEN_OPERATOR' }, error: null };
    if (ticket.status !== 'active') return { data: { success: false, error: 'TICKET_NOT_ACTIVE' }, error: null };

    Object.keys(p_update_data).forEach(k => {
        if (p_update_data[k] !== undefined) ticket[k] = p_update_data[k];
    });

    const eventId = `evt-${p_ticket_id}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    tables.bus_ticket_change_events.push({
        id: eventId, bus_ticket_id: p_ticket_id, operator_id: p_operator_id,
        changed_by: p_event_data.changed_by, change_type: p_event_data.change_type,
        old_values: p_event_data.old_values, new_values: p_event_data.new_values,
        changed_fields: p_event_data.changed_fields, created_at: new Date().toISOString()
    });

    (p_outbox_entries || []).forEach(o => {
        tables.bus_ticket_notification_outbox.push({ id: `outbox-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, event_id: eventId, ...o });
    });

    return { data: { success: true, event_id: eventId, ticket_id: p_ticket_id }, error: null };
}

function makeApp(tables, { throwingServiceRole = false, rpcOverride = null } = {}) {
    const fakeDb = createFakeSupabaseClient(tables);
    fakeDb.rpc = async (name, params) => {
        if (name === 'fn_claim_bus_trip_notification_batch') return { data: null, error: new Error('not supported in test fake') };
        if (rpcOverride) return rpcOverride(name, params);
        if (name === 'fn_atomic_bus_trip_update') return simulateAtomicBusTripUpdate(tables, params);
        throw new Error(`Unmocked RPC in phase_p2_6 test: ${name}`);
    };

    installFakeDbModule(fakeDb);
    if (throwingServiceRole) installThrowingServiceRoleModule();
    else installFakeServiceRoleModule(fakeDb);

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

describe('Phase P.2.6 — Fleet bus assignment: missing-import ReferenceError fix', () => {
    let server, baseUrl, tables;

    function startServer(opts) {
        tables = freshTables();
        const app = makeApp(tables, opts);
        return new Promise((resolve) => {
            server = http.createServer(app);
            server.listen(0, '127.0.0.1', () => {
                baseUrl = `http://127.0.0.1:${server.address().port}`;
                resolve();
            });
        });
    }

    function stopServer() { return new Promise((resolve) => server.close(resolve)); }
    const authHeaders = () => ({ Authorization: `Bearer ${generateToken(OPERATOR_ID, OPERATOR_ID)}` });

    it('0. STATIC PROOF: checkBusScheduleConflict is exported by busHelper.js, called by busAdmin.js, and now imported', () => {
        const helperSrc = fs.readFileSync(path.resolve(__dirname, '../utils/busHelper.js'), 'utf8');
        const adminSrc = fs.readFileSync(path.resolve(__dirname, '../routes/busAdmin.js'), 'utf8');
        assert.match(helperSrc, /module\.exports\s*=\s*\{[\s\S]*checkBusScheduleConflict[\s\S]*\}/, 'busHelper.js must export checkBusScheduleConflict');
        assert.ok(adminSrc.includes('await checkBusScheduleConflict('), 'busAdmin.js must call checkBusScheduleConflict');
        const importBlock = adminSrc.match(/const\s*\{[\s\S]*?\}\s*=\s*require\('\.\.\/utils\/busHelper'\);/);
        assert.ok(importBlock, 'busAdmin.js must destructure from ../utils/busHelper');
        assert.ok(importBlock[0].includes('checkBusScheduleConflict'), 'checkBusScheduleConflict must now be part of that destructure');
    });

    it('1. NULL -> compatible 78-seat Fleet bus, no conflict: succeeds, bus_id persisted, no ReferenceError', async () => {
        await startServer();
        try {
            const res = await makeRequest(baseUrl, 'PUT', '/api/bus-admin/tickets/75', authHeaders(), { bus_id: 10 });
            assert.equal(res.status, 200, JSON.stringify(res.body));
            const ticket = tables.bus_tickets.find(t => t.id === 75);
            assert.equal(ticket.bus_id, 10);
            assert.equal(ticket.total_seats, 78);
            assert.equal(ticket.floor1_seats, 22);
            assert.equal(ticket.floor2_seats, 56);
            // Existing bookings/seats/prices untouched by a bus assignment alone.
            for (const b of tables.bus_ticket_bookings) {
                assert.equal(b.total_price, 840, `booking ${b.id} price must be untouched`);
            }
            assert.deepEqual(tables.bus_ticket_bookings.map(b => b.seat_numbers).flat().sort((a, z) => a - z), [1, 2, 3, 4, 30]);
        } finally {
            await stopServer();
        }
    });

    it('2. Real schedule conflict on the target bus: controlled 409 BUS_SCHEDULE_CONFLICT, no RPC, no mutation', async () => {
        await startServer();
        try {
            // Bus 14 already has ticket 76 on the same day, 19:00-23:00; trip 75's
            // proposed window (23rd 18:00 -> 24th 10:00, its real overnight
            // arrival) genuinely overlaps — real interval-overlap detection, not
            // a stub.
            const res = await makeRequest(baseUrl, 'PUT', '/api/bus-admin/tickets/75', authHeaders(), { bus_id: 14 });
            assert.equal(res.status, 409, JSON.stringify(res.body));
            assert.equal(res.body.error, 'BUS_SCHEDULE_CONFLICT');
            assert.ok(Array.isArray(res.body.conflicts) && res.body.conflicts.length === 1);
            assert.equal(res.body.conflicts[0].ticket_id, 76);
            assert.equal(tables.bus_tickets.find(t => t.id === 75).bus_id, null, 'no mutation on a rejected replacement');
            assert.equal(tables.bus_ticket_change_events.length, 0, 'no audit event without a successful RPC');
        } finally {
            await stopServer();
        }
    });

    it('3. Incompatible seat capacity (booked seat 30 does not fit a 20-seat bus): controlled BUS_SEAT_REMAP_REQUIRED, no mutation before remap', async () => {
        await startServer();
        try {
            const res = await makeRequest(baseUrl, 'PUT', '/api/bus-admin/tickets/75', authHeaders(), { bus_id: 13 });
            assert.equal(res.status, 409, JSON.stringify(res.body));
            assert.equal(res.body.error, 'BUS_SEAT_REMAP_REQUIRED');
            assert.equal(res.body.newBus.id, 13);
            assert.equal(res.body.affectedBookings.length, 5);
            assert.equal(tables.bus_tickets.find(t => t.id === 75).bus_id, null, 'no mutation before an explicit remap is supplied');
        } finally {
            await stopServer();
        }
    });

    it('4. Bus belonging to another carrier: BUS_NOT_FOUND (tenant isolation preserved), no mutation', async () => {
        await startServer();
        try {
            const res = await makeRequest(baseUrl, 'PUT', '/api/bus-admin/tickets/75', authHeaders(), { bus_id: 11 });
            assert.equal(res.status, 403, JSON.stringify(res.body));
            assert.equal(res.body.error, 'BUS_NOT_FOUND');
            assert.equal(tables.bus_tickets.find(t => t.id === 75).bus_id, null);
        } finally {
            await stopServer();
        }
    });

    it('5. Inactive bus: BUS_NOT_AVAILABLE, no mutation', async () => {
        await startServer();
        try {
            const res = await makeRequest(baseUrl, 'PUT', '/api/bus-admin/tickets/75', authHeaders(), { bus_id: 12 });
            assert.equal(res.status, 409, JSON.stringify(res.body));
            assert.equal(res.body.error, 'BUS_NOT_AVAILABLE');
            assert.equal(tables.bus_tickets.find(t => t.id === 75).bus_id, null);
        } finally {
            await stopServer();
        }
    });

    it('6. Price + bus assignment together (NULL -> bus 10, 840 -> 700): trip updates, but all 5 existing booking prices remain 840', async () => {
        await startServer();
        try {
            const res = await makeRequest(baseUrl, 'PUT', '/api/bus-admin/tickets/75', authHeaders(), { bus_id: 10, price: 700 });
            assert.equal(res.status, 200, JSON.stringify(res.body));
            const ticket = tables.bus_tickets.find(t => t.id === 75);
            assert.equal(ticket.bus_id, 10);
            assert.equal(ticket.price, 700);
            for (const b of tables.bus_ticket_bookings) {
                assert.equal(b.total_price, 840, `booking ${b.id} must keep its original snapshot price — no historical repricing`);
            }
        } finally {
            await stopServer();
        }
    });

    it('7. Price-only path (bus untouched, still NULL): 840 -> 700 succeeds, notification suppressed, booking prices immutable (P.2 behavior unaffected)', async () => {
        await startServer();
        try {
            const res = await makeRequest(baseUrl, 'PUT', '/api/bus-admin/tickets/75', authHeaders(), { price: 700 });
            assert.equal(res.status, 200, JSON.stringify(res.body));
            assert.equal(res.body.notificationsQueued, 0);
            assert.equal(tables.bus_ticket_notification_outbox.length, 0);
            assert.equal(tables.bus_tickets.find(t => t.id === 75).price, 700);
            for (const b of tables.bus_ticket_bookings) assert.equal(b.total_price, 840);
        } finally {
            await stopServer();
        }
    });

    it('8a. P.2.5 preserved: service-role client throw -> controlled 503, no mutation, never a 500', async () => {
        await startServer({ throwingServiceRole: true });
        try {
            const res = await makeRequest(baseUrl, 'PUT', '/api/bus-admin/tickets/75', authHeaders(), { price: 700 });
            assert.equal(res.status, 503, JSON.stringify(res.body));
            assert.equal(res.body.error, 'Сервис временно недоступен. Повторите попытку позже.');
            assert.equal(tables.bus_tickets.find(t => t.id === 75).price, 840);
        } finally {
            await stopServer();
        }
    });

    it('8b. P.2.5 preserved: an unrelated unexpected exception still returns SERVER_ERROR + correlation_id, sanitized log, no secrets', async () => {
        const originalConsoleError = console.error;
        const captured = [];
        console.error = (...args) => { captured.push(args); };
        await startServer({
            rpcOverride: (name) => {
                if (name === 'fn_atomic_bus_trip_update') throw new Error('Bearer TESTOPAQUESECRETabcdefghijklmnopqrstuvwxyz0123456789 simulated leak, unrelated to the fleet fix');
                return { data: null, error: new Error('unmocked') };
            }
        });
        try {
            const res = await makeRequest(baseUrl, 'PUT', '/api/bus-admin/tickets/75', authHeaders(), { price: 700 });

            assert.equal(res.status, 500);
            assert.equal(res.body.error, 'SERVER_ERROR');
            assert.ok(res.body.correlation_id);
            const logCall = captured.find(args => args[1] && args[1].event === 'bus_trip_update_failed');
            assert.ok(logCall);
            assert.equal(logCall[1].correlation_id, res.body.correlation_id);
            const serialized = JSON.stringify(logCall);
            assert.ok(!serialized.includes('TESTOPAQUESECRETabcdefghijklmnopqrstuvwxyz0123456789'), 'secret-shaped token must be redacted');
            assert.ok(serialized.includes('[REDACTED]'));
        } finally {
            await stopServer();
            console.error = originalConsoleError;
        }
    });
});
