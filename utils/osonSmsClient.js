/**
 * osonSmsClient.js
 *
 * Fail-closed, single-attempt OSON SMS transport client.
 * Project: POPUTKI.ONLINE
 *
 * Scope: this module ONLY talks to the OSON SMS HTTP API. It does not queue,
 * retry, template, or route anything — that is manualBookingSmsOutboxService.js's
 * job. Kept deliberately dumb and small so it is easy to audit and mock.
 *
 * Contract source: reverse-engineered from the account's own historical PHP
 * integration (single class file, GET request, login+hash request signing)
 * plus osonsms.com's public documentation snippets found for the current
 * protocol. The historical code used a bare `http://` endpoint — this client
 * refuses non-HTTPS base URLs outright (see ERR_INSECURE_TRANSPORT below).
 *
 * NOT VERIFIED end-to-end against the live OSON account from this
 * environment (network egress to osonsms.com is blocked here). Do not flip
 * OSON_SMS_ENABLED/OSON_SMS_DELIVERY_ENABLED in production until that
 * verification has happened out-of-band. See docs/oson-sms-audit-report.md.
 */

'use strict';

const crypto = require('crypto');

const ALLOWED_COUNTRY_PREFIXES = {
    TJ: '992',
    RU: '7',
    UZ: '998',
    KZ: '7'
};

function readAllowedCountries() {
    const raw = process.env.OSON_SMS_ALLOWED_COUNTRIES || 'TJ';
    return raw.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
}

function maskPhoneLocal(phone) {
    if (!phone) return 'N/A';
    const clean = String(phone).trim();
    if (clean.length < 6) return '***';
    const start = clean.slice(0, 4);
    const end = clean.slice(-3);
    const middleCount = Math.max(3, clean.length - 7);
    return start + '*'.repeat(middleCount) + end;
}

function maskLogin(login) {
    if (!login) return 'N/A';
    const s = String(login);
    if (s.length <= 4) return '*'.repeat(s.length);
    return '*'.repeat(s.length - 4) + s.slice(-4);
}

/**
 * Validates E.164-ish digits-only phone against the allowed country prefix
 * list. Returns { valid, countryCode, normalized } or { valid: false, reason }.
 */
function classifyPhone(phone) {
    if (!phone || typeof phone !== 'string') {
        return { valid: false, reason: 'INVALID_PHONE' };
    }
    const digits = phone.replace(/^\+/, '');
    if (!/^\d{9,15}$/.test(digits)) {
        return { valid: false, reason: 'INVALID_PHONE' };
    }
    const allowed = readAllowedCountries();
    for (const code of allowed) {
        const prefix = ALLOWED_COUNTRY_PREFIXES[code];
        if (prefix && digits.startsWith(prefix)) {
            return { valid: true, countryCode: code, normalized: digits };
        }
    }
    return { valid: false, reason: 'UNSUPPORTED_COUNTRY' };
}

/**
 * Computes the str_hash signature used by the account's existing (verified
 * working, pre-Bearer) OSON SMS auth scheme:
 *   SHA256("jam" + txn_id + ";" + login + ";" + sender + ";" + phone_number + ";" + secretHash)
 */
function computeStrHash({ txnId, login, sender, phoneNumber, secretHash }) {
    const dlm = ';';
    const raw = `jam${txnId}${dlm}${login}${dlm}${sender}${dlm}${phoneNumber}${dlm}${secretHash}`;
    return crypto.createHash('sha256').update(raw).digest('hex');
}

function getConfig() {
    const baseUrl = process.env.OSON_SMS_BASE_URL || '';
    return {
        enabled: process.env.OSON_SMS_ENABLED === 'true',
        deliveryEnabled: process.env.OSON_SMS_DELIVERY_ENABLED === 'true',
        dryRun: process.env.OSON_SMS_DRY_RUN !== 'false', // fail-closed: dry-run unless explicitly disabled
        baseUrl,
        login: process.env.OSON_SMS_LOGIN || '',
        secretHash: process.env.OSON_SMS_HASH || '',
        sender: process.env.OSON_SMS_SENDER || '',
        timeoutMs: Number(process.env.OSON_SMS_TIMEOUT_MS) || 10000
    };
}

/**
 * Sends one transactional SMS via OSON SMS.
 *
 * @param {Object} params
 * @param {string} params.recipientPhone - digits, no '+' (already validated/normalized by caller)
 * @param {string} params.message - final rendered text, already length-checked by caller
 * @param {string} params.idempotencyKey - used to derive a stable, provider-facing txn_id
 * @param {Object} [deps] - dependency injection
 * @param {Function} [deps.fetchImpl] - fetch-compatible function; defaults to global fetch
 * @returns {Promise<{success: boolean, providerMessageId?: string, errorCode?: string, raw?: undefined}>}
 *   Never includes credentials or the unredacted provider response.
 */
async function sendServiceSms({ recipientPhone, message, idempotencyKey }, deps = {}) {
    const cfg = getConfig();
    const fetchImpl = deps.fetchImpl || globalThis.fetch;
    const maskedPhone = maskPhoneLocal(recipientPhone);

    // 1. Fail closed: master switch
    if (!cfg.enabled) {
        return { success: false, errorCode: 'OSON_SMS_DISABLED' };
    }

    // 2. Fail closed: required config present
    if (!cfg.baseUrl || !cfg.login || !cfg.secretHash || !cfg.sender) {
        console.error('[OsonSmsClient] Missing required config', {
            hasBaseUrl: Boolean(cfg.baseUrl),
            hasLogin: Boolean(cfg.login),
            hasSecretHash: Boolean(cfg.secretHash),
            hasSender: Boolean(cfg.sender)
        });
        return { success: false, errorCode: 'OSON_SMS_CONFIG_INCOMPLETE' };
    }

    // 3. HTTPS enforcement — stop release path, never silently downgrade
    if (!/^https:\/\//i.test(cfg.baseUrl)) {
        console.error('[OsonSmsClient] Refusing non-HTTPS base URL', { host: safeHost(cfg.baseUrl) });
        return { success: false, errorCode: 'ERR_INSECURE_TRANSPORT' };
    }

    // 4. Phone / country validation
    const phoneCheck = classifyPhone(recipientPhone);
    if (!phoneCheck.valid) {
        return { success: false, errorCode: phoneCheck.reason };
    }

    // 5. Message shape validation (caller should already have templated this,
    //    this is a last-resort guard, not the segmentation calculator)
    if (!message || typeof message !== 'string' || message.length === 0 || message.length > 640) {
        return { success: false, errorCode: 'INVALID_MESSAGE' };
    }
    if (!idempotencyKey || typeof idempotencyKey !== 'string') {
        return { success: false, errorCode: 'IDEMPOTENCY_KEY_REQUIRED' };
    }

    // Deterministic provider-facing txn_id derived from our own idempotency
    // key (never a raw incrementing DB id — nothing guessable/enumerable).
    const txnId = crypto.createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 24);

    const strHash = computeStrHash({
        txnId,
        login: cfg.login,
        sender: cfg.sender,
        phoneNumber: phoneCheck.normalized,
        secretHash: cfg.secretHash
    });

    const params = new URLSearchParams({
        from: cfg.sender,
        phone_number: phoneCheck.normalized,
        msg: message,
        str_hash: strHash,
        txn_id: txnId,
        login: cfg.login
    });

    // 6. Dry-run: never touches the network, never calls fetchImpl
    if (cfg.dryRun || !cfg.deliveryEnabled) {
        console.log('[OsonSmsClient] DRY_RUN — not sending', {
            phone: maskedPhone,
            login: maskLogin(cfg.login),
            sender: cfg.sender,
            txnId,
            messageLength: message.length
        });
        return { success: true, providerMessageId: null, dryRun: true };
    }

    if (typeof fetchImpl !== 'function') {
        return { success: false, errorCode: 'FETCH_IMPL_UNAVAILABLE' };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), cfg.timeoutMs);

    try {
        const response = await fetchImpl(`${cfg.baseUrl}?${params.toString()}`, {
            method: 'GET',
            signal: controller.signal
        });

        clearTimeout(timeout);

        const contentType = response.headers && typeof response.headers.get === 'function'
            ? (response.headers.get('content-type') || '')
            : '';

        let bodyText;
        try {
            bodyText = await response.text();
        } catch (readErr) {
            return { success: false, errorCode: 'RESPONSE_READ_FAILED' };
        }

        if (!response.ok) {
            return {
                success: false,
                errorCode: `PROVIDER_HTTP_${response.status}`
            };
        }

        let parsed;
        try {
            parsed = JSON.parse(bodyText);
        } catch (parseErr) {
            console.error('[OsonSmsClient] Non-JSON response body', {
                contentType,
                bodyLength: bodyText.length,
                phone: maskedPhone
            });
            return { success: false, errorCode: 'INVALID_RESPONSE_FORMAT' };
        }

        // OSON error envelope: { error: { code, msg } }
        if (parsed && parsed.error) {
            const code = parsed.error.code || 'PROVIDER_ERROR';
            return { success: false, errorCode: `PROVIDER_ERROR_${code}` };
        }

        // Success envelope (per historical integration):
        // { status: 'ok', txn_id, msg_id, smsc_msg_id, smsc_msg_status, smsc_msg_parts }
        // A confirmed provider message ID is REQUIRED for success — a bare
        // {status:'ok'} with no msg_id cannot be traced/reconciled later
        // (no delivery-status/callback endpoint is confirmed to exist for
        // this account, see docs/oson-sms-audit-report.md §3/§4), so it is
        // treated as an unrecognized response rather than assumed success.
        if (parsed && parsed.msg_id != null && String(parsed.msg_id).length > 0) {
            return {
                success: true,
                providerMessageId: String(parsed.msg_id)
            };
        }

        // HTTP 200 with a body we don't recognize as success — do NOT assume success.
        console.error('[OsonSmsClient] Unrecognized 200 response shape', { phone: maskedPhone });
        return { success: false, errorCode: 'UNRECOGNIZED_RESPONSE' };
    } catch (err) {
        clearTimeout(timeout);
        if (err.name === 'AbortError') {
            return { success: false, errorCode: 'PROVIDER_TIMEOUT' };
        }
        // Never leak err.message verbatim — it can contain the request URL
        // (including query string / signed params) on some fetch implementations.
        return { success: false, errorCode: 'NETWORK_ERROR' };
    }
}

function safeHost(url) {
    try {
        return new URL(url).host;
    } catch {
        return 'INVALID_URL';
    }
}

module.exports = {
    sendServiceSms,
    classifyPhone,
    maskPhoneLocal,
    maskLogin,
    computeStrHash,
    getConfig
};
