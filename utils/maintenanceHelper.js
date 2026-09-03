/**
 * maintenanceHelper.js — Unified Maintenance Tick (Phase E.47.7.2)
 *
 * Single canonical entry point for the two periodic production maintenance
 * tasks, intended to replace calling POST /api/admin/bookings/expire-pending
 * and POST /api/admin/trips/auto-complete separately from an external
 * scheduler. Both existing endpoints remain available for backward
 * compatibility / manual diagnostics — this module does not duplicate their
 * business logic, it only sequences the same canonical helpers they already
 * call:
 *   - expirePendingPaymentBookings() (utils/paymentExpirationHelper.js)
 *   - sweepAutoCompleteTrips()       (utils/tripCompletionHelper.js — already
 *     watermark-gated, arrival+12h, Asia/Dushanbe, atomic via
 *     fn_complete_bus_trip, idempotent)
 *
 * Task isolation: each task runs inside its own try/catch. A failure in one
 * task never prevents the other from running, and the tick's overall
 * `success` is the AND of both task outcomes.
 */

const { expirePendingPaymentBookings } = require('./paymentExpirationHelper');
const { sweepAutoCompleteTrips } = require('./tripCompletionHelper');
const defaultSupabase = require('../db');

/**
 * @param {Object} options - { dryRun, now, dbClient }
 *   dbClient, when provided (tests only), is used as BOTH the expire-pending
 *   client and the auto-complete sweep's dbClient override, so a single
 *   injected mock backs both tasks. In production neither is passed:
 *   expire-pending uses the same anon client (`../db`) its own route already
 *   uses, and auto-complete uses its own default service-role client.
 * @returns {Promise<{success: boolean, timestamp: string, tasks: Object}>}
 */
async function runMaintenanceTick(options = {}) {
    const { dryRun = false, now = new Date(), dbClient = null } = options;
    const timestamp = new Date().toISOString();
    const expireDb = dbClient || defaultSupabase;

    const tasks = {};

    try {
        const expireResult = await expirePendingPaymentBookings(expireDb, { dryRun, now });
        tasks.expire_pending = { success: true, ...expireResult };
    } catch (err) {
        console.error('[MaintenanceTick] expire_pending task failed:', err.message);
        tasks.expire_pending = { success: false, error: err.message || 'EXPIRE_PENDING_FAILED' };
    }

    try {
        const sweepOptions = dbClient ? { dryRun, now, dbClient } : { dryRun, now };
        const autoResult = await sweepAutoCompleteTrips(sweepOptions);
        tasks.auto_complete = { success: true, ...autoResult };
    } catch (err) {
        console.error('[MaintenanceTick] auto_complete task failed:', err.message);
        tasks.auto_complete = { success: false, error: err.message || 'AUTO_COMPLETE_FAILED' };
    }

    return {
        success: Boolean(tasks.expire_pending.success && tasks.auto_complete.success),
        timestamp,
        tasks
    };
}

module.exports = { runMaintenanceTick };
