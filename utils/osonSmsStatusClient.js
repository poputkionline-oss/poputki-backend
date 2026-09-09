/**
 * osonSmsStatusClient.js
 *
 * Read-only OSON SMS delivery-status query client (query_sms.php), per the
 * confirmed OSON SMS API 2.0.2 contract. This is what closes the "delivered
 * only after provider confirmation" gap the prior pass left open by design
 * — earlier, this codebase never had a confirmed delivery-status source, so
 * it never set `delivered` at all. Now it can, but ONLY by actually calling
 * this endpoint and mapping a real DELIVERED status back.
 * Project: POPUTKI.ONLINE
 *
 * CRITICAL ADDENDUM CORRECTION: the confirmed OSON SMS API 2.0.2
 * documentation for query_sms.php lists THREE parameters — login, txn_id,
 * AND msg_id — not txn_id alone. Nothing in the confirmed contract states
 * msg_id is optional, and nothing confirms a 409/duplicate response echoes
 * the original msg_id. The prior version of this module accepted txn_id
 * OR msg_id and was called with txn_id only from the duplicate-handling
 * branch in manualBookingSmsOutboxService.js — that was NOT proven by the
 * confirmed contract and has been removed. msg_id is now a hard
 * requirement, checked and failed closed BEFORE any network call. See
 * docs/oson-sms-audit-report.md ("Duplicate Reconciliation Correction")
 * and docs/oson-contract-reconciliation-form.md for the open questions to
 * OSON that would allow relaxing this.
 *
 * Not wired into any automatic polling loop yet — that is deliberately out
 * of scope for this pass (no new functionality beyond the confirmed
 * contract itself). It IS used by the worker's duplicate-txn_id handling
 * (manualBookingSmsOutboxService.js), but ONLY when a msg_id was already
 * durably stored for that outbox row from an earlier confirmed send.
 */

'use strict';

const OSON_HOST = 'api.osonsms.com';
const MAX_TIMEOUT_MS = 20000;

/**
 * Raw OSON status string -> internal outcome. `internalStatus` matches the
 * manual_booking_sms_outbox.status CHECK constraint values where a direct
 * mapping exists; UNKNOWN has no safe automatic terminal mapping and is
 * left for a human (or a bounded retry) to resolve.
 */
const STATUS_MAP = {
    ENROUTE: { internalStatus: 'sent', terminal: false },
    ACCEPTED: { internalStatus: 'sent', terminal: false },
    DELIVERED: { internalStatus: 'delivered', terminal: true },
    EXPIRED: { internalStatus: 'failed', terminal: true },
    DELETED: { internalStatus: 'cancelled', terminal: true },
    UNDELIVERABLE: { internalStatus: 'failed', terminal: true, errorCode: 'UNDELIVERABLE' },
    REJECTED: { internalStatus: 'failed', terminal: true, errorCode: 'REJECTED' },
    UNKNOWN: { internalStatus: 'retry', terminal: false, needsManualAttention: true }
};

function getConfig() {
    const rawTimeout = Number(process.env.OSON_SMS_TIMEOUT_MS);
    const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0
        ? Math.min(rawTimeout, MAX_TIMEOUT_MS)
        : MAX_TIMEOUT_MS;
    return {
        enabled: process.env.OSON_SMS_ENABLED === 'true',
        baseUrl: process.env.OSON_SMS_STATUS_URL || 'https://api.osonsms.com/query_sms.php',
        login: process.env.OSON_SMS_LOGIN || '',
        token: process.env.OSON_SMS_TOKEN || '',
        timeoutMs
    };
}

function safeHost(url) {
    try {
        return new URL(url).host;
    } catch {
        return 'INVALID_URL';
    }
}

/**
 * @param {Object} params
 * @param {string} params.txnId - required
 * @param {string} params.msgId - REQUIRED. Per the confirmed contract's
 *   documented parameter list (login, txn_id, msg_id), this client never
 *   calls the endpoint without it — there is no confirmed basis for a
 *   txn_id-only lookup. Callers without a durably known msg_id must NOT
 *   call this function at all (see manualBookingSmsOutboxService.js's
 *   duplicate-handling Variant B).
 * @param {Object} [deps] - { fetchImpl }
 * @returns {Promise<{success:boolean, rawStatus?:string, internalStatus?:string, errorCode?:string, needsManualAttention?:boolean}>}
 */
async function queryOsonSmsStatus({ txnId, msgId }, deps = {}) {
    const cfg = getConfig();
    const fetchImpl = deps.fetchImpl || globalThis.fetch;

    if (!cfg.enabled) return { success: false, errorCode: 'OSON_SMS_DISABLED' };
    if (!cfg.baseUrl || !cfg.login || !cfg.token) return { success: false, errorCode: 'OSON_SMS_CONFIG_INCOMPLETE' };
    if (!txnId) return { success: false, errorCode: 'TXN_ID_REQUIRED' };
    // Fail closed BEFORE any network call: the confirmed contract's
    // documented parameters for query_sms.php are login + txn_id + msg_id.
    // A missing msg_id is not treated as "query by txn_id alone" — it is
    // refused outright, never silently downgraded.
    if (!msgId) return { success: false, errorCode: 'MISSING_PROVIDER_MESSAGE_ID' };
    if (!/^https:\/\//i.test(cfg.baseUrl)) return { success: false, errorCode: 'ERR_INSECURE_TRANSPORT' };
    if (safeHost(cfg.baseUrl) !== OSON_HOST) return { success: false, errorCode: 'ERR_UNEXPECTED_HOST' };
    if (typeof fetchImpl !== 'function') return { success: false, errorCode: 'FETCH_IMPL_UNAVAILABLE' };

    const params = new URLSearchParams({ login: cfg.login, txn_id: txnId, msg_id: msgId });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), cfg.timeoutMs);

    try {
        const response = await fetchImpl(`${cfg.baseUrl}?${params.toString()}`, {
            method: 'GET',
            redirect: 'manual',
            headers: { Authorization: `Bearer ${cfg.token}` },
            signal: controller.signal
        });
        clearTimeout(timeout);

        if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
            return { success: false, errorCode: 'ERR_REDIRECT_BLOCKED' };
        }
        if (!response.ok) {
            return { success: false, errorCode: `PROVIDER_HTTP_${response.status}` };
        }

        let parsed;
        try {
            parsed = JSON.parse(await response.text());
        } catch {
            return { success: false, errorCode: 'INVALID_RESPONSE_FORMAT' };
        }

        const rawStatus = parsed && typeof parsed.status === 'string' ? parsed.status.toUpperCase() : null;
        const mapping = rawStatus ? STATUS_MAP[rawStatus] : null;
        if (!mapping) {
            return { success: false, errorCode: 'UNRECOGNIZED_STATUS_RESPONSE' };
        }

        return {
            success: true,
            rawStatus,
            internalStatus: mapping.internalStatus,
            terminal: mapping.terminal,
            needsManualAttention: Boolean(mapping.needsManualAttention),
            errorCode: mapping.errorCode
        };
    } catch (err) {
        clearTimeout(timeout);
        if (err.name === 'AbortError') return { success: false, errorCode: 'PROVIDER_TIMEOUT' };
        return { success: false, errorCode: 'NETWORK_ERROR' };
    }
}

module.exports = { queryOsonSmsStatus, STATUS_MAP };
