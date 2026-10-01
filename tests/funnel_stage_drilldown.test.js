const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
process.env.ADMIN_SECRET_TOKEN = 'funnel-stage-test';
const { JOURNEY_EVENT_TYPES: E } = require('../utils/journeyHelper');
const { createFakeSupabaseClient } = require('./helpers/fakeSupabaseClient');
const created_at = new Date(Date.now() - 3600000).toISOString();
const trip = { id: 1, operator_id: 1, from_city: 'A', to_city: 'B', transport_company: 'Test', departure_date: '2099-01-01' };
const bookings = [1, 2, 3].map(id => ({ id, channel: 'manual', source_type: 'manual', passenger_name: 'Fixture ' + id, phone: '+992900000001', bus_ticket_id: 1, bus_tickets: trip, created_at }));
const events = [
 { booking_id: 1, event_type: E.TELEGRAM_BOT_STARTED, channel: 'telegram', created_at },
 { booking_id: 1, event_type: E.TELEGRAM_BOT_STARTED, channel: 'telegram', created_at },
 { booking_id: 1, event_type: E.CLAIM_COMPLETED, channel: 'whatsapp', created_at },
 { booking_id: 2, event_type: E.LINK_OPENED, channel: 'telegram', created_at }
];
const db = createFakeSupabaseClient({ bus_ticket_bookings: bookings, booking_journey_events: events, booking_handoffs: [], booking_claim_requests: [] });
require('../dbServiceRole').getServiceRoleClient = () => db;
const express = require('express'); const app = express();
app.use('/funnel', require('../utils/adminTokenAuth').requireAdminToken, require('../routes/adminPassengerFunnel'));
let server, origin;
before(async () => { server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r)); origin = `http://127.0.0.1:${server.address().port}`; });
after(() => { server.closeAllConnections(); server.close(); });
async function get(path) { const r = await fetch(origin + '/funnel/' + path, { headers: { 'x-admin-token': 'funnel-stage-test' } }); assert.equal(r.status, 200); return r.json(); }
test('every stage list agrees with the counter, without duplicate event rows', async () => {
 const { stages } = await get('stages?period=30days');
 for (const stage of stages) {
  const list = await get('passengers?period=30days&stage=' + stage.id);
  assert.equal(list.pagination.total, stage.count, stage.id);
 }
});
test('reached-stage includes activated passengers; channel matches any journey event', async () => {
 const list = await get('passengers?period=30days&stage=bot_started&channel=telegram');
 assert.equal(list.pagination.total, 1); assert.equal(list.passengers[0].bookingId, 1);
 assert.equal(list.passengers[0].status, 'ACTIVATED');
 assert.ok(!JSON.stringify(list).includes('+992900000001'));
});
test('stage filter is authenticated and rejects unknown stages', async () => {
 assert.equal((await fetch(origin + '/funnel/passengers?stage=bot_started')).status, 401);
 assert.equal((await fetch(origin + '/funnel/passengers?stage=invalid', { headers: { 'x-admin-token': 'funnel-stage-test' } })).status, 400);
});
