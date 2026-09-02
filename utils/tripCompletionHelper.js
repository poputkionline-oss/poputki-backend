/**
 * tripCompletionHelper.js — Canonical Trip Completion & Auto-Complete Logic
 *
 * Phase E.47.1 — QR Boarding + Automatic Trip Completion
 * Phase E.47.2 — Atomic completion via fn_complete_bus_trip() RPC
 *
 * Guarantees:
 * - Single canonical completion service used by BOTH manual ("Завершить рейс")
 *   and automatic (arrival + 12h sweep) completion paths.
 * - TRUE ACID atomicity: the actual mutation (STEP 1 pending_boarding ->
 *   no_show, STEP 2 trip -> completed) happens inside ONE Postgres
 *   transaction via the fn_complete_bus_trip(...) RPC — see
 *   docs/migrations/20260902_atomic_trip_completion.sql. The RPC locks the
 *   trip row (SELECT ... FOR UPDATE) for the duration of the transaction, so
 *   a concurrent completion request for the SAME trip serializes behind it
 *   instead of racing it.
 * - Idempotent: completing an already-completed trip is a safe no-op
 *   (verified inside the same locked transaction, not as a separate query).
 * - Never touches: boarded bookings, already no_show bookings, cancelled /
 *   non-confirmed bookings, payment fields, commission/payout fields,
 *   Ticket V1.1 data, or historical rows (nothing is deleted).
 * - The RPC is GRANTed to service_role only (REVOKEd from anon/authenticated),
 *   so this module always calls it through the service-role client — see
 *   dbServiceRole.js — mirroring the fn_claim_booking_auto convention already
 *   established in utils/claimHelper.js.
 */

const { getServiceRoleClient } = require('../dbServiceRole');
const { logCarrierActivity, AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } = require('./auditHelper');

// Tajikistan does not observe DST; Asia/Dushanbe is a fixed UTC+5 zone.
// We still resolve the offset via Intl (rather than hardcoding +5) so the
// logic stays correct if the platform's business timezone model ever changes,
// consistent with utils/dashboardHelper.js's getBusinessLocalDate/Time.
const BUSINESS_TIME_ZONE = 'Asia/Dushanbe';
const AUTO_COMPLETE_GRACE_MS = 12 * 60 * 60 * 1000; // arrival + 12 hours

/**
 * Converts a "wall clock" date/time pair, interpreted in the given IANA
 * timezone, into the correct UTC Date instant. Handles fixed and
 * DST-observing zones alike via a single-pass offset resolution (safe for
 * fixed-offset zones like Asia/Dushanbe; sufficient precision for scheduling
 * a 12h grace window).
 *
 * @param {string} dateStr - 'YYYY-MM-DD'
 * @param {string} timeStr - 'HH:mm' or 'HH:mm:ss'
 * @param {string} timeZone - IANA timezone name
 * @returns {Date|null}
 */
function zonedTimeToUtcDate(dateStr, timeStr, timeZone = BUSINESS_TIME_ZONE) {
    if (!dateStr || typeof dateStr !== 'string') return null;
    const dateMatch = dateStr.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!dateMatch) return null;

    const timeSrc = (timeStr && typeof timeStr === 'string') ? timeStr.trim() : '00:00:00';
    const timeMatch = timeSrc.match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (!timeMatch) return null;

    const [, y, mo, d] = dateMatch;
    const [, hh, mm, ss] = timeMatch;

    // Naive instant: treat the wall-clock values as if they were UTC.
    const naiveUtcMs = Date.UTC(
        Number(y), Number(mo) - 1, Number(d),
        Number(hh), Number(mm), Number(ss || 0)
    );
    if (Number.isNaN(naiveUtcMs)) return null;

    // Ask Intl what that naive-UTC instant looks like when rendered in the
    // target timezone, and use the delta as the zone's offset at that instant.
    const dtf = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
    const parts = dtf.formatToParts(new Date(naiveUtcMs));
    const get = (type) => Number(parts.find(p => p.type === type)?.value);
    const renderedUtcMs = Date.UTC(
        get('year'), get('month') - 1, get('day'),
        get('hour') === 24 ? 0 : get('hour'), get('minute'), get('second')
    );

    const offsetMs = renderedUtcMs - naiveUtcMs;
    return new Date(naiveUtcMs - offsetMs);
}

/**
 * Resolves the trip's scheduled arrival instant (UTC), using arrival_date +
 * arrival_time interpreted in the platform business timezone (Asia/Dushanbe).
 *
 * Per project rules, auto-completion must NEVER fall back to departure time
 * when arrival is missing — a trip with no arrival data is simply not
 * eligible for auto-completion (manual completion remains available).
 *
 * @param {Object} trip - bus_tickets row (must have arrival_date, arrival_time)
 * @returns {Date|null}
 */
function getTripArrivalInstant(trip) {
    if (!trip || !trip.arrival_date || !trip.arrival_time) return null;
    return zonedTimeToUtcDate(trip.arrival_date, trip.arrival_time, BUSINESS_TIME_ZONE);
}

/**
 * Determines whether a trip is eligible for AUTOMATIC completion.
 * Rule: status === 'active' AND arrival is a valid date/time AND
 * now >= arrival + 12 hours.
 *
 * @param {Object} trip
 * @param {Date} [now]
 * @returns {boolean}
 */
function isTripEligibleForAutoComplete(trip, now = new Date()) {
    if (!trip || trip.status !== 'active') return false;
    const arrival = getTripArrivalInstant(trip);
    if (!arrival) return false;
    const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
    return nowMs >= (arrival.getTime() + AUTO_COMPLETE_GRACE_MS);
}

/**
 * Resolves the DB client used to call fn_complete_bus_trip(...) and to read
 * candidate trips for the sweep. Defaults to the service-role client (the
 * RPC is GRANTed to service_role only); tests may inject a fake via
 * options.dbClient — see tests/phase_e47_2_atomic_trip_completion.test.js.
 */
function resolveCompletionDb(options = {}) {
    return options.dbClient || getServiceRoleClient();
}

/**
 * CANONICAL trip completion service — the single source of truth used by
 * both the manual "Завершить рейс" action and the automatic arrival+12h
 * sweep. Delegates the actual mutation to the fn_complete_bus_trip(...)
 * Postgres RPC (docs/migrations/20260902_atomic_trip_completion.sql), which
 * performs the lock + STEP 1 (pending_boarding -> no_show) + STEP 2
 * (trip -> completed) as ONE database transaction.
 *
 * @param {Object} options
 * @param {number|string} options.tripId
 * @param {Object} [options.actorContext] - carrier-like context for audit
 *        logging (req.carrier for manual completion, or a synthetic system
 *        actor with role:'system' for the auto-complete sweep). A non-system
 *        actorContext with a carrier_id is also passed to the RPC as
 *        p_expected_operator_id for a defense-in-depth ownership re-check
 *        inside the locked transaction.
 * @param {Object} [options.dbClient] - override DB client (tests only).
 * @returns {Promise<Object>} result descriptor
 */
async function completeTrip({ tripId, actorContext = null, dbClient = null } = {}) {
    if (!tripId) {
        return { success: false, error: 'TRIP_ID_REQUIRED' };
    }

    const db = resolveCompletionDb({ dbClient });

    const expectedOperatorId = (actorContext && actorContext.role !== 'system' && actorContext.carrier_id != null)
        ? Number(actorContext.carrier_id)
        : null;

    const { data, error } = await db.rpc('fn_complete_bus_trip', {
        p_trip_id: Number(tripId),
        p_expected_operator_id: expectedOperatorId
    });

    if (error) {
        console.error('[TripCompletion] fn_complete_bus_trip RPC error:', error);
        return { success: false, error: 'RPC_FAILED', details: error.message };
    }

    if (!data || data.success !== true) {
        return { success: false, error: (data && data.error) || 'COMPLETION_FAILED', status: data && data.status };
    }

    // Audit logging is a secondary, non-atomicity-critical side-effect and
    // stays outside the DB transaction, matching how fn_claim_booking_auto's
    // callers log activity in JS after the RPC succeeds. Skipped on an
    // idempotent no-op (already_completed) so a retry never double-logs.
    if (actorContext && data.already_completed === false) {
        try {
            await logCarrierActivity({
                supabase: db,
                carrierContext: actorContext,
                action: AUDIT_ACTIONS.TRIP_COMPLETED,
                entityType: AUDIT_ENTITY_TYPES.TICKET,
                entityId: data.trip_id,
                entityLabel: `Рейс #${data.trip_id}`,
                oldData: { status: 'active' },
                newData: { status: 'completed' },
                metadata: { reason: 'trip_completion', seats_count: data.no_show_marked || 0 }
            });
        } catch (auditErr) {
            console.warn('[TripCompletion] Non-blocking audit error:', auditErr.message);
        }
    }

    return {
        success: true,
        already_completed: Boolean(data.already_completed),
        trip_id: data.trip_id,
        no_show_marked: data.no_show_marked || 0,
        boarded_preserved: true
    };
}

/**
 * Sweeps ALL carriers' active trips and completes every trip whose arrival
 * + 12h grace period has elapsed. Designed to be triggered periodically
 * (every 30-60 minutes) by the same external Render cron mechanism already
 * used for POST /api/admin/bookings/expire-pending.
 *
 * Safe on restart / re-invocation: each completeTrip() call is independently
 * idempotent AND now atomic (fn_complete_bus_trip locks the trip row), so
 * overlapping sweep runs — or a sweep overlapping a manual completion —
 * cannot double-apply effects.
 *
 * @param {Object} options - { dryRun, now, dbClient }
 * @returns {Promise<Object>}
 */
async function sweepAutoCompleteTrips(options = {}) {
    const { dryRun = false, now = new Date(), dbClient = null } = options;
    const nowTime = now instanceof Date ? now : new Date(now);
    const db = resolveCompletionDb({ dbClient });

    const { data: activeTrips, error: fetchErr } = await db
        .from('bus_tickets')
        .select('id, operator_id, status, from_city, to_city, arrival_date, arrival_time')
        .eq('status', 'active');

    if (fetchErr) {
        console.error('[AutoComplete] Error fetching active trips:', fetchErr);
        throw fetchErr;
    }

    const trips = activeTrips || [];
    const eligible = trips.filter(t => isTripEligibleForAutoComplete(t, nowTime));

    const details = [];
    let completed = 0;
    let failed = 0;
    let totalNoShow = 0;

    for (const trip of eligible) {
        if (dryRun) {
            details.push({ trip_id: trip.id, action: 'would_complete' });
            continue;
        }

        const systemActor = {
            carrier_id: trip.operator_id,
            user_id: 0,
            role: 'system',
            name: 'Система (Авто-завершение рейса)'
        };

        try {
            const result = await completeTrip({ tripId: trip.id, actorContext: systemActor, dbClient: db });
            if (result.success) {
                completed++;
                totalNoShow += result.no_show_marked || 0;
                details.push({ trip_id: trip.id, action: 'completed', no_show_marked: result.no_show_marked });
            } else {
                failed++;
                details.push({ trip_id: trip.id, action: 'failed', error: result.error });
            }
        } catch (itemErr) {
            failed++;
            console.error(`[AutoComplete] Unexpected error completing trip ${trip.id}:`, itemErr);
            details.push({ trip_id: trip.id, action: 'failed', error: itemErr.message });
        }
    }

    return {
        dry_run: dryRun,
        scanned: trips.length,
        eligible: eligible.length,
        completed,
        failed,
        total_no_show_marked: totalNoShow,
        details
    };
}

module.exports = {
    BUSINESS_TIME_ZONE,
    AUTO_COMPLETE_GRACE_MS,
    zonedTimeToUtcDate,
    getTripArrivalInstant,
    isTripEligibleForAutoComplete,
    completeTrip,
    sweepAutoCompleteTrips
};
