/**
 * tests/phase_e47_1_qr_boarding_trip_completion.test.js
 *
 * PHASE E.47.1 — QR Boarding Scanner + Canonical Trip Completion Service
 *
 * Covers the test matrix from the phase spec:
 *  Scanner: A (valid scan) B (duplicate) C (wrong trip) D (cross-carrier)
 *           E (tampered QR) F (pending_payment) G (non-confirmed) H (completed trip)
 *           no_show -> boarded before completion, driver assignment gating
 *  Completion: canonical completeTrip() atomicity-by-convergence, idempotency,
 *              pending->no_show, boarded preserved, cancelled/pending_payment untouched,
 *              manual HTTP endpoint role/ownership gates, auto-complete eligibility
 *              (arrival + 12h, Asia/Dushanbe timezone semantics), sweep endpoint.
 */

process.env.JWT_SECRET = 'test-jwt-secret-poputki-secure-key-12345';
process.env.ADMIN_SECRET_TOKEN = 'test-admin-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const http = require('node:http');

const { generateTicketVerificationToken } = require('../utils/ticketHelper');

// ---------------------------------------------------------------------------
// Generic in-memory Supabase-like mock query builder
// ---------------------------------------------------------------------------
function matchRow(row, filters) {
    return filters.every(f => {
        if (f.type === 'eq') return String(row[f.field]) === String(f.value);
        if (f.type === 'neq') return String(row[f.field]) !== String(f.value);
        if (f.type === 'in') return (f.value || []).some(v => String(v) === String(row[f.field]));
        if (f.type === 'or') {
            return f.value.some(cond => {
                if (cond.op === 'eq') return String(row[cond.field]) === String(cond.value);
                if (cond.op === 'is' && cond.value === 'null') return row[cond.field] === null || row[cond.field] === undefined;
                return false;
            });
        }
        return true;
    });
}

function makeMockSupabase(mockDb) {
    return {
        from(table) {
            let mode = null;
            let payload = null;
            const filters = [];

            function execute() {
                mockDb[table] = mockDb[table] || [];
                if (mode === 'update') {
                    const matched = mockDb[table].filter(r => matchRow(r, filters));
                    matched.forEach(r => Object.assign(r, payload));
                    return matched.map(r => JSON.parse(JSON.stringify(r)));
                }
                if (mode === 'insert') {
                    const rows = (payload || []).map(r => {
                        const row = { id: r.id || Math.floor(Math.random() * 1e9), ...r };
                        mockDb[table].push(row);
                        return row;
                    });
                    return rows;
                }
                // default: select
                return mockDb[table].filter(r => matchRow(r, filters)).map(r => JSON.parse(JSON.stringify(r)));
            }

            const builder = {
                select() {
                    if (!mode) mode = 'select';
                    return builder;
                },
                update(fields) {
                    mode = 'update';
                    payload = fields;
                    return builder;
                },
                insert(rows) {
                    mode = 'insert';
                    payload = rows;
                    return builder;
                },
                eq(field, value) { filters.push({ type: 'eq', field, value }); return builder; },
                neq(field, value) { filters.push({ type: 'neq', field, value }); return builder; },
                in(field, arr) { filters.push({ type: 'in', field, value: arr }); return builder; },
                or(str) {
                    const conds = String(str).split(',').map(part => {
                        const [field, op, value] = part.split('.');
                        return { field, op, value };
                    });
                    filters.push({ type: 'or', value: conds });
                    return builder;
                },
                order() { return builder; },
                limit() { return builder; },
                async maybeSingle() {
                    const rows = execute();
                    return { data: rows[0] ? rows[0] : null, error: null };
                },
                async single() {
                    const rows = execute();
                    if (rows.length !== 1) return { data: null, error: new Error('Row not found or not unique') };
                    return { data: rows[0], error: null };
                },
                then(resolve, reject) {
                    try {
                        const data = execute();
                        resolve({ data, error: null });
                    } catch (e) {
                        if (reject) reject(e); else resolve({ data: null, error: e });
                    }
                }
            };
            return builder;
        }
    };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
// Formats a target instant into { date, time } as seen in Asia/Dushanbe,
// used to build unambiguous "recent arrival" fixtures regardless of day
// rollover at the moment the test suite happens to run.
function formatInBusinessTz(instant) {
    const dtf = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Dushanbe', hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
    const parts = dtf.formatToParts(instant);
    const get = (type) => parts.find(p => p.type === type).value;
    return {
        date: `${get('year')}-${get('month')}-${get('day')}`,
        time: `${get('hour')}:${get('minute')}:${get('second')}`
    };
}

function nearFutureArrival() {
    const f = formatInBusinessTz(new Date(Date.now() + 3600 * 1000));
    return { arrival_date: f.date, arrival_time: f.time };
}

function freshMockDb() {
    return {
        users: [
            { id: 301, name: 'Carrier A Owner', phone: '+992900000301', role: 'bus_driver', is_blocked: false },
            { id: 302, name: 'Carrier A Dispatcher', phone: '+992900000302', role: 'dispatcher', is_blocked: false },
            { id: 303, name: 'Carrier A Assigned Driver', phone: '+992900000303', role: 'driver', is_blocked: false },
            { id: 304, name: 'Carrier A Accountant', phone: '+992900000304', role: 'accountant', is_blocked: false },
            { id: 401, name: 'Carrier B Owner', phone: '+992900000401', role: 'bus_driver', is_blocked: false }
        ],
        carrier_members: [
            { carrier_id: 301, user_id: 302, role: 'dispatcher', assigned_ticket_ids: [], is_active: true },
            { carrier_id: 301, user_id: 303, role: 'driver', assigned_ticket_ids: [701], is_active: true },
            { carrier_id: 301, user_id: 304, role: 'accountant', assigned_ticket_ids: [], is_active: true }
        ],
        bus_tickets: [
            // Scanner/completion fixtures deliberately use a NEAR-FUTURE arrival
            // (computed relative to wall-clock "now") so they are never
            // accidentally swept up by the arrival+12h auto-complete window,
            // regardless of what date the test suite happens to run on.
            { id: 701, operator_id: 301, status: 'active', from_city: 'Душанбе', to_city: 'Худжанд', ...nearFutureArrival() },
            { id: 702, operator_id: 301, status: 'active', from_city: 'Душанбе', to_city: 'Пенджикент', ...nearFutureArrival() },
            { id: 703, operator_id: 301, status: 'completed', from_city: 'Худжанд', to_city: 'Душанбе', arrival_date: '2020-01-01', arrival_time: '13:00:00' },
            { id: 801, operator_id: 401, status: 'active', from_city: 'Москва', to_city: 'Душанбе', ...nearFutureArrival() },
            // Completion-service fixture trip
            { id: 720, operator_id: 301, status: 'active', from_city: 'Душанбе', to_city: 'Канибадам', ...nearFutureArrival() },
            // Auto-complete sweep fixtures
            { id: 710, operator_id: 301, status: 'active', from_city: 'A', to_city: 'B', arrival_date: '2020-01-01', arrival_time: '00:00:00' }, // long past -> eligible
            { id: 711, operator_id: 301, status: 'active', from_city: 'A', to_city: 'B', ...(() => { const f = formatInBusinessTz(new Date(Date.now() - 3600 * 1000)); return { arrival_date: f.date, arrival_time: f.time }; })() }, // arrived 1h ago -> not yet 12h
            { id: 712, operator_id: 301, status: 'active', from_city: 'A', to_city: 'B', arrival_date: null, arrival_time: null } // missing arrival -> never auto-completes
        ],
        bus_ticket_bookings: [
            { id: 9001, bus_ticket_id: 701, status: 'confirmed', boarding_status: 'pending_boarding', boarded_at: null, boarded_by_user_id: null, passenger_name: 'Иванов Иван', seat_numbers: [5] },
            { id: 9002, bus_ticket_id: 701, status: 'confirmed', boarding_status: 'pending_boarding', boarded_at: null, boarded_by_user_id: null, passenger_name: 'Петров Петр', seat_numbers: [6] },
            { id: 9003, bus_ticket_id: 801, status: 'confirmed', boarding_status: 'pending_boarding', boarded_at: null, boarded_by_user_id: null, passenger_name: 'Чужой Пассажир', seat_numbers: [1] },
            { id: 9004, bus_ticket_id: 701, status: 'confirmed', boarding_status: 'pending_boarding', boarded_at: null, boarded_by_user_id: null, passenger_name: 'Сидоров Сидор', seat_numbers: [7] },
            { id: 9005, bus_ticket_id: 701, status: 'pending_payment', boarding_status: 'pending_boarding', boarded_at: null, boarded_by_user_id: null, passenger_name: 'Не Оплатил', seat_numbers: [8] },
            { id: 9006, bus_ticket_id: 701, status: 'cancelled', boarding_status: 'pending_boarding', boarded_at: null, boarded_by_user_id: null, passenger_name: 'Отменил', seat_numbers: [9] },
            { id: 9007, bus_ticket_id: 703, status: 'confirmed', boarding_status: 'pending_boarding', boarded_at: null, boarded_by_user_id: null, passenger_name: 'Поздний', seat_numbers: [10] },
            { id: 9008, bus_ticket_id: 701, status: 'confirmed', boarding_status: 'no_show', boarded_at: null, boarded_by_user_id: null, passenger_name: 'Вернулся', seat_numbers: [11] },
            { id: 9009, bus_ticket_id: 701, status: 'confirmed', boarding_status: 'pending_boarding', boarded_at: null, boarded_by_user_id: null, passenger_name: 'Подделка', seat_numbers: [12] },
            // Completion-service fixtures (trip 720)
            { id: 9101, bus_ticket_id: 720, status: 'confirmed', boarding_status: 'pending_boarding', boarded_at: null, boarded_by_user_id: null, passenger_name: 'Ожидает', seat_numbers: [1] },
            { id: 9102, bus_ticket_id: 720, status: 'confirmed', boarding_status: 'boarded', boarded_at: '2026-01-01T00:00:00.000Z', boarded_by_user_id: 301, passenger_name: 'Посажен', seat_numbers: [2] },
            { id: 9103, bus_ticket_id: 720, status: 'confirmed', boarding_status: 'no_show', boarded_at: null, boarded_by_user_id: null, passenger_name: 'УжеНеЯвился', seat_numbers: [3] },
            { id: 9104, bus_ticket_id: 720, status: 'cancelled', boarding_status: 'pending_boarding', boarded_at: null, boarded_by_user_id: null, passenger_name: 'Отменена', seat_numbers: [4] },
            { id: 9105, bus_ticket_id: 720, status: 'pending_payment', boarding_status: 'pending_boarding', boarded_at: null, boarded_by_user_id: null, passenger_name: 'Ждет оплаты', seat_numbers: [5] }
        ],
        booking_audit_logs: [],
        carrier_activity_logs: []
    };
}

function generateToken(userId, carrierId, role) {
    return jwt.sign(
        { sub: String(userId), carrierId, role },
        process.env.JWT_SECRET,
        { algorithm: 'HS256', issuer: 'poputki.online', audience: 'poputki-carrier', expiresIn: '1h' }
    );
}

function makeApp(mockDb) {
    const dbPath = require.resolve('../db');
    require.cache[dbPath] = {
        id: dbPath, filename: dbPath, loaded: true, exports: makeMockSupabase(mockDb)
    };
    // Force route modules to re-evaluate against the fresh mocked db for this test run
    delete require.cache[require.resolve('../routes/busAdmin')];
    delete require.cache[require.resolve('../routes/admin')];

    const express = require('express');
    const busAdminRouter = require('../routes/busAdmin');
    const adminRouter = require('../routes/admin');
    const app = express();
    app.use(express.json());
    app.use('/api/bus-admin', busAdminRouter);
    app.use('/api/admin', adminRouter);
    return app;
}

function makeRequest(baseUrl, method, path, headers = {}, body = null) {
    return new Promise((resolve, reject) => {
        const url = new URL(path, baseUrl);
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

test('PHASE E.47.1 — QR BOARDING SCANNER + CANONICAL TRIP COMPLETION', async (t) => {
    let mockDb = freshMockDb();
    let app = makeApp(mockDb);
    let server, baseUrl;

    const startServer = () => new Promise((resolve) => {
        server = app.listen(0, () => {
            baseUrl = `http://127.0.0.1:${server.address().port}`;
            resolve();
        });
    });
    const stopServer = () => new Promise((resolve) => server.close(resolve));

    await startServer();

    const ownerToken = generateToken(301, 301, 'owner');
    const dispatcherToken = generateToken(302, 301, 'dispatcher');
    const assignedDriverToken = generateToken(303, 301, 'driver'); // assigned to trip 701 only
    const accountantToken = generateToken(304, 301, 'accountant');
    const otherCarrierToken = generateToken(401, 401, 'owner');

    const scan = (token, ticketToken, tripId) => makeRequest(baseUrl, 'POST', '/api/bus-admin/bookings/scan-boarding', {
        Authorization: `Bearer ${token}`
    }, { ticketToken, tripId });

    // === A. Valid same-trip QR scan -> boarded ===
    await t.test('A. Valid same-trip QR scan boards the passenger', async () => {
        const token = generateTicketVerificationToken(9001);
        const res = await scan(ownerToken, token, 701);
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.success, true);
        assert.strictEqual(res.body.already_boarded, false);
        assert.strictEqual(res.body.boarding_status, 'boarded');
        assert.ok(res.body.boarded_at);
        assert.strictEqual(res.body.trip_id, 701);
        assert.deepStrictEqual(res.body.passenger.seats, [5]);
        assert.strictEqual(res.body.passenger.displayName, 'Иванов Иван');
        // No PII beyond seat/name
        assert.strictEqual(res.body.passenger.phone, undefined);
        assert.strictEqual(res.body.passenger.docNumber, undefined);

        const row = mockDb.bus_ticket_bookings.find(b => b.id === 9001);
        assert.strictEqual(row.boarding_status, 'boarded');
        assert.strictEqual(row.boarded_by_user_id, 301);
    });

    // === B. Duplicate scan -> already_boarded, no second mutation ===
    await t.test('B. Duplicate scan is idempotent (no second mutation)', async () => {
        const token = generateTicketVerificationToken(9002);
        const first = await scan(ownerToken, token, 701);
        assert.strictEqual(first.status, 200);
        const boardedAtFirst = first.body.boarded_at;

        const logsBefore = mockDb.booking_audit_logs.filter(l => l.booking_id === 9002).length;

        const second = await scan(ownerToken, token, 701);
        assert.strictEqual(second.status, 200);
        assert.strictEqual(second.body.success, true);
        assert.strictEqual(second.body.already_boarded, true);
        assert.strictEqual(second.body.boarded_at, boardedAtFirst);

        const logsAfter = mockDb.booking_audit_logs.filter(l => l.booking_id === 9002).length;
        assert.strictEqual(logsAfter, logsBefore, 'No duplicate mutation/audit entry on repeat scan');
    });

    // === C. Valid QR for another trip of the SAME carrier -> BLOCKED (wrong trip) ===
    await t.test('C. Valid QR for a different trip of the same carrier is BLOCKED as wrong-trip', async () => {
        const token = generateTicketVerificationToken(9004); // belongs to trip 701
        const res = await scan(ownerToken, token, 702); // carrier currently scanning trip 702
        assert.strictEqual(res.status, 409);
        assert.strictEqual(res.body.code, 'WRONG_TRIP');
        assert.strictEqual(res.body.error, 'Билет относится к другому рейсу');

        const row = mockDb.bus_ticket_bookings.find(b => b.id === 9004);
        assert.strictEqual(row.boarding_status, 'pending_boarding', 'Booking must remain untouched');
    });

    // === D. Cross-carrier QR -> BLOCKED, no PII leak ===
    await t.test('D. Ticket belonging to a DIFFERENT carrier is BLOCKED without leaking existence', async () => {
        const token = generateTicketVerificationToken(9003); // belongs to carrier B's trip 801
        const res = await scan(ownerToken, token, 701);
        assert.strictEqual(res.status, 404);
        assert.strictEqual(res.body.code, 'INVALID_TICKET');
        assert.ok(!JSON.stringify(res.body).includes('Чужой Пассажир'), 'Must never leak the other carrier passenger name');

        const row = mockDb.bus_ticket_bookings.find(b => b.id === 9003);
        assert.strictEqual(row.boarding_status, 'pending_boarding');
    });

    // === E. Tampered QR signature -> BLOCKED ===
    await t.test('E. Tampered/forged QR signature is BLOCKED', async () => {
        const valid = generateTicketVerificationToken(9009);
        const [id, sig] = valid.split('-');
        const tamperedChar = sig[0] === 'a' ? 'b' : 'a';
        const tampered = `${id}-${tamperedChar}${sig.slice(1)}`;

        const res = await scan(ownerToken, tampered, 701);
        assert.strictEqual(res.status, 404);
        assert.strictEqual(res.body.code, 'INVALID_TICKET');

        const row = mockDb.bus_ticket_bookings.find(b => b.id === 9009);
        assert.strictEqual(row.boarding_status, 'pending_boarding');
    });

    // === F. pending_payment booking -> BLOCKED ===
    await t.test('F. pending_payment booking is BLOCKED from boarding', async () => {
        const token = generateTicketVerificationToken(9005);
        const res = await scan(ownerToken, token, 701);
        assert.strictEqual(res.status, 400);
        assert.strictEqual(res.body.code, 'PENDING_PAYMENT');
    });

    // === G. cancelled/non-confirmed booking -> BLOCKED ===
    await t.test('G. Cancelled booking is BLOCKED from boarding', async () => {
        const token = generateTicketVerificationToken(9006);
        const res = await scan(ownerToken, token, 701);
        assert.strictEqual(res.status, 400);
        assert.strictEqual(res.body.code, 'BOOKING_INVALID');
    });

    // === H. Completed trip -> scanning BLOCKED ===
    await t.test('H. Scanning on a completed trip is BLOCKED', async () => {
        const token = generateTicketVerificationToken(9007);
        const res = await scan(ownerToken, token, 703);
        assert.strictEqual(res.status, 400);
        assert.strictEqual(res.body.code, 'TRIP_COMPLETED');
    });

    // === no_show -> boarded before completion is ALLOWED ===
    await t.test('no_show passenger can still be boarded via QR before trip completion', async () => {
        const token = generateTicketVerificationToken(9008);
        const res = await scan(ownerToken, token, 701);
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.success, true);
        assert.strictEqual(res.body.boarding_status, 'boarded');
        const row = mockDb.bus_ticket_bookings.find(b => b.id === 9008);
        assert.strictEqual(row.boarding_status, 'boarded');
    });

    // === Dispatcher and assigned driver can scan; accountant and unassigned driver cannot ===
    await t.test('Dispatcher can scan (owner-equivalent access)', async () => {
        const localDb = freshMockDb();
        app = makeApp(localDb);
        await stopServer();
        await startServer();
        const token = generateTicketVerificationToken(9001);
        const res = await scan(dispatcherToken, token, 701);
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.success, true);
    });

    await t.test('Accountant is FORBIDDEN from scanning', async () => {
        const token = generateTicketVerificationToken(9002);
        const res = await scan(accountantToken, token, 701);
        assert.strictEqual(res.status, 403);
    });

    await t.test('Assigned driver can scan their trip (701); other carrier cannot scan at all', async () => {
        const token = generateTicketVerificationToken(9002);
        const res = await scan(assignedDriverToken, token, 701);
        assert.strictEqual(res.status, 200);

        const otherToken = generateTicketVerificationToken(9004);
        const resOther = await scan(otherCarrierToken, otherToken, 701);
        assert.strictEqual(resOther.status, 404); // other carrier cannot even see it belongs to them
    });

    await t.test('Malformed ticketToken is rejected', async () => {
        const res = await scan(ownerToken, 'not-a-real-token', 701);
        assert.strictEqual(res.status, 404);
        assert.strictEqual(res.body.code, 'INVALID_TICKET');
    });

    await t.test('Missing tripId is rejected with 400', async () => {
        const token = generateTicketVerificationToken(9001);
        const res = await scan(ownerToken, token, undefined);
        assert.strictEqual(res.status, 400);
    });

    await stopServer();

    // =========================================================================
    // CANONICAL COMPLETION SERVICE (unit-level, direct against completeTrip)
    // =========================================================================
    const { completeTrip, isTripEligibleForAutoComplete, getTripArrivalInstant, zonedTimeToUtcDate, sweepAutoCompleteTrips } = require('../utils/tripCompletionHelper');

    await t.test('M/N/P. completeTrip: pending->no_show, boarded preserved, cancelled/pending_payment untouched', async () => {
        const db = freshMockDb();
        const supabase = makeMockSupabase(db);

        const result = await completeTrip(supabase, { tripId: 720, actorContext: { carrier_id: 301, user_id: 301, role: 'owner', name: 'Owner' } });
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.already_completed, false);
        assert.strictEqual(result.no_show_marked, 1); // only 9101 (confirmed + pending_boarding)

        const trip = db.bus_tickets.find(t2 => t2.id === 720);
        assert.strictEqual(trip.status, 'completed');

        const pending = db.bus_ticket_bookings.find(b => b.id === 9101);
        assert.strictEqual(pending.boarding_status, 'no_show', 'confirmed+pending_boarding must become no_show');

        const boarded = db.bus_ticket_bookings.find(b => b.id === 9102);
        assert.strictEqual(boarded.boarding_status, 'boarded', 'boarded must be preserved');
        assert.strictEqual(boarded.boarded_at, '2026-01-01T00:00:00.000Z', 'boarded_at must not churn');

        const alreadyNoShow = db.bus_ticket_bookings.find(b => b.id === 9103);
        assert.strictEqual(alreadyNoShow.boarding_status, 'no_show');

        const cancelled = db.bus_ticket_bookings.find(b => b.id === 9104);
        assert.strictEqual(cancelled.status, 'cancelled', 'cancelled booking must never be touched');
        assert.strictEqual(cancelled.boarding_status, 'pending_boarding');

        const pendingPayment = db.bus_ticket_bookings.find(b => b.id === 9105);
        assert.strictEqual(pendingPayment.status, 'pending_payment', 'pending_payment booking must never be touched');
        assert.strictEqual(pendingPayment.boarding_status, 'pending_boarding');

        // Audit log recorded
        const log = db.carrier_activity_logs.find(l => l.action === 'trip_completed' && String(l.entity_id) === '720');
        assert.ok(log, 'TRIP_COMPLETED audit entry must be recorded');
    });

    await t.test('S. Second completion is idempotent (no double effects)', async () => {
        const db = freshMockDb();
        const supabase = makeMockSupabase(db);
        await completeTrip(supabase, { tripId: 720 });

        const boardedBefore = JSON.stringify(db.bus_ticket_bookings.find(b => b.id === 9102));

        const second = await completeTrip(supabase, { tripId: 720 });
        assert.strictEqual(second.success, true);
        assert.strictEqual(second.already_completed, true);
        assert.strictEqual(second.no_show_marked, 0);

        const boardedAfter = JSON.stringify(db.bus_ticket_bookings.find(b => b.id === 9102));
        assert.strictEqual(boardedAfter, boardedBefore, 'No churn on already-boarded row');

        const trip = db.bus_tickets.find(t2 => t2.id === 720);
        assert.strictEqual(trip.status, 'completed');
    });

    await t.test('completeTrip on a non-existent trip returns TRIP_NOT_FOUND', async () => {
        const db = freshMockDb();
        const supabase = makeMockSupabase(db);
        const result = await completeTrip(supabase, { tripId: 999999 });
        assert.strictEqual(result.success, false);
        assert.strictEqual(result.error, 'TRIP_NOT_FOUND');
    });

    // =========================================================================
    // MANUAL COMPLETION HTTP ENDPOINT
    // =========================================================================
    await t.test('Manual completion HTTP endpoint: role gates, ownership, and full flow', async () => {
        mockDb = freshMockDb();
        app = makeApp(mockDb);
        await startServer();

        // Driver forbidden
        let res = await makeRequest(baseUrl, 'POST', '/api/bus-admin/tickets/720/complete', { Authorization: `Bearer ${assignedDriverToken}` });
        assert.strictEqual(res.status, 403);

        // Accountant forbidden
        res = await makeRequest(baseUrl, 'POST', '/api/bus-admin/tickets/720/complete', { Authorization: `Bearer ${accountantToken}` });
        assert.strictEqual(res.status, 403);

        // Other carrier cannot complete someone else's trip
        res = await makeRequest(baseUrl, 'POST', '/api/bus-admin/tickets/720/complete', { Authorization: `Bearer ${otherCarrierToken}` });
        assert.strictEqual(res.status, 403);

        // Owner completes successfully
        res = await makeRequest(baseUrl, 'POST', '/api/bus-admin/tickets/720/complete', { Authorization: `Bearer ${ownerToken}` });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.success, true);
        assert.strictEqual(res.body.no_show_marked, 1);

        // Idempotent re-completion via HTTP
        res = await makeRequest(baseUrl, 'POST', '/api/bus-admin/tickets/720/complete', { Authorization: `Bearer ${ownerToken}` });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.already_completed, true);

        await stopServer();
    });

    // === Q. Post-completion scanning is blocked (re-verify via HTTP for trip 720) ===
    await t.test('Q/H. QR scanning blocked after trip is completed', async () => {
        mockDb = freshMockDb();
        app = makeApp(mockDb);
        await startServer();

        await makeRequest(baseUrl, 'POST', '/api/bus-admin/tickets/720/complete', { Authorization: `Bearer ${ownerToken}` });

        const token = generateTicketVerificationToken(9101); // was pending_boarding on trip 720, now no_show + trip completed
        const res = await scan(ownerToken, token, 720);
        assert.strictEqual(res.status, 400);
        assert.strictEqual(res.body.code, 'TRIP_COMPLETED');

        await stopServer();
    });

    // =========================================================================
    // AUTO-COMPLETE ELIGIBILITY & TIMEZONE SEMANTICS
    // =========================================================================
    await t.test('Timezone: zonedTimeToUtcDate interprets arrival as Asia/Dushanbe (UTC+5)', () => {
        // 2026-09-01 13:00 in Asia/Dushanbe (UTC+5) == 2026-09-01 08:00 UTC
        const d = zonedTimeToUtcDate('2026-09-01', '13:00', 'Asia/Dushanbe');
        assert.strictEqual(d.toISOString(), '2026-09-01T08:00:00.000Z');
    });

    await t.test('Auto-complete eligibility: arrival + 12h boundary is respected', () => {
        const trip = { status: 'active', arrival_date: '2026-09-01', arrival_time: '13:00:00' };
        const arrival = getTripArrivalInstant(trip); // 2026-09-01T08:00:00Z

        const justBefore = new Date(arrival.getTime() + 12 * 3600 * 1000 - 1000);
        const justAfter = new Date(arrival.getTime() + 12 * 3600 * 1000 + 1000);

        assert.strictEqual(isTripEligibleForAutoComplete(trip, justBefore), false, 'Not yet eligible 1s before the 12h mark');
        assert.strictEqual(isTripEligibleForAutoComplete(trip, justAfter), true, 'Eligible just after the 12h mark');
    });

    await t.test('Auto-complete eligibility: completed, deleted-equivalent (missing) trips excluded', () => {
        assert.strictEqual(isTripEligibleForAutoComplete({ status: 'completed', arrival_date: '2020-01-01', arrival_time: '00:00' }), false);
        assert.strictEqual(isTripEligibleForAutoComplete({ status: 'active', arrival_date: null, arrival_time: null }), false, 'Missing arrival must never fall back to departure');
        assert.strictEqual(isTripEligibleForAutoComplete(null), false);
    });

    // =========================================================================
    // AUTO-COMPLETE SWEEP (unit-level + HTTP endpoint)
    // =========================================================================
    await t.test('R. sweepAutoCompleteTrips completes only eligible trips (arrival+12h elapsed)', async () => {
        const db = freshMockDb();
        const supabase = makeMockSupabase(db);
        const result = await sweepAutoCompleteTrips(supabase, {});

        assert.strictEqual(result.completed, 1);
        const t710 = db.bus_tickets.find(x => x.id === 710);
        const t711 = db.bus_tickets.find(x => x.id === 711);
        const t712 = db.bus_tickets.find(x => x.id === 712);
        assert.strictEqual(t710.status, 'completed', 'Long-past arrival trip must be auto-completed');
        assert.strictEqual(t711.status, 'active', 'Recent arrival (<12h) must remain active');
        assert.strictEqual(t712.status, 'active', 'Missing arrival trip must remain active (manual completion only)');
    });

    await t.test('Sweep is idempotent/safe under repeated invocation (no double effects)', async () => {
        const db = freshMockDb();
        const supabase = makeMockSupabase(db);
        await sweepAutoCompleteTrips(supabase, {});
        const first = JSON.stringify(db.bus_tickets.find(x => x.id === 710));

        const second = await sweepAutoCompleteTrips(supabase, {});
        assert.strictEqual(second.completed, 0, 'Already-completed trip is not re-completed');
        const after = JSON.stringify(db.bus_tickets.find(x => x.id === 710));
        assert.strictEqual(after, first);
    });

    await t.test('T. Finance / commission fields are never touched by boarding or completion', async () => {
        const db = freshMockDb();
        db.bus_ticket_bookings[0].total_price = 700;
        db.bus_ticket_bookings[0].commission_amount = 70;
        db.bus_ticket_bookings[0].carrier_amount = 630;
        const supabase = makeMockSupabase(db);
        await completeTrip(supabase, { tripId: 701 });
        const row = db.bus_ticket_bookings.find(b => b.id === 9001);
        assert.strictEqual(row.total_price, 700);
        assert.strictEqual(row.commission_amount, 70);
        assert.strictEqual(row.carrier_amount, 630);
    });

    await t.test('U. Ticket V1.1 verification token is unaffected by boarding/completion state', async () => {
        const before = generateTicketVerificationToken(9001);
        const db = freshMockDb();
        const supabase = makeMockSupabase(db);
        await completeTrip(supabase, { tripId: 701 });
        const after = generateTicketVerificationToken(9001);
        assert.strictEqual(before, after, 'HMAC token derivation must be independent of booking/trip mutable state');
    });

    // === HTTP-level auto-complete sweep endpoint (admin, mirrors expire-pending) ===
    await t.test('Admin auto-complete sweep endpoint requires admin token and completes eligible trips', async () => {
        mockDb = freshMockDb();
        app = makeApp(mockDb);
        await startServer();

        const unauth = await makeRequest(baseUrl, 'POST', '/api/admin/trips/auto-complete', {});
        assert.strictEqual(unauth.status, 401);

        const res = await makeRequest(baseUrl, 'POST', '/api/admin/trips/auto-complete', { 'X-Admin-Token': 'test-admin-secret' });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.success, true);
        assert.strictEqual(res.body.completed, 1);

        const t710 = mockDb.bus_tickets.find(x => x.id === 710);
        assert.strictEqual(t710.status, 'completed');

        await stopServer();
    });
});
