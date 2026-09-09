/**
 * osonSmsClient.js
 *
 * Fail-closed, single-attempt OSON SMS transport client.
 * Project: POPUTKI.ONLINE
 *
 * Scope: this module ONLY talks to the OSON SMS "send" HTTP API. It does not
 * queue, retry, template, or route anything — that is
 * manualBookingSmsOutboxService.js's job. Kept deliberately dumb and small
 * so it is easy to audit and mock.
 *
 * Contract source: OSON SMS API documentation 2.0.2 (08.02.2026),
 * https://osonsms.com/docs/sms-api-documentation.pdf, relayed and confirmed
 * by OSON support per the account owner (this sandbox cannot fetch the PDF
 * itself — osonsms.com's egress is blocked here — so this is the "official
 * support response" evidentiary source, not a self-fetched primary read).
 * See docs/oson-contract-reconciliation-form.md for the full field-by-field
 * record and docs/oson-sms-audit-report.md for the verdict trail.
 *
 * This replaces the prior login+hash (str_hash) scheme entirely — OSON
 * support confirmed the account now requires Bearer-token auth. The old
 * scheme's code has been removed, not kept as a fallback, so there is no
 * path that could accidentally sign a request with the retired secret.
 */

'use strict';

const crypto = require('crypto');

const OSON_HOST = 'api.osonsms.com';
const CONFIRMED_SENDER = 'Poputki';
const MAX_TIMEOUT_MS = 20000; // hard ceiling per the confirmed contract, regardless of env config

// Normalized OSON provider error codes -> internal names (never expose the
// raw provider body, only these names, in anything that leaves this module).
const PROVIDER_ERROR_CODES = {
    100: 'MISSING_PARAMETER',
    105: 'ACCOUNT_INACTIVE',
    106: 'INVALID_AUTHORIZATION',
    107: 'INCORRECT_SENDER',
    108: 'DUPLICATE_TXN_ID',
    109: 'STORE_FAILED',
    112: 'SEND_FAILED',
    113: 'SMSC_UNAVAILABLE',
    114: 'IP_NOT_WHITELISTED',
    119: 'INSUFFICIENT_BALANCE'
};

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
 * Tajikistan-only phone validation, per OSON support's confirmation
 * ("отправка только на номера Таджикистана +992"). Accepts ONLY
 * `+992XXXXXXXXX` or `992XXXXXXXXX` (9 digits after the country code — the
 * standard TJ mobile length). Everything else — +7, any other country,
 * wrong length, letters, extensions — is rejected outright. This function
 * never guesses or prepends "992" to an ambiguous number; an input without
 * an explicit 992/+992 prefix is simply invalid.
 *
 * @returns {{valid: boolean, normalized?: string, reason?: string}}
 */
function classifyPhone(phone) {
    if (!phone || typeof phone !== 'string') {
        return { valid: false, reason: 'INVALID_PHONE' };
    }
    const trimmed = phone.trim();

    if (/^\+7/.test(trimmed) || /^7\d{10}$/.test(trimmed)) {
        return { valid: false, reason: 'UNSUPPORTED_COUNTRY' };
    }

    const match = /^\+?(992\d{9})$/.exec(trimmed);
    if (!match) {
        return { valid: false, reason: 'INVALID_PHONE' };
    }
    // Reject anything with non-digit characters beyond a single leading '+'
    // (letters, spaces, extensions) — the regex above already guarantees
    // this for the matched portion, but guard explicitly against a caller
    // passing e.g. "+992123456789 ext.1" where trailing content could have
    // been silently ignored by a looser check.
    if (trimmed.replace(/^\+/, '') !== match[1]) {
        return { valid: false, reason: 'INVALID_PHONE' };
    }

    return { valid: true, normalized: match[1], countryCode: 'TJ' };
}

function getConfig() {
    const rawTimeout = Number(process.env.OSON_SMS_TIMEOUT_MS);
    const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0
        ? Math.min(rawTimeout, MAX_TIMEOUT_MS)
        : MAX_TIMEOUT_MS;

    return {
        enabled: process.env.OSON_SMS_ENABLED === 'true',
        deliveryEnabled: process.env.OSON_SMS_DELIVERY_ENABLED === 'true',
        dryRun: process.env.OSON_SMS_DRY_RUN !== 'false', // fail-closed: dry-run unless explicitly disabled
        baseUrl: process.env.OSON_SMS_BASE_URL || 'https://api.osonsms.com/sendsms_v1.php',
        login: process.env.OSON_SMS_LOGIN || '',
        token: process.env.OSON_SMS_TOKEN || '',
        sender: process.env.OSON_SMS_SENDER || '',
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
 * Sends one transactional SMS via OSON SMS.
 *
 * Success is ONLY: HTTP 201, body.status === "ok", body.txn_id === the
 * txn_id we sent, and a non-empty body.msg_id. HTTP 200 on the send
 * endpoint is explicitly NOT a success signal per the confirmed contract.
 *
 * @param {Object} params
 * @param {string} params.recipientPhone - raw phone as stored on the booking; validated/normalized here, not by the caller
 * @param {string} params.message - final rendered text, already length-checked by caller
 * @param {string} params.idempotencyKey - used to derive a STABLE, provider-facing txn_id — the same
 *   value must be passed on every retry of the same outbox row so txn_id never changes across attempts.
 * @param {Object} [deps] - dependency injection
 * @param {Function} [deps.fetchImpl] - fetch-compatible function; defaults to global fetch
 * @returns {Promise<{success: boolean, providerMessageId?: string, errorCode?: string, duplicate?: boolean, txnId?: string}>}
 *   Never includes credentials, the raw provider response, or the request URL.
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
    if (!cfg.baseUrl || !cfg.login || !cfg.token) {
        console.error('[OsonSmsClient] Missing required config', {
            hasBaseUrl: Boolean(cfg.baseUrl),
            hasLogin: Boolean(cfg.login),
            hasToken: Boolean(cfg.token)
        });
        return { success: false, errorCode: 'OSON_SMS_CONFIG_INCOMPLETE' };
    }

    // 3. Sender lock — ONLY the confirmed, approved Sender ID may ever be
    // used. Fails closed on anything else, including known-wrong values
    // from other tenants on the same OSON account (BlablaCarTJ, Savorcar,
    // Sherik) or any typo/placeholder.
    if (cfg.sender !== CONFIRMED_SENDER) {
        console.error('[OsonSmsClient] Refusing unconfirmed sender', { senderLength: cfg.sender.length });
        return { success: false, errorCode: 'OSON_SMS_UNCONFIRMED_SENDER' };
    }

    // 4. HTTPS + strict hostname enforcement — never trust an env override
    // to silently point this client at a different host.
    if (!/^https:\/\//i.test(cfg.baseUrl)) {
        console.error('[OsonSmsClient] Refusing non-HTTPS base URL', { host: safeHost(cfg.baseUrl) });
        return { success: false, errorCode: 'ERR_INSECURE_TRANSPORT' };
    }
    if (safeHost(cfg.baseUrl) !== OSON_HOST) {
        console.error('[OsonSmsClient] Refusing unexpected host', { host: safeHost(cfg.baseUrl) });
        return { success: false, errorCode: 'ERR_UNEXPECTED_HOST' };
    }

    // 5. Phone validation — Tajikistan only, no guessing
    const phoneCheck = classifyPhone(recipientPhone);
    if (!phoneCheck.valid) {
        return { success: false, errorCode: phoneCheck.reason };
    }

    // 6. Message shape validation
    if (!message || typeof message !== 'string' || message.length === 0 || message.length > 640) {
        return { success: false, errorCode: 'INVALID_MESSAGE' };
    }
    if (!idempotencyKey || typeof idempotencyKey !== 'string') {
        return { success: false, errorCode: 'IDEMPOTENCY_KEY_REQUIRED' };
    }

    // Deterministic, provider-facing txn_id derived from our own idempotency
    // key. This is what makes txn_id STABLE across retries of the same
    // outbox row: the same idempotencyKey always yields the same txn_id,
    // never a fresh one per attempt, and never a raw incrementing DB id.
    const txnId = crypto.createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 24);

    const params = new URLSearchParams({
        from: cfg.sender,
        phone_number: phoneCheck.normalized,
        msg: message,
        login: cfg.login,
        txn_id: txnId,
        is_confidential: 'true'
    });

    // 7. Dry-run: never touches the network, never calls fetchImpl
    if (cfg.dryRun || !cfg.deliveryEnabled) {
        console.log('[OsonSmsClient] DRY_RUN — not sending', {
            phone: maskedPhone,
            login: maskLogin(cfg.login),
            sender: cfg.sender,
            txnId,
            messageLength: message.length
        });
        return { success: true, providerMessageId: null, txnId, dryRun: true };
    }

    if (typeof fetchImpl !== 'function') {
        return { success: false, errorCode: 'FETCH_IMPL_UNAVAILABLE' };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), cfg.timeoutMs);

    try {
        const response = await fetchImpl(`${cfg.baseUrl}?${params.toString()}`, {
            method: 'GET',
            redirect: 'manual', // never silently follow a redirect to another host
            headers: {
                Authorization: `Bearer ${cfg.token}`
            },
            signal: controller.signal
        });

        clearTimeout(timeout);

        // 'manual' redirect mode surfaces a 3xx as an opaque redirect
        // response (status 0, type 'opaqueredirect') rather than following
        // it — treat that as a hard failure, never as a followable pointer.
        if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
            console.error('[OsonSmsClient] Refusing to follow a redirect response');
            return { success: false, errorCode: 'ERR_REDIRECT_BLOCKED' };
        }

        let bodyText;
        try {
            bodyText = await response.text();
        } catch (readErr) {
            return { success: false, errorCode: 'RESPONSE_READ_FAILED' };
        }

        let parsed = null;
        try {
            parsed = bodyText ? JSON.parse(bodyText) : null;
        } catch (parseErr) {
            parsed = null; // fall through to the generic-non-2xx / unrecognized-body handling below
        }

        // HTTP 409 + error.code 108 -> DUPLICATE_TXN_ID. This is NOT success
        // and must never be interpreted as delivered — the caller (worker)
        // decides how to reconcile it (status query if a msg_id is already
        // known, otherwise a bounded retry that will hit the same duplicate
        // response again rather than minting a new txn_id).
        if (response.status === 409) {
            const providerCode = parsed && parsed.error && parsed.error.code;
            if (providerCode === 108 || PROVIDER_ERROR_CODES[providerCode] === 'DUPLICATE_TXN_ID') {
                return { success: false, errorCode: 'PROVIDER_DUPLICATE_TXN_ID', duplicate: true, txnId };
            }
            return { success: false, errorCode: 'PROVIDER_HTTP_409' };
        }

        if (parsed && parsed.error) {
            const providerCode = parsed.error.code;
            const named = PROVIDER_ERROR_CODES[providerCode];
            return { success: false, errorCode: named ? `PROVIDER_ERROR_${named}` : 'PROVIDER_ERROR_UNKNOWN' };
        }

        if (response.status !== 201) {
            // Explicitly per the confirmed contract: HTTP 200 (or anything
            // other than 201) on the send endpoint is NEVER a success
            // signal, even with an ostensibly well-formed body.
            return { success: false, errorCode: `PROVIDER_HTTP_${response.status}` };
        }

        if (!parsed) {
            console.error('[OsonSmsClient] Non-JSON response body on HTTP 201', { phone: maskedPhone });
            return { success: false, errorCode: 'INVALID_RESPONSE_FORMAT' };
        }

        const bodyTxnId = parsed.txn_id != null ? String(parsed.txn_id) : null;
        const bodyMsgId = parsed.msg_id != null ? String(parsed.msg_id) : '';

        if (parsed.status !== 'ok') {
            return { success: false, errorCode: 'UNRECOGNIZED_RESPONSE' };
        }
        if (bodyTxnId !== txnId) {
            console.error('[OsonSmsClient] txn_id mismatch on 201 response', { phone: maskedPhone });
            return { success: false, errorCode: 'TXN_ID_MISMATCH' };
        }
        if (!bodyMsgId) {
            return { success: false, errorCode: 'UNRECOGNIZED_RESPONSE' };
        }

        return { success: true, providerMessageId: bodyMsgId, txnId };
    } catch (err) {
        clearTimeout(timeout);
        if (err.name === 'AbortError') {
            return { success: false, errorCode: 'PROVIDER_TIMEOUT', txnId };
        }
        // Never leak err.message verbatim — it can contain the request URL
        // (including query string) on some fetch implementations.
        return { success: false, errorCode: 'NETWORK_ERROR' };
    }
}

module.exports = {
    sendServiceSms,
    classifyPhone,
    maskPhoneLocal,
    maskLogin,
    getConfig,
    CONFIRMED_SENDER,
    PROVIDER_ERROR_CODES,
    MAX_TIMEOUT_MS,
    OSON_HOST
};
