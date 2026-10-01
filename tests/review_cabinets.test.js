const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
process.env.JWT_SECRET = 'review-cabinet-test-secret';
const { issueUserToken } = require('../utils/userAuth');
const jwt = require('jsonwebtoken');
let queries = [], failure = false;
const row = { id: 8, bus_ticket_id: 9, ride_id: null, rating: 4, comment: 'Good', created_at: '2026-01-01',
    users: { name: 'Test person', phone: 'never expose' }, reviewer_id: 23,
    bus_tickets: { from_city: 'A', to_city: 'B', departure_date: '2026-01-01', transport_company: 'Test carrier' } };
require('../dbServiceRole').getServiceRoleClient = () => ({
    from(table) {
        const q = { table, filters: [] }; queries.push(q);
        const builder = {
            select(columns, options) { q.columns = columns; q.options = options; return this; },
            eq(column, value) { q.filters.push([column, value]); return this; },
            not(...args) { q.not = args; return this; },
            order() { return this; },
            range(start, end) { q.range = [start, end]; return Promise.resolve({ data: [row], count: 41, error: failure ? { code: 'DB_FAIL' } : null }); }
        }; return builder;
    },
    rpc: async (name, params) => { queries.push({ name, params }); return { data: { count: 41, rating: 4.2 }, error: null }; }
});
// Real carrierAuth validates JWT audience and resolves the carrier from DB.
const dbPath = require.resolve('../db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: {
    from(table) { return { select() { return this; }, eq() { return this; }, async maybeSingle() {
        return { data: table === 'users' ? { id: 7, name: 'Dispatcher', role: 'dispatcher', is_blocked: false }
            : { carrier_id: 42, role: 'dispatcher', is_active: true }, error: null };
    } }; }
} };
const express = require('express');
const app = express();
app.use('/reviews', require('../routes/reviews'));
app.use('/bus-admin/reviews', require('../utils/carrierAuth').carrierAuth, require('../routes/carrierReviews'));
let server, origin;
before(async () => { server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r)); origin = `http://127.0.0.1:${server.address().port}`; });
after(() => { server.closeAllConnections(); server.close(); });
const carrierToken = jwt.sign({ sub: '7', carrierId: 42 }, process.env.JWT_SECRET, { issuer: 'poputki.online', audience: 'poputki-carrier' });
async function get(path, token) { return fetch(origin + path, { headers: token ? { Authorization: 'Bearer ' + token } : {} }); }
test('private cabinet endpoints require correct authentication audiences', async () => {
    assert.equal((await get('/reviews/sent')).status, 401);
    assert.equal((await get('/bus-admin/reviews')).status, 401);
    assert.equal((await get('/reviews/sent', carrierToken)).status, 401);
    assert.equal((await get('/bus-admin/reviews', issueUserToken({ id: 2 }))).status, 401);
});
test('sent reviews bind passenger identity, paginate all results and scrub PII', async () => {
    queries = [];
    const res = await get('/reviews/sent?page=2&reviewer_id=999', issueUserToken({ id: 2 }));
    assert.equal(res.status, 200); const body = await res.json();
    assert.deepEqual(queries[0].filters, [['reviewer_id', 2]]); assert.deepEqual(queries[0].range, [20, 39]);
    assert.equal(body.count, 41); assert.equal(body.reviews[0].company, 'Test carrier');
    assert.equal(JSON.stringify(body).includes('never expose'), false); assert.equal(body.reviews[0].reviewer_id, undefined);
});
test('received reviews use canonical membership carrier and ignore query spoofing', async () => {
    queries = [];
    const res = await get('/bus-admin/reviews?operator_id=999', carrierToken);
    assert.equal(res.status, 200); const body = await res.json();
    assert.deepEqual(queries[0].filters, [['driver_id', 42]]); assert.deepEqual(queries[0].not, ['bus_ticket_id', 'is', null]);
    assert.equal(queries[1].params.p_carrier_id, 42); assert.equal(body.rating, 4.2);
    const foreignCarrierToken = jwt.sign({ sub: '7', carrierId: 999 }, process.env.JWT_SECRET, { issuer: 'poputki.online', audience: 'poputki-carrier' });
    assert.equal((await get('/bus-admin/reviews', foreignCarrierToken)).status, 403);
});
test('invalid pagination and DB errors never produce a successful list', async () => {
    for (const page of ['0', '-1', 'x', '1.5', '1000001']) assert.equal((await get('/reviews/sent?page=' + page, issueUserToken({ id: 2 }))).status, 400);
    failure = true; assert.equal((await get('/reviews/sent', issueUserToken({ id: 2 }))).status, 500); failure = false;
});
