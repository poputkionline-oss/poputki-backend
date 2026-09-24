/**
 * tests/phase_labbay_knowledge_api.test.js
 *
 * Labbay Dynamic Knowledge Base integration — POST /api/labbay/knowledge.
 * Covers: valid international trip, no trips on date, missing city/date,
 * domestic-only route (excluded), sold-out trip, invalid/missing API key,
 * absence of personal data in the response and in the bookings SELECT,
 * reverse-direction and partial-city-match exclusion, the four TJ/foreign
 * classification pairings, the Asia/Dushanbe day-boundary "already
 * departed" check, and real cancellation of a slow in-flight query.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

process.env.LABBAY_API_KEY = 'test-labbay-secret-key-0123456789';
process.env.MINI_APP_URL = 'https://poputki.online';

// ---------------------------------------------------------------------
// In-memory mock DB + minimal chainable Supabase-like query builder
// ---------------------------------------------------------------------

const today = new Date();
function isoDaysFromNow(days) {
    const d = new Date(today.getTime() + days * 24 * 3600 * 1000);
    return d.toISOString().slice(0, 10);
}

const DATE_INTL_OK = isoDaysFromNow(30);      // scenario: valid international trip
const DATE_NO_TRIPS = isoDaysFromNow(31);     // scenario: no trips at all on this date
const DATE_DOMESTIC_ONLY = isoDaysFromNow(32); // scenario: only a domestic route exists
const DATE_SOLD_OUT = isoDaysFromNow(33);     // scenario: international trip, 0 free seats
const DATE_DIRECTION = isoDaysFromNow(34);    // scenario: direction/partial-match exclusion

const mockDb = {
    cities: [
        { name: 'Душанбе', type: 'bus' },
        { name: 'Худжанд', type: 'bus' },
        { name: 'Москва', type: 'bus' },
        { name: 'Бишкек', type: 'bus' }
    ],
    bus_tickets: [
        {
            id: 1, from_city: 'Душанбе', to_city: 'Москва',
            departure_date: DATE_INTL_OK, departure_time: '08:00:00',
            price: 1500, status: 'active', total_seats: 45
        },
        {
            id: 2, from_city: 'Душанбе', to_city: 'Худжанд',
            departure_date: DATE_DOMESTIC_ONLY, departure_time: '09:00:00',
            price: 120, status: 'active', total_seats: 45
        },
        {
            id: 3, from_city: 'Худжанд', to_city: 'Москва',
            departure_date: DATE_SOLD_OUT, departure_time: '07:00:00',
            price: 1600, status: 'active', total_seats: 1
        },
        // Direction / partial-match scenario: a query for "из Худжанда в
        // Москву" must return ONLY id 4 — never the reverse (id 5) and
        // never a trip that matches just one of the two named cities (id 6).
        {
            id: 4, from_city: 'Худжанд', to_city: 'Москва',
            departure_date: DATE_DIRECTION, departure_time: '06:00:00',
            price: 1550, status: 'active', total_seats: 40
        },
        {
            id: 5, from_city: 'Москва', to_city: 'Худжанд',
            departure_date: DATE_DIRECTION, departure_time: '10:00:00',
            price: 1550, status: 'active', total_seats: 40
        },
        {
            id: 6, from_city: 'Худжанд', to_city: 'Бишкек',
            departure_date: DATE_DIRECTION, departure_time: '12:00:00',
            price: 900, status: 'active', total_seats: 40
        }
    ],
    bus_ticket_bookings: [
        {
            id: 101, bus_ticket_id: 1, status: 'confirmed', seat_numbers: [1],
            passengers_data: [{ name: 'Секретный Пассажир', gender: 'M' }],
            phone: '+992937777777', passenger_name: 'Секретный Пассажир',
            hold_expires_at: null, created_at: new Date().toISOString(), boarding_status: 'pending_boarding'
        },
        {
            id: 301, bus_ticket_id: 3, status: 'confirmed', seat_numbers: [1],
            passengers_data: [{ name: 'Другой Пассажир', gender: 'F' }],
            phone: '+992938888888', passenger_name: 'Другой Пассажир',
            hold_expires_at: null, created_at: new Date().toISOString(), boarding_status: 'pending_boarding'
        }
    ]
};

// Tracks whether a query's AbortSignal was actually observed firing while a
// (simulated slow) request was still pending — proof the route aborts the
// signal it hands to the Supabase client, not just that the HTTP response
// timed out independently while the query kept running unobserved. This
// mock stands in for the Supabase query builder, not Postgres itself, so it
// cannot and does not prove SQL-level cancellation inside Postgres.
const abortTracking = { fired: false };

// Captures the column list of the most recent .select() call per table, so
// tests can assert the route never requests sensitive columns it doesn't
// use (e.g. bus_ticket_bookings.passengers_data) — a real Postgres/PostgREST
// projection isn't available here, but the requested column string is
// exactly what determines what such a backend would actually return.
const lastSelectColumns = {};

function makeMockSupabase(db) {
    return {
        from(table) {
            return {
                select(columns) {
                    lastSelectColumns[table] = columns;
                    const filters = [];
                    let signal = null;
                    const builder = {
                        eq(col, val) {
                            filters.push(row => String(row[col]) === String(val));
                            return builder;
                        },
                        in(col, vals) {
                            const set = new Set((vals || []).map(String));
                            filters.push(row => set.has(String(row[col])));
                            return builder;
                        },
                        abortSignal(sig) {
                            signal = sig;
                            return builder;
                        },
                        then(resolve, reject) {
                            const run = () => {
                                try {
                                    const rows = (db[table] || []).filter(row => filters.every(f => f(row)));
                                    resolve({ data: JSON.parse(JSON.stringify(rows)), error: null });
                                } catch (e) {
                                    reject(e);
                                }
                            };

                            const delayMs = db.__delays && db.__delays[table];
                            if (!delayMs) {
                                run();
                                return;
                            }

                            // Simulates a slow Postgres round-trip so the
                            // route's own timeout fires first, then proves
                            // aborting the signal really cancels this
                            // in-flight "request" instead of leaving it to
                            // resolve into the void after the fact.
                            const timer = setTimeout(run, delayMs);
                            if (signal) {
                                signal.addEventListener('abort', () => {
                                    abortTracking.fired = true;
                                    clearTimeout(timer);
                                    const abortErr = new Error('The operation was aborted');
                                    abortErr.name = 'AbortError';
                                    reject(abortErr);
                                });
                            }
                        }
                    };
                    return builder;
                }
            };
        }
    };
}

const dbPath = require.resolve('../db');
require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: makeMockSupabase(mockDb)
};

const express = require('express');
const labbayRouter = require('../routes/labbay');
const {
    classifyCity,
    isConfidentInternationalRoute,
    hasTicketAlreadyDeparted
} = require('../utils/labbayKnowledgeHelper');
const { getBusinessLocalDate, getBusinessLocalTime } = require('../utils/dashboardHelper');

const app = express();
app.use(express.json());
app.use('/api/labbay', labbayRouter);

let server;
let baseUrl;

function makeRequest(method, path, headers = {}, body = null) {
    return new Promise((resolve, reject) => {
        const url = new URL(path, baseUrl);
        const options = {
            method,
            hostname: url.hostname,
            port: url.port,
            path: url.pathname + url.search,
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
        if (body !== null) req.write(JSON.stringify(body));
        req.end();
    });
}

const AUTH = { 'X-Api-Key': process.env.LABBAY_API_KEY };

test('LABBAY DYNAMIC KNOWLEDGE BASE — POST /api/labbay/knowledge', async (t) => {
    await new Promise((resolve) => {
        server = app.listen(0, () => {
            baseUrl = `http://127.0.0.1:${server.address().port}`;
            resolve();
        });
    });

    await t.test('valid international trip: returns route, date, price, seats and booking link', async () => {
        const res = await makeRequest('POST', '/api/labbay/knowledge', AUTH, {
            query: `Хочу поехать из Душанбе в Москву ${DATE_INTL_OK}`
        });
        assert.equal(res.status, 200);
        assert.equal(typeof res.body.content, 'string');
        assert.match(res.body.content, /Душанбе/);
        assert.match(res.body.content, /Москва/);
        assert.match(res.body.content, /1500/);
        assert.match(res.body.content, /сомони/);
        assert.match(res.body.content, /свободных мест: 44/);
        assert.match(res.body.content, new RegExp(`https://poputki\\.online/bus-ticket/1`));
    });

    await t.test('no trips on requested date: clear "not found" message, no fabricated data', async () => {
        const res = await makeRequest('POST', '/api/labbay/knowledge', AUTH, {
            query: `Душанбе Москва ${DATE_NO_TRIPS}`
        });
        assert.equal(res.status, 200);
        assert.match(res.body.content, /не найдено/);
    });

    await t.test('missing city and date: asks a specific clarifying question', async () => {
        const res = await makeRequest('POST', '/api/labbay/knowledge', AUTH, {
            query: 'Здравствуйте, а сколько стоит билет?'
        });
        assert.equal(res.status, 200);
        assert.match(res.body.content, /направление/);
        assert.match(res.body.content, /дата/);
    });

    await t.test('missing date only: clarifying question mentions date', async () => {
        const res = await makeRequest('POST', '/api/labbay/knowledge', AUTH, {
            query: 'Есть рейс Душанбе Москва?'
        });
        assert.equal(res.status, 200);
        assert.match(res.body.content, /дата/);
        assert.doesNotMatch(res.body.content, /направление/);
    });

    await t.test('domestic route: never surfaced, even though city names match', async () => {
        const res = await makeRequest('POST', '/api/labbay/knowledge', AUTH, {
            query: `Душанбе Худжанд ${DATE_DOMESTIC_ONLY}`
        });
        assert.equal(res.status, 200);
        assert.match(res.body.content, /не найдено/);
        assert.doesNotMatch(res.body.content, /120/);
    });

    await t.test('reverse direction is excluded: "из Худжанда в Москву" never returns the Москва -> Худжанд trip', async () => {
        const res = await makeRequest('POST', '/api/labbay/knowledge', AUTH, {
            query: `из Худжанда в Москву ${DATE_DIRECTION}`
        });
        assert.equal(res.status, 200);
        assert.match(res.body.content, /Худжанд → Москва/);
        assert.doesNotMatch(res.body.content, /Москва → Худжанд/);
        assert.doesNotMatch(res.body.content, /bus-ticket\/5/);
    });

    await t.test('partial match is excluded: a trip matching only one of the two named cities is not returned', async () => {
        const res = await makeRequest('POST', '/api/labbay/knowledge', AUTH, {
            query: `из Худжанда в Москву ${DATE_DIRECTION}`
        });
        assert.equal(res.status, 200);
        assert.doesNotMatch(res.body.content, /Бишкек/);
        assert.doesNotMatch(res.body.content, /bus-ticket\/6/);
    });

    await t.test('sold-out international trip: reports no free seats, omits booking link', async () => {
        const res = await makeRequest('POST', '/api/labbay/knowledge', AUTH, {
            query: `Худжанд Москва ${DATE_SOLD_OUT}`
        });
        assert.equal(res.status, 200);
        assert.match(res.body.content, /свободных мест нет/);
        assert.doesNotMatch(res.body.content, /bus-ticket\/3/);
    });

    await t.test('missing API key: 401 Unauthorized', async () => {
        const res = await makeRequest('POST', '/api/labbay/knowledge', {}, {
            query: `Душанбе Москва ${DATE_INTL_OK}`
        });
        assert.equal(res.status, 401);
    });

    await t.test('wrong API key: 401 Unauthorized', async () => {
        const res = await makeRequest('POST', '/api/labbay/knowledge', { 'X-Api-Key': 'wrong-key' }, {
            query: `Душанбе Москва ${DATE_INTL_OK}`
        });
        assert.equal(res.status, 401);
    });

    await t.test('response never contains passenger personal data (name/phone)', async () => {
        const res = await makeRequest('POST', '/api/labbay/knowledge', AUTH, {
            query: `Душанбе Москва ${DATE_INTL_OK}`
        });
        assert.equal(res.status, 200);
        assert.doesNotMatch(res.body.content, /Секретный Пассажир/);
        assert.doesNotMatch(res.body.content, /\+9929377777/);
    });

    await t.test('bookings SELECT never requests passengers_data', async () => {
        // calculateTripFillStats()'s free_seats — the only stat this
        // endpoint reads — never touches passengers_data (only
        // seat_numbers/status/hold_expires_at/created_at). Asserts the
        // route doesn't fetch that PII-bearing column from the DB at all,
        // not just that it doesn't echo it back.
        delete lastSelectColumns.bus_ticket_bookings;
        const res = await makeRequest('POST', '/api/labbay/knowledge', AUTH, {
            query: `Душанбе Москва ${DATE_INTL_OK}`
        });
        assert.equal(res.status, 200);
        assert.equal(typeof lastSelectColumns.bus_ticket_bookings, 'string');
        assert.doesNotMatch(lastSelectColumns.bus_ticket_bookings, /passengers_data/);
    });

    await t.test('query too long: rejected with 400', async () => {
        const res = await makeRequest('POST', '/api/labbay/knowledge', AUTH, {
            query: 'а'.repeat(1000)
        });
        assert.equal(res.status, 400);
    });

    await t.test('server misconfiguration (no LABBAY_API_KEY set): fails closed with 500', async () => {
        const saved = process.env.LABBAY_API_KEY;
        delete process.env.LABBAY_API_KEY;
        try {
            const res = await makeRequest('POST', '/api/labbay/knowledge', { 'X-Api-Key': 'anything' }, {
                query: `Душанбе Москва ${DATE_INTL_OK}`
            });
            assert.equal(res.status, 500);
        } finally {
            process.env.LABBAY_API_KEY = saved;
        }
    });

    await t.test('slow DB query: responds 504 within budget AND actually fires the AbortSignal on the still-pending query', async () => {
        // Simulates a Supabase query taking far longer than Labbay's 5s
        // budget. Proves two things at the route's own boundary: (a) it
        // responds before the slow query would have finished, and (b) the
        // AbortSignal it hands to the Supabase client actually fires while
        // that query is still pending, rather than the request handler just
        // walking away from an unawaited promise.
        //
        // Scope: this mocks the Supabase query builder itself, so it does
        // NOT exercise postgrest-js's real fetch() call or prove Postgres
        // cancels the underlying SQL statement server-side — abortSignal()
        // forwarding it to fetch() is verified by reading postgrest-js's
        // source (PostgrestBuilder passes `signal` straight into its fetch
        // options), and SQL-level cancellation on client disconnect is
        // standard Postgres behavior outside this process's control. What
        // this test guarantees is that OUR code reliably triggers that
        // abort instead of silently leaving a promise to resolve into the
        // void after the response has already gone out.
        mockDb.__delays = { bus_tickets: 300 };
        abortTracking.fired = false;
        const savedBudget = process.env.LABBAY_REQUEST_BUDGET_MS;
        process.env.LABBAY_REQUEST_BUDGET_MS = '50';

        try {
            const startedAt = Date.now();
            const res = await makeRequest('POST', '/api/labbay/knowledge', AUTH, {
                query: `Душанбе Москва ${DATE_INTL_OK}`
            });
            const elapsedMs = Date.now() - startedAt;

            assert.equal(res.status, 504);
            assert.ok(elapsedMs < 300, `expected the 50ms budget to win the race, took ${elapsedMs}ms`);

            // Give the aborted listener a tick to run, then confirm the
            // slow query was actually cancelled rather than left dangling.
            await new Promise(resolve => setTimeout(resolve, 10));
            assert.equal(abortTracking.fired, true, 'expected the in-flight DB query to be aborted, not merely outraced');
        } finally {
            delete mockDb.__delays;
            if (savedBudget === undefined) {
                delete process.env.LABBAY_REQUEST_BUDGET_MS;
            } else {
                process.env.LABBAY_REQUEST_BUDGET_MS = savedBudget;
            }
        }
    });

    server.close();
});

// ---------------------------------------------------------------------
// Pure-function unit tests (no HTTP server, no mock DB) — the exact
// classification and day-boundary logic the route above depends on.
// ---------------------------------------------------------------------

test('isConfidentInternationalRoute — requires exactly one TJ side and one foreign side', () => {
    // TJ -> foreign: international.
    assert.equal(isConfidentInternationalRoute('Душанбе', 'Москва'), true);
    // foreign -> TJ: international.
    assert.equal(isConfidentInternationalRoute('Москва', 'Душанбе'), true);
    // TJ -> TJ: domestic, never international.
    assert.equal(isConfidentInternationalRoute('Душанбе', 'Худжанд'), false);
    // foreign -> foreign: NOT international — a single foreign endpoint is
    // not sufficient on its own; this is the pairing bug that was fixed.
    assert.equal(isConfidentInternationalRoute('Москва', 'Бишкек'), false);

    // Sanity on the underlying classifier for the same four cities.
    assert.equal(classifyCity('Душанбе'), 'tj');
    assert.equal(classifyCity('Худжанд'), 'tj');
    assert.equal(classifyCity('Москва'), 'foreign');
    assert.equal(classifyCity('Бишкек'), 'foreign');
});

test('hasTicketAlreadyDeparted — Asia/Dushanbe day boundary, not UTC or server-local time', () => {
    // A trip dated for a day strictly before "today" (business-local) has
    // always departed, regardless of time.
    assert.equal(
        hasTicketAlreadyDeparted({ departure_date: '2026-10-04', departure_time: '23:59' }, '2026-10-05', '00:05'),
        true
    );
    // A trip dated for a day strictly after "today" has never departed,
    // regardless of the current time-of-day.
    assert.equal(
        hasTicketAlreadyDeparted({ departure_date: '2026-10-06', departure_time: '00:01' }, '2026-10-05', '23:55'),
        false
    );

    // The boundary that actually matters: Asia/Dushanbe (UTC+5) rolls over
    // to a new business-local day ~5 hours before UTC does. A trip departing
    // at 00:10 on the NEW business-local day must already be considered
    // departed once business-local time has passed 00:10 on that day, even
    // though a UTC-date-based check would still think it's "yesterday" and
    // never even compare the time — that mismatch was the bug.
    assert.equal(
        hasTicketAlreadyDeparted({ departure_date: '2026-10-06', departure_time: '00:10' }, '2026-10-06', '00:30'),
        true,
        'a trip 20 minutes into the new business-local day should already be considered departed'
    );
    // Same day, but the current business-local time is still before
    // departure: not yet departed.
    assert.equal(
        hasTicketAlreadyDeparted({ departure_date: '2026-10-06', departure_time: '23:50' }, '2026-10-06', '00:30'),
        false
    );
});

test('getBusinessLocalDate/getBusinessLocalTime — correct across the UTC/Asia-Dushanbe day boundary', () => {
    // 2026-10-05T20:30:00Z is 2026-10-06T01:30:00+05:00 in Asia/Dushanbe —
    // already the next business-local day and well past midnight there,
    // while a naive `now.toISOString().split('T')[0]` (UTC date) would
    // still say "2026-10-05". This is exactly the class of bug the route
    // fix removes by using these functions everywhere instead of mixing in
    // a UTC calendar date.
    const straddlingInstant = new Date('2026-10-05T20:30:00.000Z');

    assert.equal(getBusinessLocalDate('Asia/Dushanbe', straddlingInstant), '2026-10-06');
    assert.equal(getBusinessLocalTime('Asia/Dushanbe', straddlingInstant), '01:30');

    // A naive UTC-date read of the same instant would disagree — this is
    // the mismatch that used to exist between todayIso (business-local,
    // already correct) and the old currentDate/currentTime (UTC-based).
    assert.equal(straddlingInstant.toISOString().split('T')[0], '2026-10-05');
});
