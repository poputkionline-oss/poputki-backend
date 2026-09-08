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
    computeStrHash
} = require('../utils/osonSmsClient');
const { calculateSmsSegments, renderManualBookingTicketSms } = require('../utils/smsTemplates');
const { checkSendCaps, hmacPhone, isCarrierAllowlisted } = require('../utils/osonSmsCaps');
const { processManualBookingSmsOutbox } = require('../utils/manualBookingSmsOutboxService');

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
    process.env.OSON_SMS_HASH = 'testsecrethash';
    process.env.OSON_SMS_SENDER = 'Poputki';
    process.env.OSON_SMS_TIMEOUT_MS = '200';
    process.env.OSON_SMS_ALLOWED_COUNTRIES = 'TJ';
    Object.assign(process.env, overrides);
}

describe('MANUAL BOOKING SMS OUTBOX — OSON SMS CLIENT', () => {
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

    it('[2] client success on a well-formed 200 JSON success envelope', async () => {
        enabledConfig();
        const fetchImpl = async () => ({
            ok: true,
            status: 200,
            headers: { get: () => 'application/json' },
            text: async () => JSON.stringify({ status: 'ok', msg_id: 40127 })
        });
        const result = await sendServiceSms(
            { recipientPhone: '992900000001', message: 'test', idempotencyKey: 'k2' },
            { fetchImpl }
        );
        assert.equal(result.success, true);
        assert.equal(result.providerMessageId, '40127');
    });

    it('[3] provider HTTP error (non-2xx) is reported, not treated as success', async () => {
        enabledConfig();
        const fetchImpl = async () => ({
            ok: false,
            status: 500,
            headers: { get: () => 'text/plain' },
            text: async () => 'Internal Server Error'
        });
        const result = await sendServiceSms(
            { recipientPhone: '992900000001', message: 'test', idempotencyKey: 'k3' },
            { fetchImpl }
        );
        assert.equal(result.success, false);
        assert.equal(result.errorCode, 'PROVIDER_HTTP_500');
    });

    it('[4] HTTP 200 with a provider error envelope is NOT treated as success', async () => {
        enabledConfig();
        const fetchImpl = async () => ({
            ok: true,
            status: 200,
            headers: { get: () => 'application/json' },
            text: async () => JSON.stringify({ error: { code: 5, msg: 'Insufficient balance' } })
        });
        const result = await sendServiceSms(
            { recipientPhone: '992900000001', message: 'test', idempotencyKey: 'k4' },
            { fetchImpl }
        );
        assert.equal(result.success, false);
        assert.match(result.errorCode, /^PROVIDER_ERROR_/);
    });

    it('[5] timeout via AbortController is reported as PROVIDER_TIMEOUT, single attempt only', async () => {
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
            { recipientPhone: '992900000001', message: 'test', idempotencyKey: 'k5' },
            { fetchImpl }
        );
        assert.equal(result.success, false);
        assert.equal(result.errorCode, 'PROVIDER_TIMEOUT');
        assert.equal(callCount, 1, 'client must never blindly retry internally');
    });

    it('[6] invalid/non-JSON response body is not treated as success', async () => {
        enabledConfig();
        const fetchImpl = async () => ({
            ok: true,
            status: 200,
            headers: { get: () => 'text/html' },
            text: async () => '<html>not json</html>'
        });
        const result = await sendServiceSms(
            { recipientPhone: '992900000001', message: 'test', idempotencyKey: 'k6' },
            { fetchImpl }
        );
        assert.equal(result.success, false);
        assert.equal(result.errorCode, 'INVALID_RESPONSE_FORMAT');
    });

    it('[7] refuses non-HTTPS base URL (ERR_INSECURE_TRANSPORT), never calls fetch', async () => {
        enabledConfig({ OSON_SMS_BASE_URL: 'http://api.osonsms.com/sendsms_v1.php' });
        let called = false;
        const result = await sendServiceSms(
            { recipientPhone: '992900000001', message: 'test', idempotencyKey: 'k7' },
            { fetchImpl: async () => { called = true; } }
        );
        assert.equal(result.success, false);
        assert.equal(result.errorCode, 'ERR_INSECURE_TRANSPORT');
        assert.equal(called, false);
    });

    it('[8] invalid phone is rejected before any network call', async () => {
        enabledConfig();
        let called = false;
        const result = await sendServiceSms(
            { recipientPhone: 'not-a-phone', message: 'test', idempotencyKey: 'k8' },
            { fetchImpl: async () => { called = true; } }
        );
        assert.equal(result.success, false);
        assert.equal(result.errorCode, 'INVALID_PHONE');
        assert.equal(called, false);
    });

    it('[9] unsupported country is rejected (allowlist = TJ only, RU number given)', async () => {
        enabledConfig({ OSON_SMS_ALLOWED_COUNTRIES: 'TJ' });
        const result = await sendServiceSms(
            { recipientPhone: '79261234567', message: 'test', idempotencyKey: 'k9' },
            { fetchImpl: async () => ({}) }
        );
        assert.equal(result.success, false);
        assert.equal(result.errorCode, 'UNSUPPORTED_COUNTRY');
    });

    it('[10] dry-run mode never calls fetch and returns success', async () => {
        enabledConfig({ OSON_SMS_DRY_RUN: 'true' });
        let called = false;
        const result = await sendServiceSms(
            { recipientPhone: '992900000001', message: 'test', idempotencyKey: 'k10' },
            { fetchImpl: async () => { called = true; } }
        );
        assert.equal(result.success, true);
        assert.equal(result.dryRun, true);
        assert.equal(called, false);
    });

    it('[11] delivery-disabled (OSON_SMS_DELIVERY_ENABLED=false) behaves like dry-run, never calls fetch', async () => {
        enabledConfig({ OSON_SMS_DRY_RUN: 'false', OSON_SMS_DELIVERY_ENABLED: 'false' });
        let called = false;
        const result = await sendServiceSms(
            { recipientPhone: '992900000001', message: 'test', idempotencyKey: 'k11' },
            { fetchImpl: async () => { called = true; } }
        );
        assert.equal(result.success, true);
        assert.equal(called, false);
    });

    it('[12] secret (OSON_SMS_HASH) is never present in the outgoing request or the returned result', async () => {
        enabledConfig({ OSON_SMS_HASH: 'super-secret-value-12345' });
        let capturedUrl = null;
        const fetchImpl = async (url) => {
            capturedUrl = url;
            return {
                ok: true, status: 200, headers: { get: () => 'application/json' },
                text: async () => JSON.stringify({ status: 'ok', msg_id: 1 })
            };
        };
        const result = await sendServiceSms(
            { recipientPhone: '992900000001', message: 'test', idempotencyKey: 'k12' },
            { fetchImpl }
        );
        assert.ok(!capturedUrl.includes('super-secret-value-12345'), 'raw secret must never appear in the request URL');
        assert.ok(!JSON.stringify(result).includes('super-secret-value-12345'), 'raw secret must never appear in the returned result');
    });

    it('[13] phone masking hides the middle digits', () => {
        const masked = maskPhoneLocal('992901234567');
        assert.ok(!masked.includes('901234'));
        assert.match(masked, /^9929\*+567$/);
    });

    it('[14] login masking hides all but the last 4 characters', () => {
        assert.equal(maskLogin('blablacartj'), '*******artj');
        assert.equal(maskLogin('ab'), '**');
    });

    it('[15] str_hash formula matches the historical PHP integration exactly', () => {
        // Recomputed independently from the audited osonsms.php class logic:
        // SHA256("jam" + txn_id + ";" + login + ";" + sender + ";" + phone + ";" + hash)
        const crypto = require('node:crypto');
        const expected = crypto.createHash('sha256')
            .update('jam123;mylogin;Poputki;992900000001;mysecret')
            .digest('hex');
        const actual = computeStrHash({
            txnId: '123', login: 'mylogin', sender: 'Poputki',
            phoneNumber: '992900000001', secretHash: 'mysecret'
        });
        assert.equal(actual, expected);
    });

    it('[16] classifyPhone accepts TJ numbers and rejects malformed input', () => {
        assert.equal(classifyPhone('992901234567').valid, true);
        assert.equal(classifyPhone('123').valid, false);
        assert.equal(classifyPhone(null).valid, false);
        assert.equal(classifyPhone('abc').valid, false);
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
});
