/**
 * paymentExpirationHelper.js — Canonical Payment Hold & Expiration Logic
 * 
 * Guarantees:
 * - Deterministic Expiration: SmartPay 30-minute invoice lifetime (1800s).
 * - Legacy Compatibility: Fallback to created_at + 30m when hold_expires_at is null.
 * - Defensive Seat Locking: Expired pending_payment bookings NEVER lock seats,
 *   even if cron / cleanup is delayed.
 * - Idempotency & Race Safety: Conditional DB update (WHERE id = ? AND status = 'pending_payment')
 *   ensures that late payment confirmations are never overwritten by cleanup.
 */

const { logCarrierActivity, AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } = require('./auditHelper');

const DEFAULT_HOLD_TTL_SECONDS = 1800; // 30 minutes
const DEFAULT_HOLD_TTL_MS = DEFAULT_HOLD_TTL_SECONDS * 1000;

/**
 * Calculates the exact expiration Date for a booking hold.
 * 
 * @param {Object} booking 
 * @returns {Date}
 */
function getBookingHoldExpiration(booking) {
    if (!booking) return new Date(0);

    if (booking.hold_expires_at) {
        const parsed = new Date(booking.hold_expires_at);
        if (!isNaN(parsed.getTime())) {
            return parsed;
        }
    }

    // Legacy fallback: created_at + 30 minutes
    if (booking.created_at) {
        const created = new Date(booking.created_at);
        if (!isNaN(created.getTime())) {
            return new Date(created.getTime() + DEFAULT_HOLD_TTL_MS);
        }
    }

    // Malformed/missing dates: default to Unix epoch Date(0) so hold is inactive/expired.
    // NEVER do Date.now() + TTL here, as that creates an infinite rolling hold bug.
    return new Date(0);
}

/**
 * Checks whether a booking's pending payment hold is currently active.
 * 
 * @param {Object} booking 
 * @param {Date|number|string} now 
 * @returns {boolean}
 */
function isPendingHoldActive(booking, now = new Date()) {
    if (!booking) return false;
    if (booking.status !== 'pending_payment') return false;

    const expiration = getBookingHoldExpiration(booking);
    const nowTime = now instanceof Date ? now.getTime() : new Date(now).getTime();

    return expiration.getTime() > nowTime;
}

/**
 * Determines whether a booking currently occupies/locks a seat.
 * 
 * Rule:
 * - status === 'confirmed' -> TRUE (sold)
 * - status === 'pending_payment' && isPendingHoldActive(b, now) -> TRUE (held)
 * - status === 'pending_payment' && !isPendingHoldActive(b, now) -> FALSE (expired hold, free)
 * - status === 'cancelled' -> FALSE (free)
 * 
 * @param {Object} booking 
 * @param {Date|number|string} now 
 * @returns {boolean}
 */
function isSeatLockedByBooking(booking, now = new Date()) {
    if (!booking) return false;
    if (booking.status === 'confirmed') return true;
    if (booking.status === 'pending_payment') {
        return isPendingHoldActive(booking, now);
    }
    return false;
}

/**
 * Filters an array of bookings to only those that actively lock seats.
 * 
 * @param {Array} bookings 
 * @param {Date|number|string} now 
 * @returns {Array}
 */
function filterActiveSeatLocks(bookings = [], now = new Date()) {
    if (!Array.isArray(bookings)) return [];
    return bookings.filter(b => isSeatLockedByBooking(b, now));
}

/**
 * Centralized service to expire stale pending_payment bookings and release seats.
 * 
 * @param {Object} supabase - Supabase client instance
 * @param {Object} options - { dryRun, now, carrierId }
 * @returns {Promise<Object>}
 */
async function expirePendingPaymentBookings(supabase, options = {}) {
    const {
        dryRun = false,
        now = new Date(),
        carrierId = null
    } = options;

    const nowTime = now instanceof Date ? now : new Date(now);

    // 1. Fetch pending_payment bookings
    let query = supabase
        .from('bus_ticket_bookings')
        .select(`
            id,
            bus_ticket_id,
            seat_numbers,
            status,
            created_at,
            hold_expires_at,
            total_price,
            bus_tickets:bus_ticket_id (
                id,
                operator_id,
                from_city,
                to_city
            )
        `)
        .eq('status', 'pending_payment');

    const { data: pendingBookings, error: fetchErr } = await query;

    if (fetchErr) {
        console.error('[PaymentExpiration] Error fetching pending bookings:', fetchErr);
        throw fetchErr;
    }

    const allBookings = pendingBookings || [];
    const scanned = allBookings.length;
    let active = 0;
    let expired = 0;
    let cancelled = 0;
    let skipped = 0;
    let failed = 0;
    const details = [];

    for (const b of allBookings) {
        const isActive = isPendingHoldActive(b, nowTime);
        const expDate = getBookingHoldExpiration(b);

        if (isActive) {
            active++;
            details.push({
                id: b.id,
                bus_ticket_id: b.bus_ticket_id,
                status: 'pending_payment',
                action: 'kept_active',
                hold_expires_at: expDate.toISOString()
            });
            continue;
        }

        // Booking is expired
        expired++;

        if (dryRun) {
            details.push({
                id: b.id,
                bus_ticket_id: b.bus_ticket_id,
                status: 'pending_payment',
                action: 'would_cancel',
                hold_expires_at: expDate.toISOString()
            });
            continue;
        }

        // Atomic conditional cancellation: UPDATE only if status is STILL pending_payment
        try {
            const { data: updatedData, error: updateErr } = await supabase
                .from('bus_ticket_bookings')
                .update({ status: 'cancelled' })
                .eq('id', b.id)
                .eq('status', 'pending_payment')
                .select('id, status');

            if (updateErr) {
                console.error(`[PaymentExpiration] Failed to cancel booking ${b.id}:`, updateErr);
                failed++;
                details.push({ id: b.id, action: 'failed', error: updateErr.message });
                continue;
            }

            if (!updatedData || updatedData.length === 0) {
                // Status changed concurrently (e.g. payment callback succeeded)
                skipped++;
                details.push({ id: b.id, action: 'skipped_race_condition' });
                continue;
            }

            cancelled++;
            details.push({ id: b.id, action: 'cancelled_success' });

            // Write audit activity log (Dual safe: never crashes if audit logging fails)
            const operatorId = b.bus_tickets?.operator_id || carrierId || 0;
            if (operatorId > 0) {
                try {
                    await logCarrierActivity({
                        supabase,
                        carrierContext: {
                            carrier_id: operatorId,
                            user_id: 0,
                            role: 'system',
                            name: 'Система (Автоотмена)'
                        },
                        action: AUDIT_ACTIONS.BOOKING_PAYMENT_EXPIRED || 'booking_payment_expired',
                        entityType: AUDIT_ENTITY_TYPES.BOOKING,
                        entityId: String(b.id),
                        entityLabel: `Бронь #${b.id}`,
                        oldData: { status: 'pending_payment' },
                        newData: { status: 'cancelled' },
                        metadata: { reason: 'payment_timeout' }
                    });
                } catch (auditErr) {
                    console.warn(`[PaymentExpiration] Non-blocking audit error for booking ${b.id}:`, auditErr.message);
                }
            }

        } catch (itemErr) {
            console.error(`[PaymentExpiration] Unexpected error on booking ${b.id}:`, itemErr);
            failed++;
            details.push({ id: b.id, action: 'failed', error: itemErr.message });
        }
    }

    return {
        dry_run: dryRun,
        scanned,
        active,
        expired,
        cancelled,
        skipped,
        failed,
        details
    };
}

module.exports = {
    DEFAULT_HOLD_TTL_SECONDS,
    DEFAULT_HOLD_TTL_MS,
    getBookingHoldExpiration,
    isPendingHoldActive,
    isSeatLockedByBooking,
    filterActiveSeatLocks,
    expirePendingPaymentBookings
};
