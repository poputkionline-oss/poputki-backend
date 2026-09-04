/**
 * services/acquisition/maintenanceSweepService.js
 *
 * Phase P.1G.3A: Scheduled Outbox Sweep + Reconciliation
 *
 * Single canonical entry point for the two acquisition-funnel reliability
 * tasks that Phase P.1G.3's own audit found were never actually invoked in
 * production: draining the persistent outbox (beyond the opportunistic
 * in-band drain that already happens right after an event is enqueued) and
 * running the reconciliation gap-recovery pass. Intended to be called on a
 * schedule (GitHub Actions, extending the existing maintenance.yml) via the
 * admin-token-gated POST /api/admin/maintenance/acquisition-sweep endpoint —
 * NOT via the HMAC-gated /api/internal/acquisition/* routes, since this is a
 * server-to-server scheduler call authorized the same way the pre-existing,
 * already-proven-reliable POST /api/admin/maintenance/tick is.
 *
 * Task isolation: each task runs inside its own try/catch, matching
 * utils/maintenanceHelper.js's runMaintenanceTick pattern — a failure in one
 * task never prevents the other from running.
 *
 * Reconciliation's own lock guard (services/acquisition/reconciliationService.js)
 * protects against overlapping runs regardless of caller — this service does
 * not duplicate that logic, it just surfaces the result.
 */

'use strict';

const { getServiceRoleClient } = require('../../dbServiceRole');
const { processOutboxBatch, getOutboxMetrics } = require('./outboxService');
const { runReconciliationPass } = require('./reconciliationService');

/**
 * Runs one outbox sweep (drains any pending/retry-ready/expired-lease
 * events beyond the normal in-band drain) followed by one
 * lock-guarded reconciliation pass.
 *
 * @param {Object} [options] - { dbClient, batchSize }
 * @returns {Promise<{success: boolean, timestamp: string, tasks: Object}>}
 */
async function runAcquisitionMaintenanceSweep(options = {}) {
    const { dbClient = null, batchSize = 100 } = options;
    const db = dbClient || getServiceRoleClient();
    const timestamp = new Date().toISOString();
    const tasks = {};

    try {
        const outbox_before = await getOutboxMetrics(db);
        const sweepResult = await processOutboxBatch({ batchSize, dbClient: db });
        const outbox_after = await getOutboxMetrics(db);
        tasks.outbox_sweep = { success: true, ...sweepResult, outbox_before, outbox_after };
    } catch (err) {
        console.error('[MaintenanceSweep] outbox_sweep task failed:', err.message);
        tasks.outbox_sweep = { success: false, error: err.message || 'OUTBOX_SWEEP_FAILED' };
    }

    try {
        const reconResult = await runReconciliationPass({ dbClient: db });
        tasks.reconciliation = { success: true, ...reconResult };
    } catch (err) {
        console.error('[MaintenanceSweep] reconciliation task failed:', err.message);
        tasks.reconciliation = { success: false, error: err.message || 'RECONCILIATION_FAILED' };
    }

    return {
        success: Boolean(tasks.outbox_sweep.success && tasks.reconciliation.success),
        timestamp,
        tasks
    };
}

module.exports = { runAcquisitionMaintenanceSweep };
