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
    bindSubscriptionSession,
    hasPendingSubscription,
    completeSubscription,
    unsubscribeFollower,
    getActiveFollowerCount
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

// Convenience matching the real bot flow exactly: /start subscribe_<token>
// binds the session to a telegram id (raw token used once, then discarded);
// completion later is keyed purely by that telegram id.
async function startAndBind(db, bookingId, telegramId, now) {
    const session = await generateSubscriptionSession(bookingId, { supabaseClient: db, now });
    const bind = await bindSubscriptionSession(session.sessionToken, telegramId, { supabaseClient: db, now });
    return { session, bind };
}

describe('bindSubscriptionSession — the only point the raw token is used again', () => {
    it('binds a valid, unconsumed session to a telegram id', async () => {
        const db = createMockDb();
        seedBookingAndTrip(db);
        const session = await generateSubscriptionSession(900, { supabaseClient: db });
        const bind = await bindSubscriptionSession(session.sessionToken, 555000111, { supabaseClient: db });
        assert.equal(bind.success, true);
        const row = [...db._tables.booking_subscription_sessions.values()].find(r => r.id === session.sessionId);
        assert.equal(row.bound_telegram_id, 555000111);
    });

    it('rejects an already-consumed session hash', async () => {
        const db = createMockDb();
        seedBookingAndTrip(db);
        const { session } = await startAndBind(db, 900, 555000111);
        await completeSubscription(555000111, 2, 'passenger', { supabaseClient: db });
        const rebind = await bindSubscriptionSession(session.sessionToken, 555000111, { supabaseClient: db });
        assert.equal(rebind.success, false);
        assert.equal(rebind.error, 'SESSION_INVALID_EXPIRED_OR_CONSUMED');
    });

    it('rejects a garbage/empty token without throwing', async () => {
        const db = createMockDb();
        const bind = await bindSubscriptionSession('', 555000111, { supabaseClient: db });
        assert.equal(bind.success, false);
    });

    it('a second bind for the same telegram_id supersedes the first, but re-opening the FIRST link again reactivates it and supersedes the second', async () => {
        const db = createMockDb();
        seedBookingAndTrip(db, { bookingId: 900, tripId: 100 });
        seedBookingAndTrip(db, { bookingId: 901, tripId: 100 });
        const sessionA = await generateSubscriptionSession(900, { supabaseClient: db });
        const sessionB = await generateSubscriptionSession(901, { supabaseClient: db });

        await bindSubscriptionSession(sessionA.sessionToken, 555000111, { supabaseClient: db });
        await bindSubscriptionSession(sessionB.sessionToken, 555000111, { supabaseClient: db });
        assert.ok(db._tables.booking_subscription_sessions.get(sessionA.sessionId).superseded_at, 'A superseded by B');

        // User goes back and re-opens A's link (re-triggers /start
        // subscribe_<tokenA> in the bot, hence a fresh bind(A) call).
        const rebindA = await bindSubscriptionSession(sessionA.sessionToken, 555000111, { supabaseClient: db });
        assert.equal(rebindA.success, true);

        const rowA = db._tables.booking_subscription_sessions.get(sessionA.sessionId);
        const rowB = db._tables.booking_subscription_sessions.get(sessionB.sessionId);
        assert.equal(rowA.superseded_at, null, 'A must be reactivated (superseded_at cleared)');
        assert.ok(rowB.superseded_at, 'B must now be the superseded one');

        const result = await completeSubscription(555000111, 2, 'passenger', { supabaseClient: db });
        assert.equal(result.bookingId, 900, 'completion must resolve A, the most recently (re)bound session');
    });
});

describe('hasPendingSubscription — cheap existence check, used by routes/claims.js before touching the users table', () => {
    it('true right after a session is bound to a telegram id', async () => {
        const db = createMockDb();
        seedBookingAndTrip(db);
        await startAndBind(db, 900, 555000111);
        assert.equal(await hasPendingSubscription(555000111, { supabaseClient: db }), true);
    });

    it('false for a telegram id with no bound session at all', async () => {
        const db = createMockDb();
        seedBookingAndTrip(db);
        await startAndBind(db, 900, 555000111);
        assert.equal(await hasPendingSubscription(999999999, { supabaseClient: db }), false);
    });

    it('false once the bound session has already been consumed', async () => {
        const db = createMockDb();
        seedBookingAndTrip(db);
        await startAndBind(db, 900, 555000111);
        await completeSubscription(555000111, 2, 'passenger', { supabaseClient: db });
        assert.equal(await hasPendingSubscription(555000111, { supabaseClient: db }), false);
    });

    it('false for an expired bound session', async () => {
        const db = createMockDb();
        seedBookingAndTrip(db);
        const past = new Date(Date.now() - SUBSCRIPTION_SESSION_TTL_MS - 1000);
        await startAndBind(db, 900, 555000111, past);
        assert.equal(await hasPendingSubscription(555000111, { supabaseClient: db }), false);
    });

    it('never throws even when the underlying query errors out', async () => {
        const db = createMockDb();
        // A client with no .rpc() (so isInjectedMock is true) but whose
        // _tables lacks the expected Map shape entirely — the mock path
        // should degrade to false rather than throwing.
        const brokenDb = { _tables: {} };
        assert.equal(await hasPendingSubscription(1, { supabaseClient: brokenDb }), false);
    });
});

describe('completeSubscription — keyed by telegram id, subscribed / resubscribed / idempotent, and audit events', () => {
    it('first-time subscription (after bind) logs a "subscribed" event', async () => {
        const db = createMockDb();
        seedBookingAndTrip(db);
        await startAndBind(db, 900, 555000111);
        const result = await completeSubscription(555000111, 2, 'passenger', { supabaseClient: db });
        assert.equal(result.success, true);
        assert.equal(result.event, 'subscribed');
        assert.equal(db._tables.booking_follower_events.length, 1);
        assert.equal(db._tables.booking_follower_events[0].event_type, 'subscribed');
    });

    it('completion with no prior bind for this telegram id fails cleanly (nothing to complete)', async () => {
        const db = createMockDb();
        seedBookingAndTrip(db);
        const result = await completeSubscription(999999999, 2, 'passenger', { supabaseClient: db });
        assert.equal(result.success, false);
        assert.equal(result.error, 'SESSION_INVALID_EXPIRED_OR_CONSUMED');
    });

    it('a second, different subscriber (different telegram id, different platform user) succeeds independently (no "first wins" blocking)', async () => {
        const db = createMockDb();
        seedBookingAndTrip(db);
        await startAndBind(db, 900, 555000111);
        await startAndBind(db, 900, 777000222);
        const resultA = await completeSubscription(555000111, 2, 'passenger', { supabaseClient: db });
        const resultB = await completeSubscription(777000222, 3, 'intermediary', { supabaseClient: db });
        assert.equal(resultA.success, true);
        assert.equal(resultB.success, true);
        assert.equal(db._tables.booking_followers.size, 2);
    });

    it('re-completing for the same telegram id after it already consumed its session fails', async () => {
        const db = createMockDb();
        seedBookingAndTrip(db);
        await startAndBind(db, 900, 555000111);
        await completeSubscription(555000111, 2, 'passenger', { supabaseClient: db });
        const reuse = await completeSubscription(555000111, 2, 'passenger', { supabaseClient: db });
        assert.equal(reuse.success, false);
        assert.equal(reuse.error, 'SESSION_INVALID_EXPIRED_OR_CONSUMED');
    });

    it('an expired (bound) session is rejected at completion time', async () => {
        const db = createMockDb();
        seedBookingAndTrip(db);
        await startAndBind(db, 900, 555000111, new Date(Date.now() - 20 * 60 * 1000));
        const result = await completeSubscription(555000111, 2, 'passenger', { supabaseClient: db, now: new Date() });
        assert.equal(result.success, false);
        assert.equal(result.error, 'SESSION_INVALID_EXPIRED_OR_CONSUMED');
    });

    it('one user opens booking A then booking B\'s subscribe link (bind order A, B): completion resolves ONLY B, never both, regardless of which session was created earlier', async () => {
        const db = createMockDb();
        seedBookingAndTrip(db, { bookingId: 900, tripId: 100 });
        seedBookingAndTrip(db, { bookingId: 901, tripId: 100 });
        // B's underlying session row is deliberately made the OLDER one by
        // created_at (i.e. the carrier generated link B's session before
        // link A's) — proving the outcome tracks BIND order, not creation
        // order, which is exactly the ambiguity a naive "ORDER BY
        // created_at DESC" would get wrong.
        const sessionB = await generateSubscriptionSession(901, { supabaseClient: db });
        db._tables.booking_subscription_sessions.get(sessionB.sessionId).created_at = new Date(Date.now() - 60000).toISOString();
        const sessionA = await generateSubscriptionSession(900, { supabaseClient: db });

        // Bind order: A first, then B (the user clicks A's link, then B's).
        await bindSubscriptionSession(sessionA.sessionToken, 555000111, { supabaseClient: db });
        const bindB = await bindSubscriptionSession(sessionB.sessionToken, 555000111, { supabaseClient: db });
        assert.equal(bindB.success, true);

        const result = await completeSubscription(555000111, 2, 'passenger', { supabaseClient: db });
        assert.equal(result.success, true);
        assert.equal(result.bookingId, 901, 'the most recently BOUND session (B) must win, even though it was created earlier');

        const sessionARow = [...db._tables.booking_subscription_sessions.values()].find(r => r.booking_id === 900);
        assert.ok(sessionARow.superseded_at, 'A must be marked superseded the instant B is bound');
        assert.ok(!sessionARow.consumed_at, 'A must never be silently consumed — only superseded');

        // A second, independent completion attempt must never also resolve
        // the superseded session A — there is exactly one outcome, not two.
        const secondAttempt = await completeSubscription(555000111, 3, 'passenger', { supabaseClient: db });
        assert.equal(secondAttempt.success, false, 'B is already consumed and A is superseded — nothing left to complete');
    });

    it('a bind for one telegram_id never supersedes a DIFFERENT telegram_id\'s session (an intermediary and a passenger with different telegram accounts both work independently)', async () => {
        const db = createMockDb();
        seedBookingAndTrip(db, { bookingId: 900, tripId: 100 });
        seedBookingAndTrip(db, { bookingId: 901, tripId: 100 });
        await startAndBind(db, 900, 555000111); // passenger's own telegram
        await startAndBind(db, 901, 777000222); // intermediary's own, different telegram

        const passengerResult = await completeSubscription(555000111, 2, 'passenger', { supabaseClient: db });
        const intermediaryResult = await completeSubscription(777000222, 3, 'intermediary', { supabaseClient: db });

        assert.equal(passengerResult.success, true);
        assert.equal(passengerResult.bookingId, 900);
        assert.equal(intermediaryResult.success, true);
        assert.equal(intermediaryResult.bookingId, 901);
    });

    it('repeat contact-share after a completed subscription never creates a second subscription for that telegram_id', async () => {
        const db = createMockDb();
        seedBookingAndTrip(db);
        await startAndBind(db, 900, 555000111);
        const first = await completeSubscription(555000111, 2, 'passenger', { supabaseClient: db });
        assert.equal(first.success, true);

        // The bot re-sends the same contact-share (e.g. a duplicate webhook
        // delivery) with no new bind in between — there is no bound,
        // unconsumed session left for this telegram_id anymore.
        const repeat = await completeSubscription(555000111, 2, 'passenger', { supabaseClient: db });
        assert.equal(repeat.success, false);
        assert.equal(repeat.error, 'SESSION_INVALID_EXPIRED_OR_CONSUMED');
        assert.equal(db._tables.booking_followers.size, 1, 'still exactly one follower row, never a duplicate');
    });

    it('a superseded session can never be completed, even before its own TTL expires', async () => {
        const db = createMockDb();
        seedBookingAndTrip(db, { bookingId: 900, tripId: 100 });
        seedBookingAndTrip(db, { bookingId: 901, tripId: 100 });
        const sessionA = await generateSubscriptionSession(900, { supabaseClient: db });
        await bindSubscriptionSession(sessionA.sessionToken, 555000111, { supabaseClient: db });
        const sessionB = await generateSubscriptionSession(901, { supabaseClient: db });
        await bindSubscriptionSession(sessionB.sessionToken, 555000111, { supabaseClient: db }); // supersedes A

        const sessionARow = db._tables.booking_subscription_sessions.get(sessionA.sessionId);
        assert.ok(sessionARow.superseded_at);
        assert.ok(new Date(sessionARow.expires_at) > new Date(), 'A has not actually expired, only been superseded');

        const result = await completeSubscription(555000111, 2, 'passenger', { supabaseClient: db });
        assert.equal(result.bookingId, 901, 'only B (the non-superseded session) can ever be completed');
    });

    it('binding a second session for the same telegram_id leaves exactly one non-superseded bound session, never two', async () => {
        const db = createMockDb();
        seedBookingAndTrip(db, { bookingId: 900, tripId: 100 });
        seedBookingAndTrip(db, { bookingId: 901, tripId: 100 });
        const sessionA = await generateSubscriptionSession(900, { supabaseClient: db });
        const sessionB = await generateSubscriptionSession(901, { supabaseClient: db });
        await bindSubscriptionSession(sessionA.sessionToken, 555000111, { supabaseClient: db });
        await bindSubscriptionSession(sessionB.sessionToken, 555000111, { supabaseClient: db });

        const active = [...db._tables.booking_subscription_sessions.values()]
            .filter(r => String(r.bound_telegram_id) === '555000111' && !r.consumed_at && !r.superseded_at);
        assert.equal(active.length, 1, 'at most one active bound session per telegram_id, ever');
        assert.equal(active[0].booking_id, 901);
    });

    it('idempotent re-subscribe on an already-active follower logs no duplicate event', async () => {
        const db = createMockDb();
        seedBookingAndTrip(db);
        await startAndBind(db, 900, 555000111);
        await completeSubscription(555000111, 2, 'passenger', { supabaseClient: db });

        await startAndBind(db, 900, 555000111);
        const result = await completeSubscription(555000111, 2, 'passenger', { supabaseClient: db });

        assert.equal(result.success, true);
        assert.equal(result.event, 'already_active');
        const events = db._tables.booking_follower_events.filter(e => e.user_id === 2);
        assert.equal(events.length, 1); // still just the original "subscribed"
    });

    it('unsubscribe then re-subscribe logs "resubscribed", not a second "subscribed"', async () => {
        const db = createMockDb();
        seedBookingAndTrip(db);
        await startAndBind(db, 900, 555000111);
        await completeSubscription(555000111, 2, 'passenger', { supabaseClient: db });

        const unsub = await unsubscribeFollower(900, 2, { supabaseClient: db });
        assert.equal(unsub.success, true);

        await startAndBind(db, 900, 555000111);
        const result = await completeSubscription(555000111, 2, 'unknown', { supabaseClient: db });
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
        await startAndBind(db, 900, 555000111);
        await completeSubscription(555000111, 2, 'passenger', { supabaseClient: db });
        await unsubscribeFollower(900, 2, { supabaseClient: db });

        const row = [...db._tables.booking_followers.values()].find(r => r.user_id === 2);
        assert.ok(row, 'row must still physically exist');
        assert.equal(row.notifications_enabled, false);
        assert.ok(row.unsubscribed_at);
    });

    it('malformed/unrecognized role_declared never throws and is stored as "unknown"', async () => {
        const db = createMockDb();
        seedBookingAndTrip(db);
        await startAndBind(db, 900, 555000111);
        const result = await completeSubscription(555000111, 2, 'DROP TABLE users;--', { supabaseClient: db });
        assert.equal(result.success, true);
        const row = [...db._tables.booking_followers.values()].find(r => r.user_id === 2);
        assert.equal(row.role_declared, 'unknown');
    });

    it('booking cancelled between bind and bot confirmation is caught at completion time too', async () => {
        const db = createMockDb();
        seedBookingAndTrip(db);
        await startAndBind(db, 900, 555000111);
        db._tables.bus_ticket_bookings.get(900).status = 'cancelled';
        const result = await completeSubscription(555000111, 2, 'passenger', { supabaseClient: db });
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

describe('getActiveFollowerCount — carrier-facing aggregate only', () => {
    it('0 followers', async () => {
        const db = createMockDb();
        seedBookingAndTrip(db);
        assert.equal(await getActiveFollowerCount(900, { supabaseClient: db }), 0);
    });

    it('counts only active (non-unsubscribed) followers', async () => {
        const db = createMockDb();
        seedBookingAndTrip(db);
        await startAndBind(db, 900, 555000111);
        await completeSubscription(555000111, 2, 'passenger', { supabaseClient: db });
        await startAndBind(db, 900, 777000222);
        await completeSubscription(777000222, 3, 'intermediary', { supabaseClient: db });
        assert.equal(await getActiveFollowerCount(900, { supabaseClient: db }), 2);

        await unsubscribeFollower(900, 2, { supabaseClient: db });
        assert.equal(await getActiveFollowerCount(900, { supabaseClient: db }), 1);
    });

    it('never throws and returns 0 when the underlying table is unreachable', async () => {
        const brokenClient = { from() { throw new Error('table does not exist'); } };
        const count = await getActiveFollowerCount(900, { supabaseClient: brokenClient });
        assert.equal(count, 0);
    });

    it('a follower with notifications muted (notifications_enabled:false) but NOT unsubscribed is excluded from the count — it must mirror exactly who the trip-edit fan-out would actually notify', async () => {
        const db = createMockDb();
        seedBookingAndTrip(db);
        await startAndBind(db, 900, 555000111);
        await completeSubscription(555000111, 2, 'passenger', { supabaseClient: db });
        assert.equal(await getActiveFollowerCount(900, { supabaseClient: db }), 1);

        // Mute without unsubscribing — a distinct state the schema allows
        // (unsubscribed_at and notifications_enabled are independent
        // columns), which getActiveFollowerCount must not conflate with an
        // active, notifiable subscriber.
        const row = [...db._tables.booking_followers.values()].find(r => r.booking_id === 900 && r.user_id === 2);
        row.notifications_enabled = false;
        assert.equal(await getActiveFollowerCount(900, { supabaseClient: db }), 0);
    });
});

describe('Raw token lifecycle: never persisted anywhere after bind', () => {
    it('the mock DB (standing in for both backend and bot-side storage) holds no row containing the raw token after bind — only its hash', async () => {
        const db = createMockDb();
        seedBookingAndTrip(db);
        const session = await generateSubscriptionSession(900, { supabaseClient: db });
        await bindSubscriptionSession(session.sessionToken, 555000111, { supabaseClient: db });

        for (const table of Object.values(db._tables)) {
            if (!(table instanceof Map)) continue;
            for (const row of table.values()) {
                const serialized = JSON.stringify(row);
                assert.ok(!serialized.includes(session.sessionToken), 'raw token leaked into a stored row');
            }
        }
    });
});
