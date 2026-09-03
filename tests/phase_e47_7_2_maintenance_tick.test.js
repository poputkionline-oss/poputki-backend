/**
 * tests/phase_e47_7_2_maintenance_tick.test.js
 *
 * PHASE E.47.7.2 — Unified Maintenance Tick (POST /api/admin/maintenance/tick)
 *
 * Verifies:
 *  1. unauthenticated maintenance tick -> blocked
 *  2. authorized dry run -> no mutation
 *  3. dry-run expire-pending preview -> correct would_expire count
 *  4. dry-run auto-complete preview -> correct eligible counts
 *  5. legacy trip -> excluded
 *  6. post-watermark before arrival+12h -> excluded
 *  7. post-watermark after arrival+12h -> would-complete
 *  8. real execution expire-pending -> canonical helper used
 *  9. real execution auto-complete -> canonical helper used
 * 10. expire-pending failure -> auto-complete still runs
 * 11. auto-complete failure -> expire-pending result preserved
 * 12. repeated tick -> idempotent
 * 13. no finance changes from trip completion
 * 14. Ticket V1.1 unchanged
 * 15. QR scanner logic unchanged
 * 16. E.45 claim behavior preserved
 * 17. no secret in response/errors
 *
 * Reuses the reference fn_complete_bus_trip mock + generic in-memory
 * Supabase mock established in tests/phase_e47_2_atomic_trip_completion.test.js
 * and tests/phase_e47_6_watermark.test.js, and the payment-expiration mock
 * fixture shape from tests/phase_p15_payment_expiration.test.js.
 */

process.env.JWT_SECRET = 'test-jwt-secret-poputki-secure-key-12345';
process.env.ADMIN_SECRET_TOKEN = 'test-admin-secret';
process.env.SUPABASE_URL = 'https://test-local-only.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-local-service-role-key-not-real';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { runMaintenanceTick } = require('../utils/maintenanceHelper');
const { generateTicketVerificationToken } = require('../utils/ticketHelper');
const { evaluateAutoClaimEligibility } = require('../utils/claimHelper');

// ---------------------------------------------------------------------------
// Reference fn_complete_bus_trip mock (see phase_e47_2 for the SQL cross-ref)
// ---------------------------------------------------------------------------
function simulateFnCompleteBusTrip(mockDb, { p_trip_id, p_expected_operator_id }) {
    const trip = (mockDb.bus_tickets || []).find(t => Number(t.id) === Number(p_trip_id));
    if (!trip) return { success: false, error: 'TRIP_NOT_FOUND' };

    if (p_expected_operator_id != null && Number(trip.operator_id) !== Number(p_expected_operator_id)) {
        return { success: false, error: 'TRIP_OWNERSHIP_MISMATCH' };
    }

    if (trip.status === 'completed') {
        return { success: true, already_completed: true, trip_id: trip.id, no_show_marked: 0 };
    }

    if (trip.status !== 'active') {
        return { success: false, error: 'TRIP_NOT_ACTIVE', status: trip.status };
    }

    const targets = (mockDb.bus_ticket_bookings || []).filter(b =>
        Number(b.bus_ticket_id) === Number(p_trip_id) &&
        b.status === 'confirmed' &&
        (b.boarding_status === 'pending_boarding' || b.boarding_status == null)
    );
    targets.forEach(b => { b.boarding_status = 'no_show'; });

    trip.status = 'completed';

    return { success: true, already_completed: false, trip_id: trip.id, no_show_marked: targets.length };
}

function matchRow(row, filters) {
    return filters.every(f => {
        if (f.type === 'eq') return String(row[f.field]) === String(f.value);
        if (f.type === 'neq') return String(row[f.field]) !== String(f.value);
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
                return mockDb[table].filter(r => matchRow(r, filters)).map(r => JSON.parse(JSON.stringify(r)));
            }

            const builder = {
                select() { if (!mode) mode = 'select'; return builder; },
                update(fields) { mode = 'update'; payload = fields; return builder; },
                insert(rows) { mode = 'insert'; payload = rows; return builder; },
                eq(field, value) { filters.push({ type: 'eq', field, value }); return builder; },
                neq(field, value) { filters.push({ type: 'neq', field, value }); return builder; },
                order() { return builder; },
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
        },
        async rpc(name, params) {
            if (name === 'fn_complete_bus_trip') {
                return { data: simulateFnCompleteBusTrip(mockDb, params), error: null };
            }
            return { data: null, error: new Error(`Unmocked RPC: ${name}`) };
        }
    };
}

// A client that fails every call against ONE table, so a single maintenance
// task can be made to fail in isolation without touching the other task's
// tables (auto-complete's RPC path never touches bus_ticket_bookings via
// .from() — the simulated RPC mutates mockDb directly — so breaking
// bus_ticket_bookings only breaks expire-pending, and vice versa breaking
// bus_tickets only breaks auto-complete's initial active-trip scan).
function makeFaultyMockSupabase(mockDb, brokenTable) {
    const base = makeMockSupabase(mockDb);
    return {
        rpc: base.rpc,
        from(table) {
            if (table === brokenTable) {
                const failingBuilder = {
                    select() { return failingBuilder; },
                    eq() { return failingBuilder; },
                    then(resolve) { resolve({ data: null, error: new Error(`SIMULATED_${brokenTable}_FAILURE`) }); }
                };
                return failingBuilder;
            }
            return base.from(table);
        }
    };
}

const LEGACY_CREATED_AT = '2026-07-01T00:00:00.000Z'; // before watermark (2026-08-15)
const POST_WATERMARK_CREATED_AT = '2026-09-01T00:00:00.000Z'; // after watermark

function freshMockDb() {
    return {
        bus_tickets: [
            // legacy trip, past arrival+12h -> must be excluded from auto-complete
            { id: 7040, operator_id: 301, status: 'active', created_at: LEGACY_CREATED_AT, arrival_date: '2020-01-01', arrival_time: '00:00:00' },
            // post-watermark, future arrival -> not yet eligible
            { id: 7100, operator_id: 301, status: 'active', created_at: POST_WATERMARK_CREATED_AT, arrival_date: '2099-01-01', arrival_time: '00:00:00' },
            // post-watermark, past arrival+12h -> eligible / would-complete
            { id: 7200, operator_id: 301, status: 'active', created_at: POST_WATERMARK_CREATED_AT, arrival_date: '2020-01-01', arrival_time: '00:00:00' }
        ],
        bus_ticket_bookings: [
            { id: 72001, bus_ticket_id: 7200, status: 'confirmed', boarding_status: 'pending_boarding', passenger_name: 'Passenger', total_price: 700, commission_amount: 70, carrier_amount: 630 },
            // pending_payment bookings for expire-pending
            { id: 8001, bus_ticket_id: 9999, status: 'pending_payment', hold_expires_at: '2020-01-01T00:00:00Z', bus_tickets: { operator_id: 301 } }, // expired
            { id: 8002, bus_ticket_id: 9999, status: 'pending_payment', hold_expires_at: '2099-01-01T00:00:00Z', bus_tickets: { operator_id: 301 } }  // active hold
        ],
        carrier_activity_logs: []
    };
}

// =============================================================================
// PART 1 — runMaintenanceTick (unit-level, via injected dbClient)
// =============================================================================
describe('Phase E.47.7.2 — runMaintenanceTick', () => {
    it('2/3/4. authorized dry run: correct would_expire / eligible counts, zero mutation', async () => {
        const db = freshMockDb();
        const dbClient = makeMockSupabase(db);

        const result = await runMaintenanceTick({ dryRun: true, dbClient });

        assert.equal(result.success, true);
        assert.equal(result.tasks.expire_pending.success, true);
        assert.equal(result.tasks.expire_pending.dry_run, true);
        assert.equal(result.tasks.expire_pending.expired, 1, 'exactly one pending_payment booking is past its hold');

        assert.equal(result.tasks.auto_complete.success, true);
        assert.equal(result.tasks.auto_complete.dry_run, true);
        assert.equal(result.tasks.auto_complete.scanned, 3);
        assert.equal(result.tasks.auto_complete.eligible, 1, 'only trip 7200 is post-watermark AND past arrival+12h');

        // Zero mutation: nothing in the mock DB changed state.
        assert.equal(db.bus_ticket_bookings.find(b => b.id === 8001).status, 'pending_payment');
        assert.equal(db.bus_tickets.find(t => t.id === 7200).status, 'active');
        assert.equal(db.bus_ticket_bookings.find(b => b.id === 72001).boarding_status, 'pending_boarding');
    });

    it('5. legacy trip is excluded from auto-complete (even in dry-run would_complete details)', async () => {
        const db = freshMockDb();
        const dbClient = makeMockSupabase(db);
        const result = await runMaintenanceTick({ dryRun: true, dbClient });
        const wouldCompleteIds = result.tasks.auto_complete.details.map(d => d.trip_id);
        assert.ok(!wouldCompleteIds.includes(7040), 'legacy trip must never appear in would_complete');
    });

    it('6. post-watermark trip before arrival+12h is excluded', async () => {
        const db = freshMockDb();
        const dbClient = makeMockSupabase(db);
        const result = await runMaintenanceTick({ dryRun: true, dbClient });
        const wouldCompleteIds = result.tasks.auto_complete.details.map(d => d.trip_id);
        assert.ok(!wouldCompleteIds.includes(7100), 'future-arrival post-watermark trip must not appear');
    });

    it('7. post-watermark trip after arrival+12h appears in would_complete', async () => {
        const db = freshMockDb();
        const dbClient = makeMockSupabase(db);
        const result = await runMaintenanceTick({ dryRun: true, dbClient });
        const wouldCompleteIds = result.tasks.auto_complete.details.map(d => d.trip_id);
        assert.deepEqual(wouldCompleteIds, [7200]);
    });

    it('8. real execution: expire-pending uses the canonical helper and actually cancels the expired booking', async () => {
        const db = freshMockDb();
        const dbClient = makeMockSupabase(db);
        const result = await runMaintenanceTick({ dbClient });

        assert.equal(result.tasks.expire_pending.cancelled, 1);
        assert.equal(db.bus_ticket_bookings.find(b => b.id === 8001).status, 'cancelled');
        assert.equal(db.bus_ticket_bookings.find(b => b.id === 8002).status, 'pending_payment', 'active hold untouched');
    });

    it('9. real execution: auto-complete uses the canonical helper (atomic RPC) and completes the eligible trip', async () => {
        const db = freshMockDb();
        const dbClient = makeMockSupabase(db);
        const result = await runMaintenanceTick({ dbClient });

        assert.equal(result.tasks.auto_complete.completed, 1);
        assert.equal(db.bus_tickets.find(t => t.id === 7200).status, 'completed');
        assert.equal(db.bus_ticket_bookings.find(b => b.id === 72001).boarding_status, 'no_show');
        assert.equal(db.bus_tickets.find(t => t.id === 7040).status, 'active', 'legacy trip never completed');
    });

    it('10. expire-pending task failure does not prevent auto-complete from running', async () => {
        const db = freshMockDb();
        const dbClient = makeFaultyMockSupabase(db, 'bus_ticket_bookings');

        const result = await runMaintenanceTick({ dbClient });

        assert.equal(result.tasks.expire_pending.success, false);
        assert.ok(result.tasks.expire_pending.error);
        assert.equal(result.tasks.auto_complete.success, true, 'auto_complete must still run and succeed');
        assert.equal(result.tasks.auto_complete.completed, 1);
        assert.equal(result.success, false, 'overall success is false when either task failed');
    });

    it('11. auto-complete task failure preserves the expire-pending result', async () => {
        const db = freshMockDb();
        const dbClient = makeFaultyMockSupabase(db, 'bus_tickets');

        const result = await runMaintenanceTick({ dbClient });

        assert.equal(result.tasks.auto_complete.success, false);
        assert.ok(result.tasks.auto_complete.error);
        assert.equal(result.tasks.expire_pending.success, true, 'expire_pending must still run and succeed');
        assert.equal(result.tasks.expire_pending.cancelled, 1);
        assert.equal(result.success, false);
    });

    it('12. repeated tick is idempotent: second run does nothing new', async () => {
        const db = freshMockDb();
        const dbClient = makeMockSupabase(db);

        await runMaintenanceTick({ dbClient });
        const snapshotAfterFirst = JSON.stringify({ tickets: db.bus_tickets, bookings: db.bus_ticket_bookings });

        const second = await runMaintenanceTick({ dbClient });
        assert.equal(second.tasks.expire_pending.cancelled, 0);
        assert.equal(second.tasks.auto_complete.completed, 0);
        assert.equal(JSON.stringify({ tickets: db.bus_tickets, bookings: db.bus_ticket_bookings }), snapshotAfterFirst);
    });

    it('13. FINANCE_UNCHANGED: commission/payout fields untouched by trip completion via the tick', async () => {
        const db = freshMockDb();
        const dbClient = makeMockSupabase(db);
        await runMaintenanceTick({ dbClient });
        const row = db.bus_ticket_bookings.find(b => b.id === 72001);
        assert.equal(row.total_price, 700);
        assert.equal(row.commission_amount, 70);
        assert.equal(row.carrier_amount, 630);
    });

    it('14/15. TICKET_V1_1_UNCHANGED / QR_SCANNER_UNCHANGED: HMAC verification token derivation is unaffected', async () => {
        const before = generateTicketVerificationToken(72001);
        const db = freshMockDb();
        const dbClient = makeMockSupabase(db);
        await runMaintenanceTick({ dbClient });
        const after = generateTicketVerificationToken(72001);
        assert.equal(before, after);
    });

    it('16. E45_PRESERVED: verified-phone auto-claim remains independent of contact_role', () => {
        const verifiedUser = { id: 1121, telegram_id: '99887766', phone: '+992900000000', name: 'Test Passenger' };
        const familyGroupBooking = {
            id: 504, status: 'confirmed', claim_status: null, claimed_by_user_id: null,
            phone: '+992900000000', contact_role: 'family_or_group'
        };
        const res = evaluateAutoClaimEligibility(familyGroupBooking, verifiedUser, {}, '99887766');
        assert.equal(res.canAutoClaim, true);
        assert.equal(res.method, 'known_user_phone_match');
    });

    it('17. no secret leaks into the response, including on task failure', async () => {
        const db = freshMockDb();
        const dbClient = makeFaultyMockSupabase(db, 'bus_ticket_bookings');
        const result = await runMaintenanceTick({ dbClient });
        const resStr = JSON.stringify(result);

        assert.ok(!resStr.includes(process.env.ADMIN_SECRET_TOKEN));
        assert.ok(!resStr.includes(process.env.SUPABASE_SERVICE_ROLE_KEY));
        assert.ok(!resStr.toLowerCase().includes('x-admin-token'));
    });
});

// =============================================================================
// PART 2 — HTTP integration: auth gating on the real route
// =============================================================================
describe('Phase E.47.7.2 — POST /api/admin/maintenance/tick (HTTP)', () => {
    function makeApp(sharedDb) {
        const dbPath = require.resolve('../db');
        require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: makeMockSupabase(sharedDb) };

        const serviceRolePath = require.resolve('../dbServiceRole');
        require.cache[serviceRolePath] = {
            id: serviceRolePath, filename: serviceRolePath, loaded: true,
            exports: {
                getServiceRoleClient: () => makeMockSupabase(sharedDb),
                getServiceRoleDiagnostics: () => ({})
            }
        };

        delete require.cache[require.resolve('../utils/tripCompletionHelper')];
        delete require.cache[require.resolve('../utils/paymentExpirationHelper')];
        delete require.cache[require.resolve('../utils/maintenanceHelper')];
        delete require.cache[require.resolve('../routes/admin')];

        const express = require('express');
        const adminRouter = require('../routes/admin');
        const app = express();
        app.use(express.json());
        app.use('/api/admin', adminRouter);
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

    let server, baseUrl;
    const startServer = (app) => new Promise((resolve) => {
        server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
    });
    const stopServer = () => new Promise((resolve) => server.close(resolve));

    it('1. unauthenticated maintenance tick is blocked (401)', async () => {
        const db = freshMockDb();
        const app = makeApp(db);
        await startServer(app);

        const res = await makeRequest(baseUrl, 'POST', '/api/admin/maintenance/tick', {});
        assert.equal(res.status, 401);

        await stopServer();
    });

    it('authorized dry-run over HTTP returns structured per-task results and mutates nothing', async () => {
        const db = freshMockDb();
        const app = makeApp(db);
        await startServer(app);

        const res = await makeRequest(baseUrl, 'POST', '/api/admin/maintenance/tick?dry_run=true', { 'X-Admin-Token': 'test-admin-secret' });
        assert.equal(res.status, 200);
        assert.equal(res.body.success, true);
        assert.ok(res.body.tasks.expire_pending);
        assert.ok(res.body.tasks.auto_complete);
        assert.equal(res.body.tasks.expire_pending.dry_run, true);
        assert.equal(res.body.tasks.auto_complete.dry_run, true);
        assert.equal(db.bus_tickets.find(t => t.id === 7200).status, 'active');

        await stopServer();
    });

    it('legacy endpoints remain available for backward compatibility', async () => {
        const db = freshMockDb();
        const app = makeApp(db);
        await startServer(app);

        const r1 = await makeRequest(baseUrl, 'POST', '/api/admin/bookings/expire-pending?dry_run=true', { 'X-Admin-Token': 'test-admin-secret' });
        assert.equal(r1.status, 200);

        const r2 = await makeRequest(baseUrl, 'POST', '/api/admin/trips/auto-complete?dry_run=true', { 'X-Admin-Token': 'test-admin-secret' });
        assert.equal(r2.status, 200);

        await stopServer();
    });
});
