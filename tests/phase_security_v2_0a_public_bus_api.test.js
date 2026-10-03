/**
 * tests/phase_security_v2_0a_public_bus_api.test.js
 *
 * SECURITY HOTFIX V2.0A — Public bus trip endpoints must not expose passenger,
 * payment, accounting or carrier-private data.
 *
 * These tests load the REAL routes/busTickets.js router and call it over HTTP.
 * Only the database layer is replaced (require-cache injection of ../db and
 * ../dbServiceRole). The fake DB deliberately returns FULL rows (every column,
 * including PII) regardless of the requested column list, so a passing test
 * proves the response is built from an allowlist, not from what the query
 * happened to select. All fixtures are synthetic.
 */

'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');

process.env.JWT_SECRET = 'test-jwt-secret-for-security-v2-0a-public-bus-api-32b';

// ---------------------------------------------------------------------------
// Synthetic fixtures (obvious markers so any leak is detectable by value too)
// ---------------------------------------------------------------------------
const PII = {
    name: 'SYNTH_PASSENGER_NAME_ALPHA',
    phone: '+0009990001111',
    doc: 'SYNTH_DOC_NUMBER_777',
    dob: '1900-01-01-SYNTH',
    citizenship: 'SYNTH_COUNTRY',
    payLink: 'https://pay.synthetic.invalid/SYNTH_PAY_LINK',
    order: 'SYNTH_ORDER_ID_123',
    invoice: 'SYNTH_INVOICE_UUID_456',
    note: 'SYNTH_CARRIER_NOTE_SECRET',
    leaderName: 'SYNTH_LEADER_NAME',
    leaderPhone: '+0009990002222',
    leaderWa: '+0009990003333'
};

function makeTicket(overrides = {}) {
    return {
        id: 501,
        operator_id: 77,
        transport_company: 'Synthetic Bus Co',
        from_city: 'Alpha',
        from_address: 'Alpha Station',
        to_city: 'Omega',
        to_address: 'Omega Station',
        departure_date: '2099-01-01',
        departure_time: '08:00:00',
        arrival_date: '2099-01-01',
        arrival_time: '14:30:00',
        duration_minutes: 390,
        price: 100,
        premium_price: 150,
        total_seats: 10,
        reserved_seats: [1, 2],
        status: 'active',
        bus_type: 'single',
        passenger_comments: 'Public carrier comment',
        intermediate_stops: [{ city: 'Midway', time: '11:00:00' }],
        created_at: '2098-12-01T00:00:00Z',
        floor1_seats: null,
        floor2_seats: null,
        photos: [{ url: 'https://img.synthetic.invalid/1.jpg', public_id: 'p1' }],
        bus_id: 9,
        group_leader_name: PII.leaderName,
        group_leader_phone: PII.leaderPhone,
        group_leader_whatsapp: PII.leaderWa,
        poll_completed_at: '2098-12-02T00:00:00Z',
        secret_future_column: 'SYNTH_FUTURE_COLUMN_VALUE',
        operator: { phone: '+0009990004444', service_fee_percent: 7, id: 77, name: 'SYNTH_OPERATOR_NAME', password_hash: 'SYNTH_HASH' },
        ...overrides
    };
}

function makeBooking(overrides = {}) {
    return {
        id: 9001,
        bus_ticket_id: 501,
        passenger_id: 31,
        seat_numbers: '[3,4]',
        passenger_count: 2,
        passengers_data: [
            { firstName: PII.name, lastName: PII.name, gender: 'female', birthDate: PII.dob, citizenship: PII.citizenship, docType: 'passport', docNumber: PII.doc },
            { firstName: PII.name, lastName: PII.name, gender: 'male', birthDate: PII.dob, citizenship: PII.citizenship, docType: 'passport', docNumber: PII.doc }
        ],
        phone: PII.phone,
        status: 'confirmed',
        total_price: 200,
        created_at: '2098-12-03T00:00:00Z',
        passenger_name: PII.name,
        pickup_city: 'Alpha',
        drop_off_city: 'Omega',
        payment_order_id: PII.order,
        invoice_uuid: PII.invoice,
        payment_link: PII.payLink,
        channel: 'manual',
        commission_rate: 10,
        commission_amount: 20,
        carrier_amount: 180,
        carrier_notes: PII.note,
        hold_expires_at: null,
        ...overrides
    };
}

const FORBIDDEN_KEYS = [
    'bookings', 'passengers_data', 'passenger_name', 'phone', 'passenger_id', 'payment_link',
    'payment_order_id', 'invoice_uuid', 'carrier_notes', 'commission_rate', 'commission_amount',
    'carrier_amount', 'total_price', 'group_leader_name', 'group_leader_phone', 'group_leader_whatsapp',
    'operator', 'seat_numbers', 'firstName', 'lastName', 'birthDate', 'citizenship', 'docType', 'docNumber',
    'password_hash', 'poll_completed_at', 'created_at', 'secret_future_column'
];

function collectKeys(value, acc = new Set()) {
    if (Array.isArray(value)) value.forEach(v => collectKeys(v, acc));
    else if (value && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) { acc.add(k); collectKeys(v, acc); }
    }
    return acc;
}

function assertNoSensitiveData(body, { allowSeatGenders = false } = {}) {
    const keys = collectKeys(body);
    for (const k of FORBIDDEN_KEYS) assert.ok(!keys.has(k), `forbidden key leaked: ${k}`);
    if (!allowSeatGenders) assert.ok(!keys.has('seatGenders'), 'seatGenders leaked to unauthenticated response');
    const text = JSON.stringify(body);
    for (const [name, value] of Object.entries(PII)) {
        assert.ok(!text.includes(value), `synthetic PII value leaked: ${name}`);
    }
    assert.ok(!text.includes('SYNTH_FUTURE_COLUMN_VALUE'), 'unlisted column leaked');
    assert.ok(!text.includes('SYNTH_OPERATOR_NAME'), 'raw operator object leaked');
}

// ---------------------------------------------------------------------------
// Fake DB (chainable + thenable). Returns FULL rows; records select() strings.
// ---------------------------------------------------------------------------
const state = { tickets: [], bookings: [], selects: [], filters: [] };

function fakeFrom(table) {
    const q = { table, filters: [], selectCols: null, ors: [] };
    const api = {
        select(cols) { q.selectCols = cols; state.selects.push({ table, cols }); return api; },
        eq(c, v) { q.filters.push([c, v, 'eq']); state.filters.push({ table, c, v }); return api; },
        in() { return api; },
        or() { return api; },
        order() { return api; },
        ilike() { return api; },
        gte() { return api; },
        single() { q.single = true; return api; },
        maybeSingle() { q.single = true; return api; },
        then(resolve, reject) {
            let rows = table === 'bus_tickets' ? state.tickets : table === 'bus_ticket_bookings' ? state.bookings : [];
            for (const [c, v] of q.filters) rows = rows.filter(r => String(r[c]) === String(v));
            const result = q.single
                ? (rows[0] ? { data: JSON.parse(JSON.stringify(rows[0])), error: null } : { data: null, error: { message: 'not found' } })
                : { data: JSON.parse(JSON.stringify(rows)), error: null };
            return Promise.resolve(result).then(resolve, reject);
        }
    };
    return api;
}

function injectModule(relPath, exportsObj) {
    const resolved = require.resolve(path.join(__dirname, '..', relPath));
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

let server;
let baseUrl;

before(async () => {
    injectModule('db.js', { from: fakeFrom });
    injectModule('dbServiceRole.js', {
        getServiceRoleClient: () => ({
            from: () => {
                const api = {
                    select() { return api; },
                    in() { return api; },
                    eq() { return api; },
                    maybeSingle() { return Promise.resolve({ data: BUS_MASTER, error: null }); },
                    then(res, rej) { return Promise.resolve({ data: [BUS_MASTER], error: null }).then(res, rej); }
                };
                return api;
            }
        }),
        getServiceRoleDiagnostics: () => ({})
    });
    const express = require('express');
    const router = require('../routes/busTickets');
    const app = express();
    app.use(express.json());
    app.use('/api/bus-tickets', router);
    await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
    if (server) await new Promise(r => server.close(r));
});

const BUS_MASTER = {
    id: 9, brand: 'SynthBrand', model: 'SynthModel', license_plate: 'SYNTH-PLATE', year_built: 2020, color: 'blue',
    amenities: ['wifi', 'not_allowed_amenity'],
    vin: 'SYNTH_VIN_SECRET', carrier_id: 77, notes: 'SYNTH_PRIVATE_BUS_NOTE'
};

function reset({ tickets, bookings } = {}) {
    state.tickets = tickets || [makeTicket()];
    state.bookings = bookings || [makeBooking(), makeBooking({ id: 9002, seat_numbers: '[5]', status: 'pending_payment', hold_expires_at: new Date(Date.now() + 10 * 60000).toISOString() })];
    state.selects = [];
    state.filters = [];
}

async function get(pathname, headers = {}) {
    const res = await fetch(baseUrl + pathname, { headers });
    let body = null;
    try { body = await res.json(); } catch (_) { /* empty */ }
    return { status: res.status, body };
}

const { issueUserToken } = require('../utils/userAuth');

// ---------------------------------------------------------------------------
describe('GET /api/bus-tickets/:id — unauthenticated guest', () => {
    it('returns 200 and NO passenger/payment/accounting/carrier-private data', async () => {
        reset();
        const { status, body } = await get('/api/bus-tickets/501');
        assert.equal(status, 200);
        assertNoSensitiveData(body);
    });

    it('returns the fields the existing UI needs (allowlist)', async () => {
        reset();
        const { body } = await get('/api/bus-tickets/501');
        for (const k of ['id', 'transport_company', 'from_city', 'from_address', 'to_city', 'to_address',
            'departure_date', 'departure_time', 'arrival_date', 'arrival_time', 'duration_minutes', 'price',
            'premium_price', 'total_seats', 'bus_type', 'photos', 'passenger_comments', 'intermediate_stops',
            'operator_id', 'operator_phone', 'service_fee_percent', 'bookedSeats', 'availableSeatsCount', 'premiumSeats', 'bus']) {
            assert.ok(k in body, `missing expected field: ${k}`);
        }
        assert.equal(body.departure_time, '08:00');
        assert.equal(body.arrival_time, '14:30');
        assert.equal(body.operator_phone, '+0009990004444'); // intentionally passenger-facing carrier contact
        assert.equal(body.service_fee_percent, 7);
        assert.deepEqual(body.intermediate_stops, [{ city: 'Midway', time: '11:00' }]);
    });

    it('response keys are exactly the allowlist (no unlisted/future columns)', async () => {
        reset();
        const { body } = await get('/api/bus-tickets/501');
        const allowed = new Set(['id', 'transport_company', 'from_city', 'from_address', 'to_city', 'to_address',
            'departure_date', 'departure_time', 'arrival_date', 'arrival_time', 'duration_minutes', 'price',
            'premium_price', 'total_seats', 'bus_type', 'floor1_seats', 'floor2_seats', 'photos', 'passenger_comments',
            'intermediate_stops', 'operator_id', 'bus', 'operator_phone', 'service_fee_percent', 'bookedSeats',
            'availableSeatsCount', 'premiumSeats']);
        for (const k of Object.keys(body)) assert.ok(allowed.has(k), `unexpected top-level key: ${k}`);
    });

    it('computes bookedSeats/availableSeatsCount server-side from confirmed bookings only (behaviour preserved)', async () => {
        reset();
        const { body } = await get('/api/bus-tickets/501');
        // fixture: confirmed booking holds seats 3,4; pending_payment (seat 5) is not "confirmed"
        assert.deepEqual(body.bookedSeats.slice().sort(), [3, 4]);
        assert.equal(body.availableSeatsCount, 8);
        assert.deepEqual(body.premiumSeats, [1, 2, 3, 4]);
    });

    it('double-decker exposes the extended premium seat list', async () => {
        reset({ tickets: [makeTicket({ bus_type: 'double' })] });
        const { body } = await get('/api/bus-tickets/501');
        assert.deepEqual(body.premiumSeats, [1, 2, 3, 4, 69, 70, 71, 72, 73, 74, 75, 76]);
    });

    it('bus projection stays passenger-safe (no VIN / carrier id / notes)', async () => {
        reset();
        const { body } = await get('/api/bus-tickets/501');
        const text = JSON.stringify(body.bus);
        assert.ok(!text.includes('SYNTH_VIN_SECRET'));
        assert.ok(!text.includes('SYNTH_PRIVATE_BUS_NOTE'));
        assert.ok(!('carrier_id' in body.bus));
        assert.deepEqual(body.bus.amenities, ['wifi']);
    });

    it('never selects * and never selects passengers_data/payment columns for a guest', async () => {
        reset();
        await get('/api/bus-tickets/501');
        for (const s of state.selects) {
            assert.ok(!/(^|[\s,(])\*([\s,)]|$)/.test(s.cols || ''), `select('*') used on ${s.table}`);
        }
        const bookingSelect = state.selects.find(s => s.table === 'bus_ticket_bookings');
        assert.ok(bookingSelect, 'bookings must still be read server-side to derive seats');
        for (const col of ['passengers_data', 'phone', 'passenger_name', 'payment_link', 'invoice_uuid', 'carrier_notes']) {
            assert.ok(!bookingSelect.cols.includes(col), `guest booking query selects ${col}`);
        }
        const ticketSelect = state.selects.find(s => s.table === 'bus_tickets');
        for (const col of ['group_leader', 'poll_completed_at', 'created_at']) {
            assert.ok(!ticketSelect.cols.includes(col), `ticket query selects ${col}`);
        }
    });

    it('cancelled / completed trips are not exposed to guests (404)', async () => {
        for (const status of ['cancelled', 'completed']) {
            reset({ tickets: [makeTicket({ status })] });
            const { status: code, body } = await get('/api/bus-tickets/501');
            assert.equal(code, 404, status);
            assert.deepEqual(body, { error: 'Ticket not found' });
        }
    });

    it('unknown trip id returns 404', async () => {
        reset();
        const { status } = await get('/api/bus-tickets/999999');
        assert.equal(status, 404);
    });

    it('a sequence of trip ids yields no PII for any of them (enumeration yields only public data)', async () => {
        reset({ tickets: [makeTicket({ id: 501 }), makeTicket({ id: 502 }), makeTicket({ id: 503, status: 'completed' })],
            bookings: [makeBooking({ bus_ticket_id: 501 }), makeBooking({ id: 9005, bus_ticket_id: 502 }), makeBooking({ id: 9006, bus_ticket_id: 503 })] });
        for (const id of [501, 502, 503, 504]) {
            const { status, body } = await get(`/api/bus-tickets/${id}`);
            assert.ok([200, 404].includes(status));
            assertNoSensitiveData(body);
        }
    });
});

describe('GET /api/bus-tickets/:id — authentication handling', () => {
    it('an invalid / forged token is treated as a guest (no seatGenders, no PII)', async () => {
        reset();
        const { status, body } = await get('/api/bus-tickets/501', { Authorization: 'Bearer not-a-real-token' });
        assert.equal(status, 200);
        assertNoSensitiveData(body);
    });

    it('a carrier-audience token is not a passenger session (no seatGenders)', async () => {
        reset();
        const jwt = require('jsonwebtoken');
        const carrier = jwt.sign({ sub: '77', carrierId: 77 }, process.env.JWT_SECRET, { algorithm: 'HS256', issuer: 'poputki.online', audience: 'poputki-carrier' });
        const { body } = await get('/api/bus-tickets/501', { Authorization: `Bearer ${carrier}` });
        assertNoSensitiveData(body);
    });

    it('an authenticated passenger gets ONLY the per-seat gender map for the seat picker — still no PII', async () => {
        reset();
        const token = issueUserToken({ id: 31 });
        const { status, body } = await get('/api/bus-tickets/501', { Authorization: `Bearer ${token}` });
        assert.equal(status, 200);
        assert.deepEqual(body.seatGenders, { 3: 'female', 4: 'male' });
        assertNoSensitiveData(body, { allowSeatGenders: true });
        assert.deepEqual(body.bookedSeats.slice().sort(), [3, 4]);
    });
});

describe('GET /api/bus-tickets — public search/list', () => {
    it('returns no passenger/payment/accounting/carrier-private data and no unlisted columns', async () => {
        reset({ tickets: [makeTicket(), makeTicket({ id: 502 })] });
        const { status, body } = await get('/api/bus-tickets?from=Alpha&to=Omega');
        assert.equal(status, 200);
        assert.equal(body.length, 2);
        assertNoSensitiveData(body);
        for (const t of body) {
            assert.ok(!('operator_id' in t), 'operator_id must not be in list');
            assert.ok(!('bus_id' in t) && !('status' in t));
        }
    });

    it('does not select *, group leader, operator or booking data', async () => {
        reset();
        await get('/api/bus-tickets');
        const sel = state.selects.filter(s => s.table === 'bus_tickets');
        assert.ok(sel.length >= 1);
        for (const s of sel) {
            assert.ok(!/(^|[\s,(])\*([\s,)]|$)/.test(s.cols), "select('*') used");
            for (const col of ['group_leader', 'poll_completed_at', 'created_at', 'operator_id', 'operator:']) {
                assert.ok(!s.cols.includes(col), `list query selects ${col}`);
            }
        }
        assert.ok(!state.selects.some(s => s.table === 'bus_ticket_bookings'), 'list must not touch bookings');
    });

    it('keeps the fields the web/Flutter search UI consumes, incl. reserved_seats (numbers only) for compatibility', async () => {
        reset();
        const { body } = await get('/api/bus-tickets');
        const t = body[0];
        for (const k of ['id', 'from_city', 'to_city', 'departure_date', 'departure_time', 'arrival_time', 'price', 'premium_price',
            'total_seats', 'reserved_seats', 'availableSeatsCount', 'transport_company', 'duration_minutes', 'bus_type', 'photos', 'bus', 'intermediate_stops', 'from_address', 'to_address']) {
            assert.ok(k in t, `missing ${k}`);
        }
        assert.deepEqual(t.reserved_seats, [1, 2]);
        assert.equal(t.availableSeatsCount, 8);
        assert.equal(t.departure_time, '08:00');
    });

    it('still honours the intermediate-stop destination match (matchingStop)', async () => {
        reset();
        const { body } = await get('/api/bus-tickets?to=Midway');
        assert.equal(body.length, 1);
        assert.deepEqual(body[0].matchingStop, { city: 'Midway', time: '11:00' });
        const none = await get('/api/bus-tickets?to=Nowhere');
        assert.equal(none.body.length, 0);
    });

    it('only requests active trips', async () => {
        reset();
        await get('/api/bus-tickets');
        assert.ok(state.filters.some(f => f.table === 'bus_tickets' && f.c === 'status' && f.v === 'active'));
    });
});

describe('publicBusTicketProjection — canonical seat occupancy & allowlist', () => {
    const { computeSeatOccupancy, toPublicBusTripSummary, toPublicBusTripDetails, computePremiumSeats } = require('../utils/publicBusTicketProjection');
    const future = new Date(Date.now() + 15 * 60000).toISOString();
    const past = new Date(Date.now() - 15 * 60000).toISOString();

    it('confirmed + active hold lock seats; expired hold and cancelled do not', () => {
        const { confirmedSeats, lockedSeats } = computeSeatOccupancy([
            { seat_numbers: '[1]', status: 'confirmed' },
            { seat_numbers: '[2]', status: 'pending_payment', hold_expires_at: future },
            { seat_numbers: '[3]', status: 'pending_payment', hold_expires_at: past },
            { seat_numbers: '[4]', status: 'cancelled' },
            { seat_numbers: [5, 6], status: 'confirmed' }
        ]);
        assert.deepEqual(confirmedSeats.sort(), [1, 5, 6]);
        assert.deepEqual(lockedSeats.sort(), [1, 2, 5, 6]);
    });

    it('tolerates malformed input without throwing', () => {
        assert.deepEqual(computeSeatOccupancy(null), { confirmedSeats: [], lockedSeats: [] });
        assert.deepEqual(computeSeatOccupancy([{ seat_numbers: 'not json', status: 'confirmed' }]), { confirmedSeats: [], lockedSeats: [] });
    });

    it('DTO builders ignore unlisted columns (future-proof allowlist)', () => {
        const row = makeTicket();
        const summary = toPublicBusTripSummary(row, null);
        const details = toPublicBusTripDetails(row, { confirmedSeats: [1], operator: { phone: 'x', service_fee_percent: 5 } });
        for (const dto of [summary, details]) {
            assert.ok(!('secret_future_column' in dto));
            assert.ok(!('group_leader_phone' in dto));
            assert.ok(!('operator' in dto));
        }
        assert.equal(details.availableSeatsCount, 9);
        assert.deepEqual(computePremiumSeats('single'), [1, 2, 3, 4]);
    });
});
