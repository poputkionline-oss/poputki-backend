/**
 * tests/phase_e47_1_qr_boarding_trip_completion.test.js
 *
 * PHASE E.47.1 — QR Boarding Scanner
 *
 * Covers the scanner test matrix from the phase spec:
 *  A (valid scan) B (duplicate) C (wrong trip) D (cross-carrier)
 *  E (tampered QR) F (pending_payment) G (non-confirmed) H (completed trip)
 *  no_show -> boarded before completion, driver assignment gating.
 *
 * The canonical trip-completion service (manual + auto-complete sweep,
 * now backed by the fn_complete_bus_trip(...) atomic RPC) has its own
 * dedicated suite: tests/phase_e47_2_atomic_trip_completion.test.js.
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
            { id: 701, operator_id: 301, status: 'active', from_city: 'Душанбе', to_city: 'Худжанд' },
            { id: 702, operator_id: 301, status: 'active', from_city: 'Душанбе', to_city: 'Пенджикент' },
            { id: 703, operator_id: 301, status: 'completed', from_city: 'Худжанд', to_city: 'Душанбе' },
            { id: 801, operator_id: 401, status: 'active', from_city: 'Москва', to_city: 'Душанбе' }
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
            { id: 9009, bus_ticket_id: 701, status: 'confirmed', boarding_status: 'pending_boarding', boarded_at: null, boarded_by_user_id: null, passenger_name: 'Подделка', seat_numbers: [12] }
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

test('PHASE E.47.1 — QR BOARDING SCANNER', async (t) => {
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

});
