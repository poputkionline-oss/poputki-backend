/**
 * notificationRecipientDedup.js
 *
 * Manual Booking Telegram Subscription Model — recipient deduplication.
 *
 * A single manual booking can now have a recipient reachable through up to
 * three independent paths: bus_ticket_bookings.passenger_id,
 * bus_ticket_bookings.claimed_by_user_id (the pre-existing online-claim
 * ownership field — untouched by this model, but still a valid recipient
 * source for a booking that happens to have been claimed the old way), and
 * one or more booking_followers rows. The same platform user_id can appear
 * through more than one of these at once (e.g. the same person is both
 * claimed_by_user_id AND, redundantly, a booking_followers row). Without
 * dedup, a trip-change notification fan-out would message that person
 * multiple times for the same event.
 *
 * This module is intentionally standalone and NOT yet wired into
 * utils/tripChangeNotificationService.js / the bus_trip_change_outbox
 * fan-out (that recipient list is currently populated by a ~480-line
 * PL/pgSQL trigger function in docs/migrations/20260906_bus_trip_change_
 * outbox.sql, not JS) — integrating booking_followers into that trigger is
 * its own follow-up requiring a dedicated read of that migration, out of
 * scope for this pass. This function is the tested building block for that
 * follow-up.
 */

/**
 * @param {Array<{userId: (number|string), source: string}>} candidates -
 *   e.g. [{userId: 5, source: 'claimed_by_user_id'}, {userId: 5, source: 'booking_followers'}]
 * @returns {Array<{userId: (number|string), source: string}>} one entry per
 *   distinct userId; when the same user appears via multiple sources, the
 *   first-seen source wins (stable, deterministic) and is kept for
 *   observability only — it never affects which data the user sees.
 */
function dedupeNotificationRecipients(candidates) {
    if (!Array.isArray(candidates)) return [];
    const seen = new Set();
    const result = [];
    for (const candidate of candidates) {
        if (!candidate || candidate.userId === null || candidate.userId === undefined) continue;
        const key = String(candidate.userId);
        if (seen.has(key)) continue;
        seen.add(key);
        result.push({ userId: candidate.userId, source: candidate.source || 'unknown' });
    }
    return result;
}

/**
 * Convenience builder: from a booking row + its active (non-unsubscribed)
 * booking_followers rows, produce the candidate list that
 * dedupeNotificationRecipients() expects.
 *
 * @param {{passenger_id: ?number, claimed_by_user_id: ?number}} booking
 * @param {Array<{user_id: number, notifications_enabled: boolean}>} followers
 */
function buildNotificationCandidates(booking, followers = []) {
    const candidates = [];
    // Mirrors routes/busAdmin.js's own `effectiveUserId = b.claimed_by_user_id
    // || b.passenger_id` exactly — these are NOT two independent recipients.
    // For a manual booking, passenger_id is set to the CARRIER's own user id
    // at booking-creation time (routes/busAdmin.js's manual-booking insert:
    // "passenger_id: req.carrier.user_id // Authenticated carrier manager
    // (legacy surrogate)") — it is a fallback identity for the same single
    // "owner" slot, never a second, additional recipient alongside
    // claimed_by_user_id.
    const effectiveUserId = booking?.claimed_by_user_id || booking?.passenger_id;
    if (effectiveUserId) {
        candidates.push({ userId: effectiveUserId, source: booking?.claimed_by_user_id ? 'claimed_by_user_id' : 'passenger_id' });
    }
    for (const follower of followers) {
        if (follower && follower.notifications_enabled) {
            candidates.push({ userId: follower.user_id, source: 'booking_followers' });
        }
    }
    return dedupeNotificationRecipients(candidates);
}

module.exports = { dedupeNotificationRecipients, buildNotificationCandidates };
