/**
 * osonSmsBalanceClient.js
 *
 * Read-only OSON SMS account-balance check (check_balance.php), per the
 * confirmed OSON SMS API 2.0.2 contract. Prepared and unit-tested against a
 * mocked fetch only — this module is NEVER called against the real OSON
 * endpoint from this codebase or its tests. Doing so requires the new
 * rotated Bearer token AND a separate, explicit go-ahead from the account
 * owner, per this pass's own instructions ("не выполнять настоящий запрос
 * без нового token и отдельного разрешения").
 * Project: POPUTKI.ONLINE
 */

'use strict';

const OSON_HOST = 'api.osonsms.com';
const MAX_TIMEOUT_MS = 20000;

function getConfig() {
    const rawTimeout = Number(process.env.OSON_SMS_TIMEOUT_MS);
    const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0
        ? Math.min(rawTimeout, MAX_TIMEOUT_MS)
        : MAX_TIMEOUT_MS;
    return {
        enabled: process.env.OSON_SMS_ENABLED === 'true',
        baseUrl: process.env.OSON_SMS_BALANCE_URL || 'https://api.osonsms.com/check_balance.php',
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
 * @param {Object} [deps] - { fetchImpl }
 * @returns {Promise<{success:boolean, balance?:number, timestamp?:string, errorCode?:string}>}
 */
async function checkOsonSmsBalance(deps = {}) {
    const cfg = getConfig();
    const fetchImpl = deps.fetchImpl || globalThis.fetch;

    if (!cfg.enabled) return { success: false, errorCode: 'OSON_SMS_DISABLED' };
    if (!cfg.baseUrl || !cfg.login || !cfg.token) return { success: false, errorCode: 'OSON_SMS_CONFIG_INCOMPLETE' };
    if (!/^https:\/\//i.test(cfg.baseUrl)) return { success: false, errorCode: 'ERR_INSECURE_TRANSPORT' };
    if (safeHost(cfg.baseUrl) !== OSON_HOST) return { success: false, errorCode: 'ERR_UNEXPECTED_HOST' };
    if (typeof fetchImpl !== 'function') return { success: false, errorCode: 'FETCH_IMPL_UNAVAILABLE' };

    const params = new URLSearchParams({ login: cfg.login });

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
        if (response.status !== 200) {
            return { success: false, errorCode: `PROVIDER_HTTP_${response.status}` };
        }

        let parsed;
        try {
            parsed = JSON.parse(await response.text());
        } catch {
            return { success: false, errorCode: 'INVALID_RESPONSE_FORMAT' };
        }

        const balance = Number(parsed && parsed.balance);
        if (!Number.isFinite(balance)) {
            return { success: false, errorCode: 'INVALID_BALANCE_VALUE' };
        }

        return { success: true, balance, timestamp: parsed.timestamp || null };
    } catch (err) {
        clearTimeout(timeout);
        if (err.name === 'AbortError') return { success: false, errorCode: 'PROVIDER_TIMEOUT' };
        return { success: false, errorCode: 'NETWORK_ERROR' };
    }
}

module.exports = { checkOsonSmsBalance };
