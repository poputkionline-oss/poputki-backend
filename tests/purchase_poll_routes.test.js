const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
process.env.INTERNAL_SERVICE_SECRET = 'poll-route-test-secret';
process.env.ADMIN_SECRET_TOKEN = 'poll-test-admin';
let captured, fail = false, queryLog = [];
require('../dbServiceRole').getServiceRoleClient = () => ({ from(table) {
    const query = { table }; queryLog.push(query);
    const chain = {
        select(fields, options) { query.fields = fields; query.options = options; return chain; },
        eq(key, value) { (query.filters ||= []).push([key, value]); return chain; },
        in(key, value) { (query.memberships ||= []).push([key, value]); return chain; },
        order(key, options) { (query.orders ||= []).push([key, options]); return chain; },
        range(start, end) { query.range = [start, end]; return chain; },
        then(resolve, reject) {
            const count = table === 'purchase_poll_recipients' ? (query.filters?.some(([k]) => k === 'answer_status') ? 8 : 23) : 0;
            return Promise.resolve({ data: [{ id: 'sent-1' }], count, error: fail ? {} : null }).then(resolve, reject);
        }
    }; return chain;
}, rpc: async (name, params) => {
    if (name === 'fn_record_internal_service_nonce') return { data: true, error: null };
    captured = { name, params }; return { data: { status: 'saved' }, error: fail ? {} : null };
} });
const { computeSignature } = require('../utils/internalServiceAuth');
const express = require('express'); const app = express(); app.use(express.json());
app.use('/api/internal/polls', require('../routes/internalPolls'));
app.use('/api/admin/polls', require('../utils/adminTokenAuth').requireAdminToken, require('../routes/adminPolls'));
let server, origin;
before(async () => { server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r)); origin = `http://127.0.0.1:${server.address().port}`; });
after(() => { server.closeAllConnections(); server.close(); });
function sign(body) {
    const timestamp = String(Date.now()), nonce = crypto.randomBytes(16).toString('hex');
    return { 'Content-Type': 'application/json', 'x-internal-timestamp': timestamp, 'x-internal-nonce': nonce,
        'x-internal-signature': computeSignature({ method: 'POST', path: '/api/internal/polls/answer', timestamp, nonce, body, secret: process.env.INTERNAL_SERVICE_SECRET }) };
}
const body = { action: 'vote', telegram_id: '55', poll_id: 'test-poll', option: 1 };
async function post(data, headers = sign(data)) { return fetch(origin + '/api/internal/polls/answer', { method: 'POST', headers, body: JSON.stringify(data) }); }
test('poll answer endpoint rejects unsigned and replayed calls', async () => {
    assert.equal((await post(body, { 'Content-Type': 'application/json' })).status, 401);
    const headers = sign(body); assert.equal((await post(body, headers)).status, 200); assert.equal((await post(body, headers)).status, 401);
});
test('recipient list is admin-only, paginated and fails without leaking database errors', async () => {
    assert.equal((await fetch(origin + '/api/admin/polls/recipients')).status, 401);
    const headers = { 'x-admin-token': 'poll-test-admin' };
    assert.equal((await fetch(origin + '/api/admin/polls/recipients?page=0', { headers })).status, 400);
    queryLog = [];
    const response = await fetch(origin + '/api/admin/polls/recipients?page=2', { headers });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()), { recipients: [{ id: 'sent-1' }], count: 23, page: 2, page_size: 20 });
    assert.deepEqual(queryLog[0].range, [20, 39]);
    fail = true;
    assert.equal((await fetch(origin + '/api/admin/polls/recipients', { headers })).status, 500);
    fail = false;
});
test('status includes historical sent ledger totals and separate dispatch errors', async () => {
    const response = await fetch(origin + '/api/admin/polls/status', { headers: { 'x-admin-token': 'poll-test-admin' } });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.sent_total, 23); assert.equal(result.answered_total, 8); assert.equal(result.awaiting_total, 15);
    assert.equal(result.sent, 0); assert.equal(result.failed, 0);
});
test('banner filters apply to the database query before pagination', async () => {
    const headers = { 'x-admin-token': 'poll-test-admin' };
    for (const filter of ['sent', 'answered', 'awaiting', 'issues']) {
        queryLog = [];
        assert.equal((await fetch(origin + '/api/admin/polls/recipients?filter=' + filter, { headers })).status, 200);
        if (filter === 'issues') assert.deepEqual(queryLog[0].memberships, [['delivery_status', ['failed', 'uncertain']]]);
        else {
            assert.deepEqual(queryLog[0].filters[0], ['delivery_status', 'sent']);
            if (filter !== 'sent') assert.deepEqual(queryLog[0].filters[1], ['answer_status', filter]);
        }
        assert.deepEqual(queryLog[0].range, [0, 19]);
    }
    assert.equal((await fetch(origin + '/api/admin/polls/recipients?filter=invalid', { headers })).status, 400);
    assert.equal((await fetch(origin + '/api/admin/polls/templates')).status, 401);
    assert.equal((await fetch(origin + '/api/admin/polls/templates', { headers })).status, 200);
});
test('signed vote persists only supplied Telegram voter and selected index', async () => {
    assert.equal((await post({ ...body, user_id: 999, booking_id: 999 })).status, 200);
    assert.deepEqual(captured, { name: 'fn_answer_purchase_poll', params: { p_poll_id: 'test-poll', p_telegram_id: '55', p_option: 1 } });
});
test('invalid inputs are rejected and persistence errors request Telegram retry', async () => {
    for (const patch of [{ telegram_id: '-1' }, { option: 4 }, { option: '1' }, { action: 'x' }]) assert.equal((await post({ ...body, ...patch })).status, 400);
    fail = true; assert.equal((await post(body)).status, 503); fail = false;
});
test('poll admin APIs require admin token; dry-run does not send or read recipients', async () => {
    assert.equal((await fetch(origin + '/api/admin/polls/settings')).status, 401);
    captured = null;
    const result = await fetch(origin + '/api/admin/polls/trigger?dry_run=true', { method: 'POST', headers: { 'x-admin-token': 'poll-test-admin' } });
    assert.equal(result.status, 200); assert.equal((await result.json()).sent, 0); assert.equal(captured, null);
});
