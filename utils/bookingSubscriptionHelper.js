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
 * Completes a subscription: verifies the raw token against the stored hash,
 * TTL, purpose and consumed_at, re-checks booking/trip availability, and
 * atomically upserts booking_followers + a booking_follower_events row.
 * Idempotent for an already-active follower (no duplicate event).
 */
async function completeSubscription(sessionToken, userId, roleDeclared, options = {}) {
    const dbClient = getSubscriptionDb(options);
    if (!sessionToken || typeof sessionToken !== 'string') {
        return { success: false, error: 'INVALID_SESSION_TOKEN' };
    }
    const tokenHash = hashSubscriptionToken(sessionToken.trim());
    const safeRole = normalizeRoleDeclared(roleDeclared);

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
        p_session_hash: tokenHash,
        p_user_id: userId,
        p_role_declared: safeRole
    });

    if (error || !data || data.success !== true) {
        return { success: false, error: (data && data.error) || (error && error.message) || 'COMPLETE_SUBSCRIPTION_FAILED' };
    }
    return { success: true, bookingId: data.booking_id, event: data.event };
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
    completeSubscription,
    unsubscribeFollower
};
