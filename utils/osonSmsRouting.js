/**
 * osonSmsRouting.js
 *
 * Pure, unit-testable enqueue-decision logic for the manual-booking OSON SMS
 * outbox, extracted out of routes/busAdmin.js so Stage-6 critical conditions
 * (kill switch, rollout cutoff) can be proven with direct unit tests instead
 * of only by code review of an inline route handler.
 * Project: POPUTKI.ONLINE
 */

'use strict';

const { isCarrierAllowlisted } = require('./osonSmsCaps');

/**
 * @param {Object} params
 * @param {boolean} params.isAutoClaimed - true if the booking was already
 *   auto-linked to a Telegram-verified passenger (Telegram takes priority).
 * @param {string|null} params.phone - normalized phone, or null/empty.
 * @param {number} params.carrierId
 * @param {Date} [params.now]
 * @param {Object} [params.env] - injectable for tests; defaults to process.env
 * @returns {{ enqueue: boolean, reason: string }}
 */
function shouldEnqueueOsonSms({ isAutoClaimed, phone, carrierId, now = new Date(), env = process.env }) {
    if (isAutoClaimed) {
        return { enqueue: false, reason: 'ALREADY_TELEGRAM_LINKED' };
    }
    if (env.OSON_SMS_ENABLED !== 'true') {
        return { enqueue: false, reason: 'OSON_SMS_DISABLED' };
    }
    if (!phone) {
        return { enqueue: false, reason: 'NO_PHONE' };
    }

    const rolloutStartedAt = env.OSON_SMS_ROLLOUT_STARTED_AT ? new Date(env.OSON_SMS_ROLLOUT_STARTED_AT) : null;
    if (!rolloutStartedAt || isNaN(rolloutStartedAt.getTime())) {
        return { enqueue: false, reason: 'ROLLOUT_CUTOFF_NOT_CONFIGURED' };
    }
    if (now < rolloutStartedAt) {
        return { enqueue: false, reason: 'BEFORE_ROLLOUT_CUTOFF' };
    }

    if (!isCarrierAllowlisted(carrierId)) {
        return { enqueue: false, reason: 'CARRIER_NOT_ALLOWLISTED' };
    }

    return { enqueue: true, reason: 'ELIGIBLE' };
}

module.exports = { shouldEnqueueOsonSms };
