/**
 * bookingChannelHelper.js
 *
 * Single canonical manual/online booking classifier (Phase: Subscription
 * Model). `channel`/`source_type` were found NOT to be a reliable signal:
 * the direct online-booking insert (routes/busBookings.js) never sets
 * either column, so both fall back to their table DEFAULT, which is
 * 'manual' for both — an online booking can carry channel='manual',
 * source_type='manual' at rest. adminPassengerFunnel.js already relies on
 * `channel === 'manual' || source_type === 'manual'` for its own filtering,
 * which inherits that same blind spot; this helper deliberately does not
 * reuse that pattern for anything authorization-relevant.
 *
 * `created_by_user_id` is the one field every known booking-creation path
 * sets consistently AND intentionally for exactly this purpose:
 *   - routes/busAdmin.js manual booking insert: created_by_user_id =
 *     req.carrier.user_id (explicit).
 *   - routes/smartpay.js online booking insert: created_by_user_id = null,
 *     with the inline comment "Online bookings cannot be created by an
 *     internal manager".
 *   - routes/busBookings.js direct online insert: omits the column
 *     entirely, which is NULL by the column's own nullable-no-default
 *     definition — consistent with "online" under this same rule.
 */

/**
 * @param {Object} booking - a bus_ticket_bookings row (or partial projection
 *   including at least created_by_user_id)
 * @returns {boolean} true if this booking was created by a carrier/staff
 *   member through the manual-booking path, false for a self-service
 *   online booking.
 */
function isManualBooking(booking) {
    if (!booking) return false;
    return booking.created_by_user_id !== null && booking.created_by_user_id !== undefined;
}

module.exports = { isManualBooking };
