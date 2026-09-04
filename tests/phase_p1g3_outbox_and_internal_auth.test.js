/**
 * tests/phase_p1g3_outbox_and_internal_auth.test.js
 *
 * Automated tests for Phase P.1G.3:
 * 1. HMAC-SHA256 Internal Authentication & Replay Guard
 * 2. Persistent Replay Protection across simulated process restarts
 * 3. Outbox enqueuing, leasing, resolution, and dead-letter semantics
 * 4. Business write to outbox gap test (reconciliation recovery)
 * 5. Watermark validation & zero legacy backfill guarantee
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { setServiceRoleClient } = require('../dbServiceRole');

// Mock Persistent PostgreSQL Database
const persistentPgNonces = new Set();
const persistentOutboxStore = [];

const mockPgClient = {
    rpc: async (fnName, params) => {
        if (fnName === 'fn_record_internal_service_nonce') {
            const nonce = params.p_nonce;
            if (persistentPgNonces.has(nonce)) {
                return { data: false, error: null }; // Already exists in DB!
            }
            persistentPgNonces.add(nonce);
            return { data: true, error: null }; // Successfully inserted in DB!
        }

        if (fnName === 'fn_claim_outbox_events') {
            const batchSize = params.p_batch_size || 50;
            const leaseToken = crypto.randomUUID();
            const claimed = [];
            for (const item of persistentOutboxStore) {
                if (item.status === 'pending' && claimed.length < batchSize) {
                    item.status = 'processing';
                    item.lease_token = leaseToken;
                    claimed.push({ ...item });
                }
            }
            return { data: claimed, error: null };
        }

        if (fnName === 'fn_resolve_outbox_event') {
            const item = persistentOutboxStore.find(i => i.id === params.p_id);
            if (item) {
                item.status = params.p_success ? 'completed' : 'dead_letter';
                item.lease_token = null;
                return { data: true, error: null };
            }
            return { data: false, error: null };
        }

        if (fnName === 'fn_create_booking_acquisition_attribution') {
            return { data: true, error: null };
        }

        return { data: true, error: null };
    },
    from: (table) => ({
        select: (cols, opts) => ({
            lt: async () => ({ count: 157 }),
            gte: () => ({
                order: async () => ({
                    data: [
                        {
                            id: 88888881,
                            passenger_id: 1,
                            bus_ticket_id: 10,
                            status: 'confirmed',
                            created_at: new Date().toISOString(),
                            total_price: 150,
                            paid_amount: 150
                        }
                    ],
                    error: null
                })
            }),
            eq: (col, val) => ({
                maybeSingle: async () => {
                    if (table === 'acquisition_system_config' && val === 'reconciliation_launch_watermark') {
                        return {
                            data: {
                                value: { watermark_utc: '2026-09-04T18:50:00.000Z' }
                            },
                            error: null
                        };
                    }
                    if (table === 'booking_acquisition_attributions') return { data: null };
                    if (table === 'acquisition_events') return { data: null };
                    if (table === 'bus_tickets') return { data: { status: 'active' } };
                    return { data: null, error: null };
                }
            })
        }),
        upsert: (row) => {
            const id = row.id || crypto.randomUUID();
            const record = { ...row, id };
            persistentOutboxStore.push(record);
            return {
                select: () => ({
                    maybeSingle: async () => ({
                        data: { id, status: record.status, idempotency_key: record.idempotency_key },
                        error: null
                    })
                }),
                then: (resolve) => resolve({ data: [record], error: null })
            };
        },
        insert: async (row) => ({ data: row, error: null })
    })
};

setServiceRoleClient(mockPgClient);

const {
    computeSignature,
    recordPersistentNonce,
    _resetMemoryNonceCache
} = require('../utils/internalServiceAuth');

const {
    enqueueOutboxEvent,
    claimOutboxBatch,
    resolveOutboxEvent
} = require('../services/acquisition/outboxService');

const {
    runReconciliationPass,
    getReconciliationWatermark,
    DEFAULT_WATERMARK_UTC
} = require('../services/acquisition/reconciliationService');

test('PHASE P.1G.3 — OUTBOX RELIABILITY & INTERNAL AUTH', async (t) => {

    await t.test('1. HMAC-SHA256 Signature Computation & Freshness', () => {
        const secret = 'test_secret_for_hmac_12345';
        const method = 'POST';
        const path = '/api/internal/acquisition/consume-telegram-session';
        const timestamp = Date.now().toString();
        const nonce = crypto.randomBytes(16).toString('hex');
        const body = { raw_token: '0123456789abcdef0123456789abcdef' };

        const sig1 = computeSignature({ method, path, timestamp, nonce, body, secret });
        const sig2 = computeSignature({ method, path, timestamp, nonce, body, secret });

        assert.equal(sig1, sig2, 'Signature must be deterministic for identical inputs');
        assert.equal(typeof sig1, 'string');
        assert.equal(sig1.length, 64, 'HMAC-SHA256 hex must be 64 characters');

        // Tampered body produces different signature
        const tamperedSig = computeSignature({
            method,
            path,
            timestamp,
            nonce,
            body: { raw_token: 'tampered_token_value' },
            secret
        });
        assert.notEqual(sig1, tamperedSig, 'Tampered body must produce different signature');

        // Tampered path produces different signature
        const tamperedPathSig = computeSignature({
            method,
            path: '/api/internal/acquisition/bot-start',
            timestamp,
            nonce,
            body,
            secret
        });
        assert.notEqual(sig1, tamperedPathSig, 'Tampered path must produce different signature');
    });

    await t.test('2. REPLAY_AFTER_PROCESS_RESTART_TEST (Persistent Nonce Protection)', async () => {
        const testNonce = `test_restart_nonce_${crypto.randomBytes(12).toString('hex')}`;

        // 1. Record fresh nonce into persistent storage
        const firstRecord = await recordPersistentNonce(testNonce, 300);
        assert.equal(firstRecord, true, 'First nonce recording must succeed');

        // 2. Immediate in-memory re-recording must be rejected
        const duplicateImmediate = await recordPersistentNonce(testNonce, 300);
        assert.equal(duplicateImmediate, false, 'Duplicate nonce in same process must be rejected');

        // 3. Simulate process restart by completely wiping in-memory L1 cache
        _resetMemoryNonceCache();

        // 4. Re-record same nonce after process restart simulation
        // Even though memory cache is wiped, PostgreSQL database still contains the nonce!
        const duplicateAfterRestart = await recordPersistentNonce(testNonce, 300);
        assert.equal(duplicateAfterRestart, false, 'Replayed nonce MUST be rejected even after process restart');

        console.log('    ✔ REPLAY_AFTER_PROCESS_RESTART_TEST: PASSED');
    });

    await t.test('3. Persistent Outbox Lifecycle (Enqueue, Claim, Resolve)', async () => {
        const testIdempKey = `test_outbox_${crypto.randomBytes(12).toString('hex')}`;

        // 1. Enqueue event
        const enqResult = await enqueueOutboxEvent({
            eventName: 'BOOKING_CREATED',
            eventSource: 'backend',
            idempotencyKey: testIdempKey,
            bookingId: 999999991,
            properties: {
                test: true,
                phone: '+992900000000', // PII must be stripped by service
                passport: 'A1234567'    // PII must be stripped by service
            }
        });

        assert.equal(enqResult.success, true, 'Outbox enqueue must succeed');

        // 2. Claim batch
        const claimed = await claimOutboxBatch({ batchSize: 50, leaseSeconds: 30 });
        assert.ok(Array.isArray(claimed), 'Claimed must be an array');

        const ourEvent = claimed.find(e => e.idempotency_key === testIdempKey);
        assert.ok(ourEvent, 'Enqueued event must be claimed');

        // Verify PII was stripped
        assert.equal(ourEvent.properties.phone, undefined, 'Phone must be stripped from outbox properties');
        assert.equal(ourEvent.properties.passport, undefined, 'Passport must be stripped from outbox properties');
        assert.equal(ourEvent.properties.test, true);

        // 3. Resolve event as completed
        const resolved = await resolveOutboxEvent({
            id: ourEvent.id,
            leaseToken: ourEvent.lease_token,
            success: true
        });
        assert.equal(resolved, true, 'Outbox resolution must succeed');
    });

    await t.test('4. BUSINESS_WRITE_TO_OUTBOX_GAP_TEST (Reconciliation Recovery)', async () => {
        const recSummary = await runReconciliationPass({
            overrideWatermark: '2026-09-04T00:00:00.000Z'
        });

        assert.equal(recSummary.scanned_bookings, 1, 'Must scan eligible post-watermark booking');
        assert.equal(recSummary.recovered_attributions, 1, 'Must recover missing attribution');
        assert.equal(recSummary.recovered_booking_events, 1, 'Must recover missing BOOKING_CREATED');
        assert.equal(recSummary.recovered_payments, 1, 'Must recover missing PAYMENT_COMPLETED');

        console.log('    ✔ BUSINESS_WRITE_TO_OUTBOX_GAP_TEST: PASSED');
    });

    await t.test('5. Watermark Launch Validation (Zero Legacy Backfill)', async () => {
        const watermarkInfo = await getReconciliationWatermark();
        assert.ok(watermarkInfo.watermark_utc, 'Watermark UTC must be defined');
        assert.equal(watermarkInfo.watermark_utc, DEFAULT_WATERMARK_UTC);

        const summary = await runReconciliationPass();
        assert.equal(summary.watermark_utc, DEFAULT_WATERMARK_UTC);
        assert.equal(summary.skipped_legacy, 157, 'Must skip all 157 historical legacy bookings');

        console.log(`    ✔ Legacy bookings skipped: ${summary.skipped_legacy} (LEGACY_BACKFILL_PERFORMED: NO)`);
    });

});
