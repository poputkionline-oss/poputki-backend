/**
 * tests/phase_notification_recipient_fix_and_changed_fields_normalization.test.js
 *
 * Local fix for three defects confirmed by a read-only audit of a real
 * trip-78 / booking-487 notification incident (see routes/busAdmin.js PUT
 * /tickets/:id and utils/changedFieldsNormalization.js for the fix itself):
 *
 *   1. booking_followers has RLS enabled with zero policies and no anon/
 *      authenticated GRANT — the anon-key `supabase` client always got
 *      "permission denied", silently caught, so active followers were NEVER
 *      notified. Fixed by reading via the service-role client already
 *      required later in the same handler for fn_atomic_bus_trip_update —
 *      no GRANT, no RLS policy, no migration.
 *   2. The `users` query selected a nonexistent `language` column, failing
 *      the WHOLE query (not just the language part) for every recipient,
 *      including the legacy one. Fixed by selecting only `id, telegram_id`
 *      and hardcoding language to 'ru'.
 *   3. changed_fields used a raw JSON.stringify comparison with zero
 *      normalization, producing false positives for time-format
 *      differences ("06:35:00" vs "06:35") and null-vs-empty-string
 *      nullable text fields — which could misclassify a real price-only
 *      edit as a schedule_update and fabricate phantom "changes" in
 *      notification payloads.
 *
 * Per explicit instruction, source/regex-level tests alone are NOT
 * sufficient proof here — every scenario below drives the REAL
 * routes/busAdmin.js PUT /tickets/:id handler over real HTTP, using the
 * same require.cache-injection technique as
 * tests/phase_p2_5_trip_update_hardening.test.js (createFakeSupabaseClient
 * + installFakeDbModule/installFakeServiceRoleModule). Nothing here is a
 * reimplementation of the route's logic.
 */

'use strict';

process.env.JWT_SECRET = 'test-secret-key-notif-recipient-fix';
process.env.SUPABASE_URL = 'https://test-local-only.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-local-service-role-key-not-real';
process.env.MANUAL_BOOKING_SUBSCRIPTION_MODEL_ENABLED = 'true';
process.env.NOTIFICATION_DELIVERY_ENABLED = 'false';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const jwt = require('jsonwebtoken');

const {
    createFakeSupabaseClient,
    installFakeDbModule,
    installFakeServiceRoleModule
} = require('./helpers/fakeSupabaseClient');

const OPERATOR_ID = 901; // also used as the manual-booking "legacy surrogate" passenger_id
const TICKET_ID = 501;
const BOOKING_ID = 9501;
const DEPARTURE_DATE = '2027-08-01';
const ARRIVAL_DATE = '2027-08-02'; // next calendar day, so changing departure_time within DEPARTURE_DATE never violates arrival-after-departure

const FOLLOWER_1 = 8801; // telegram 55501
const FOLLOWER_2 = 8802; // telegram 55502
const FOLLOWER_NO_TG = 8803; // no telegram
const FOLLOWER_SHARES_TG_WITH_1 = 8804; // telegram 55501, same as FOLLOWER_1

function generateToken(userId, carrierId) {
    return jwt.sign(
        { sub: String(userId), carrierId },
        process.env.JWT_SECRET,
        { algorithm: 'HS256', issuer: 'poputki.online', audience: 'poputki-carrier', expiresIn: '1h' }
    );
}

function baseTables() {
    return {
        users: [
            { id: OPERATOR_ID, name: 'Carrier Owner', phone: '+992900000901', role: 'bus_driver', is_blocked: false, service_fee_percent: 10, telegram_id: null },
            { id: FOLLOWER_1, name: 'Follower One', phone: '+992900008801', role: 'passenger', is_blocked: false, telegram_id: 55501 },
            { id: FOLLOWER_2, name: 'Follower Two', phone: '+992900008802', role: 'passenger', is_blocked: false, telegram_id: 55502 },
            { id: FOLLOWER_NO_TG, name: 'Follower NoTG', phone: '+992900008803', role: 'passenger', is_blocked: false, telegram_id: null },
            { id: FOLLOWER_SHARES_TG_WITH_1, name: 'Follower SharesTG', phone: '+992900008804', role: 'passenger', is_blocked: false, telegram_id: 55501 }
        ],
        carrier_members: [],
        bus_tickets: [
            {
                id: TICKET_ID, operator_id: OPERATOR_ID, status: 'active',
                from_city: 'Душанбе', to_city: 'Худжанд',
                from_address: 'Автовокзал', to_address: 'Автовокзал 2',
                departure_date: DEPARTURE_DATE, departure_time: '10:00:00',
                arrival_date: ARRIVAL_DATE, arrival_time: '06:35:00',
                duration_minutes: null,
                price: 840, premium_price: null,
                bus_type: 'single', total_seats: 40, floor1_seats: null, floor2_seats: null, bus_id: null,
                reserved_seats: [1], intermediate_stops: [], photos: [],
                group_leader_name: null, group_leader_phone: '', group_leader_whatsapp: null, passenger_comments: ''
            }
        ],
        // A manual/unclaimed booking: passenger_id is the carrier's own
        // account (the documented "legacy surrogate" — see
        // utils/notificationRecipientDedup.js), claimed_by_user_id is null.
        bus_ticket_bookings: [
            {
                id: BOOKING_ID, bus_ticket_id: TICKET_ID, passenger_id: OPERATOR_ID, claimed_by_user_id: null,
                seat_numbers: '[1]', status: 'confirmed', total_price: 840, hold_expires_at: null,
                created_at: '2026-09-01T00:00:00.000Z', passengers_data: []
            }
        ],
        booking_followers: [],
        bus_ticket_change_events: [],
        bus_ticket_notification_outbox: [],
        carrier_activity_logs: []
    };
}

function addFollowers(tables, rows) {
    tables.booking_followers.push(...rows.map((r, idx) => ({
        id: 7000 + idx,
        booking_id: BOOKING_ID,
        user_id: r.userId,
        notifications_enabled: r.notificationsEnabled !== undefined ? r.notificationsEnabled : true,
        unsubscribed_at: r.unsubscribedAt !== undefined ? r.unsubscribedAt : null
    })));
}

/** Mirrors the observable contract of fn_atomic_bus_trip_update (same convention as phase_p2_5_trip_update_hardening.test.js). */
function simulateAtomicBusTripUpdate(tables, params) {
    const { p_ticket_id, p_operator_id, p_update_data, p_event_data, p_outbox_entries } = params;
    const ticket = tables.bus_tickets.find(t => t.id === p_ticket_id);
    if (!ticket) return { data: { success: false, error: 'TICKET_NOT_FOUND' }, error: null };
    if (ticket.operator_id !== p_operator_id) return { data: { success: false, error: 'FORBIDDEN_OPERATOR' }, error: null };

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

/** Wraps a fake client's .from(table) so every call is recorded in callLog as {client: label, table}. */
function withCallTracking(baseClient, label, callLog) {
    return {
        ...baseClient,
        from(tableName) {
            callLog.push({ client: label, table: tableName });
            return baseClient.from(tableName);
        }
    };
}

/** Wraps a fake client so .from(tableName) always resolves with the given PostgREST-shaped error (data: null, error). */
function withErrorInjection(baseClient, tableName, errorToThrow) {
    return {
        ...baseClient,
        from(name) {
            if (name !== tableName) return baseClient.from(name);
            const failingBuilder = {
                select() { return failingBuilder; },
                eq() { return failingBuilder; },
                in() { return failingBuilder; },
                is() { return failingBuilder; },
                then(resolve, reject) {
                    return Promise.resolve({ data: null, error: errorToThrow }).then(resolve, reject);
                }
            };
            return failingBuilder;
        }
    };
}

function makeApp(tables, { rpcOverride = null, anonWrap = null, serviceWrap = null, callLog = null } = {}) {
    let anonClient = createFakeSupabaseClient(tables);
    let serviceClient = createFakeSupabaseClient(tables);
    const rpcImpl = async (name, params) => {
        // Best-effort worker wake-up (routes/busAdmin.js step 10) fires
        // fire-and-forget after the response is built; returning an empty
        // claimed batch here (rather than an RPC error) keeps
        // processTripChangeOutbox's claim-error SELECT-fallback from racing
        // this test's own assertions against bus_ticket_notification_outbox
        // row status — delivery status is out of scope for this suite,
        // which is about recipient formation/dedup, not the worker.
        if (name === 'fn_claim_bus_trip_notification_batch') return { data: [], error: null };
        if (rpcOverride) return rpcOverride(name, params);
        if (name === 'fn_atomic_bus_trip_update') return simulateAtomicBusTripUpdate(tables, params);
        throw new Error(`Unmocked RPC in notification-recipient-fix test: ${name}`);
    };
    anonClient.rpc = rpcImpl;
    serviceClient.rpc = rpcImpl;

    if (callLog) {
        anonClient = withCallTracking(anonClient, 'anon', callLog);
        serviceClient = withCallTracking(serviceClient, 'service', callLog);
    }
    if (anonWrap) anonClient = anonWrap(anonClient);
    if (serviceWrap) serviceClient = serviceWrap(serviceClient);

    installFakeDbModule(anonClient);
    installFakeServiceRoleModule(serviceClient);

    delete require.cache[require.resolve('../routes/busAdmin')];
    delete require.cache[require.resolve('../utils/changedFieldsNormalization')];
    delete require.cache[require.resolve('../utils/notificationRecipientDedup')];
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

describe('Notification recipient fix + changed_fields normalization (real HTTP, real routes/busAdmin.js)', () => {
    const authHeaders = () => ({ Authorization: `Bearer ${generateToken(OPERATOR_ID, OPERATOR_ID)}` });

    /**
     * Starts a fresh fake-backed server for one scenario, runs `fn(ctx)`,
     * and ALWAYS closes the server afterwards (even on assertion failure) —
     * so a failing scenario can never leave a dangling open server holding
     * the test process open.
     */
    async function withScenario(seedFn, opts, fn) {
        const tables = baseTables();
        if (seedFn) seedFn(tables);
        const app = makeApp(tables, opts);
        const server = http.createServer(app);
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const baseUrl = `http://127.0.0.1:${server.address().port}`;
        try {
            await fn({ tables, baseUrl });
        } finally {
            await new Promise((resolve) => server.close(resolve));
        }
    }

    it('A: one booking + 2 active followers with different Telegram IDs -> notificationsQueued=2, two distinct pending follower rows', () =>
        withScenario(t => addFollowers(t, [{ userId: FOLLOWER_1 }, { userId: FOLLOWER_2 }]), undefined, async ({ tables, baseUrl }) => {
            const res = await makeRequest(baseUrl, 'PUT', `/api/bus-admin/tickets/${TICKET_ID}`, authHeaders(), { departure_time: '11:00' });
            assert.equal(res.status, 200, JSON.stringify(res.body));
            assert.equal(res.body.notificationsQueued, 2);

            const followerRows = tables.bus_ticket_notification_outbox.filter(o => [FOLLOWER_1, FOLLOWER_2].includes(o.recipient_user_id));
            assert.equal(followerRows.length, 2);
            assert.ok(followerRows.every(r => r.status === 'pending'));
            assert.notEqual(followerRows[0].recipient_user_id, followerRows[1].recipient_user_id);
        }));

    it('B: legacy recipient without Telegram + two followers -> two pending follower rows, one unreachable legacy row, manualContactRequired=1', () =>
        withScenario(t => addFollowers(t, [{ userId: FOLLOWER_1 }, { userId: FOLLOWER_2 }]), undefined, async ({ tables, baseUrl }) => {
            const res = await makeRequest(baseUrl, 'PUT', `/api/bus-admin/tickets/${TICKET_ID}`, authHeaders(), { departure_time: '11:00' });
            assert.equal(res.status, 200, JSON.stringify(res.body));
            assert.equal(res.body.notificationsQueued, 2);
            assert.equal(res.body.unreachableCount, 1);
            assert.equal(res.body.manualContactRequired, 1);

            const legacyRow = tables.bus_ticket_notification_outbox.find(o => o.recipient_user_id === OPERATOR_ID);
            assert.ok(legacyRow, 'legacy row must still be created');
            assert.equal(legacyRow.status, 'unreachable');
            assert.equal(legacyRow.recipient_telegram_id, null);
        }));

    it('C: a user who is simultaneously legacy AND follower gets exactly one Telegram delivery', () =>
        withScenario(t => {
            t.bus_ticket_bookings[0].claimed_by_user_id = FOLLOWER_1;
            addFollowers(t, [{ userId: FOLLOWER_1 }]); // same user also a follower row
        }, undefined, async ({ tables, baseUrl }) => {
            const res = await makeRequest(baseUrl, 'PUT', `/api/bus-admin/tickets/${TICKET_ID}`, authHeaders(), { departure_time: '11:00' });
            assert.equal(res.status, 200, JSON.stringify(res.body));
            assert.equal(res.body.notificationsQueued, 1);

            const rowsForUser = tables.bus_ticket_notification_outbox.filter(o => o.recipient_user_id === FOLLOWER_1);
            assert.equal(rowsForUser.length, 1, 'no duplicate outbox row for a user who is both legacy and follower');
        }));

    it('D: two different users sharing the SAME Telegram ID -> exactly one Telegram delivery for that booking', () =>
        withScenario(t => addFollowers(t, [{ userId: FOLLOWER_1 }, { userId: FOLLOWER_SHARES_TG_WITH_1 }]), undefined, async ({ tables, baseUrl }) => {
            const res = await makeRequest(baseUrl, 'PUT', `/api/bus-admin/tickets/${TICKET_ID}`, authHeaders(), { departure_time: '11:00' });
            assert.equal(res.status, 200, JSON.stringify(res.body));

            const deliveredToTg55501 = tables.bus_ticket_notification_outbox.filter(o => o.recipient_telegram_id === 55501);
            assert.equal(deliveredToTg55501.length, 1, 'two different user_ids sharing one Telegram account must yield only one delivery');
        }));

    it('E: notifications_enabled=false excludes that follower', () =>
        withScenario(t => addFollowers(t, [
            { userId: FOLLOWER_1, notificationsEnabled: true },
            { userId: FOLLOWER_2, notificationsEnabled: false }
        ]), undefined, async ({ tables, baseUrl }) => {
            const res = await makeRequest(baseUrl, 'PUT', `/api/bus-admin/tickets/${TICKET_ID}`, authHeaders(), { departure_time: '11:00' });
            assert.equal(res.status, 200, JSON.stringify(res.body));
            assert.ok(!tables.bus_ticket_notification_outbox.some(o => o.recipient_user_id === FOLLOWER_2));
            assert.ok(tables.bus_ticket_notification_outbox.some(o => o.recipient_user_id === FOLLOWER_1));
        }));

    it('F: unsubscribed_at not null excludes that follower', () =>
        withScenario(t => addFollowers(t, [
            { userId: FOLLOWER_1, unsubscribedAt: null },
            { userId: FOLLOWER_2, unsubscribedAt: '2026-01-01T00:00:00.000Z' }
        ]), undefined, async ({ tables, baseUrl }) => {
            const res = await makeRequest(baseUrl, 'PUT', `/api/bus-admin/tickets/${TICKET_ID}`, authHeaders(), { departure_time: '11:00' });
            assert.equal(res.status, 200, JSON.stringify(res.body));
            assert.ok(!tables.bus_ticket_notification_outbox.some(o => o.recipient_user_id === FOLLOWER_2));
            assert.ok(tables.bus_ticket_notification_outbox.some(o => o.recipient_user_id === FOLLOWER_1));
        }));

    it('G: one follower without Telegram is counted unreachable while the other follower stays pending', () =>
        withScenario(t => addFollowers(t, [{ userId: FOLLOWER_1 }, { userId: FOLLOWER_NO_TG }]), undefined, async ({ tables, baseUrl }) => {
            const res = await makeRequest(baseUrl, 'PUT', `/api/bus-admin/tickets/${TICKET_ID}`, authHeaders(), { departure_time: '11:00' });
            assert.equal(res.status, 200, JSON.stringify(res.body));

            const followerNoTgRow = tables.bus_ticket_notification_outbox.find(o => o.recipient_user_id === FOLLOWER_NO_TG);
            const follower1Row = tables.bus_ticket_notification_outbox.find(o => o.recipient_user_id === FOLLOWER_1);
            assert.equal(followerNoTgRow.status, 'unreachable');
            assert.equal(follower1Row.status, 'pending');
        }));

    it('H: booking_followers is read via serviceClient — the plain anon client never receives that table', () => {
        const callLog = [];
        return withScenario(t => addFollowers(t, [{ userId: FOLLOWER_1 }]), { callLog }, async ({ baseUrl }) => {
            const res = await makeRequest(baseUrl, 'PUT', `/api/bus-admin/tickets/${TICKET_ID}`, authHeaders(), { departure_time: '11:00' });
            assert.equal(res.status, 200, JSON.stringify(res.body));

            assert.ok(!callLog.some(c => c.client === 'anon' && c.table === 'booking_followers'), 'the anon-key client must never be used to read booking_followers');
            assert.ok(callLog.some(c => c.client === 'service' && c.table === 'booking_followers'), 'booking_followers must be read via serviceClient');
        });
    });

    it('I: users query omits language — id, telegram_id selection succeeds and outbox language is ru', () =>
        withScenario(t => addFollowers(t, [{ userId: FOLLOWER_1 }]), undefined, async ({ tables, baseUrl }) => {
            const res = await makeRequest(baseUrl, 'PUT', `/api/bus-admin/tickets/${TICKET_ID}`, authHeaders(), { departure_time: '11:00' });
            assert.equal(res.status, 200, JSON.stringify(res.body));

            const follower1Row = tables.bus_ticket_notification_outbox.find(o => o.recipient_user_id === FOLLOWER_1);
            assert.equal(follower1Row.status, 'pending');
            assert.equal(follower1Row.recipient_telegram_id, 55501);
            assert.equal(follower1Row.language, 'ru');
        }));

    it('J: "06:35:00" vs "06:35" -> arrival_time is absent from changed_fields (no-op, since it is the only field sent)', () =>
        withScenario(null, undefined, async ({ tables, baseUrl }) => {
            const res = await makeRequest(baseUrl, 'PUT', `/api/bus-admin/tickets/${TICKET_ID}`, authHeaders(), { arrival_time: '06:35' });
            assert.equal(res.status, 200, JSON.stringify(res.body));
            assert.equal(res.body.noChanges, true);
            assert.equal(tables.bus_ticket_change_events.length, 0);
        }));

    it('K: null/""/whitespace for nullable text fields never register as a false change', () =>
        withScenario(null, undefined, async ({ tables, baseUrl }) => {
            const res = await makeRequest(baseUrl, 'PUT', `/api/bus-admin/tickets/${TICKET_ID}`, authHeaders(), {
                group_leader_name: '', // old is null
                group_leader_phone: '   ', // old is ''
                group_leader_whatsapp: '' // old is null
            });
            assert.equal(res.status, 200, JSON.stringify(res.body));
            assert.equal(res.body.noChanges, true);
            assert.equal(tables.bus_ticket_change_events.length, 0);
        }));

    it('L: a real time change is present in changed_fields', () =>
        withScenario(null, undefined, async ({ tables, baseUrl }) => {
            const res = await makeRequest(baseUrl, 'PUT', `/api/bus-admin/tickets/${TICKET_ID}`, authHeaders(), { departure_time: '12:30' });
            assert.equal(res.status, 200, JSON.stringify(res.body));
            assert.equal(res.body.noChanges, undefined);
            assert.equal(tables.bus_ticket_change_events.length, 1);
            assert.deepEqual(tables.bus_ticket_change_events[0].changed_fields, ['departure_time']);
        }));

    it('M: after normalization no changes remain -> RPC not called, no event/outbox created, worker not started, noChanges=true', () =>
        withScenario(t => addFollowers(t, [{ userId: FOLLOWER_1 }]), undefined, async ({ tables, baseUrl }) => {
            const res = await makeRequest(baseUrl, 'PUT', `/api/bus-admin/tickets/${TICKET_ID}`, authHeaders(), {
                arrival_time: '06:35', // old '06:35:00' — same instant
                group_leader_name: '' // old null — semantically empty
            });
            assert.equal(res.status, 200, JSON.stringify(res.body));
            assert.deepEqual(res.body, {
                success: true,
                noChanges: true,
                bus_replaced: false,
                notificationsQueued: 0,
                unreachableCount: 0,
                manualContactRequired: 0,
                seatsRemapped: 0
            });
            assert.equal(tables.bus_ticket_change_events.length, 0, 'no change event on a no-op save');
            assert.equal(tables.bus_ticket_notification_outbox.length, 0, 'no outbox rows on a no-op save');
        }));

    it('N: a real price-only change stays price-only even when a phantom (format-only) field is also present — no Telegram schedule-change outbox', () =>
        withScenario(t => addFollowers(t, [{ userId: FOLLOWER_1 }]), undefined, async ({ tables, baseUrl }) => {
            const res = await makeRequest(baseUrl, 'PUT', `/api/bus-admin/tickets/${TICKET_ID}`, authHeaders(), {
                price: 999,
                arrival_time: '06:35' // old '06:35:00' — format-only, normalizes to no change
            });
            assert.equal(res.status, 200, JSON.stringify(res.body));
            assert.equal(res.body.notificationsQueued, 0, 'price-only edits must not generate Telegram trip-change notifications');
            assert.equal(tables.bus_ticket_notification_outbox.length, 0);
            assert.equal(tables.bus_ticket_change_events.length, 1);
            assert.equal(tables.bus_ticket_change_events[0].change_type, 'price_update');
            assert.deepEqual(tables.bus_ticket_change_events[0].changed_fields, ['price']);
        }));

    it('O: serviceClient error reading followers -> no crash, legacy path stays functional, safe degradation', () => {
        const followerReadError = { message: 'simulated transient error reading booking_followers', code: '55000' };
        return withScenario(
            t => {
                addFollowers(t, [{ userId: FOLLOWER_1 }]);
                t.users.find(u => u.id === OPERATOR_ID).telegram_id = 900901; // legacy recipient IS reachable here
            },
            { serviceWrap: (client) => withErrorInjection(client, 'booking_followers', followerReadError) },
            async ({ tables, baseUrl }) => {
                const res = await makeRequest(baseUrl, 'PUT', `/api/bus-admin/tickets/${TICKET_ID}`, authHeaders(), { departure_time: '11:00' });
                assert.equal(res.status, 200, JSON.stringify(res.body), 'a follower-read failure must never crash the request');
                // Only the legacy recipient (reachable) was queued — followers
                // could not be resolved this time, so we must NOT assert they
                // were sent.
                assert.equal(res.body.notificationsQueued, 1);
                assert.equal(tables.bus_ticket_change_events.length, 1, 'legacy schedule-change event must still be created');
                const legacyRow = tables.bus_ticket_notification_outbox.find(o => o.recipient_user_id === OPERATOR_ID);
                assert.ok(legacyRow, 'legacy recipient outbox row must still be created despite the follower-read failure');
                assert.equal(legacyRow.status, 'pending');
            }
        );
    });
});
