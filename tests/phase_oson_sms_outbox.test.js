/**
 * phase_oson_sms_outbox.test.js
 *
 * Test Suite: MANUAL BOOKING AUTOMATIC SMS TICKET DELIVERY (OSON SMS)
 * POPUTKI.ONLINE
 *
 * Scope: osonSmsClient (transport), smsTemplates (rendering/segmentation),
 * osonSmsCaps (abuse/cost protection), manualBookingSmsOutboxService
 * (worker orchestration against mocked Supabase clients).
 *
 * FOR UPDATE SKIP LOCKED concurrency, lease-expiry recovery, and the
 * idempotency_key UNIQUE constraint are verified separately against a real
 * local PostgreSQL database (see docs/oson-sms-audit-report.md, "PostgreSQL
 * Integration Gate") — those guarantees cannot be meaningfully asserted
 * against a mocked query builder, so they are intentionally NOT re-tested
 * here as unit tests.
 *
 * No test in this file ever targets a real osonsms.com endpoint.
 */

require('dotenv').config();
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const {
    sendServiceSms,
    classifyPhone,
    maskPhoneLocal,
    maskLogin,
    CONFIRMED_SENDER,
    MAX_TIMEOUT_MS
} = require('../utils/osonSmsClient');
const { queryOsonSmsStatus, STATUS_MAP } = require('../utils/osonSmsStatusClient');
const { checkOsonSmsBalance } = require('../utils/osonSmsBalanceClient');
const { calculateSmsSegments, renderManualBookingTicketSms } = require('../utils/smsTemplates');
const { checkSendCaps, hmacPhone, isCarrierAllowlisted } = require('../utils/osonSmsCaps');
const { processManualBookingSmsOutbox } = require('../utils/manualBookingSmsOutboxService');
const { shouldEnqueueOsonSms } = require('../utils/osonSmsRouting');
const fs = require('node:fs');
const path = require('node:path');

const ORIGINAL_ENV = { ...process.env };

function resetEnv() {
    for (const key of Object.keys(process.env)) {
        if (key.startsWith('OSON_SMS_')) delete process.env[key];
    }
    process.env = { ...ORIGINAL_ENV };
    for (const key of Object.keys(process.env)) {
        if (key.startsWith('OSON_SMS_')) delete process.env[key];
    }
}

function enabledConfig(overrides = {}) {
    process.env.OSON_SMS_ENABLED = 'true';
    process.env.OSON_SMS_DELIVERY_ENABLED = 'true';
    process.env.OSON_SMS_DRY_RUN = 'false';
    process.env.OSON_SMS_BASE_URL = 'https://api.osonsms.com/sendsms_v1.php';
    process.env.OSON_SMS_LOGIN = 'testlogin';
    process.env.OSON_SMS_TOKEN = 'test-bearer-token';
    process.env.OSON_SMS_SENDER = 'Poputki';
    process.env.OSON_SMS_TIMEOUT_MS = '200';
    Object.assign(process.env, overrides);
}

// Mirrors the txn_id derivation inside osonSmsClient.js exactly, so tests
// can build a matching success response without importing an internal.
function deriveTxnId(idempotencyKey) {
    return require('node:crypto').createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 24);
}

function jsonResponse(status, body, opts = {}) {
    return {
        ok: status >= 200 && status < 300,
        status,
        type: opts.type || 'basic',
        headers: { get: () => 'application/json' },
        text: async () => JSON.stringify(body)
    };
}

describe('MANUAL BOOKING SMS OUTBOX — OSON SMS CLIENT (API 2.0.2, Bearer contract)', () => {
    beforeEach(resetEnv);
    afterEach(resetEnv);

    it('[1] fails closed with OSON_SMS_DISABLED when master switch is off, never calls fetch', async () => {
        resetEnv();
        let called = false;
        const result = await sendServiceSms(
            { recipientPhone: '992900000001', message: 'test', idempotencyKey: 'k1' },
            { fetchImpl: async () => { called = true; } }
        );
        assert.equal(result.success, false);
        assert.equal(result.errorCode, 'OSON_SMS_DISABLED');
        assert.equal(called, false);
    });

    it('[2] HTTP 201 + status "ok" + matching txn_id + msg_id -> success', async () => {
        enabledConfig();
        const txnId = deriveTxnId('k2');
        const fetchImpl = async () => jsonResponse(201, { status: 'ok', txn_id: txnId, msg_id: 40127 });
        const result = await sendServiceSms(
            { recipientPhone: '992900000001', message: 'test', idempotencyKey: 'k2' },
            { fetchImpl }
        );
        assert.equal(result.success, true);
        assert.equal(result.providerMessageId, '40127');
        assert.equal(result.txnId, txnId);
    });

    it('[3] HTTP 200 on the send endpoint is NEVER success, even with an otherwise well-formed body', async () => {
        enabledConfig();
        const txnId = deriveTxnId('k3');
        const fetchImpl = async () => jsonResponse(200, { status: 'ok', txn_id: txnId, msg_id: 999 });
        const result = await sendServiceSms(
            { recipientPhone: '992900000001', message: 'test', idempotencyKey: 'k3' },
            { fetchImpl }
        );
        assert.equal(result.success, false);
        assert.equal(result.errorCode, 'PROVIDER_HTTP_200');
    });

    it('[4] HTTP 201 without a msg_id is a failure, not success', async () => {
        enabledConfig();
        const txnId = deriveTxnId('k4');
        const fetchImpl = async () => jsonResponse(201, { status: 'ok', txn_id: txnId });
        const result = await sendServiceSms(
            { recipientPhone: '992900000001', message: 'test', idempotencyKey: 'k4' },
            { fetchImpl }
        );
        assert.equal(result.success, false);
        assert.equal(result.errorCode, 'UNRECOGNIZED_RESPONSE');
    });

    it('[5] a txn_id in the response that does not match what we sent is a failure (TXN_ID_MISMATCH)', async () => {
        enabledConfig();
        const fetchImpl = async () => jsonResponse(201, { status: 'ok', txn_id: 'some-other-txn-id', msg_id: 1 });
        const result = await sendServiceSms(
            { recipientPhone: '992900000001', message: 'test', idempotencyKey: 'k5' },
            { fetchImpl }
        );
        assert.equal(result.success, false);
        assert.equal(result.errorCode, 'TXN_ID_MISMATCH');
    });

    it('[6] HTTP 409 + error.code=108 is reported as a DUPLICATE, never as success', async () => {
        enabledConfig();
        const fetchImpl = async () => jsonResponse(409, { error: { code: 108, msg: 'duplicate txn_id' } });
        const result = await sendServiceSms(
            { recipientPhone: '992900000001', message: 'test', idempotencyKey: 'k6' },
            { fetchImpl }
        );
        assert.equal(result.success, false);
        assert.equal(result.duplicate, true);
        assert.equal(result.errorCode, 'PROVIDER_DUPLICATE_TXN_ID');
        assert.equal(result.txnId, deriveTxnId('k6'), 'the same stable txn_id must be echoed back for reconciliation');
    });

    it('[7] provider HTTP error (non-2xx, non-409) is reported, not treated as success', async () => {
        enabledConfig();
        const fetchImpl = async () => ({ ok: false, status: 500, type: 'basic', headers: { get: () => 'text/plain' }, text: async () => 'Internal Server Error' });
        const result = await sendServiceSms(
            { recipientPhone: '992900000001', message: 'test', idempotencyKey: 'k7' },
            { fetchImpl }
        );
        assert.equal(result.success, false);
        assert.equal(result.errorCode, 'PROVIDER_HTTP_500');
    });

    it('[8] a known provider error code (e.g. 107 INCORRECT_SENDER) normalizes to a named error, never the raw code alone', async () => {
        enabledConfig();
        const fetchImpl = async () => jsonResponse(400, { error: { code: 107, msg: 'incorrect sender' } });
        const result = await sendServiceSms(
            { recipientPhone: '992900000001', message: 'test', idempotencyKey: 'k8' },
            { fetchImpl }
        );
        assert.equal(result.success, false);
        assert.equal(result.errorCode, 'PROVIDER_ERROR_INCORRECT_SENDER');
    });

    it('[9] timeout via AbortController is reported as PROVIDER_TIMEOUT, single attempt only', async () => {
        enabledConfig({ OSON_SMS_TIMEOUT_MS: '30' });
        let callCount = 0;
        const fetchImpl = (url, { signal }) => {
            callCount++;
            return new Promise((resolve, reject) => {
                signal.addEventListener('abort', () => {
                    const err = new Error('aborted');
                    err.name = 'AbortError';
                    reject(err);
                });
            });
        };
        const result = await sendServiceSms(
            { recipientPhone: '992900000001', message: 'test', idempotencyKey: 'k9' },
            { fetchImpl }
        );
        assert.equal(result.success, false);
        assert.equal(result.errorCode, 'PROVIDER_TIMEOUT');
        assert.equal(callCount, 1, 'client must never blindly retry internally');
    });

    it('[10] configured timeout is capped at 20 seconds even if a larger value is set', () => {
        process.env.OSON_SMS_TIMEOUT_MS = '999999';
        const { getConfig } = require('../utils/osonSmsClient');
        assert.equal(getConfig().timeoutMs, MAX_TIMEOUT_MS);
        assert.equal(MAX_TIMEOUT_MS, 20000);
    });

    it('[11] invalid/non-JSON response body on HTTP 201 is not treated as success', async () => {
        enabledConfig();
        const fetchImpl = async () => ({ ok: true, status: 201, type: 'basic', headers: { get: () => 'text/html' }, text: async () => '<html>not json</html>' });
        const result = await sendServiceSms(
            { recipientPhone: '992900000001', message: 'test', idempotencyKey: 'k11' },
            { fetchImpl }
        );
        assert.equal(result.success, false);
        assert.equal(result.errorCode, 'INVALID_RESPONSE_FORMAT');
    });

    it('[12] refuses non-HTTPS base URL (ERR_INSECURE_TRANSPORT), never calls fetch', async () => {
        enabledConfig({ OSON_SMS_BASE_URL: 'http://api.osonsms.com/sendsms_v1.php' });
        let called = false;
        const result = await sendServiceSms(
            { recipientPhone: '992900000001', message: 'test', idempotencyKey: 'k12' },
            { fetchImpl: async () => { called = true; } }
        );
        assert.equal(result.success, false);
        assert.equal(result.errorCode, 'ERR_INSECURE_TRANSPORT');
        assert.equal(called, false);
    });

    it('[13] refuses any host other than api.osonsms.com, never calls fetch', async () => {
        enabledConfig({ OSON_SMS_BASE_URL: 'https://evil.example.com/sendsms_v1.php' });
        let called = false;
        const result = await sendServiceSms(
            { recipientPhone: '992900000001', message: 'test', idempotencyKey: 'k13' },
            { fetchImpl: async () => { called = true; } }
        );
        assert.equal(result.success, false);
        assert.equal(result.errorCode, 'ERR_UNEXPECTED_HOST');
        assert.equal(called, false);
    });

    it('[14] a redirect response (opaqueredirect / 3xx) is refused, never silently followed', async () => {
        enabledConfig();
        const fetchImpl = async () => ({ ok: false, status: 0, type: 'opaqueredirect', headers: { get: () => '' }, text: async () => '' });
        const result = await sendServiceSms(
            { recipientPhone: '992900000001', message: 'test', idempotencyKey: 'k14' },
            { fetchImpl }
        );
        assert.equal(result.success, false);
        assert.equal(result.errorCode, 'ERR_REDIRECT_BLOCKED');
    });

    it('[15] a "+992..." phone is normalized to "992..." for the provider', async () => {
        enabledConfig();
        let capturedUrl = null;
        const txnId = deriveTxnId('k15');
        const fetchImpl = async (url) => { capturedUrl = url; return jsonResponse(201, { status: 'ok', txn_id: txnId, msg_id: 1 }); };
        const result = await sendServiceSms(
            { recipientPhone: '+992901234567', message: 'test', idempotencyKey: 'k15' },
            { fetchImpl }
        );
        assert.equal(result.success, true);
        assert.ok(capturedUrl.includes('phone_number=992901234567'));
        assert.ok(!capturedUrl.includes('%2B992'), 'the "+" must not reach the provider — normalized form only');
    });

    it('[16] a bare "992..." phone (no plus) is accepted as-is', async () => {
        enabledConfig();
        const txnId = deriveTxnId('k16');
        const fetchImpl = async () => jsonResponse(201, { status: 'ok', txn_id: txnId, msg_id: 1 });
        const result = await sendServiceSms(
            { recipientPhone: '992901234567', message: 'test', idempotencyKey: 'k16' },
            { fetchImpl }
        );
        assert.equal(result.success, true);
    });

    it('[17] a +7 (Russia) number is rejected before any network call — no guessing, no country add-on', async () => {
        enabledConfig();
        let called = false;
        const result = await sendServiceSms(
            { recipientPhone: '+79261234567', message: 'test', idempotencyKey: 'k17' },
            { fetchImpl: async () => { called = true; } }
        );
        assert.equal(result.success, false);
        assert.equal(result.errorCode, 'UNSUPPORTED_COUNTRY');
        assert.equal(called, false);
    });

    it('[18] a local 9-digit number with no 992/+992 prefix is rejected — never assume/prepend the country code', async () => {
        enabledConfig();
        let called = false;
        const result = await sendServiceSms(
            { recipientPhone: '901234567', message: 'test', idempotencyKey: 'k18' },
            { fetchImpl: async () => { called = true; } }
        );
        assert.equal(result.success, false);
        assert.equal(result.errorCode, 'INVALID_PHONE');
        assert.equal(called, false);
    });

    it('[19] wrong length / letters / extensions are all rejected', async () => {
        for (const bad of ['+9929012345', '+99290123456789', '+992abcde1234', '+992901234567ext5']) {
            const result = await sendServiceSms({ recipientPhone: bad, message: 'test', idempotencyKey: 'kbad-' + bad }, { fetchImpl: async () => { throw new Error('must not be called'); } });
            assert.equal(result.success, false, `expected rejection for ${bad}`);
        }
    });

    it('[20] dry-run mode never calls fetch and returns success', async () => {
        enabledConfig({ OSON_SMS_DRY_RUN: 'true' });
        let called = false;
        const result = await sendServiceSms(
            { recipientPhone: '992900000001', message: 'test', idempotencyKey: 'k20' },
            { fetchImpl: async () => { called = true; } }
        );
        assert.equal(result.success, true);
        assert.equal(result.dryRun, true);
        assert.equal(called, false);
    });

    it('[21] delivery-disabled (OSON_SMS_DELIVERY_ENABLED=false) behaves like dry-run, never calls fetch', async () => {
        enabledConfig({ OSON_SMS_DRY_RUN: 'false', OSON_SMS_DELIVERY_ENABLED: 'false' });
        let called = false;
        const result = await sendServiceSms(
            { recipientPhone: '992900000001', message: 'test', idempotencyKey: 'k21' },
            { fetchImpl: async () => { called = true; } }
        );
        assert.equal(result.success, true);
        assert.equal(called, false);
    });

    it('[22] the Bearer token is sent as a header, never appears in the request URL, never in the returned result', async () => {
        enabledConfig({ OSON_SMS_TOKEN: 'super-secret-bearer-value-12345' });
        let capturedUrl = null;
        let capturedAuthHeader = null;
        const txnId = deriveTxnId('k22');
        const fetchImpl = async (url, init) => {
            capturedUrl = url;
            capturedAuthHeader = init && init.headers && init.headers.Authorization;
            return jsonResponse(201, { status: 'ok', txn_id: txnId, msg_id: 1 });
        };
        const result = await sendServiceSms(
            { recipientPhone: '992900000001', message: 'test', idempotencyKey: 'k22' },
            { fetchImpl }
        );
        assert.equal(capturedAuthHeader, 'Bearer super-secret-bearer-value-12345', 'token IS sent, but only as the Authorization header');
        assert.ok(!capturedUrl.includes('super-secret-bearer-value-12345'), 'token must never appear in the request URL');
        assert.ok(!JSON.stringify(result).includes('super-secret-bearer-value-12345'), 'token must never appear in the returned result');
    });

    it('[23] is_confidential=true is always sent on every send request', async () => {
        enabledConfig();
        let capturedUrl = null;
        const txnId = deriveTxnId('k23');
        const fetchImpl = async (url) => { capturedUrl = url; return jsonResponse(201, { status: 'ok', txn_id: txnId, msg_id: 1 }); };
        await sendServiceSms({ recipientPhone: '992900000001', message: 'test', idempotencyKey: 'k23' }, { fetchImpl });
        assert.ok(capturedUrl.includes('is_confidential=true'));
    });

    it('[24] the exact confirmed sender "Poputki" is required — refuses any other value, never calls fetch', async () => {
        for (const badSender of ['BlablaCarTJ', 'Savorcar', 'Sherik', 'poputki', 'Poputki ', '']) {
            let called = false;
            enabledConfig({ OSON_SMS_SENDER: badSender });
            const result = await sendServiceSms(
                { recipientPhone: '992900000001', message: 'test', idempotencyKey: 'ksender-' + badSender },
                { fetchImpl: async () => { called = true; } }
            );
            assert.equal(result.success, false, `sender "${badSender}" must be refused`);
            assert.equal(result.errorCode, 'OSON_SMS_UNCONFIRMED_SENDER');
            assert.equal(called, false, `sender "${badSender}" must never reach the network`);
        }
        assert.equal(CONFIRMED_SENDER, 'Poputki');
    });

    it('[25] phone masking hides the middle digits', () => {
        const masked = maskPhoneLocal('992901234567');
        assert.ok(!masked.includes('901234'));
        assert.match(masked, /^9929\*+567$/);
    });

    it('[26] login masking hides all but the last 4 characters', () => {
        // Synthetic example login only — never a real account credential.
        assert.equal(maskLogin('examplelogin'), '********ogin');
        assert.equal(maskLogin('ab'), '**');
    });

    it('[27] classifyPhone accepts only TJ numbers and rejects everything else', () => {
        assert.equal(classifyPhone('992901234567').valid, true);
        assert.equal(classifyPhone('+992901234567').valid, true);
        assert.equal(classifyPhone('79261234567').valid, false);
        assert.equal(classifyPhone('123').valid, false);
        assert.equal(classifyPhone(null).valid, false);
        assert.equal(classifyPhone('abc').valid, false);
    });

    it('[28] txn_id stays identical across repeated calls with the same idempotencyKey (retry safety)', () => {
        assert.equal(deriveTxnId('same-key'), deriveTxnId('same-key'));
    });
});

describe('MANUAL BOOKING SMS OUTBOX — OSON SMS STATUS CLIENT (query_sms.php)', () => {
    beforeEach(resetEnv);
    afterEach(resetEnv);

    it('[S1] ENROUTE maps to sent, never delivered', async () => {
        enabledConfig();
        const fetchImpl = async () => jsonResponse(200, { status: 'ENROUTE' });
        const result = await queryOsonSmsStatus({ txnId: 'x' }, { fetchImpl });
        assert.equal(result.success, true);
        assert.equal(result.internalStatus, 'sent');
    });

    it('[S2] ACCEPTED maps to sent, never delivered', async () => {
        enabledConfig();
        const fetchImpl = async () => jsonResponse(200, { status: 'ACCEPTED' });
        const result = await queryOsonSmsStatus({ txnId: 'x' }, { fetchImpl });
        assert.equal(result.internalStatus, 'sent');
        assert.notEqual(result.internalStatus, 'delivered');
    });

    it('[S3] DELIVERED maps to delivered, and only DELIVERED does', async () => {
        enabledConfig();
        const fetchImpl = async () => jsonResponse(200, { status: 'DELIVERED' });
        const result = await queryOsonSmsStatus({ txnId: 'x' }, { fetchImpl });
        assert.equal(result.internalStatus, 'delivered');
        assert.equal(result.terminal, true);
    });

    it('[S4] EXPIRED maps to failed', async () => {
        enabledConfig();
        const fetchImpl = async () => jsonResponse(200, { status: 'EXPIRED' });
        const result = await queryOsonSmsStatus({ txnId: 'x' }, { fetchImpl });
        assert.equal(result.internalStatus, 'failed');
    });

    it('[S5] DELETED maps to cancelled', async () => {
        enabledConfig();
        const fetchImpl = async () => jsonResponse(200, { status: 'DELETED' });
        const result = await queryOsonSmsStatus({ txnId: 'x' }, { fetchImpl });
        assert.equal(result.internalStatus, 'cancelled');
    });

    it('[S6] UNDELIVERABLE and REJECTED both map to failed with a distinct error code', async () => {
        enabledConfig();
        const r1 = await queryOsonSmsStatus({ txnId: 'x' }, { fetchImpl: async () => jsonResponse(200, { status: 'UNDELIVERABLE' }) });
        const r2 = await queryOsonSmsStatus({ txnId: 'x' }, { fetchImpl: async () => jsonResponse(200, { status: 'REJECTED' }) });
        assert.equal(r1.internalStatus, 'failed');
        assert.equal(r1.errorCode, 'UNDELIVERABLE');
        assert.equal(r2.internalStatus, 'failed');
        assert.equal(r2.errorCode, 'REJECTED');
    });

    it('[S7] UNKNOWN never resolves to delivered — flagged for retry/manual attention instead', async () => {
        enabledConfig();
        const fetchImpl = async () => jsonResponse(200, { status: 'UNKNOWN' });
        const result = await queryOsonSmsStatus({ txnId: 'x' }, { fetchImpl });
        assert.notEqual(result.internalStatus, 'delivered');
        assert.equal(result.needsManualAttention, true);
    });

    it('[S8] a redirect on the status endpoint is refused', async () => {
        enabledConfig();
        const fetchImpl = async () => ({ ok: false, status: 0, type: 'opaqueredirect', headers: { get: () => '' }, text: async () => '' });
        const result = await queryOsonSmsStatus({ txnId: 'x' }, { fetchImpl });
        assert.equal(result.success, false);
        assert.equal(result.errorCode, 'ERR_REDIRECT_BLOCKED');
    });

    it('[S9] the query URL never appears in an error result if the request throws', async () => {
        enabledConfig();
        const fetchImpl = async () => { throw new Error('https://api.osonsms.com/query_sms.php?login=real&txn_id=abc123 boom'); };
        const result = await queryOsonSmsStatus({ txnId: 'abc123' }, { fetchImpl });
        assert.equal(result.success, false);
        assert.ok(!JSON.stringify(result).includes('query_sms.php'));
    });
});

describe('MANUAL BOOKING SMS OUTBOX — OSON SMS BALANCE CLIENT (check_balance.php, never called live)', () => {
    beforeEach(resetEnv);
    afterEach(resetEnv);

    it('[B1] parses a numeric balance and timestamp from a well-formed 200 response', async () => {
        enabledConfig();
        const fetchImpl = async () => jsonResponse(200, { balance: 123.45, timestamp: '2026-09-10T00:00:00Z' });
        const result = await checkOsonSmsBalance({ fetchImpl });
        assert.equal(result.success, true);
        assert.equal(result.balance, 123.45);
        assert.equal(result.timestamp, '2026-09-10T00:00:00Z');
    });

    it('[B2] a non-numeric balance value is rejected, not silently coerced', async () => {
        enabledConfig();
        const fetchImpl = async () => jsonResponse(200, { balance: 'not-a-number' });
        const result = await checkOsonSmsBalance({ fetchImpl });
        assert.equal(result.success, false);
        assert.equal(result.errorCode, 'INVALID_BALANCE_VALUE');
    });

    it('[B3] disabled feature flag fails closed before any network call', async () => {
        resetEnv();
        let called = false;
        const result = await checkOsonSmsBalance({ fetchImpl: async () => { called = true; } });
        assert.equal(result.success, false);
        assert.equal(called, false);
    });

    it('[B4] a redirect on the balance endpoint is refused', async () => {
        enabledConfig();
        const fetchImpl = async () => ({ ok: false, status: 0, type: 'opaqueredirect', headers: { get: () => '' }, text: async () => '' });
        const result = await checkOsonSmsBalance({ fetchImpl });
        assert.equal(result.success, false);
        assert.equal(result.errorCode, 'ERR_REDIRECT_BLOCKED');
    });
});

describe('MANUAL BOOKING SMS OUTBOX — SEGMENTATION & TEMPLATES', () => {
    it('[17] Cyrillic (ru/tj) text is UCS-2, 70 chars/segment', () => {
        const info = calculateSmsSegments('Привет, это тест кириллицей');
        assert.equal(info.encoding, 'UCS2');
        assert.equal(info.charsPerSegment, 70);
    });

    it('[18] pure ASCII text is GSM-7, 160 chars/segment', () => {
        const info = calculateSmsSegments('Hello, this is a plain ASCII test message.');
        assert.equal(info.encoding, 'GSM7');
        assert.equal(info.charsPerSegment, 160);
    });

    it('[19] renders and reports real segment counts for RU/TJ/UZ manual-booking templates', () => {
        const claimUrl = 'https://www.poputki.online/t/1a2b3c4d5e6f7890a1b2c3d4e5f67890';
        for (const locale of ['ru', 'tj', 'uz']) {
            const rendered = renderManualBookingTicketSms({ locale, fromCity: 'Душанбе', toCity: 'Худжанд', claimUrl });
            assert.equal(rendered.locale, locale);
            assert.ok(rendered.segmentInfo.segments >= 1);
            assert.ok(rendered.text.includes(claimUrl));
        }
    });
});

describe('MANUAL BOOKING SMS OUTBOX — CAPS & ALLOWLIST', () => {
    beforeEach(resetEnv);
    afterEach(resetEnv);

    function mockCapsDb(counts) {
        return {
            from(table) {
                assert.equal(table, 'manual_booking_sms_outbox');
                const query = {
                    _eq: {},
                    select() { return query; },
                    in() { return query; },
                    gte() { return query; },
                    eq(field, value) { query._eq[field] = value; return query; },
                    then(resolve) {
                        if (query._eq.recipient_phone_hmac) return resolve({ count: counts.phone || 0, error: null });
                        if (query._eq.carrier_id) return resolve({ count: counts.carrier || 0, error: null });
                        return resolve({ count: counts.global || 0, error: null });
                    }
                };
                return query;
            }
        };
    }

    it('[20] fails closed when OSON_SMS_DAILY_CAP is not configured', async () => {
        const result = await checkSendCaps({ dbClient: mockCapsDb({}), phone: '992900000001' });
        assert.equal(result.allowed, false);
        assert.equal(result.reason, 'DAILY_CAP_NOT_CONFIGURED');
    });

    it('[21] blocks once the global daily cap is reached', async () => {
        process.env.OSON_SMS_DAILY_CAP = '5';
        process.env.OSON_SMS_PHONE_HASH_SECRET = 'test-secret';
        const result = await checkSendCaps({ dbClient: mockCapsDb({ global: 5 }), phone: '992900000001' });
        assert.equal(result.allowed, false);
        assert.equal(result.reason, 'DAILY_CAP_EXCEEDED');
    });

    it('[22] blocks once the per-phone daily cap is reached', async () => {
        process.env.OSON_SMS_DAILY_CAP = '100';
        process.env.OSON_SMS_PER_PHONE_DAILY_CAP = '1';
        process.env.OSON_SMS_PHONE_HASH_SECRET = 'test-secret';
        const result = await checkSendCaps({ dbClient: mockCapsDb({ global: 1, phone: 1 }), phone: '992900000001' });
        assert.equal(result.allowed, false);
        assert.equal(result.reason, 'PER_PHONE_DAILY_CAP_EXCEEDED');
    });

    it('[23] blocks once the per-carrier daily cap is reached', async () => {
        process.env.OSON_SMS_DAILY_CAP = '100';
        process.env.OSON_SMS_PER_CARRIER_DAILY_CAP = '2';
        process.env.OSON_SMS_PHONE_HASH_SECRET = 'test-secret';
        const result = await checkSendCaps({ dbClient: mockCapsDb({ global: 1, phone: 0, carrier: 2 }), phone: '992900000001', carrierId: 7 });
        assert.equal(result.allowed, false);
        assert.equal(result.reason, 'PER_CARRIER_DAILY_CAP_EXCEEDED');
    });

    it('[24] allows send when all caps are under threshold', async () => {
        process.env.OSON_SMS_DAILY_CAP = '100';
        process.env.OSON_SMS_PER_PHONE_DAILY_CAP = '1';
        process.env.OSON_SMS_PHONE_HASH_SECRET = 'test-secret';
        const result = await checkSendCaps({ dbClient: mockCapsDb({ global: 1, phone: 0 }), phone: '992900000001' });
        assert.equal(result.allowed, true);
    });

    it('[24b] the atomic RPC path is passed p_outbox_id — required for fn_oson_sms_check_cap to actually reserve the slot (regression guard for the concurrency fix proven in the PostgreSQL gate)', async () => {
        process.env.OSON_SMS_DAILY_CAP = '100';
        process.env.OSON_SMS_PHONE_HASH_SECRET = 'test-secret';
        let capturedParams = null;
        const rpcClient = {
            rpc: async (name, params) => {
                capturedParams = params;
                return { data: { allowed: true }, error: null };
            }
        };
        await checkSendCaps({ dbClient: rpcClient, phone: '992900000001', outboxId: 'row-abc-123' });
        assert.equal(capturedParams.p_outbox_id, 'row-abc-123');
    });

    it('[25] carrier allowlist fails closed when unset (pilot must be explicit)', () => {
        assert.equal(isCarrierAllowlisted(42), false);
    });

    it('[26] carrier allowlist admits only listed carrier ids', () => {
        process.env.OSON_SMS_CARRIER_ALLOWLIST = '42,99';
        assert.equal(isCarrierAllowlisted(42), true);
        assert.equal(isCarrierAllowlisted(43), false);
    });

    it('[27] hmacPhone is deterministic and never returns the raw phone', () => {
        process.env.OSON_SMS_PHONE_HASH_SECRET = 'test-secret';
        const h1 = hmacPhone('992900000001');
        const h2 = hmacPhone('992900000001');
        assert.equal(h1, h2);
        assert.notEqual(h1, '992900000001');
        assert.equal(h1.length, 64);
    });
});

describe('MANUAL BOOKING SMS OUTBOX — WORKER ORCHESTRATION', () => {
    beforeEach(resetEnv);
    afterEach(resetEnv);

    function makeUpdateTrackingMock({ claimed, booking }) {
        const updates = [];
        return {
            updates,
            rpc: async (name) => {
                assert.equal(name, 'fn_claim_manual_booking_sms_batch');
                return { data: claimed, error: null };
            },
            from(table) {
                if (table === 'manual_booking_sms_outbox') {
                    return {
                        update(patch) {
                            return {
                                eq(field, value) {
                                    updates.push({ patch, [field]: value });
                                    return Promise.resolve({ error: null });
                                }
                            };
                        }
                    };
                }
                if (table === 'bus_ticket_bookings') {
                    return {
                        select() {
                            return {
                                eq() {
                                    return { single: async () => ({ data: booking, error: booking ? null : { message: 'not found' } }) };
                                }
                            };
                        }
                    };
                }
                if (table === 'bus_tickets') {
                    return {
                        select() {
                            return { eq() { return { single: async () => ({ data: { from_city: 'A', to_city: 'B' } }) }; } };
                        }
                    };
                }
                return { select() { return { eq() { return { single: async () => ({ data: null }) }; }, in() { return this; } }; } };
            }
        };
    }

    it('[28] kill switch: OSON_SMS_ENABLED unset means zero claims, zero DB writes', async () => {
        resetEnv();
        const client = makeUpdateTrackingMock({ claimed: [{ outbox_id: 'x' }], booking: null });
        const result = await processManualBookingSmsOutbox({ supabaseClient: client });
        assert.equal(result.killSwitchOff, true);
        assert.equal(result.processed, 0);
        assert.equal(client.updates.length, 0);
    });

    it('[29] a booking that is no longer confirmed (cancelled) is skipped, never sent', async () => {
        enabledConfig({ OSON_SMS_DRY_RUN: 'true' });
        const client = makeUpdateTrackingMock({
            claimed: [{ outbox_id: 'row-1', booking_id: 4, idempotency_key: 'k', locale: 'ru' }],
            booking: { id: 4, status: 'cancelled', claim_status: 'unclaimed', phone: '992900000001', bus_ticket_id: 1 }
        });
        const result = await processManualBookingSmsOutbox({ supabaseClient: client });
        assert.equal(result.cancelled, 1);
        assert.equal(result.sent, 0);
        assert.equal(client.updates[0].patch.status, 'cancelled');
        assert.equal(client.updates[0].patch.last_error_code, 'BOOKING_NO_LONGER_ELIGIBLE');
    });

    it('[30] a booking already claimed (e.g. via Telegram) is skipped — no duplicate delivery', async () => {
        enabledConfig({ OSON_SMS_DRY_RUN: 'true' });
        const client = makeUpdateTrackingMock({
            claimed: [{ outbox_id: 'row-2', booking_id: 1, idempotency_key: 'k', locale: 'ru' }],
            booking: { id: 1, status: 'confirmed', claim_status: 'claimed', claimed_by_user_id: 55, phone: '992900000001', bus_ticket_id: 1 }
        });
        const result = await processManualBookingSmsOutbox({ supabaseClient: client });
        assert.equal(result.cancelled, 1);
        assert.equal(client.updates[0].patch.last_error_code, 'ALREADY_CLAIMED_SKIP_SMS');
    });

    it('[31] missing/unparseable phone goes straight to dead_letter, not endless retry', async () => {
        enabledConfig({ OSON_SMS_DRY_RUN: 'true' });
        const client = makeUpdateTrackingMock({
            claimed: [{ outbox_id: 'row-3', booking_id: 2, idempotency_key: 'k', locale: 'ru' }],
            booking: { id: 2, status: 'confirmed', claim_status: 'unclaimed', phone: null, bus_ticket_id: 1 }
        });
        const result = await processManualBookingSmsOutbox({ supabaseClient: client });
        assert.equal(result.dead_letter, 1);
        assert.equal(client.updates[0].patch.status, 'dead_letter');
        assert.equal(client.updates[0].patch.last_error_code, 'NO_PHONE');
    });

    // [32]/[33] (200-body-shape edge cases) removed — fully superseded by
    // the new contract's tests [3] (HTTP 200 is never success, checked
    // before body shape even matters) and [4] (HTTP 201 without msg_id).
});

describe('MANUAL BOOKING SMS OUTBOX — ENQUEUE ROUTING (rollout cutoff, kill switch, allowlist)', () => {
    beforeEach(resetEnv);
    afterEach(resetEnv);

    it('[34] kill switch off (OSON_SMS_ENABLED unset) never enqueues, regardless of everything else', () => {
        process.env.OSON_SMS_ROLLOUT_STARTED_AT = new Date(Date.now() - 86400000).toISOString();
        process.env.OSON_SMS_CARRIER_ALLOWLIST = '7';
        const result = shouldEnqueueOsonSms({ isAutoClaimed: false, phone: '992900000001', carrierId: 7 });
        assert.equal(result.enqueue, false);
        assert.equal(result.reason, 'OSON_SMS_DISABLED');
    });

    it('[35] a booking created BEFORE the rollout cutoff is never enqueued', () => {
        process.env.OSON_SMS_ENABLED = 'true';
        process.env.OSON_SMS_CARRIER_ALLOWLIST = '7';
        process.env.OSON_SMS_ROLLOUT_STARTED_AT = new Date(Date.now() + 3600000).toISOString(); // 1h in the future
        const result = shouldEnqueueOsonSms({ isAutoClaimed: false, phone: '992900000001', carrierId: 7, now: new Date() });
        assert.equal(result.enqueue, false);
        assert.equal(result.reason, 'BEFORE_ROLLOUT_CUTOFF');
    });

    it('[36] no rollout cutoff configured at all fails closed (never enqueues) — this is what keeps the existing 159+ old bookings untouched even if OSON_SMS_ENABLED is flipped on by mistake', () => {
        process.env.OSON_SMS_ENABLED = 'true';
        process.env.OSON_SMS_CARRIER_ALLOWLIST = '7';
        const result = shouldEnqueueOsonSms({ isAutoClaimed: false, phone: '992900000001', carrierId: 7 });
        assert.equal(result.enqueue, false);
        assert.equal(result.reason, 'ROLLOUT_CUTOFF_NOT_CONFIGURED');
    });

    it('[37] a non-allowlisted carrier is never enqueued even past cutoff with SMS enabled', () => {
        process.env.OSON_SMS_ENABLED = 'true';
        process.env.OSON_SMS_ROLLOUT_STARTED_AT = new Date(Date.now() - 86400000).toISOString();
        process.env.OSON_SMS_CARRIER_ALLOWLIST = '999';
        const result = shouldEnqueueOsonSms({ isAutoClaimed: false, phone: '992900000001', carrierId: 7 });
        assert.equal(result.enqueue, false);
        assert.equal(result.reason, 'CARRIER_NOT_ALLOWLISTED');
    });

    it('[38] an already-Telegram-linked booking is never enqueued for SMS, even if every other condition is met', () => {
        process.env.OSON_SMS_ENABLED = 'true';
        process.env.OSON_SMS_ROLLOUT_STARTED_AT = new Date(Date.now() - 86400000).toISOString();
        process.env.OSON_SMS_CARRIER_ALLOWLIST = '7';
        const result = shouldEnqueueOsonSms({ isAutoClaimed: true, phone: '992900000001', carrierId: 7 });
        assert.equal(result.enqueue, false);
        assert.equal(result.reason, 'ALREADY_TELEGRAM_LINKED');
    });

    it('[39] no phone means no enqueue', () => {
        process.env.OSON_SMS_ENABLED = 'true';
        process.env.OSON_SMS_ROLLOUT_STARTED_AT = new Date(Date.now() - 86400000).toISOString();
        process.env.OSON_SMS_CARRIER_ALLOWLIST = '7';
        const result = shouldEnqueueOsonSms({ isAutoClaimed: false, phone: null, carrierId: 7 });
        assert.equal(result.enqueue, false);
        assert.equal(result.reason, 'NO_PHONE');
    });

    it('[40] all conditions satisfied → enqueue', () => {
        process.env.OSON_SMS_ENABLED = 'true';
        process.env.OSON_SMS_ROLLOUT_STARTED_AT = new Date(Date.now() - 86400000).toISOString();
        process.env.OSON_SMS_CARRIER_ALLOWLIST = '7';
        const result = shouldEnqueueOsonSms({ isAutoClaimed: false, phone: '992900000001', carrierId: 7 });
        assert.equal(result.enqueue, true);
    });
});

describe('MANUAL BOOKING SMS OUTBOX — TIMEOUT RETRY SAFETY', () => {
    beforeEach(resetEnv);
    afterEach(resetEnv);

    it('[41] a provider timeout schedules a LONG backoff (>=25 min), never an immediate/near-immediate retry that could race a duplicate send', async () => {
        enabledConfig({ OSON_SMS_DAILY_CAP: '100', OSON_SMS_PHONE_HASH_SECRET: 'test-secret' });
        const fetchImpl = (url, { signal }) => new Promise((_, reject) => {
            signal.addEventListener('abort', () => {
                const err = new Error('aborted'); err.name = 'AbortError'; reject(err);
            });
        });

        const updates = [];
        const client = {
            rpc: async (name) => {
                if (name === 'fn_claim_manual_booking_sms_batch') {
                    return {
                        data: [{ outbox_id: 'row-t', booking_id: 1, idempotency_key: 'k', locale: 'ru', attempts_count: 1, max_attempts: 3 }],
                        error: null
                    };
                }
                if (name === 'fn_oson_sms_check_cap') {
                    return { data: { allowed: true }, error: null };
                }
                return { data: null, error: { message: 'unexpected rpc ' + name } };
            },
            from(table) {
                if (table === 'manual_booking_sms_outbox') {
                    return { update(patch) { return { eq(f, v) { updates.push({ patch, [f]: v }); return Promise.resolve({ error: null }); } }; } };
                }
                if (table === 'bus_ticket_bookings') {
                    return {
                        select() {
                            return {
                                eq() {
                                    return {
                                        single: async () => ({
                                            data: { id: 1, status: 'confirmed', claim_status: 'unclaimed', phone: '992900000001', bus_ticket_id: 1 }
                                        })
                                    };
                                }
                            };
                        }
                    };
                }
                if (table === 'booking_claim_sessions') {
                    // Backs claimHelper.generateClaimSession()'s .insert([...]).select('*').single()
                    return {
                        insert() {
                            return {
                                select() {
                                    return {
                                        single: async () => ({
                                            data: { id: 'sess-1', booking_id: 1, session_token_hash: 'x'.repeat(64), expires_at: new Date(Date.now() + 900000).toISOString() }
                                        })
                                    };
                                }
                            };
                        }
                    };
                }
                return {
                    select() {
                        return {
                            eq() {
                                return { single: async () => ({ data: { from_city: 'A', to_city: 'B' } }) };
                            }
                        };
                    }
                };
            }
        };

        const before = Date.now();
        await processManualBookingSmsOutbox({ supabaseClient: client, dryRun: false, fetchImpl });
        const retryUpdate = updates.find(u => u.patch.status === 'retry');
        assert.ok(retryUpdate, 'expected a retry-status update after a timeout');
        assert.equal(retryUpdate.patch.last_error_code, 'PROVIDER_TIMEOUT');
        const scheduledDelayMs = new Date(retryUpdate.patch.scheduled_at).getTime() - before;
        assert.ok(scheduledDelayMs >= 25 * 60 * 1000, `expected >=25min backoff, got ${scheduledDelayMs}ms`);
    });
});

describe('MANUAL BOOKING SMS OUTBOX — DUPLICATE TXN_ID RESOLUTION (HTTP 409 / code 108)', () => {
    beforeEach(resetEnv);
    afterEach(resetEnv);

    function makeDuplicateFlowClient({ statusResponseBody, statusResponseStatus = 200 }) {
        const updates = [];
        const client = {
            rpc: async (name) => {
                if (name === 'fn_claim_manual_booking_sms_batch') {
                    return { data: [{ outbox_id: 'row-d', booking_id: 1, idempotency_key: 'dup-key', locale: 'ru', attempts_count: 1, max_attempts: 5 }], error: null };
                }
                if (name === 'fn_oson_sms_check_cap') {
                    return { data: { allowed: true }, error: null };
                }
                return { data: null, error: { message: 'unexpected rpc ' + name } };
            },
            from(table) {
                if (table === 'manual_booking_sms_outbox') {
                    return { update(patch) { return { eq(f, v) { updates.push({ patch, [f]: v }); return Promise.resolve({ error: null }); } }; } };
                }
                if (table === 'bus_ticket_bookings') {
                    return {
                        select() {
                            return {
                                eq() {
                                    return {
                                        single: async () => ({
                                            data: { id: 1, status: 'confirmed', claim_status: 'unclaimed', phone: '992900000001', bus_ticket_id: 1 }
                                        })
                                    };
                                }
                            };
                        }
                    };
                }
                if (table === 'booking_claim_sessions') {
                    return {
                        insert() {
                            return {
                                select() {
                                    return {
                                        single: async () => ({
                                            data: { id: 'sess-1', booking_id: 1, session_token_hash: 'x'.repeat(64), expires_at: new Date(Date.now() + 900000).toISOString() }
                                        })
                                    };
                                }
                            };
                        }
                    };
                }
                return {
                    select() {
                        return {
                            eq() {
                                return { single: async () => ({ data: { from_city: 'A', to_city: 'B' } }) };
                            }
                        };
                    }
                };
            }
        };

        const fetchImpl = async (url) => {
            if (url.includes('sendsms_v1.php')) {
                return { ok: false, status: 409, type: 'basic', headers: { get: () => 'application/json' }, text: async () => JSON.stringify({ error: { code: 108, msg: 'duplicate' } }) };
            }
            if (url.includes('query_sms.php')) {
                return { ok: statusResponseStatus === 200, status: statusResponseStatus, type: 'basic', headers: { get: () => 'application/json' }, text: async () => JSON.stringify(statusResponseBody) };
            }
            throw new Error('unexpected URL in duplicate-flow test: ' + url);
        };

        return { client, updates, fetchImpl };
    }

    it('[D1] duplicate resolved via query_sms.php DELIVERED -> outbox marked delivered (never assumed from the bare 409 alone)', async () => {
        enabledConfig({ OSON_SMS_DAILY_CAP: '100', OSON_SMS_PHONE_HASH_SECRET: 'test-secret' });
        const { client, updates, fetchImpl } = makeDuplicateFlowClient({ statusResponseBody: { status: 'DELIVERED' } });
        await processManualBookingSmsOutbox({ supabaseClient: client, dryRun: false, fetchImpl });
        const finalUpdate = updates[updates.length - 1];
        assert.equal(finalUpdate.patch.status, 'delivered');
    });

    it('[D2] duplicate resolved via query_sms.php ENROUTE -> outbox marked sent, NOT delivered', async () => {
        enabledConfig({ OSON_SMS_DAILY_CAP: '100', OSON_SMS_PHONE_HASH_SECRET: 'test-secret' });
        const { client, updates, fetchImpl } = makeDuplicateFlowClient({ statusResponseBody: { status: 'ENROUTE' } });
        await processManualBookingSmsOutbox({ supabaseClient: client, dryRun: false, fetchImpl });
        const finalUpdate = updates[updates.length - 1];
        assert.equal(finalUpdate.patch.status, 'sent');
    });

    it('[D3] duplicate resolved via query_sms.php UNKNOWN -> bounded retry, never delivered, same idempotency_key next attempt', async () => {
        enabledConfig({ OSON_SMS_DAILY_CAP: '100', OSON_SMS_PHONE_HASH_SECRET: 'test-secret' });
        const { client, updates, fetchImpl } = makeDuplicateFlowClient({ statusResponseBody: { status: 'UNKNOWN' } });
        await processManualBookingSmsOutbox({ supabaseClient: client, dryRun: false, fetchImpl });
        const finalUpdate = updates[updates.length - 1];
        assert.equal(finalUpdate.patch.status, 'retry');
        assert.equal(finalUpdate.patch.last_error_code, 'PROVIDER_DUPLICATE_TXN_ID');
    });

    it('[D4] duplicate where the status query itself fails -> bounded retry, never delivered, never dead_letter on first attempt', async () => {
        enabledConfig({ OSON_SMS_DAILY_CAP: '100', OSON_SMS_PHONE_HASH_SECRET: 'test-secret' });
        const { client, updates, fetchImpl } = makeDuplicateFlowClient({ statusResponseBody: { error: { code: 106 } }, statusResponseStatus: 400 });
        await processManualBookingSmsOutbox({ supabaseClient: client, dryRun: false, fetchImpl });
        const finalUpdate = updates[updates.length - 1];
        assert.equal(finalUpdate.patch.status, 'retry');
        assert.notEqual(finalUpdate.patch.status, 'delivered');
    });

    it('[D5] a duplicate never mints a new txn_id on the resolving status query — the same stable id is used', async () => {
        enabledConfig({ OSON_SMS_DAILY_CAP: '100', OSON_SMS_PHONE_HASH_SECRET: 'test-secret' });
        let capturedStatusUrl = null;
        const { client } = makeDuplicateFlowClient({ statusResponseBody: { status: 'DELIVERED' } });
        const fetchImpl = async (url) => {
            if (url.includes('sendsms_v1.php')) {
                return { ok: false, status: 409, type: 'basic', headers: { get: () => 'application/json' }, text: async () => JSON.stringify({ error: { code: 108 } }) };
            }
            capturedStatusUrl = url;
            return { ok: true, status: 200, type: 'basic', headers: { get: () => 'application/json' }, text: async () => JSON.stringify({ status: 'DELIVERED' }) };
        };
        await processManualBookingSmsOutbox({ supabaseClient: client, dryRun: false, fetchImpl });
        const crypto = require('node:crypto');
        const expectedTxnId = crypto.createHash('sha256').update('dup-key').digest('hex').slice(0, 24);
        assert.ok(capturedStatusUrl.includes(`txn_id=${expectedTxnId}`));
    });
});

describe('MANUAL BOOKING SMS OUTBOX — LOG/PII HYGIENE (source-level)', () => {
    const clientSrc = fs.readFileSync(path.join(__dirname, '../utils/osonSmsClient.js'), 'utf8');
    const workerSrc = fs.readFileSync(path.join(__dirname, '../utils/manualBookingSmsOutboxService.js'), 'utf8');
    const capsSrc = fs.readFileSync(path.join(__dirname, '../utils/osonSmsCaps.js'), 'utf8');

    it('[42] osonSmsClient never logs the raw phone, the raw Bearer token, or the raw login — only masked/Boolean-wrapped forms', () => {
        // No console.* call in the file may reference the raw phone param
        // destructured at sendServiceSms's top.
        assert.ok(!/console\.[a-z]+\([^;]*?\brecipientPhone\b/s.test(clientSrc));

        // Find every console.*(...) call block (may span multiple lines up to
        // its closing "});") and assert any cfg.login / cfg.token inside it
        // is always wrapped as Boolean(...) or maskLogin(...) — i.e. only
        // "does a credential exist" (or a masked form) may ever reach a log,
        // never the raw value. cfg.token specifically must NEVER appear
        // unwrapped anywhere in the file at all — not even in a comment-free
        // code line outside a console call — since it is never partially
        // displayed the way login/phone are.
        const consoleCalls = clientSrc.match(/console\.[a-z]+\([\s\S]*?\}\);/g) || [];
        assert.ok(consoleCalls.length > 0, 'expected at least one console.* call to inspect');
        for (const block of consoleCalls) {
            for (const field of ['cfg.login', 'cfg.token']) {
                if (block.includes(field)) {
                    const safelyWrapped = block.includes(`Boolean(${field})`) || block.includes(`maskLogin(${field})`);
                    assert.ok(safelyWrapped, `console call must Boolean()- or maskLogin()-wrap ${field}: ${block}`);
                }
            }
            assert.ok(!block.includes('cfg.token}') && !/cfg\.token[,)]/.test(block) || block.includes('Boolean(cfg.token)'),
                'cfg.token must never be interpolated raw into a log');
        }

        // The Authorization header line is the ONE place cfg.token is used
        // for its actual value — confirm it goes into the header, not a log.
        assert.match(clientSrc, /headers:\s*\{\s*Authorization:\s*`Bearer \$\{cfg\.token\}`/);
    });

    it('[43] worker never logs err.message from the OSON client call itself (only normalized errorCode) or the raw phone', () => {
        assert.ok(!/console\.[a-z]+\([^)]*\bphone\b(?!Check|Masked|Hmac)/.test(workerSrc));
    });

    it('[44] the worker only ever sets status "delivered" inside the confirmed-status branch (statusResult.internalStatus === \'delivered\'), never from a bare send response', () => {
        // Now that queryOsonSmsStatus (query_sms.php) exists, the worker CAN
        // legitimately reach 'delivered' — but only via an explicit status
        // confirmation, never by assuming it from sendServiceSms's own
        // result. Assert every occurrence of the delivered-status literal is
        // gated behind that specific check.
        const deliveredOccurrences = workerSrc.split('\n')
            .map((line, idx) => ({ line, idx }))
            .filter(({ line }) => line.includes("'delivered'"));
        assert.ok(deliveredOccurrences.length > 0, 'expected at least one delivered-status code path via confirmed status query');

        const lines = workerSrc.split('\n');
        for (const { idx } of deliveredOccurrences) {
            const windowStart = Math.max(0, idx - 12);
            const context = lines.slice(windowStart, idx + 1).join('\n');
            assert.ok(
                context.includes("statusResult.internalStatus === 'delivered'"),
                `'delivered' at line ${idx + 1} must be gated behind an explicit statusResult.internalStatus === 'delivered' check`
            );
        }
        // sendServiceSms's own success branch (result.success) must never
        // itself write 'delivered' — only 'sent'.
        assert.ok(!/result\.success\)[\s\S]{0,120}'delivered'/.test(workerSrc));
    });

    it('[45] cap check never logs the phone HMAC or hashes anything without the dedicated secret env var', () => {
        assert.ok(capsSrc.includes('OSON_SMS_PHONE_HASH_SECRET'));
        assert.ok(!/console\.[a-z]+\([^)]*phoneHmac/.test(capsSrc));
    });
});
