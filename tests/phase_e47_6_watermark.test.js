/**
 * tests/phase_e47_6_watermark.test.js
 *
 * PHASE E.47.6 — Auto-Complete Release Watermark / Legacy Trip Protection
 *
 * E.47.5's production audit found 3 real historical trips (#40, #48, #52)
 * already past arrival+12h at the moment automatic completion was about to
 * be wired up. Decision: these trips predate Auto-Complete V1 and must
 * NEVER be auto-completed — they remain manual-completion only.
 *
 * This suite verifies the watermark added in utils/tripCompletionHelper.js:
 * a trip is only in scope for AUTOMATIC completion if bus_tickets.created_at
 * is on/after AUTO_COMPLETE_WATERMARK_AT (2026-08-15T00:00:00Z, chosen from
 * the production gap between the last pre-Fleet trip, created 2026-08-06,
 * and trip #73, the first Fleet-linked trip, created 2026-08-29). Manual
 * completion ("Завершить рейс") is NOT gated by the watermark.
 *
 * Reuses the same reference fn_complete_bus_trip mock + in-memory Supabase
 * mock pattern established in tests/phase_e47_2_atomic_trip_completion.test.js.
 */

process.env.JWT_SECRET = 'test-jwt-secret-poputki-secure-key-12345';
process.env.ADMIN_SECRET_TOKEN = 'test-admin-secret';
process.env.SUPABASE_URL = 'https://test-local-only.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-local-service-role-key-not-real';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
    completeTrip,
    sweepAutoCompleteTrips,
    isTripEligibleForAutoComplete,
    isPostWatermarkTrip,
    AUTO_COMPLETE_WATERMARK_AT
} = require('../utils/tripCompletionHelper');
const { generateTicketVerificationToken } = require('../utils/ticketHelper');
const { evaluateAutoClaimEligibility } = require('../utils/claimHelper');

// ---------------------------------------------------------------------------
// Reference JS mirror of fn_complete_bus_trip (see phase_e47_2 for the
// authoritative copy + SQL cross-reference). Duplicated here deliberately —
// each phase test file in this project is self-contained.
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

// ---------------------------------------------------------------------------
// Fixture mirroring the real production shape found in E.47.5's audit:
// trip #40 (legacy, no bookings), #48 (legacy, confirmed pending_boarding
// bookings), #52 (legacy, only cancelled bookings) — plus a healthy
// post-watermark population.
// ---------------------------------------------------------------------------
const LEGACY_CREATED_AT = '2026-07-01T00:00:00.000Z'; // before watermark (2026-08-15)
const POST_WATERMARK_CREATED_AT = '2026-09-01T00:00:00.000Z'; // after watermark

function freshMockDb() {
    return {
        bus_tickets: [
            // --- Legacy (pre-watermark) trips — arrival long past +12h ---
            { id: 9040, operator_id: 301, status: 'active', created_at: LEGACY_CREATED_AT, arrival_date: '2020-01-01', arrival_time: '00:00:00' }, // trip #40 equivalent — no bookings
            { id: 9048, operator_id: 301, status: 'active', created_at: LEGACY_CREATED_AT, arrival_date: '2020-01-01', arrival_time: '00:00:00' }, // trip #48 equivalent — confirmed pending_boarding bookings
            { id: 9052, operator_id: 301, status: 'active', created_at: LEGACY_CREATED_AT, arrival_date: '2020-01-01', arrival_time: '00:00:00' }, // trip #52 equivalent — only cancelled bookings

            // --- Post-watermark trips ---
            { id: 9100, operator_id: 301, status: 'active', created_at: POST_WATERMARK_CREATED_AT, arrival_date: '2099-01-01', arrival_time: '00:00:00' }, // future arrival -> not yet eligible
            { id: 9200, operator_id: 301, status: 'active', created_at: POST_WATERMARK_CREATED_AT, arrival_date: '2020-01-01', arrival_time: '00:00:00' }, // past arrival+12h -> eligible
            { id: 9300, operator_id: 301, status: 'active', created_at: POST_WATERMARK_CREATED_AT, arrival_date: null, arrival_time: null }, // missing arrival -> skipped
            { id: 9400, operator_id: 301, status: 'completed', created_at: POST_WATERMARK_CREATED_AT, arrival_date: '2020-01-01', arrival_time: '00:00:00' } // already completed -> skipped
        ],
        bus_ticket_bookings: [
            { id: 90481, bus_ticket_id: 9048, status: 'confirmed', boarding_status: 'pending_boarding', passenger_name: 'Legacy Passenger', total_price: 500, commission_amount: 50, carrier_amount: 450 },
            { id: 90521, bus_ticket_id: 9052, status: 'cancelled', boarding_status: 'pending_boarding', passenger_name: 'Cancelled Legacy' },
            { id: 92001, bus_ticket_id: 9200, status: 'confirmed', boarding_status: 'pending_boarding', passenger_name: 'Post-watermark Passenger', total_price: 700, commission_amount: 70, carrier_amount: 630 }
        ],
        carrier_activity_logs: []
    };
}

// =============================================================================
// PART 1 — Pure eligibility function: watermark semantics
// =============================================================================
describe('Phase E.47.6 — isPostWatermarkTrip / isTripEligibleForAutoComplete', () => {
    it('WATERMARK_CONSTANT: is a fixed UTC instant between the last pre-Fleet trip and trip #73', () => {
        assert.equal(AUTO_COMPLETE_WATERMARK_AT.toISOString(), '2026-08-15T00:00:00.000Z');
    });

    it('trip created before the watermark is legacy/out-of-scope', () => {
        assert.equal(isPostWatermarkTrip({ created_at: '2026-08-06T17:31:56.000Z' }), false);
        assert.equal(isPostWatermarkTrip({ created_at: LEGACY_CREATED_AT }), false);
    });

    it('trip created on/after the watermark is in-scope', () => {
        assert.equal(isPostWatermarkTrip({ created_at: '2026-08-29T10:20:00.000Z' }), true, 'trip #73\'s real created_at must be in-scope');
        assert.equal(isPostWatermarkTrip({ created_at: AUTO_COMPLETE_WATERMARK_AT.toISOString() }), true, 'boundary instant is inclusive');
    });

    it('trip with no created_at is treated as out-of-scope, not eligible', () => {
        assert.equal(isPostWatermarkTrip({}), false);
        assert.equal(isPostWatermarkTrip(null), false);
    });

    it('legacy active trip past arrival+12h is NOT eligible for auto-complete', () => {
        const legacyTrip = { status: 'active', created_at: LEGACY_CREATED_AT, arrival_date: '2020-01-01', arrival_time: '00:00:00' };
        assert.equal(isTripEligibleForAutoComplete(legacyTrip), false);
    });

    it('post-watermark future trip is not eligible before arrival+12h', () => {
        const futureTrip = { status: 'active', created_at: POST_WATERMARK_CREATED_AT, arrival_date: '2099-01-01', arrival_time: '00:00:00' };
        assert.equal(isTripEligibleForAutoComplete(futureTrip), false);
    });

    it('post-watermark trip after arrival+12h IS eligible', () => {
        const eligibleTrip = { status: 'active', created_at: POST_WATERMARK_CREATED_AT, arrival_date: '2020-01-01', arrival_time: '00:00:00' };
        assert.equal(isTripEligibleForAutoComplete(eligibleTrip), true);
    });

    it('missing arrival is skipped regardless of watermark', () => {
        const missingArrival = { status: 'active', created_at: POST_WATERMARK_CREATED_AT, arrival_date: null, arrival_time: null };
        assert.equal(isTripEligibleForAutoComplete(missingArrival), false);
    });

    it('completed trip is skipped', () => {
        const completedTrip = { status: 'completed', created_at: POST_WATERMARK_CREATED_AT, arrival_date: '2020-01-01', arrival_time: '00:00:00' };
        assert.equal(isTripEligibleForAutoComplete(completedTrip), false);
    });
});

// =============================================================================
// PART 2 — sweepAutoCompleteTrips: real-shaped legacy trips excluded
// =============================================================================
describe('Phase E.47.6 — sweepAutoCompleteTrips excludes legacy trips #40/#48/#52 equivalents', () => {
    it('trip #40 equivalent (legacy, no bookings) is excluded from auto-completion', async () => {
        const db = freshMockDb();
        const dbClient = makeMockSupabase(db);
        await sweepAutoCompleteTrips({ dbClient });
        assert.equal(db.bus_tickets.find(t => t.id === 9040).status, 'active', 'legacy trip #40 equivalent must remain active');
    });

    it('trip #48 equivalent (legacy, confirmed pending_boarding bookings) is excluded from AUTO completion', async () => {
        const db = freshMockDb();
        const dbClient = makeMockSupabase(db);
        await sweepAutoCompleteTrips({ dbClient });
        assert.equal(db.bus_tickets.find(t => t.id === 9048).status, 'active', 'legacy trip #48 equivalent must remain active');
        assert.equal(db.bus_ticket_bookings.find(b => b.id === 90481).boarding_status, 'pending_boarding', 'confirmed booking must NOT be auto-marked no_show');
    });

    it('trip #52 equivalent (legacy, only cancelled bookings) is excluded', async () => {
        const db = freshMockDb();
        const dbClient = makeMockSupabase(db);
        await sweepAutoCompleteTrips({ dbClient });
        assert.equal(db.bus_tickets.find(t => t.id === 9052).status, 'active', 'legacy trip #52 equivalent must remain active');
    });

    it('sweep still completes eligible post-watermark trips (#9200) while protecting legacy ones', async () => {
        const db = freshMockDb();
        const dbClient = makeMockSupabase(db);
        const result = await sweepAutoCompleteTrips({ dbClient });

        assert.equal(result.completed, 1, 'only the single post-watermark eligible trip should be completed');
        assert.equal(db.bus_tickets.find(t => t.id === 9200).status, 'completed');
        assert.equal(db.bus_ticket_bookings.find(b => b.id === 92001).boarding_status, 'no_show');
        assert.equal(db.bus_tickets.find(t => t.id === 9100).status, 'active', 'future post-watermark trip must remain active');
        assert.equal(db.bus_tickets.find(t => t.id === 9300).status, 'active', 'missing-arrival trip must remain active');
        assert.equal(db.bus_tickets.find(t => t.id === 9400).status, 'completed', 'already-completed trip stays completed (no-op)');
    });

    it('duplicate/overlapping sweep execution is safe: second run is a no-op for legacy AND already-completed trips', async () => {
        const db = freshMockDb();
        const dbClient = makeMockSupabase(db);
        await sweepAutoCompleteTrips({ dbClient });
        const snapshotAfterFirst = JSON.stringify(db.bus_tickets);

        const second = await sweepAutoCompleteTrips({ dbClient });
        assert.equal(second.completed, 0, 'nothing new to complete on the second run');
        assert.equal(JSON.stringify(db.bus_tickets), snapshotAfterFirst, 'no state churn on repeated invocation');
    });

    it('dry_run uses exactly the same eligibility function as real execution: legacy trips never appear in would_complete details', async () => {
        const db = freshMockDb();
        const dbClient = makeMockSupabase(db);
        const result = await sweepAutoCompleteTrips({ dbClient, dryRun: true });

        assert.equal(result.dry_run, true);
        const wouldCompleteIds = result.details.map(d => d.trip_id);
        assert.ok(!wouldCompleteIds.includes(9040), 'legacy trip #40 equivalent must never appear in would_complete');
        assert.ok(!wouldCompleteIds.includes(9048), 'legacy trip #48 equivalent must never appear in would_complete');
        assert.ok(!wouldCompleteIds.includes(9052), 'legacy trip #52 equivalent must never appear in would_complete');
        assert.deepEqual(wouldCompleteIds, [9200], 'only the genuinely eligible post-watermark trip is reported');

        // dry_run must not mutate anything, including the legacy trips
        assert.equal(db.bus_tickets.find(t => t.id === 9048).status, 'active');
        assert.equal(db.bus_ticket_bookings.find(b => b.id === 90481).boarding_status, 'pending_boarding');
    });
});

// =============================================================================
// PART 3 — Manual completion is NOT gated by the watermark
// =============================================================================
describe('Phase E.47.6 — manual completion remains available for legacy trips', () => {
    it('legacy trip #48 equivalent CAN be manually completed via completeTrip()', async () => {
        const db = freshMockDb();
        const dbClient = makeMockSupabase(db);

        const result = await completeTrip({
            tripId: 9048,
            actorContext: { carrier_id: 301, user_id: 301, role: 'owner', name: 'Owner' },
            dbClient
        });

        assert.equal(result.success, true, 'manual completion must succeed for a legacy trip');
        assert.equal(result.no_show_marked, 1);
        assert.equal(db.bus_tickets.find(t => t.id === 9048).status, 'completed');
        assert.equal(db.bus_ticket_bookings.find(b => b.id === 90481).boarding_status, 'no_show');
    });

    it('legacy trip #40 equivalent (no bookings) CAN be manually completed with zero no_show', async () => {
        const db = freshMockDb();
        const dbClient = makeMockSupabase(db);
        const result = await completeTrip({ tripId: 9040, actorContext: { carrier_id: 301, user_id: 301, role: 'owner' }, dbClient });
        assert.equal(result.success, true);
        assert.equal(result.no_show_marked, 0);
        assert.equal(db.bus_tickets.find(t => t.id === 9040).status, 'completed');
    });
});

// =============================================================================
// PART 4 — Cross-cutting regressions this phase must not touch
// =============================================================================
describe('Phase E.47.6 — cross-cutting regressions unaffected', () => {
    it('FINANCE_UNCHANGED / PAYMENT_UNCHANGED: commission/payout fields untouched by auto-completion', async () => {
        const db = freshMockDb();
        const dbClient = makeMockSupabase(db);
        await sweepAutoCompleteTrips({ dbClient });
        const row = db.bus_ticket_bookings.find(b => b.id === 92001);
        assert.equal(row.total_price, 700);
        assert.equal(row.commission_amount, 70);
        assert.equal(row.carrier_amount, 630);
    });

    it('TICKET_V1_1_UNCHANGED / QR_SCANNER_UNCHANGED: HMAC verification token derivation is unaffected', async () => {
        const before = generateTicketVerificationToken(92001);
        const db = freshMockDb();
        const dbClient = makeMockSupabase(db);
        await sweepAutoCompleteTrips({ dbClient });
        const after = generateTicketVerificationToken(92001);
        assert.equal(before, after);
    });

    it('E45_PRESERVED: verified-phone auto-claim remains independent of contact_role', () => {
        const verifiedUser = { id: 1121, telegram_id: '99887766', phone: '+992900000000', name: 'Test Passenger' };
        const familyGroupBooking = {
            id: 504, status: 'confirmed', claim_status: null, claimed_by_user_id: null,
            phone: '+992900000000', contact_role: 'family_or_group'
        };
        const res = evaluateAutoClaimEligibility(familyGroupBooking, verifiedUser, {}, '99887766');
        assert.equal(res.canAutoClaim, true);
        assert.equal(res.method, 'known_user_phone_match');
    });
});
