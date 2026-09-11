/**
 * phase_subscription_model_core.test.js
 *
 * POPUTKI.ONLINE — Manual Booking Telegram Subscription Model, core logic.
 *
 * Owner-approved LOCAL implementation of the corrected subscription-model
 * plan. This suite tests utils/bookingSubscriptionHelper.js and
 * utils/bookingChannelHelper.js directly against an in-memory mock DB (same
 * "isInjectedMock" pattern already established by utils/claimHelper.js and
 * tests/phase_e_booking_claim.test.js), plus the real RPC-facing SQL
 * (fn_is_booking_subscribable / fn_start_booking_subscription_session /
 * fn_complete_booking_subscription / fn_unsubscribe_booking_follower) was
 * separately verified against a real local Postgres 16 instance seeded from
 * docs/migrations/staging/00_staging_schema_baseline.sql — not production
 * Supabase, and not re-run as part of this automated suite.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
    SUBSCRIPTION_SESSION_TTL_MS,
    VALID_ROLES,
    hashSubscriptionToken,
    isBookingSubscribable,
    normalizeRoleDeclared,
    generateSubscriptionSession,
    completeSubscription,
    unsubscribeFollower
} = require('../utils/bookingSubscriptionHelper');
const { isManualBooking } = require('../utils/bookingChannelHelper');
const { resolveClaimSession } = require('../utils/claimHelper');

// Minimal in-memory mock supporting exactly the query shapes this module's
// mock ("isInjectedMock") path uses: select().eq()[.eq()].single()/
// .maybeSingle(), insert([row]).select().single(), update(patch).eq(),
// upsert(obj, {onConflict}). No .rpc() — so isInjectedMock(options) is true.
function createMockDb(seed = {}) {
    const tables = {
        bus_ticket_bookings: new Map(),
        bus_tickets: new Map(),
        booking_subscription_sessions: new Map(),
        booking_followers: new Map(),
        booking_follower_events: [],
        booking_claim_sessions: new Map(),
        ...Object.fromEntries(Object.entries(seed).map(([k, v]) => [k, v]))
    };
    let autoId = 1;

    function matches(row, filters) {
        return filters.every(([col, val]) => String(row[col]) === String(val));
    }

    return {
        _tables: tables,
        from(table) {
            const store = tables[table];
            const filters = [];
            const builder = {
                select() { return builder; },
                eq(col, val) { filters.push([col, val]); return builder; },
                async maybeSingle() {
                    if (Array.isArray(store)) {
                        const row = store.find(r => matches(r, filters));
                        return { data: row || null, error: null };
                    }
                    const row = [...store.values()].find(r => matches(r, filters));
                    return { data: row || null, error: null };
                },
                async single() {
                    const result = await builder.maybeSingle();
                    return result.data ? result : { data: null, error: new Error('not found') };
                },
                insert(rows) {
                    const arr = Array.isArray(rows) ? rows : [rows];
                    const inserted = arr.map(r => {
                        const id = r.id || `mock-${autoId++}`;
                        const record = { id, created_at: new Date().toISOString(), ...r };
                        if (Array.isArray(store)) store.push(record);
                        else store.set(id, record);
                        return record;
                    });
                    return {
                        select() {
                            return {
                                single: async () => ({ data: inserted[0], error: null })
                            };
                        }
                    };
                },
                update(patch) {
                    const updateFilters = [];
                    const updateBuilder = {
                        eq(col, val) { updateFilters.push([col, val]); return updateBuilder; },
                        then(resolve) {
                            for (const [key, row] of store.entries()) {
                                if (matches(row, updateFilters)) store.set(key, { ...row, ...patch });
                            }
                            return Promise.resolve({ error: null }).then(resolve);
                        }
                    };
                    return updateBuilder;
                },
                upsert(obj, opts = {}) {
                    const onConflict = (opts.onConflict || '').split(',');
                    for (const [key, row] of store.entries()) {
                        if (onConflict.every(col => String(row[col]) === String(obj[col]))) {
                            store.set(key, { ...row, ...obj });
                            return Promise.resolve({ data: store.get(key), error: null });
                        }
                    }
                    const id = obj.id || `mock-${autoId++}`;
                    store.set(id, { id, created_at: new Date().toISOString(), ...obj });
                    return Promise.resolve({ data: store.get(id), error: null });
                }
            };
            return builder;
        }
    };
}

function seedBookingAndTrip(db, { bookingId = 900, tripId = 100, bookingStatus = 'confirmed', tripStatus = 'active', arrivalDate, arrivalTime = '18:00', createdByUserId = 1 } = {}) {
    const today = new Date().toISOString().slice(0, 10);
    db._tables.bus_tickets.set(tripId, {
        id: tripId, status: tripStatus,
        arrival_date: arrivalDate || today, arrival_time: arrivalTime,
        from_city: 'A', to_city: 'B', departure_date: today, departure_time: '10:00',
        transport_company: 'Test Carrier'
    });
    db._tables.bus_ticket_bookings.set(bookingId, {
        id: bookingId, bus_ticket_id: tripId, status: bookingStatus,
        seat_numbers: '[78]', created_by_user_id: createdByUserId
    });
}

describe('bookingChannelHelper.isManualBooking — canonical manual/online classification', () => {
    it('created_by_user_id set (busAdmin.js manual insert shape) -> manual', () => {
        assert.equal(isManualBooking({ created_by_user_id: 11, channel: 'manual', source_type: 'manual' }), true);
    });

    it('created_by_user_id null (smartpay.js online insert shape, explicit null) -> NOT manual', () => {
        assert.equal(isManualBooking({ created_by_user_id: null, channel: 'web', source_type: 'smartpay' }), false);
    });

    it('created_by_user_id omitted entirely (busBookings.js direct online insert shape) -> NOT manual, even though channel/source_type default to "manual" at rest', () => {
        // This is the exact schema-drift case found during audit: the direct
        // online booking insert never sets channel/source_type, so both sit
        // at their column DEFAULT of 'manual' — proving those two fields
        // alone are not a safe signal, and created_by_user_id is.
        assert.equal(isManualBooking({ channel: 'manual', source_type: 'manual' }), false);
    });

    it('null/undefined booking -> false, never throws', () => {
        assert.equal(isManualBooking(null), false);
        assert.equal(isManualBooking(undefined), false);
    });
});

describe('bookingSubscriptionHelper.isBookingSubscribable — shared availability rule', () => {
    const today = new Date().toISOString().slice(0, 10);

    it('confirmed booking, active trip, arrival later today -> subscribable', () => {
        assert.equal(isBookingSubscribable({ status: 'confirmed' }, { status: 'active', arrival_date: today, arrival_time: '23:59' }), true);
    });

    it('cancelled booking -> not subscribable', () => {
        assert.equal(isBookingSubscribable({ status: 'cancelled' }, { status: 'active', arrival_date: today, arrival_time: '23:59' }), false);
    });

    it('trip.status=completed -> not subscribable', () => {
        assert.equal(isBookingSubscribable({ status: 'confirmed' }, { status: 'completed', arrival_date: today, arrival_time: '23:59' }), false);
    });

    it('trip.status=cancelled -> not subscribable', () => {
        assert.equal(isBookingSubscribable({ status: 'confirmed' }, { status: 'cancelled', arrival_date: today, arrival_time: '23:59' }), false);
    });

    it('arrival 3 days in the past (grace period long elapsed) -> not subscribable', () => {
        const past = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString().slice(0, 10);
        assert.equal(isBookingSubscribable({ status: 'confirmed' }, { status: 'active', arrival_date: past, arrival_time: '18:00' }), false);
    });

    it('multi-day international route: arrival_date differs from departure, still within grace -> subscribable', () => {
        const tomorrow = new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 10);
        assert.equal(isBookingSubscribable({ status: 'confirmed' }, { status: 'active', arrival_date: tomorrow, arrival_time: '08:00' }), true);
    });

    it('12h grace boundary: 11.5h after arrival still subscribable, 12.5h after is not', () => {
        const now = new Date();
        // Dushanbe (UTC+5) wall-clock digits that correspond to a real UTC
        // arrival instant `hoursAgo` hours before `now` — built by shifting
        // forward 5h before reading the wall-clock digits, mirroring the
        // function's own "-5h to get UTC" conversion in reverse.
        function tripArrivedHoursAgo(hoursAgo) {
            const trueUtcInstant = now.getTime() - hoursAgo * 3600 * 1000;
            const dushanbeWallClock = new Date(trueUtcInstant + 5 * 3600 * 1000);
            return {
                status: 'active',
                arrival_date: dushanbeWallClock.toISOString().slice(0, 10),
                arrival_time: dushanbeWallClock.toISOString().slice(11, 16)
            };
        }

        assert.equal(isBookingSubscribable({ status: 'confirmed' }, tripArrivedHoursAgo(11.5), now), true);
        assert.equal(isBookingSubscribable({ status: 'confirmed' }, tripArrivedHoursAgo(12.5), now), false);
    });

    it('missing booking or trip -> false, never throws', () => {
        assert.equal(isBookingSubscribable(null, {}), false);
        assert.equal(isBookingSubscribable({ status: 'confirmed' }, null), false);
    });
});

describe('bookingSubscriptionHelper.normalizeRoleDeclared — server-side allowlist', () => {
    it('every declared valid role passes through unchanged', () => {
        for (const role of VALID_ROLES) {
            assert.equal(normalizeRoleDeclared(role), role);
        }
    });

    it('unrecognized/malicious value collapses to "unknown", never throws or bubbles a raw CHECK-style error', () => {
        assert.equal(normalizeRoleDeclared('hacker_role'), 'unknown');
        assert.equal(normalizeRoleDeclared(''), 'unknown');
        assert.equal(normalizeRoleDeclared(null), 'unknown');
        assert.equal(normalizeRoleDeclared(undefined), 'unknown');
        assert.equal(normalizeRoleDeclared({}), 'unknown');
    });

    it('default is never "passenger"', () => {
        assert.notEqual(normalizeRoleDeclared(undefined), 'passenger');
    });
});

describe('bookingSubscriptionHelper — token hashing and entropy', () => {
    it('hashSubscriptionToken is deterministic SHA-256, separate namespace from claim hashing', () => {
        const { hashSessionToken } = require('../utils/claimHelper');
        const h1 = hashSubscriptionToken('sometoken');
        const h2 = hashSubscriptionToken('sometoken');
        assert.equal(h1, h2);
        assert.equal(h1.length, 64); // hex sha256
        // Same raw string hashed by the two DIFFERENT functions still
        // produces the same SHA-256 digest (same algorithm) — the isolation
        // between claim and subscription tokens comes from using separate
        // TABLES/columns and separately-generated random tokens in
        // production, not from the hash function itself differing.
        assert.equal(h1, hashSessionToken('sometoken'));
    });

    it('generateSubscriptionSession mints a 128-bit (32 hex char) raw token', async () => {
        const db = createMockDb();
        seedBookingAndTrip(db);
        const result = await generateSubscriptionSession(900, { supabaseClient: db });
        assert.equal(result.success, true);
        assert.match(result.sessionToken, /^[a-f0-9]{32}$/);
    });

    it('deep link uses the subscribe_ prefix, never claim_/s_', async () => {
        const db = createMockDb();
        seedBookingAndTrip(db);
        const result = await generateSubscriptionSession(900, { supabaseClient: db });
        assert.match(result.deepLink, /\?start=subscribe_[a-f0-9]{32}$/);
        assert.ok(!result.deepLink.includes('claim_'));
    });

    it('TTL constant is exactly 15 minutes', () => {
        assert.equal(SUBSCRIPTION_SESSION_TTL_MS, 15 * 60 * 1000);
    });
});

describe('generateSubscriptionSession — availability gating and independence', () => {
    it('refuses to start a session for a cancelled booking', async () => {
        const db = createMockDb();
        seedBookingAndTrip(db, { bookingStatus: 'cancelled' });
        const result = await generateSubscriptionSession(900, { supabaseClient: db });
        assert.equal(result.success, false);
        assert.equal(result.error, 'BOOKING_NOT_SUBSCRIBABLE');
    });

    it('refuses to start a session for a booking whose trip already completed', async () => {
        const db = createMockDb();
        seedBookingAndTrip(db, { tripStatus: 'completed' });
        const result = await generateSubscriptionSession(900, { supabaseClient: db });
        assert.equal(result.success, false);
        assert.equal(result.error, 'BOOKING_NOT_SUBSCRIBABLE');
    });

    it('two independent sessions for the same booking do not invalidate each other', async () => {
        const db = createMockDb();
        seedBookingAndTrip(db);
        const sessionA = await generateSubscriptionSession(900, { supabaseClient: db });
        const sessionB = await generateSubscriptionSession(900, { supabaseClient: db });
        assert.equal(sessionA.success, true);
        assert.equal(sessionB.success, true);
        assert.notEqual(sessionA.sessionToken, sessionB.sessionToken);
        assert.equal(db._tables.booking_subscription_sessions.size, 2);
        // Both remain independently unconsumed.
        const rows = [...db._tables.booking_subscription_sessions.values()];
        assert.ok(rows.every(r => !r.consumed_at));
    });
});

describe('completeSubscription — subscribed / resubscribed / idempotent, and audit events', () => {
    it('first-time subscription logs a "subscribed" event', async () => {
        const db = createMockDb();
        seedBookingAndTrip(db);
        const session = await generateSubscriptionSession(900, { supabaseClient: db });
        const result = await completeSubscription(session.sessionToken, 2, 'passenger', { supabaseClient: db });
        assert.equal(result.success, true);
        assert.equal(result.event, 'subscribed');
        assert.equal(db._tables.booking_follower_events.length, 1);
        assert.equal(db._tables.booking_follower_events[0].event_type, 'subscribed');
    });

    it('a second, different subscriber on the same booking succeeds independently (no "first wins" blocking)', async () => {
        const db = createMockDb();
        seedBookingAndTrip(db);
        const sessionA = await generateSubscriptionSession(900, { supabaseClient: db });
        const sessionB = await generateSubscriptionSession(900, { supabaseClient: db });
        const resultA = await completeSubscription(sessionA.sessionToken, 2, 'passenger', { supabaseClient: db });
        const resultB = await completeSubscription(sessionB.sessionToken, 3, 'intermediary', { supabaseClient: db });
        assert.equal(resultA.success, true);
        assert.equal(resultB.success, true);
        assert.equal(db._tables.booking_followers.size, 2);
    });

    it('re-using an already-consumed session fails', async () => {
        const db = createMockDb();
        seedBookingAndTrip(db);
        const session = await generateSubscriptionSession(900, { supabaseClient: db });
        await completeSubscription(session.sessionToken, 2, 'passenger', { supabaseClient: db });
        const reuse = await completeSubscription(session.sessionToken, 2, 'passenger', { supabaseClient: db });
        assert.equal(reuse.success, false);
        assert.equal(reuse.error, 'SESSION_INVALID_EXPIRED_OR_CONSUMED');
    });

    it('an expired session is rejected', async () => {
        const db = createMockDb();
        seedBookingAndTrip(db);
        const past = new Date(Date.now() - 1000);
        const session = await generateSubscriptionSession(900, { supabaseClient: db, now: new Date(Date.now() - 20 * 60 * 1000) });
        const result = await completeSubscription(session.sessionToken, 2, 'passenger', { supabaseClient: db, now: new Date() });
        assert.equal(result.success, false);
        assert.equal(result.error, 'SESSION_INVALID_EXPIRED_OR_CONSUMED');
        void past;
    });

    it('idempotent re-subscribe on an already-active follower logs no duplicate event', async () => {
        const db = createMockDb();
        seedBookingAndTrip(db);
        const sessionA = await generateSubscriptionSession(900, { supabaseClient: db });
        await completeSubscription(sessionA.sessionToken, 2, 'passenger', { supabaseClient: db });

        const sessionB = await generateSubscriptionSession(900, { supabaseClient: db });
        const result = await completeSubscription(sessionB.sessionToken, 2, 'passenger', { supabaseClient: db });

        assert.equal(result.success, true);
        assert.equal(result.event, 'already_active');
        const events = db._tables.booking_follower_events.filter(e => e.user_id === 2);
        assert.equal(events.length, 1); // still just the original "subscribed"
    });

    it('unsubscribe then re-subscribe logs "resubscribed", not a second "subscribed"', async () => {
        const db = createMockDb();
        seedBookingAndTrip(db);
        const sessionA = await generateSubscriptionSession(900, { supabaseClient: db });
        await completeSubscription(sessionA.sessionToken, 2, 'passenger', { supabaseClient: db });

        const unsub = await unsubscribeFollower(900, 2, { supabaseClient: db });
        assert.equal(unsub.success, true);

        const sessionB = await generateSubscriptionSession(900, { supabaseClient: db });
        const result = await completeSubscription(sessionB.sessionToken, 2, 'unknown', { supabaseClient: db });
        assert.equal(result.event, 'resubscribed');

        const events = db._tables.booking_follower_events.filter(e => e.user_id === 2).map(e => e.event_type);
        assert.deepEqual(events, ['subscribed', 'unsubscribed', 'resubscribed']);
    });

    it('unsubscribing a non-subscriber fails cleanly', async () => {
        const db = createMockDb();
        seedBookingAndTrip(db);
        const result = await unsubscribeFollower(900, 999, { supabaseClient: db });
        assert.equal(result.success, false);
        assert.equal(result.error, 'NOT_SUBSCRIBED_OR_ALREADY_UNSUBSCRIBED');
    });

    it('unsubscribe is soft: the row is never deleted, only flagged', async () => {
        const db = createMockDb();
        seedBookingAndTrip(db);
        const session = await generateSubscriptionSession(900, { supabaseClient: db });
        await completeSubscription(session.sessionToken, 2, 'passenger', { supabaseClient: db });
        await unsubscribeFollower(900, 2, { supabaseClient: db });

        const row = [...db._tables.booking_followers.values()].find(r => r.user_id === 2);
        assert.ok(row, 'row must still physically exist');
        assert.equal(row.notifications_enabled, false);
        assert.ok(row.unsubscribed_at);
    });

    it('malformed/unrecognized role_declared never throws and is stored as "unknown"', async () => {
        const db = createMockDb();
        seedBookingAndTrip(db);
        const session = await generateSubscriptionSession(900, { supabaseClient: db });
        const result = await completeSubscription(session.sessionToken, 2, 'DROP TABLE users;--', { supabaseClient: db });
        assert.equal(result.success, true);
        const row = [...db._tables.booking_followers.values()].find(r => r.user_id === 2);
        assert.equal(row.role_declared, 'unknown');
    });

    it('booking cancelled between session start and bot confirmation is caught at completion time too', async () => {
        const db = createMockDb();
        seedBookingAndTrip(db);
        const session = await generateSubscriptionSession(900, { supabaseClient: db });
        db._tables.bus_ticket_bookings.get(900).status = 'cancelled';
        const result = await completeSubscription(session.sessionToken, 2, 'passenger', { supabaseClient: db });
        assert.equal(result.success, false);
        assert.equal(result.error, 'BOOKING_NOT_SUBSCRIBABLE');
    });
});

describe('Cross-flow isolation: a subscription token can never be used by the old claim flow', () => {
    it('resolveClaimSession finds nothing for a hash that only exists in booking_subscription_sessions', async () => {
        const db = createMockDb();
        seedBookingAndTrip(db);
        const session = await generateSubscriptionSession(900, { supabaseClient: db });

        // booking_claim_sessions (a completely separate table/Map in this
        // mock, exactly mirroring production) has never heard of this hash.
        const claimResult = await resolveClaimSession(session.sessionToken, { supabaseClient: db });
        assert.equal(claimResult.isValid, false);
        assert.equal(claimResult.reason, 'SESSION_NOT_FOUND');
    });
});
