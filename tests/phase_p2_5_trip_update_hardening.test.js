/**
 * tests/phase_p2_5_trip_update_hardening.test.js
 *
 * PHASE P.2.5 — TRIP UPDATE 500 HARDENING + OBSERVABILITY
 *
 * Root cause (P.2.4, read-only diagnostic): PUT /api/bus-admin/tickets/:id
 * resolved its service-role client for the fn_atomic_bus_trip_update RPC
 * with a bare `getServiceRoleClient() || supabase` — but
 * getServiceRoleClient() THROWS (never returns null/undefined) when
 * service-role config is unavailable, so that "fallback" never actually
 * fired; the throw fell straight through to the outer catch as an opaque,
 * unlogged 500 with no way to correlate it to a specific request.
 *
 * This phase (see routes/busAdmin.js):
 *   1. Replaces that unguarded call with the same getRequiredServiceClient()
 *      helper already used at the sibling bus-replacement call site — fails
 *      closed with a controlled 503 "Сервис временно недоступен. Повторите
 *      попытку позже." and mutates nothing.
 *   2. Gives the outer catch a crypto.randomUUID() correlation_id, sanitized
 *      structured logging (never the request body, passenger data, or any
 *      secret), and returns that id to the client in the 500 body so a
 *      carrier can report exactly which failure this was.
 *
 * This suite exercises the REAL routes/busAdmin.js PUT /tickets/:id handler
 * over real HTTP, the same require.cache-injection technique as
 * tests/phase_p2_notification_suppression.test.js — nothing here is a
 * reimplementation of the route's logic.
 *
 * NOTE (historical, resolved in P.2.6) — while building scenario G below, a
 * pre-existing, UNRELATED bug was found: routes/busAdmin.js called
 * checkBusScheduleConflict(...) at its bus-replacement call site but never
 * imported it. Any request that changed bus_id to a real, available,
 * capacity-valid bus reached that line and threw a synchronous
 * ReferenceError, reaching the outer catch as a 500 — this phase (P.2.5)
 * made that failure observable (correlation_id, sanitized log) without
 * fixing it, out of its explicitly authorized scope. P.2.6
 * (tests/phase_p2_6_fleet_bus_assignment_reference_error.test.js) added the
 * missing one-line import; scenario G below was updated accordingly to
 * assert the now-real success path instead of the historical crash.
 */

'use strict';

process.env.JWT_SECRET = 'test-secret-key-p2-5-hardening';
process.env.SUPABASE_URL = 'https://test-local-only.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-local-service-role-key-not-real';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const jwt = require('jsonwebtoken');

const {
    createFakeSupabaseClient,
    installFakeDbModule,
    installFakeServiceRoleModule
} = require('./helpers/fakeSupabaseClient');

const OPERATOR_ID = 701;
const FUTURE_DEPARTURE_DATE = '2027-06-01';
const FUTURE_DEPARTURE_TIME = '10:00:00';

function generateToken(userId, carrierId) {
    return jwt.sign(
        { sub: String(userId), carrierId },
        process.env.JWT_SECRET,
        { algorithm: 'HS256', issuer: 'poputki.online', audience: 'poputki-carrier', expiresIn: '1h' }
    );
}

/** Installs a dbServiceRole.js fake whose getServiceRoleClient() throws synchronously, exactly like the real module does with no SUPABASE_SERVICE_ROLE_KEY. */
function installThrowingServiceRoleModule() {
    const path = require.resolve('../dbServiceRole');
    require.cache[path] = {
        id: path,
        filename: path,
        loaded: true,
        exports: {
            getServiceRoleClient: () => {
                throw new Error('SUPABASE_SERVICE_ROLE_KEY is required for server-side claim operations');
            },
            getServiceRoleDiagnostics: () => ({
                serviceRoleEnvPresent: false,
                serviceRoleClientCached: false,
                moduleInstanceId: 'fake-service-role-throwing',
                processPid: process.pid
            }),
            setServiceRoleClient: () => {}
        }
    };
}

function freshTables() {
    return {
        users: [
            { id: OPERATOR_ID, name: 'Carrier Owner', phone: '+992900000701', role: 'bus_driver', is_blocked: false, service_fee_percent: 10 },
            { id: 801, name: 'Passenger A', phone: '+992900000801', role: 'passenger', is_blocked: false, telegram_id: 900801, language: 'ru' },
            { id: 802, name: 'Passenger B', phone: '+992900000802', role: 'passenger', is_blocked: false, telegram_id: 900802, language: 'ru' }
        ],
        carrier_members: [],
        carrier_buses: [
            { id: 55, carrier_id: OPERATOR_ID, status: 'active', bus_type: 'single', total_seats: 45, floor1_seats: null, floor2_seats: null, photos: [] },
            { id: 56, carrier_id: OPERATOR_ID, status: 'inactive', bus_type: 'single', total_seats: 45, floor1_seats: null, floor2_seats: null, photos: [] }
        ],
        bus_tickets: [
            {
                id: 1, operator_id: OPERATOR_ID, status: 'active',
                from_city: 'Душанбе', to_city: 'Худжанд',
                from_address: 'Автовокзал', to_address: 'Автовокзал 2',
                departure_date: FUTURE_DEPARTURE_DATE, departure_time: FUTURE_DEPARTURE_TIME,
                arrival_date: null, arrival_time: null, duration_minutes: null,
                price: 840, premium_price: null,
                bus_type: 'single', total_seats: 40, floor1_seats: null, floor2_seats: null, bus_id: null,
                reserved_seats: [1, 2], intermediate_stops: [], photos: [],
                group_leader_name: '', group_leader_phone: '', group_leader_whatsapp: ''
            }
        ],
        bus_ticket_bookings: [
            { id: 9101, bus_ticket_id: 1, passenger_id: 801, claimed_by_user_id: null, seat_numbers: [1], status: 'confirmed', total_price: 840, hold_expires_at: null, created_at: '2026-09-01T00:00:00.000Z', passengers_data: [] },
            { id: 9102, bus_ticket_id: 1, passenger_id: 802, claimed_by_user_id: null, seat_numbers: [2], status: 'confirmed', total_price: 840, hold_expires_at: null, created_at: '2026-09-01T00:00:00.000Z', passengers_data: [] }
        ],
        bus_ticket_change_events: [],
        bus_ticket_notification_outbox: [],
        carrier_activity_logs: []
    };
}

/** Mirrors the observable contract of fn_atomic_bus_trip_update (same as phase_p2_notification_suppression.test.js). */
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

function makeApp(tables, { rpcOverride = null, throwingServiceRole = false } = {}) {
    const fakeDb = createFakeSupabaseClient(tables);
    fakeDb.rpc = async (name, params) => {
        if (name === 'fn_claim_bus_trip_notification_batch') return { data: null, error: new Error('not supported in test fake') };
        if (rpcOverride) return rpcOverride(name, params);
        if (name === 'fn_atomic_bus_trip_update') return simulateAtomicBusTripUpdate(tables, params);
        throw new Error(`Unmocked RPC in phase_p2_5 test: ${name}`);
    };

    installFakeDbModule(fakeDb);
    if (throwingServiceRole) {
        installThrowingServiceRoleModule();
    } else {
        installFakeServiceRoleModule(fakeDb);
    }

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

describe('Phase P.2.5 — Trip update 500 hardening + observability', () => {
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

    function stopServer() {
        return new Promise((resolve) => server.close(resolve));
    }

    const authHeaders = (secretToken = 'super-secret-jwt-bearer-should-not-leak') => ({
        Authorization: `Bearer ${generateToken(OPERATOR_ID, OPERATOR_ID)}`,
        'X-Test-Secret-Header': secretToken
    });

    it('A: service-role client throw at the RPC call site -> controlled 503, no mutation, never a 500', async () => {
        await startServer({ throwingServiceRole: true });
        const res = await makeRequest(baseUrl, 'PUT', '/api/bus-admin/tickets/1', authHeaders(), { price: 700 });
        assert.equal(res.status, 503, JSON.stringify(res.body));
        assert.equal(res.body.error, 'Сервис временно недоступен. Повторите попытку позже.');
        assert.equal(res.body.correlation_id, undefined, '503 fail-closed response is not the generic 500 path and carries no correlation_id');
        assert.equal(tables.bus_tickets.find(t => t.id === 1).price, 840, 'price must remain untouched');
        assert.equal(tables.bus_ticket_change_events.length, 0, 'no audit event on a failed-closed request');
        assert.equal(tables.bus_ticket_notification_outbox.length, 0);
        await stopServer();
    });

    it('B: service-role client available -> request proceeds normally past the guard (200)', async () => {
        await startServer();
        const res = await makeRequest(baseUrl, 'PUT', '/api/bus-admin/tickets/1', authHeaders(), { price: 700 });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(tables.bus_tickets.find(t => t.id === 1).price, 700);
        await stopServer();
    });

    it('C: unexpected exception during RPC execution -> 500 SERVER_ERROR with a correlation_id (never the opaque old shape)', async () => {
        await startServer({
            rpcOverride: (name) => {
                if (name === 'fn_atomic_bus_trip_update') throw new Error('simulated unexpected driver-level exception, unrelated to service-role resolution');
                return { data: null, error: new Error('unmocked') };
            }
        });
        const res = await makeRequest(baseUrl, 'PUT', '/api/bus-admin/tickets/1', authHeaders(), { price: 700 });
        assert.equal(res.status, 500, JSON.stringify(res.body));
        assert.equal(res.body.error, 'SERVER_ERROR');
        assert.equal(res.body.message, 'Внутренняя ошибка сервера');
        assert.ok(res.body.correlation_id, 'a correlation_id must be present on the generic 500 path');
        assert.match(res.body.correlation_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
        assert.equal(tables.bus_tickets.find(t => t.id === 1).price, 840, 'no partial mutation on an unexpected exception');
        await stopServer();
    });

    it('D: the sanitized structured log for an unexpected exception carries the same correlation_id returned to the client', async () => {
        const originalConsoleError = console.error;
        const captured = [];
        console.error = (...args) => { captured.push(args); };
        try {
            await startServer({
                rpcOverride: (name) => {
                    if (name === 'fn_atomic_bus_trip_update') throw new Error('simulated unexpected exception for log correlation check');
                    return { data: null, error: new Error('unmocked') };
                }
            });
            const res = await makeRequest(baseUrl, 'PUT', '/api/bus-admin/tickets/1', authHeaders(), { price: 700 });
            await stopServer();

            const logCall = captured.find(args => args[1] && args[1].event === 'bus_trip_update_failed');
            assert.ok(logCall, 'a structured bus_trip_update_failed log entry must be written');
            const meta = logCall[1];
            assert.equal(meta.correlation_id, res.body.correlation_id, 'logged correlation_id must match the one returned to the client');
            assert.equal(meta.route, 'PUT /api/bus-admin/tickets/:id');
            assert.equal(meta.method, 'PUT');
            assert.equal(String(meta.trip_id), '1');
            assert.equal(meta.carrier_id, OPERATOR_ID);
            assert.equal(meta.error_name, 'Error');
            assert.ok(meta.error_message.includes('simulated unexpected exception'));
        } finally {
            console.error = originalConsoleError;
        }
    });

    it('E: the sanitized log never contains the request body, Authorization header, phone numbers, or secret-shaped tokens', async () => {
        const originalConsoleError = console.error;
        const captured = [];
        console.error = (...args) => { captured.push(args); };
        try {
            await startServer({
                rpcOverride: (name) => {
                    if (name === 'fn_atomic_bus_trip_update') throw new Error('Bearer TESTOPAQUESECRETabcdefghijklmnopqrstuvwxyz0123456789 leaked into error message by a lower-level client');
                    return { data: null, error: new Error('unmocked') };
                }
            });
            await makeRequest(baseUrl, 'PUT', '/api/bus-admin/tickets/1', authHeaders('sensitive-carrier-secret-should-never-appear-in-logs'), {
                price: 700,
                group_leader_phone: '+992900000999',
                passenger_comments: 'private note that must never be logged'
            });
            await stopServer();

            const logCall = captured.find(args => args[1] && args[1].event === 'bus_trip_update_failed');
            assert.ok(logCall);
            const serializedLog = JSON.stringify(logCall);

            assert.ok(!serializedLog.includes('sensitive-carrier-secret-should-never-appear-in-logs'), 'Authorization/secret header value must never be logged');
            assert.ok(!serializedLog.includes('+992900000999'), 'passenger/group-leader phone number must never be logged');
            assert.ok(!serializedLog.includes('private note that must never be logged'), 'request body content must never be logged');
            assert.ok(!serializedLog.includes('TESTOPAQUESECRETabcdefghijklmnopqrstuvwxyz0123456789'), 'opaque secret-shaped token must be redacted by sanitizeErrorMessage');
            assert.ok(serializedLog.includes('[REDACTED]'), 'the redaction marker must actually appear, proving sanitization ran (not just absence by coincidence)');
        } finally {
            console.error = originalConsoleError;
        }
    });

    it('F: controlled 4xx/409 Fleet responses that ARE reachable before the pre-existing checkBusScheduleConflict reference error are unchanged', async () => {
        await startServer();
        // BUS_UNASSIGN_FORBIDDEN: oldTicket.bus_id is null here, so this specific
        // 400 does not apply; assert the still-reachable BUS_NOT_AVAILABLE guard
        // instead (fires before the broken checkBusScheduleConflict call).
        const res = await makeRequest(baseUrl, 'PUT', '/api/bus-admin/tickets/1', authHeaders(), { bus_id: 56 });
        assert.equal(res.status, 409, JSON.stringify(res.body));
        assert.equal(res.body.error, 'BUS_NOT_AVAILABLE');
        assert.equal(tables.bus_tickets.find(t => t.id === 1).bus_id, null, 'no mutation on a rejected bus replacement');
        await stopServer();
    });

    // UPDATE (P.2.6): at the time this P.2.5 suite was first written, this
    // exact scenario hit a SEPARATE, pre-existing, unrelated bug —
    // checkBusScheduleConflict was called by routes/busAdmin.js's
    // bus-replacement path but never imported, so it threw a
    // ReferenceError. P.2.5 made that failure observable (correlation_id,
    // sanitized log) without fixing it, and flagged it in its final report
    // as a candidate follow-up. P.2.6 (tests/phase_p2_6_fleet_bus_assignment_
    // reference_error.test.js) added the missing import — the one-line fix
    // — so this path is now reachable to a real 200 as intended. Kept here,
    // updated rather than deleted, so this suite continues to prove the
    // NULL -> valid-bus path stays healthy after the P.2.6 fix lands.
    it('G: NULL -> valid, available, capacity-valid fleet bus with active bookings now succeeds (the pre-existing checkBusScheduleConflict reference error was fixed in P.2.6)', async () => {
        await startServer();
        try {
            const res = await makeRequest(baseUrl, 'PUT', '/api/bus-admin/tickets/1', authHeaders(), { bus_id: 55 });
            assert.equal(res.status, 200, JSON.stringify(res.body));
            assert.equal(tables.bus_tickets.find(t => t.id === 1).bus_id, 55);
        } finally {
            await stopServer();
        }
    });

    it('H: price-only update behavior is unchanged by this phase (200, no notification queued)', async () => {
        await startServer();
        const res = await makeRequest(baseUrl, 'PUT', '/api/bus-admin/tickets/1', authHeaders(), { price: 700 });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(res.body.notificationsQueued, 0);
        assert.equal(tables.bus_tickets.find(t => t.id === 1).price, 700);
        await stopServer();
    });

    it('I: price-only update with active bookings present is still supported (not blocked by anything in this phase)', async () => {
        await startServer();
        assert.equal(tables.bus_ticket_bookings.filter(b => b.bus_ticket_id === 1 && b.status === 'confirmed').length, 2);
        const res = await makeRequest(baseUrl, 'PUT', '/api/bus-admin/tickets/1', authHeaders(), { price: 650, premium_price: 900 });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(tables.bus_tickets.find(t => t.id === 1).price, 650);
        assert.equal(tables.bus_tickets.find(t => t.id === 1).premium_price, 900);
        await stopServer();
    });

    it('J: existing booking prices remain immutable after a price-only update', async () => {
        await startServer();
        await makeRequest(baseUrl, 'PUT', '/api/bus-admin/tickets/1', authHeaders(), { price: 700 });
        assert.equal(tables.bus_ticket_bookings.find(b => b.id === 9101).total_price, 840);
        assert.equal(tables.bus_ticket_bookings.find(b => b.id === 9102).total_price, 840);
        await stopServer();
    });

    it('K: price-only edits still suppress the passenger trip-change notification', async () => {
        await startServer();
        const res = await makeRequest(baseUrl, 'PUT', '/api/bus-admin/tickets/1', authHeaders(), { price: 700 });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(res.body.notificationsQueued, 0);
        assert.equal(tables.bus_ticket_notification_outbox.length, 0);
        await stopServer();
    });

    it('L: price + schedule together still queues the full passenger notification, price fields included in the diff', async () => {
        await startServer();
        const res = await makeRequest(baseUrl, 'PUT', '/api/bus-admin/tickets/1', authHeaders(), { price: 700, departure_time: '15:00:00' });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(res.body.notificationsQueued, 2, 'both confirmed passengers have a telegram_id -> both queued');
        assert.equal(tables.bus_ticket_notification_outbox.length, 2);
        const outboxRow = tables.bus_ticket_notification_outbox[0];
        assert.equal(outboxRow.payload.changes.newValues.price, 700);
        await stopServer();
    });
});
