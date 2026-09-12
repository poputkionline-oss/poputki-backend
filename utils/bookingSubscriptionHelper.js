/**
 * bookingSubscriptionHelper.js
 *
 * Manual-booking Telegram subscription model (booking_followers).
 *
 * Deliberately separate from utils/claimHelper.js / booking_claim_sessions /
 * fn_claim_booking_auto: a token minted here can never be consumed by the
 * online-booking ownership-transfer claim flow, and vice versa — different
 * table, different hash column, different `purpose` domain, different
 * Telegram deep-link prefix (`subscribe_` vs `claim_`/`s_`).
 *
 * Behind MANUAL_BOOKING_SUBSCRIPTION_MODEL_ENABLED (default false/unset).
 * When the flag is off, every exported function here still works in
 * isolation (so it stays fully unit-testable), but routes/claims.js never
 * calls into this module at all — see the route-level flag gate there.
 */

const crypto = require('crypto');
const { getServiceRoleClient } = require('../dbServiceRole');

const SUBSCRIPTION_SESSION_TTL_MS = 15 * 60 * 1000;
const VALID_ROLES = ['unknown', 'passenger', 'family_or_group', 'coordinator', 'intermediary'];
const DUSHANBE_UTC_OFFSET_MS = 5 * 60 * 60 * 1000; // Asia/Dushanbe = UTC+5, no DST
const ARRIVAL_GRACE_MS = 12 * 60 * 60 * 1000; // same watermark as the existing trip auto-complete sweep

function getSubscriptionDb(options = {}) {
    return options.supabaseClient || getServiceRoleClient() || require('../db');
}

function isInjectedMock(options = {}) {
    return Boolean(options.supabaseClient && typeof options.supabaseClient.rpc !== 'function');
}

/** Separate hash function/namespace from claimHelper.hashSessionToken, even
 * though the algorithm is identical — the two token types must never be
 * interchangeable by convention as well as by table structure. */
function hashSubscriptionToken(token) {
    if (!token || typeof token !== 'string') return '';
    return crypto.createHash('sha256').update(token.trim()).digest('hex');
}

/**
 * Server-side re-implementation of fn_is_booking_subscribable(), used by the
 * mock/test path and exported for direct unit testing against the same
 * rule the real RPC enforces. NOT itself the source of truth in production
 * (the RPC re-checks this atomically inside the same transaction as the
 * hash/TTL/consumed check) — this exists so the rule can be tested without
 * a live database and so ticket-view (a plain read) can show the same
 * canSubscribe answer without a round trip through the RPC meant for
 * mutating calls.
 *
 * @param {{status: string}} booking
 * @param {{status: string, arrival_date: string, arrival_time: string}} trip
 * @param {Date} [now]
 */
function isBookingSubscribable(booking, trip, now = new Date()) {
    if (!booking || !trip) return false;
    if (booking.status !== 'confirmed') return false;
    if (trip.status === 'completed' || trip.status === 'cancelled') return false;
    if (!trip.arrival_date || !trip.arrival_time) return false;

    const [h = 0, m = 0, s = 0] = String(trip.arrival_time).split(':').map(Number);
    const arrivalWallClockUtcMs = Date.parse(`${trip.arrival_date}T00:00:00Z`)
        + ((h * 3600 + m * 60 + s) * 1000);
    if (Number.isNaN(arrivalWallClockUtcMs)) return false;

    // Wall-clock time in Asia/Dushanbe converted to the true UTC instant.
    const arrivalUtcMs = arrivalWallClockUtcMs - DUSHANBE_UTC_OFFSET_MS;
    return (arrivalUtcMs + ARRIVAL_GRACE_MS) > now.getTime();
}

/** Never trust caller-supplied role_declared beyond this allowlist — used
 * both defensively in Node (before ever reaching the RPC) and mirrored by
 * the RPC's own server-side CASE normalization, per the "double safety net"
 * design: neither layer alone is trusted to be the only check. */
function normalizeRoleDeclared(role) {
    return VALID_ROLES.includes(role) ? role : 'unknown';
}

/**
 * Starts a new 15-minute subscription session for a booking. Independent of
 * any other session already open for the same booking — no invalidation of
 * prior sessions, so an intermediary and the real passenger can each hold
 * their own concurrent session.
 *
 * @returns {Promise<{success:boolean, sessionId?:string, sessionToken?:string,
 *   expiresAt?:string, deepLink?:string, error?:string}>}
 */
async function generateSubscriptionSession(bookingId, options = {}) {
    const dbClient = getSubscriptionDb(options);
    const rawToken = crypto.randomBytes(16).toString('hex'); // 128 bits of entropy
    const tokenHash = hashSubscriptionToken(rawToken);

    let sessionId;
    if (isInjectedMock(options)) {
        const { data: booking } = await dbClient.from('bus_ticket_bookings').select('*').eq('id', bookingId).single();
        if (!booking) return { success: false, error: 'BOOKING_NOT_FOUND' };
        const { data: trip } = await dbClient.from('bus_tickets').select('*').eq('id', booking.bus_ticket_id).single();
        if (!trip || !isBookingSubscribable(booking, trip, options.now)) {
            return { success: false, error: 'BOOKING_NOT_SUBSCRIBABLE' };
        }
        const expiresAt = new Date((options.now ? options.now.getTime() : Date.now()) + SUBSCRIPTION_SESSION_TTL_MS).toISOString();
        const { data: inserted, error } = await dbClient
            .from('booking_subscription_sessions')
            .insert([{ booking_id: bookingId, session_token_hash: tokenHash, purpose: 'booking_subscription', expires_at: expiresAt }])
            .select('*')
            .single();
        if (error) return { success: false, error: 'BOOKING_SUBSCRIPTION_SESSION_INSERT_FAILED' };
        sessionId = inserted.id;
        var expiresAtOut = expiresAt;
    } else {
        const { data, error } = await dbClient.rpc('fn_start_booking_subscription_session', {
            p_booking_id: bookingId,
            p_session_token_hash: tokenHash
        });
        if (error || !data || data.success !== true) {
            return { success: false, error: (data && data.error) || (error && error.message) || 'START_SUBSCRIPTION_SESSION_FAILED' };
        }
        sessionId = data.session_id;
        expiresAtOut = new Date(Date.now() + SUBSCRIPTION_SESSION_TTL_MS).toISOString();
    }

    const botUsername = process.env.TELEGRAM_BOT_USERNAME || 'Poputkionline_bot';
    return {
        success: true,
        sessionId,
        sessionToken: rawToken,
        expiresAt: expiresAtOut,
        deepLink: `https://t.me/${botUsername}?start=subscribe_${rawToken}`
    };
}

/**
 * Binds a just-started subscription session to a Telegram user id. This is
 * the ONLY function that ever sees the raw token again after
 * generateSubscriptionSession() minted it — called once, synchronously,
 * from the bot's /start subscribe_<token> webhook handler. The raw token is
 * discarded by the caller immediately afterwards: it is never written to
 * any table, bot-side (bot_user_states or otherwise) or backend-side, and
 * this function itself only ever persists the hash it computes here (which
 * was already being stored anyway) plus the telegram id.
 */
async function bindSubscriptionSession(sessionToken, telegramId, options = {}) {
    const dbClient = getSubscriptionDb(options);
    if (!sessionToken || typeof sessionToken !== 'string') {
        return { success: false, error: 'INVALID_SESSION_TOKEN' };
    }
    const tokenHash = hashSubscriptionToken(sessionToken.trim());

    if (isInjectedMock(options)) {
        const now = options.now || new Date();
        const { data: session } = await dbClient
            .from('booking_subscription_sessions')
            .select('*')
            .eq('session_token_hash', tokenHash)
            .single();

        if (!session || session.purpose !== 'booking_subscription' || session.consumed_at
            || new Date(session.expires_at) <= now) {
            return { success: false, error: 'SESSION_INVALID_EXPIRED_OR_CONSUMED' };
        }

        await dbClient.from('booking_subscription_sessions').update({ bound_telegram_id: telegramId }).eq('id', session.id);
        return { success: true };
    }

    const { data, error } = await dbClient.rpc('fn_bind_booking_subscription_session', {
        p_session_token_hash: tokenHash,
        p_telegram_id: telegramId
    });

    if (error || !data || data.success !== true) {
        return { success: false, error: (data && data.error) || (error && error.message) || 'BIND_SUBSCRIPTION_SESSION_FAILED' };
    }
    return { success: true };
}

/**
 * Cheap, side-effect-free existence check: is there ANY bound, unconsumed,
 * unexpired subscription session for this telegramId? Used by routes/
 * claims.js's /bot/subscribe handler to decide, BEFORE touching the users
 * table at all, whether an incoming contact-share is actually a subscribe
 * completion attempt or just an ordinary contact share the bot opportunistically
 * offered to this endpoint (see api/bot-claim.js's attemptSubscribeFromContact
 * in the bot repo). Without this early check, resolveOrCreateTelegramPassenger
 * would run — and potentially link/create user records — on every contact
 * share, not just ones that actually intended to subscribe.
 */
async function hasPendingSubscription(telegramId, options = {}) {
    const dbClient = getSubscriptionDb(options);
    const now = options.now || new Date();

    if (isInjectedMock(options)) {
        const allSessions = [...(dbClient._tables?.booking_subscription_sessions?.values?.() || [])];
        return allSessions.some(r => String(r.bound_telegram_id) === String(telegramId)
            && r.purpose === 'booking_subscription' && !r.consumed_at && new Date(r.expires_at) > now);
    }

    try {
        const { data, error } = await dbClient
            .from('booking_subscription_sessions')
            .select('id')
            .eq('bound_telegram_id', telegramId)
            .eq('purpose', 'booking_subscription')
            .is('consumed_at', null)
            .gt('expires_at', now.toISOString())
            .limit(1);

        if (error) return false;
        return Array.isArray(data) && data.length > 0;
    } catch (_) {
        return false;
    }
}

/**
 * Completes a subscription for whichever session was most recently bound to
 * this telegramId (see bindSubscriptionSession above) — NOT by raw token,
 * which the bot no longer holds by the time the Telegram contact-share
 * message arrives. Re-checks purpose/consumed_at/TTL and booking/trip
 * availability, and atomically upserts booking_followers + a
 * booking_follower_events row. Idempotent for an already-active follower
 * (no duplicate event). If more than one session is currently bound to this
 * telegramId (e.g. two different manual bookings' subscribe links opened in
 * quick succession), only the most recently bound one is completed — see
 * the migration's own comment on fn_complete_booking_subscription for why
 * this is a Telegram UX constraint, not an added limitation.
 */
async function completeSubscription(telegramId, userId, roleDeclared, options = {}) {
    const dbClient = getSubscriptionDb(options);
    const safeRole = normalizeRoleDeclared(roleDeclared);

    if (isInjectedMock(options)) {
        const now = options.now || new Date();
        // The lightweight test mock only supports single-row select/eq
        // lookups; emulate "most recently bound, still-valid session for
        // this telegramId" by scanning the mock's own in-memory rows
        // directly (production does the equivalent as one indexed SQL query
        // inside fn_complete_booking_subscription — see the migration).
        const allSessions = [...(dbClient._tables?.booking_subscription_sessions?.values?.() || [])];
        const candidates = allSessions
            .filter(r => String(r.bound_telegram_id) === String(telegramId)
                && r.purpose === 'booking_subscription' && !r.consumed_at && new Date(r.expires_at) > now)
            .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
        const session = candidates[0] || null;

        if (!session) {
            return { success: false, error: 'SESSION_INVALID_EXPIRED_OR_CONSUMED' };
        }

        const { data: booking } = await dbClient.from('bus_ticket_bookings').select('*').eq('id', session.booking_id).single();
        const { data: trip } = booking ? await dbClient.from('bus_tickets').select('*').eq('id', booking.bus_ticket_id).single() : { data: null };
        if (!booking || !trip || !isBookingSubscribable(booking, trip, now)) {
            return { success: false, error: 'BOOKING_NOT_SUBSCRIBABLE' };
        }

        const { data: existing } = await dbClient
            .from('booking_followers')
            .select('*')
            .eq('booking_id', session.booking_id)
            .eq('user_id', userId)
            .maybeSingle();

        const eventType = !existing ? 'subscribed' : (existing.unsubscribed_at ? 'resubscribed' : null);

        await dbClient.from('booking_followers').upsert({
            booking_id: session.booking_id,
            user_id: userId,
            role_declared: safeRole,
            notifications_enabled: true,
            unsubscribed_at: null
        }, { onConflict: 'booking_id,user_id' });

        if (eventType) {
            await dbClient.from('booking_follower_events').insert([{ booking_id: session.booking_id, user_id: userId, event_type: eventType }]);
        }

        await dbClient.from('booking_subscription_sessions').update({ consumed_at: now.toISOString() }).eq('id', session.id);

        return { success: true, bookingId: session.booking_id, event: eventType || 'already_active' };
    }

    const { data, error } = await dbClient.rpc('fn_complete_booking_subscription', {
        p_telegram_id: telegramId,
        p_user_id: userId,
        p_role_declared: safeRole
    });

    if (error || !data || data.success !== true) {
        return { success: false, error: (data && data.error) || (error && error.message) || 'COMPLETE_SUBSCRIPTION_FAILED' };
    }
    return { success: true, bookingId: data.booking_id, event: data.event };
}

/**
 * Carrier-facing aggregate only — count of currently active (not
 * unsubscribed) followers for a booking. Never returns user_id, telegram_id,
 * username, phone, or name. Returns 0 (never throws) when the subscription
 * model tables aren't reachable — e.g. the feature flag is off in an
 * environment where the migration hasn't been applied — so the caller's
 * existing response shape is never broken by this being additive.
 */
async function getActiveFollowerCount(bookingId, options = {}) {
    const dbClient = getSubscriptionDb(options);
    try {
        if (isInjectedMock(options)) {
            const all = [...(dbClient._tables?.booking_followers?.values?.() || [])];
            return all.filter(r => String(r.booking_id) === String(bookingId) && !r.unsubscribed_at).length;
        }
        const { count, error } = await dbClient
            .from('booking_followers')
            .select('id', { count: 'exact', head: true })
            .eq('booking_id', bookingId)
            .is('unsubscribed_at', null);
        if (error) return 0;
        return count || 0;
    } catch {
        return 0;
    }
}

async function unsubscribeFollower(bookingId, userId, options = {}) {
    const dbClient = getSubscriptionDb(options);

    if (isInjectedMock(options)) {
        const { data: existing } = await dbClient
            .from('booking_followers')
            .select('*')
            .eq('booking_id', bookingId)
            .eq('user_id', userId)
            .maybeSingle();

        if (!existing || existing.unsubscribed_at) {
            return { success: false, error: 'NOT_SUBSCRIBED_OR_ALREADY_UNSUBSCRIBED' };
        }

        await dbClient.from('booking_followers').update({
            notifications_enabled: false,
            unsubscribed_at: new Date().toISOString()
        }).eq('booking_id', bookingId).eq('user_id', userId);

        await dbClient.from('booking_follower_events').insert([{ booking_id: bookingId, user_id: userId, event_type: 'unsubscribed' }]);
        return { success: true };
    }

    const { data, error } = await dbClient.rpc('fn_unsubscribe_booking_follower', { p_booking_id: bookingId, p_user_id: userId });
    if (error || !data || data.success !== true) {
        return { success: false, error: (data && data.error) || (error && error.message) || 'UNSUBSCRIBE_FAILED' };
    }
    return { success: true };
}

module.exports = {
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
};
