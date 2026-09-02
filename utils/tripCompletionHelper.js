/**
 * tripCompletionHelper.js — Canonical Trip Completion & Auto-Complete Logic
 *
 * Phase E.47.1 — QR Boarding + Automatic Trip Completion
 *
 * Guarantees:
 * - Single canonical completion service used by BOTH manual ("Завершить рейс")
 *   and automatic (arrival + 12h sweep) completion paths.
 * - Idempotent: completing an already-completed trip is a safe no-op.
 * - Order-safe convergence: pending -> no_show is applied BEFORE the trip is
 *   marked completed, and both steps are individually idempotent, so a retry
 *   after a partial failure always converges to the correct final state
 *   without any duplicate financial or notification side-effects.
 * - Never touches: boarded bookings, already no_show bookings, cancelled /
 *   non-confirmed bookings, payment fields, commission/payout fields,
 *   Ticket V1.1 data, or historical rows (nothing is deleted).
 *
 * IMPORTANT — Atomicity caveat (see docs/E47_1_REPORT for full detail):
 * Supabase (PostgREST) is used here via two sequential conditional UPDATE
 * statements rather than a single DB transaction/RPC. This is NOT ACID-atomic:
 * a crash between STEP 1 and STEP 2 can leave a trip 'active' with some
 * bookings already flipped to 'no_show'. This is intentional per project
 * instructions (no new RPC/migration without separate approval). The design
 * is instead made SAFE-BY-CONVERGENCE: STEP 1 only touches rows that are
 * still 'pending_boarding', so re-running completeTrip() (manually, or on
 * the next auto-complete sweep) always finishes the job correctly with zero
 * duplicate effects. True ACID atomicity would require a Postgres RPC
 * function wrapping both steps in one transaction.
 */

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
 * CANONICAL trip completion service — the single source of truth used by
 * both the manual "Завершить рейс" action and the automatic arrival+12h
 * sweep. See file header for the atomicity caveat.
 *
 * @param {Object} supabase - Supabase client
 * @param {Object} options
 * @param {number|string} options.tripId
 * @param {Object} [options.actorContext] - carrier-like context for audit logging
 *        (req.carrier for manual completion, or a synthetic system actor for
 *        the auto-complete sweep). If omitted, audit logging is skipped.
 * @returns {Promise<Object>} result descriptor
 */
async function completeTrip(supabase, { tripId, actorContext = null } = {}) {
    if (!tripId) {
        return { success: false, error: 'TRIP_ID_REQUIRED' };
    }

    const { data: trip, error: tripErr } = await supabase
        .from('bus_tickets')
        .select('id, operator_id, status, from_city, to_city, departure_date, departure_time, arrival_date, arrival_time')
        .eq('id', tripId)
        .maybeSingle();

    if (tripErr || !trip) {
        return { success: false, error: 'TRIP_NOT_FOUND' };
    }

    // Idempotency: completing an already-completed trip is a safe no-op.
    if (trip.status === 'completed') {
        return {
            success: true,
            already_completed: true,
            trip_id: trip.id,
            no_show_marked: 0,
            boarded_preserved: true
        };
    }

    if (trip.status !== 'active') {
        return { success: false, error: 'TRIP_NOT_ACTIVE', status: trip.status };
    }

    // STEP 1: confirmed + pending_boarding -> no_show.
    // Never touches boarded, already no_show, or non-confirmed bookings.
    // Conditional filter makes this step itself idempotent/re-runnable.
    const { data: noShowRows, error: noShowErr } = await supabase
        .from('bus_ticket_bookings')
        .update({ boarding_status: 'no_show' })
        .eq('bus_ticket_id', tripId)
        .eq('status', 'confirmed')
        .or('boarding_status.eq.pending_boarding,boarding_status.is.null')
        .select('id');

    if (noShowErr) {
        console.error('[TripCompletion] STEP1 no_show update failed:', noShowErr);
        return { success: false, error: 'NO_SHOW_UPDATE_FAILED', details: noShowErr.message };
    }

    const noShowCount = Array.isArray(noShowRows) ? noShowRows.length : 0;

    // STEP 2: mark trip completed, conditioned on still being 'active' so a
    // concurrent completion (race) never double-applies STEP 1's effects.
    const { data: updatedTripRows, error: completeErr } = await supabase
        .from('bus_tickets')
        .update({ status: 'completed' })
        .eq('id', tripId)
        .eq('status', 'active')
        .select('id, status');

    if (completeErr) {
        console.error('[TripCompletion] STEP2 status update failed:', completeErr);
        return { success: false, error: 'TRIP_STATUS_UPDATE_FAILED', details: completeErr.message, no_show_marked: noShowCount };
    }

    const tripWasCompletedNow = Array.isArray(updatedTripRows) && updatedTripRows.length > 0;

    if (actorContext) {
        try {
            await logCarrierActivity({
                supabase,
                carrierContext: actorContext,
                action: AUDIT_ACTIONS.TRIP_COMPLETED,
                entityType: AUDIT_ENTITY_TYPES.TICKET,
                entityId: trip.id,
                entityLabel: `Рейс ${trip.from_city || ''} → ${trip.to_city || ''} #${trip.id}`,
                oldData: { status: 'active' },
                newData: { status: 'completed' },
                metadata: { reason: 'trip_completion', seats_count: noShowCount }
            });
        } catch (auditErr) {
            console.warn('[TripCompletion] Non-blocking audit error:', auditErr.message);
        }
    }

    return {
        success: true,
        already_completed: !tripWasCompletedNow, // race: someone else completed it first
        trip_id: trip.id,
        no_show_marked: noShowCount,
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
 * idempotent, and trips already completed are skipped by the eligibility
 * filter itself (status is re-checked in the DB query, not cached), so
 * overlapping sweep runs cannot double-apply effects.
 *
 * @param {Object} supabase
 * @param {Object} options - { dryRun, now }
 * @returns {Promise<Object>}
 */
async function sweepAutoCompleteTrips(supabase, options = {}) {
    const { dryRun = false, now = new Date() } = options;
    const nowTime = now instanceof Date ? now : new Date(now);

    const { data: activeTrips, error: fetchErr } = await supabase
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
            const result = await completeTrip(supabase, { tripId: trip.id, actorContext: systemActor });
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
