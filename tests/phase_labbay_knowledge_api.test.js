/**
 * tests/phase_labbay_knowledge_api.test.js
 *
 * Labbay Dynamic Knowledge Base integration — POST /api/labbay/knowledge.
 * Covers: valid international trip, no trips on date, missing city/date,
 * domestic-only route (excluded), sold-out trip, invalid/missing API key,
 * and absence of personal data in the response.
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

const mockDb = {
    cities: [
        { name: 'Душанбе', type: 'bus' },
        { name: 'Худжанд', type: 'bus' },
        { name: 'Москва', type: 'bus' }
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

function makeMockSupabase(db) {
    return {
        from(table) {
            return {
                select() {
                    const filters = [];
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
                        then(resolve, reject) {
                            try {
                                const rows = (db[table] || []).filter(row => filters.every(f => f(row)));
                                resolve({ data: JSON.parse(JSON.stringify(rows)), error: null });
                            } catch (e) {
                                reject(e);
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

    server.close();
});
