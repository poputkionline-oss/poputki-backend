/**
 * tests/phase_e47_2_atomic_trip_completion.test.js
 *
 * PHASE E.47.2 — Atomic Trip Completion (fn_complete_bus_trip RPC)
 *
 * The canonical completion service (utils/tripCompletionHelper.js) now
 * delegates the actual mutation to a single Postgres transaction via the
 * fn_complete_bus_trip(...) RPC (docs/migrations/20260902_atomic_trip_completion.sql),
 * used identically by BOTH manual completion (POST /bus-admin/tickets/:id/complete)
 * and the automatic arrival+12h sweep (POST /admin/trips/auto-complete).
 *
 * Testing strategy (mirrors the project's own fn_claim_booking_auto tests in
 * tests/phase_e2b_claim_security.test.js):
 *  1. Spy-style unit tests verify the JS layer calls the RPC with the exact
 *     expected name/params, and correctly propagates success/failure/
 *     idempotent results from the RPC's JSONB response.
 *  2. A hand-written JS mock of fn_complete_bus_trip's documented contract
 *     (lock -> ownership check -> idempotent check -> STEP1 -> STEP2) is used
 *     for deeper HTTP-level integration tests and the sequential
 *     "concurrent calls" contract test. This validates that the calling code
 *     (routes + tripCompletionHelper.js) correctly drives the RPC contract.
 *     It does NOT prove real Postgres row-locking under true parallel
 *     transactions — that guarantee lives in the deployed SQL function and
 *     is checked separately below by a static assertion over the migration
 *     file's contents (FOR UPDATE lock, single function body, grants).
 *  3. HTTP integration tests mock dbServiceRole.getServiceRoleClient() (the
 *     only client the RPC is GRANTed to) via require.cache, the same
 *     technique used for '../db' in tests/phase_e47_1_qr_boarding_trip_completion.test.js.
 */

process.env.JWT_SECRET = 'test-jwt-secret-poputki-secure-key-12345';
process.env.ADMIN_SECRET_TOKEN = 'test-admin-secret';
process.env.SUPABASE_URL = 'https://test-local-only.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-local-service-role-key-not-real';

const test = require('node:test');
const { describe, it } = test;
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const {
    completeTrip,
    sweepAutoCompleteTrips,
    isTripEligibleForAutoComplete,
    getTripArrivalInstant,
    zonedTimeToUtcDate
} = require('../utils/tripCompletionHelper');
const { generateTicketVerificationToken } = require('../utils/ticketHelper');

// ---------------------------------------------------------------------------
// Reference JS mirror of fn_complete_bus_trip(p_trip_id, p_expected_operator_id)
// See docs/migrations/20260902_atomic_trip_completion.sql for the real SQL.
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

// ---------------------------------------------------------------------------
// Generic in-memory Supabase-like mock (table ops + the RPC contract above)
// ---------------------------------------------------------------------------
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

function freshMockDb() {
    return {
        bus_tickets: [
            // All fixture trips are created well after the E.47.6 watermark
            // (2026-08-15T00:00:00Z) — this suite tests general eligibility
            // behavior, not legacy protection (see phase_e47_6_watermark.test.js).
            { id: 720, operator_id: 301, status: 'active', from_city: 'Душанбе', to_city: 'Канибадам', created_at: '2026-09-01T00:00:00.000Z' },
            { id: 710, operator_id: 301, status: 'active', from_city: 'A', to_city: 'B', created_at: '2026-09-01T00:00:00.000Z', arrival_date: '2020-01-01', arrival_time: '00:00:00' }, // long past -> eligible
            { id: 711, operator_id: 301, status: 'active', from_city: 'A', to_city: 'B', created_at: '2026-09-01T00:00:00.000Z', ...(() => { const f = formatInBusinessTz(new Date(Date.now() - 3600 * 1000)); return { arrival_date: f.date, arrival_time: f.time }; })() }, // arrived 1h ago -> not yet 12h
            { id: 712, operator_id: 301, status: 'active', from_city: 'A', to_city: 'B', created_at: '2026-09-01T00:00:00.000Z', arrival_date: null, arrival_time: null }, // missing arrival
            { id: 801, operator_id: 401, status: 'active', from_city: 'Москва', to_city: 'Душанбе', created_at: '2026-09-01T00:00:00.000Z' } // different carrier
        ],
        bus_ticket_bookings: [
            { id: 9001, bus_ticket_id: 701, status: 'confirmed', boarding_status: 'pending_boarding', total_price: 700, commission_amount: 70, carrier_amount: 630 },
            { id: 9101, bus_ticket_id: 720, status: 'confirmed', boarding_status: 'pending_boarding', boarded_at: null, boarded_by_user_id: null, passenger_name: 'Ожидает', seat_numbers: [1] },
            { id: 9102, bus_ticket_id: 720, status: 'confirmed', boarding_status: 'boarded', boarded_at: '2026-01-01T00:00:00.000Z', boarded_by_user_id: 301, passenger_name: 'Посажен', seat_numbers: [2] },
            { id: 9103, bus_ticket_id: 720, status: 'confirmed', boarding_status: 'no_show', boarded_at: null, boarded_by_user_id: null, passenger_name: 'УжеНеЯвился', seat_numbers: [3] },
            { id: 9104, bus_ticket_id: 720, status: 'cancelled', boarding_status: 'pending_boarding', boarded_at: null, boarded_by_user_id: null, passenger_name: 'Отменена', seat_numbers: [4] },
            { id: 9105, bus_ticket_id: 720, status: 'pending_payment', boarding_status: 'pending_boarding', boarded_at: null, boarded_by_user_id: null, passenger_name: 'Ждет оплаты', seat_numbers: [5] }
        ],
        carrier_activity_logs: []
    };
}

// Formats a target instant into { date, time } as seen in Asia/Dushanbe.
function formatInBusinessTz(instant) {
    const dtf = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Dushanbe', hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
    const parts = dtf.formatToParts(instant);
    const get = (type) => parts.find(p => p.type === type).value;
    return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}:${get('second')}` };
}

// =============================================================================
// PART 1 — RPC CONTRACT: name/params spy tests (mirrors phase_e2b_claim_security.test.js)
// =============================================================================
describe('Phase E.47.2 — fn_complete_bus_trip RPC call contract', () => {
    it('MANUAL_COMPLETION_USES_RPC: completeTrip calls fn_complete_bus_trip with p_expected_operator_id from a carrier actorContext', async () => {
        let captured = null;
        const dbClient = {
            async rpc(name, params) {
                captured = { name, params };
                return { data: { success: true, already_completed: false, trip_id: 720, no_show_marked: 2 }, error: null };
            }
        };

        const result = await completeTrip({
            tripId: 720,
            actorContext: { carrier_id: 301, user_id: 301, role: 'owner', name: 'Owner' },
            dbClient
        });

        assert.equal(result.success, true);
        assert.equal(captured.name, 'fn_complete_bus_trip');
        assert.deepEqual(captured.params, { p_trip_id: 720, p_expected_operator_id: 301 });
    });

    it('AUTO_COMPLETION_USES_RPC: the sweep\'s system actor passes p_expected_operator_id = null (no single-carrier context)', async () => {
        let captured = null;
        const dbClient = {
            async rpc(name, params) {
                captured = { name, params };
                return { data: { success: true, already_completed: false, trip_id: 710, no_show_marked: 0 }, error: null };
            }
        };

        await completeTrip({
            tripId: 710,
            actorContext: { carrier_id: 301, user_id: 0, role: 'system', name: 'Система (Авто-завершение рейса)' },
            dbClient
        });

        assert.equal(captured.name, 'fn_complete_bus_trip');
        assert.deepEqual(captured.params, { p_trip_id: 710, p_expected_operator_id: null });
    });

    it('propagates an RPC-level business rejection without local retry/mutation', async () => {
        const dbClient = { async rpc() { return { data: { success: false, error: 'TRIP_OWNERSHIP_MISMATCH' }, error: null }; } };
        const result = await completeTrip({ tripId: 720, dbClient });
        assert.equal(result.success, false);
        assert.equal(result.error, 'TRIP_OWNERSHIP_MISMATCH');
    });

    it('propagates a transport-level RPC error (network/DB failure) as RPC_FAILED', async () => {
        const dbClient = { async rpc() { return { data: null, error: new Error('connection reset') }; } };
        const result = await completeTrip({ tripId: 720, dbClient });
        assert.equal(result.success, false);
        assert.equal(result.error, 'RPC_FAILED');
    });

    it('propagates the idempotent already_completed branch verbatim', async () => {
        const dbClient = { async rpc() { return { data: { success: true, already_completed: true, trip_id: 720, no_show_marked: 0 }, error: null }; } };
        const result = await completeTrip({ tripId: 720, dbClient });
        assert.equal(result.success, true);
        assert.equal(result.already_completed, true);
        assert.equal(result.no_show_marked, 0);
    });

    it('never calls the RPC when tripId is missing', async () => {
        let called = false;
        const dbClient = { async rpc() { called = true; return { data: null, error: null }; } };
        const result = await completeTrip({ dbClient });
        assert.equal(result.success, false);
        assert.equal(result.error, 'TRIP_ID_REQUIRED');
        assert.equal(called, false);
    });
});

// =============================================================================
// PART 2 — Business behavior against the reference RPC-contract mock
// =============================================================================
describe('Phase E.47.2 — completeTrip business behavior (via reference RPC mock)', () => {
    it('pending_boarding confirmed -> no_show; boarded/no_show/cancelled/pending_payment preserved', async () => {
        const db = freshMockDb();
        const dbClient = makeMockSupabase(db);

        const result = await completeTrip({ tripId: 720, actorContext: { carrier_id: 301, user_id: 301, role: 'owner', name: 'Owner' }, dbClient });
        assert.equal(result.success, true);
        assert.equal(result.already_completed, false);
        assert.equal(result.no_show_marked, 1);

        assert.equal(db.bus_tickets.find(t => t.id === 720).status, 'completed');
        assert.equal(db.bus_ticket_bookings.find(b => b.id === 9101).boarding_status, 'no_show');
        assert.equal(db.bus_ticket_bookings.find(b => b.id === 9102).boarding_status, 'boarded', 'boarded preserved');
        assert.equal(db.bus_ticket_bookings.find(b => b.id === 9102).boarded_at, '2026-01-01T00:00:00.000Z', 'boarded_at must not churn');
        assert.equal(db.bus_ticket_bookings.find(b => b.id === 9103).boarding_status, 'no_show', 'already no_show preserved');
        assert.equal(db.bus_ticket_bookings.find(b => b.id === 9104).boarding_status, 'pending_boarding', 'cancelled booking never touched');
        assert.equal(db.bus_ticket_bookings.find(b => b.id === 9105).boarding_status, 'pending_boarding', 'pending_payment booking never touched');

        const log = db.carrier_activity_logs.find(l => l.action === 'trip_completed' && String(l.entity_id) === '720');
        assert.ok(log, 'TRIP_COMPLETED audit entry must be recorded');
    });

    it('second completion is idempotent: no double no_show, no churn, no duplicate audit log', async () => {
        const db = freshMockDb();
        const dbClient = makeMockSupabase(db);

        await completeTrip({ tripId: 720, actorContext: { carrier_id: 301, user_id: 301, role: 'owner' }, dbClient });
        const logsAfterFirst = db.carrier_activity_logs.filter(l => l.action === 'trip_completed').length;
        const boardedBefore = JSON.stringify(db.bus_ticket_bookings.find(b => b.id === 9102));

        const second = await completeTrip({ tripId: 720, actorContext: { carrier_id: 301, user_id: 301, role: 'owner' }, dbClient });
        assert.equal(second.success, true);
        assert.equal(second.already_completed, true);
        assert.equal(second.no_show_marked, 0);

        assert.equal(JSON.stringify(db.bus_ticket_bookings.find(b => b.id === 9102)), boardedBefore, 'no churn on already-boarded row');
        assert.equal(db.carrier_activity_logs.filter(l => l.action === 'trip_completed').length, logsAfterFirst, 'idempotent no-op must not double-log');
    });

    it('CONCURRENT_COMPLETION_SAFE (contract-level): two overlapping completion requests for the same trip converge to one completion, no_show applied exactly once', async () => {
        const db = freshMockDb();
        const dbClient = makeMockSupabase(db);
        const actorContext = { carrier_id: 301, user_id: 301, role: 'owner' };

        // Two "simultaneous" completion requests, issued together via Promise.all
        // exactly as two concurrent HTTP requests would race in the route handler.
        const [r1, r2] = await Promise.all([
            completeTrip({ tripId: 720, actorContext, dbClient }),
            completeTrip({ tripId: 720, actorContext, dbClient })
        ]);

        const outcomes = [r1, r2].map(r => r.already_completed);
        assert.deepEqual(outcomes.sort(), [false, true], 'exactly one call performs the real completion, the other observes it as already-completed');

        const noShowCounts = [r1, r2].map(r => r.no_show_marked);
        assert.deepEqual(noShowCounts.sort(), [0, 1], 'no_show is applied exactly once across both calls, never twice');

        assert.equal(db.bus_tickets.find(t => t.id === 720).status, 'completed');
        assert.equal(db.bus_ticket_bookings.find(b => b.id === 9101).boarding_status, 'no_show');
        assert.equal(db.carrier_activity_logs.filter(l => l.action === 'trip_completed' && String(l.entity_id) === '720').length, 1, 'no duplicate audit side-effect');
    });

    it('cross-carrier ownership mismatch is rejected (defense-in-depth inside the RPC)', async () => {
        const db = freshMockDb();
        const dbClient = makeMockSupabase(db);
        const result = await completeTrip({ tripId: 801, actorContext: { carrier_id: 301, user_id: 301, role: 'owner' }, dbClient });
        assert.equal(result.success, false);
        assert.equal(result.error, 'TRIP_OWNERSHIP_MISMATCH');
        assert.equal(db.bus_tickets.find(t => t.id === 801).status, 'active', 'other carrier\'s trip must remain untouched');
    });

    it('completeTrip on a non-existent trip returns TRIP_NOT_FOUND', async () => {
        const db = freshMockDb();
        const dbClient = makeMockSupabase(db);
        const result = await completeTrip({ tripId: 999999, dbClient });
        assert.equal(result.success, false);
        assert.equal(result.error, 'TRIP_NOT_FOUND');
    });

    it('FINANCE_UNCHANGED / PAYMENT_UNCHANGED: commission/payout fields never touched by completion', async () => {
        const db = freshMockDb();
        const dbClient = makeMockSupabase(db);
        db.bus_tickets.push({ id: 730, operator_id: 301, status: 'active' });
        db.bus_ticket_bookings.push({ id: 9301, bus_ticket_id: 730, status: 'confirmed', boarding_status: 'pending_boarding', total_price: 700, commission_amount: 70, carrier_amount: 630 });

        await completeTrip({ tripId: 730, dbClient });
        const row = db.bus_ticket_bookings.find(b => b.id === 9301);
        assert.equal(row.total_price, 700);
        assert.equal(row.commission_amount, 70);
        assert.equal(row.carrier_amount, 630);
        assert.equal(row.boarding_status, 'no_show');
    });

    it('TICKET_V1_1_UNCHANGED: HMAC verification token derivation is unaffected by completion', async () => {
        const before = generateTicketVerificationToken(9101);
        const db = freshMockDb();
        const dbClient = makeMockSupabase(db);
        await completeTrip({ tripId: 720, dbClient });
        const after = generateTicketVerificationToken(9101);
        assert.equal(before, after);
    });
});

// =============================================================================
// PART 3 — Auto-complete eligibility & timezone semantics (pure functions, unchanged from E.47.1)
// =============================================================================
describe('Phase E.47.2 — Auto-complete eligibility & Asia/Dushanbe timezone', () => {
    it('zonedTimeToUtcDate interprets arrival as Asia/Dushanbe (UTC+5)', () => {
        const d = zonedTimeToUtcDate('2026-09-01', '13:00', 'Asia/Dushanbe');
        assert.equal(d.toISOString(), '2026-09-01T08:00:00.000Z');
    });

    it('arrival + 12h boundary is respected', () => {
        // created_at must be post-watermark (Phase E.47.6) for this trip to be
        // in scope for auto-completion at all — see phase_e47_6_watermark.test.js.
        const trip = { status: 'active', created_at: '2026-09-01T00:00:00.000Z', arrival_date: '2026-09-01', arrival_time: '13:00:00' };
        const arrival = getTripArrivalInstant(trip);
        const justBefore = new Date(arrival.getTime() + 12 * 3600 * 1000 - 1000);
        const justAfter = new Date(arrival.getTime() + 12 * 3600 * 1000 + 1000);
        assert.equal(isTripEligibleForAutoComplete(trip, justBefore), false);
        assert.equal(isTripEligibleForAutoComplete(trip, justAfter), true);
    });

    it('completed trips and missing-arrival trips are excluded; departure is never used as a fallback base', () => {
        assert.equal(isTripEligibleForAutoComplete({ status: 'completed', arrival_date: '2020-01-01', arrival_time: '00:00' }), false);
        assert.equal(isTripEligibleForAutoComplete({ status: 'active', arrival_date: null, arrival_time: null, departure_date: '2020-01-01', departure_time: '00:00' }), false);
        assert.equal(isTripEligibleForAutoComplete(null), false);
    });
});

// =============================================================================
// PART 4 — sweepAutoCompleteTrips (unit-level, via reference RPC mock)
// =============================================================================
describe('Phase E.47.2 — sweepAutoCompleteTrips', () => {
    it('completes only eligible trips (arrival+12h elapsed); skips recent/missing-arrival/other-carrier as appropriate', async () => {
        const db = freshMockDb();
        const dbClient = makeMockSupabase(db);
        const result = await sweepAutoCompleteTrips({ dbClient });

        assert.equal(result.completed, 1);
        assert.equal(db.bus_tickets.find(t => t.id === 710).status, 'completed', 'long-past arrival must be auto-completed');
        assert.equal(db.bus_tickets.find(t => t.id === 711).status, 'active', 'recent arrival (<12h) must remain active');
        assert.equal(db.bus_tickets.find(t => t.id === 712).status, 'active', 'missing arrival must remain active');
    });

    it('is idempotent/safe under repeated invocation (no double effects, e.g. overlapping cron runs)', async () => {
        const db = freshMockDb();
        const dbClient = makeMockSupabase(db);
        await sweepAutoCompleteTrips({ dbClient });
        const first = JSON.stringify(db.bus_tickets.find(t => t.id === 710));

        const second = await sweepAutoCompleteTrips({ dbClient });
        assert.equal(second.completed, 0, 'already-completed trip is not re-completed');
        assert.equal(JSON.stringify(db.bus_tickets.find(t => t.id === 710)), first);
    });

    it('dry_run mode never mutates state', async () => {
        const db = freshMockDb();
        const dbClient = makeMockSupabase(db);
        const result = await sweepAutoCompleteTrips({ dbClient, dryRun: true });
        assert.equal(result.dry_run, true);
        assert.equal(db.bus_tickets.find(t => t.id === 710).status, 'active', 'dry_run must not mutate state');
    });
});

// =============================================================================
// PART 5 — Migration SQL static contract check (the deployed artifact itself)
// =============================================================================
describe('Phase E.47.2 — fn_complete_bus_trip migration file shape', () => {
    const migrationPath = path.resolve(__dirname, '../docs/migrations/20260902_atomic_trip_completion.sql');
    const sql = fs.readFileSync(migrationPath, 'utf8');

    it('migration file exists and defines fn_complete_bus_trip', () => {
        assert.ok(sql.includes('CREATE OR REPLACE FUNCTION public.fn_complete_bus_trip'));
    });

    it('locks the trip row for the duration of the transaction (concurrency safety)', () => {
        assert.ok(/FOR UPDATE/.test(sql), 'must use SELECT ... FOR UPDATE to serialize concurrent completions of the same trip');
    });

    it('both STEP 1 (no_show) and STEP 2 (completed) live inside the same function body (one transaction)', () => {
        const fnBody = sql.split('CREATE OR REPLACE FUNCTION public.fn_complete_bus_trip')[1].split('$$;')[0];
        assert.ok(/UPDATE public\.bus_ticket_bookings/.test(fnBody));
        assert.ok(/UPDATE public\.bus_tickets/.test(fnBody));
        assert.ok(!/\bCOMMIT\b/.test(fnBody), 'a plpgsql function body must not issue its own COMMIT — the whole function is one implicit transaction');
    });

    it('idempotent already-completed branch is present', () => {
        assert.ok(sql.includes("already_completed"));
        assert.ok(sql.includes("v_trip.status = 'completed'"));
    });

    it('is locked down to service_role only (matches fn_claim_booking_auto convention)', () => {
        assert.ok(sql.includes('REVOKE ALL ON FUNCTION public.fn_complete_bus_trip(INTEGER, INTEGER) FROM anon'));
        assert.ok(sql.includes('REVOKE ALL ON FUNCTION public.fn_complete_bus_trip(INTEGER, INTEGER) FROM authenticated'));
        assert.ok(sql.includes('GRANT EXECUTE ON FUNCTION public.fn_complete_bus_trip(INTEGER, INTEGER) TO service_role'));
    });

    it('never touches finance/payment/Ticket V1.1 columns', () => {
        const rawBody = sql.split('CREATE OR REPLACE FUNCTION public.fn_complete_bus_trip')[1].split('$$;')[0];
        // Strip SQL line comments first — the function is deliberately
        // commented to explain what it does NOT touch, which would otherwise
        // false-positive a naive substring scan of the executable body.
        const fnBody = rawBody.split('\n').map(line => line.replace(/--.*$/, '')).join('\n');
        const forbidden = ['total_price', 'commission_', 'carrier_amount', 'payment', 'verification_token', 'DELETE '];
        forbidden.forEach(term => {
            assert.ok(!fnBody.includes(term), `executable migration body must never reference ${term}`);
        });
    });
});


// =============================================================================
// PART 6 — HTTP integration: manual completion + auto-complete sweep endpoints
// (mocks dbServiceRole.getServiceRoleClient, the only client granted EXECUTE)
//
// In production the anon client (routes/busAdmin.js's `supabase`) and the
// service-role client (this RPC) hit the SAME Postgres database. To keep
// that property in the test double, both mocked clients below are built
// from ONE shared in-memory mockDb object rather than two independent ones.
// =============================================================================
describe('Phase E.47.2 — HTTP endpoints backed by the atomic RPC', () => {
    function generateToken(userId, carrierId, role) {
        return jwt.sign(
            { sub: String(userId), carrierId, role },
            process.env.JWT_SECRET,
            { algorithm: 'HS256', issuer: 'poputki.online', audience: 'poputki-carrier', expiresIn: '1h' }
        );
    }

    function sharedFixture() {
        const db = freshMockDb();
        db.users = [
            { id: 301, name: 'Carrier A Owner', phone: '+992900000301', role: 'bus_driver', is_blocked: false },
            { id: 303, name: 'Carrier A Driver', phone: '+992900000303', role: 'driver', is_blocked: false },
            { id: 304, name: 'Carrier A Accountant', phone: '+992900000304', role: 'accountant', is_blocked: false },
            { id: 401, name: 'Carrier B Owner', phone: '+992900000401', role: 'bus_driver', is_blocked: false }
        ];
        db.carrier_members = [
            { carrier_id: 301, user_id: 303, role: 'driver', assigned_ticket_ids: [720], is_active: true },
            { carrier_id: 301, user_id: 304, role: 'accountant', assigned_ticket_ids: [], is_active: true }
        ];
        db.booking_audit_logs = [];
        return db;
    }

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

    it('manual completion endpoint: role gates, ownership, and full flow through the RPC', async () => {
        const db = sharedFixture();
        const app = makeApp(db);
        await startServer(app);

        const ownerToken = generateToken(301, 301, 'owner');
        const driverToken = generateToken(303, 301, 'driver');
        const accountantToken = generateToken(304, 301, 'accountant');
        const otherCarrierToken = generateToken(401, 401, 'owner');

        let res = await makeRequest(baseUrl, 'POST', '/api/bus-admin/tickets/720/complete', { Authorization: `Bearer ${driverToken}` });
        assert.equal(res.status, 403);

        res = await makeRequest(baseUrl, 'POST', '/api/bus-admin/tickets/720/complete', { Authorization: `Bearer ${accountantToken}` });
        assert.equal(res.status, 403);

        res = await makeRequest(baseUrl, 'POST', '/api/bus-admin/tickets/720/complete', { Authorization: `Bearer ${otherCarrierToken}` });
        assert.equal(res.status, 403);

        res = await makeRequest(baseUrl, 'POST', '/api/bus-admin/tickets/720/complete', { Authorization: `Bearer ${ownerToken}` });
        assert.equal(res.status, 200);
        assert.equal(res.body.success, true);
        assert.equal(res.body.no_show_marked, 1);
        assert.equal(db.bus_tickets.find(t => t.id === 720).status, 'completed');
        assert.equal(db.bus_ticket_bookings.find(b => b.id === 9101).boarding_status, 'no_show');
        assert.equal(db.bus_ticket_bookings.find(b => b.id === 9102).boarding_status, 'boarded', 'boarded preserved through HTTP flow');

        res = await makeRequest(baseUrl, 'POST', '/api/bus-admin/tickets/720/complete', { Authorization: `Bearer ${ownerToken}` });
        assert.equal(res.status, 200);
        assert.equal(res.body.already_completed, true);

        await stopServer();
    });

    it('admin auto-complete sweep endpoint requires admin token and completes only eligible trips', async () => {
        const db = sharedFixture();
        const app = makeApp(db);
        await startServer(app);

        const unauth = await makeRequest(baseUrl, 'POST', '/api/admin/trips/auto-complete', {});
        assert.equal(unauth.status, 401);

        const res = await makeRequest(baseUrl, 'POST', '/api/admin/trips/auto-complete', { 'X-Admin-Token': 'test-admin-secret' });
        assert.equal(res.status, 200);
        assert.equal(res.body.success, true);
        assert.equal(res.body.completed, 1);
        assert.equal(db.bus_tickets.find(t => t.id === 710).status, 'completed');
        assert.equal(db.bus_tickets.find(t => t.id === 711).status, 'active');

        await stopServer();
    });

    it('QR scanning is blocked after HTTP manual completion (E.47.1 <-> E.47.2 integration)', async () => {
        const db = sharedFixture();
        const app = makeApp(db);
        await startServer(app);

        const ownerToken = generateToken(301, 301, 'owner');
        await makeRequest(baseUrl, 'POST', '/api/bus-admin/tickets/720/complete', { Authorization: `Bearer ${ownerToken}` });

        const token = generateTicketVerificationToken(9101);
        const res = await makeRequest(baseUrl, 'POST', '/api/bus-admin/bookings/scan-boarding', { Authorization: `Bearer ${ownerToken}` }, { ticketToken: token, tripId: 720 });
        assert.equal(res.status, 400);
        assert.equal(res.body.code, 'TRIP_COMPLETED');

        await stopServer();
    });
});
