/**
 * phase_oson_sms_retry_sweep.test.js
 *
 * Test Suite: OSON SMS RETRY SWEEP — in-process periodic retry pickup
 * POPUTKI.ONLINE, Stage D2 implementation.
 *
 * Scope: startManualBookingSmsRetrySweep() / stopManualBookingSmsRetrySweep()
 * (utils/manualBookingSmsOutboxService.js) — a scheduling shortcut around
 * the existing, already-tested processManualBookingSmsOutbox() (see
 * phase_oson_sms_outbox.test.js and phase_oson_sms_fast_trigger.test.js for
 * claim/lease/cap/allowlist/kill-switch/concurrency coverage, which is
 * unmodified and unaffected by this feature except for the DAILY_CAP retry
 * semantics fix covered explicitly below).
 *
 * Real PostgreSQL FOR UPDATE SKIP LOCKED / pg_advisory_xact_lock atomicity
 * is proven separately against a real local database (see
 * docs/oson-sms-audit-report.md). The concurrency tests below prove the
 * orchestration layer's own behavior under a mock that mirrors that DB
 * contract (a row already marked 'processing' or a cap slot already taken
 * is never handed out twice), using JS's single-threaded execution to make
 * that mirroring deterministic (no `await` inside the mock's decision
 * body), exactly as in phase_oson_sms_fast_trigger.test.js.
 *
 * Sweep interval tests use short REAL timers (tens of ms) rather than
 * Node's experimental mock timers, to avoid fighting fake-timer/promise
 * interleaving for a background tick that itself awaits several promises
 * internally; the pure start/stop/no-op state tests do not depend on any
 * timer firing at all.
 */

'use strict';

require('dotenv').config();
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
    processManualBookingSmsOutbox,
    startManualBookingSmsRetrySweep,
    stopManualBookingSmsRetrySweep
} = require('../utils/manualBookingSmsOutboxService');

const ORIGINAL_ENV = { ...process.env };

function resetEnv() {
    for (const key of Object.keys(process.env)) {
        if (key.startsWith('OSON_SMS_')) delete process.env[key];
    }
    process.env = { ...ORIGINAL_ENV };
    for (const key of Object.keys(process.env)) {
        if (key.startsWith('OSON_SMS_')) delete process.env[key];
    }
    stopManualBookingSmsRetrySweep();
}

function enabledConfig(overrides = {}) {
    process.env.OSON_SMS_ENABLED = 'true';
    process.env.OSON_SMS_DELIVERY_ENABLED = 'false'; // dry-run-equivalent: worker marks "sent" without any network call
    process.env.OSON_SMS_DRY_RUN = 'true';
    process.env.OSON_SMS_PHONE_HASH_SECRET = 'test-phone-hash-secret';
    Object.assign(process.env, overrides);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Mock Supabase-like client with:
 * - rpc('fn_claim_manual_booking_sms_batch'): honors status IN
 *   ('pending','retry'), scheduled_at <= now, attempts_count < max_attempts
 *   — mirrors the real RPC's WHERE clause closely enough to prove the
 *   worker/sweep never picks up a future-scheduled or exhausted row. No
 *   internal await, so concurrent calls cannot interleave mid-claim
 *   (mirrors FOR UPDATE SKIP LOCKED's mutual exclusion via JS's
 *   single-threaded execution).
 * - rpc('fn_oson_sms_check_cap'): pluggable via `capMode`.
 * - booking_claim_sessions insert stub so the real claimHelper call
 *   succeeds without a live DB.
 */
function makeMockOutbox(initialRows, bookingsById, opts = {}) {
    const rows = new Map(initialRows.map(r => [r.outbox_id, { max_attempts: 5, attempts_count: 0, ...r, status: r.status || 'pending' }]));
    const updates = [];
    const capMode = opts.capMode || (() => ({ allowed: true }));
    let sessionAutoId = 1;
    let claimCalls = 0;
    return {
        updates,
        rows,
        get claimCalls() { return claimCalls; },
        rpc: async (name, params) => {
            if (name === 'fn_claim_manual_booking_sms_batch') {
                claimCalls++;
                const now = Date.now();
                const claimable = [...rows.values()].filter(r =>
                    ['pending', 'retry'].includes(r.status) &&
                    new Date(r.scheduled_at || 0).getTime() <= now &&
                    r.attempts_count < r.max_attempts
                );
                const batch = claimable.slice(0, params.p_batch_size || 10);
                for (const r of batch) {
                    r.status = 'processing';
                    r.attempts_count += 1;
                }
                return { data: batch.map(r => ({ ...r })), error: null };
            }
            if (name === 'fn_oson_sms_check_cap') {
                const decision = capMode();
                return { data: decision, error: null };
            }
            throw new Error(`Unexpected rpc call in mock: ${name}`);
        },
        from(table) {
            if (table === 'manual_booking_sms_outbox') {
                return {
                    update(patch) {
                        return {
                            eq(field, value) {
                                updates.push({ patch, [field]: value });
                                const row = rows.get(value);
                                if (row) Object.assign(row, patch);
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
                            eq(field, value) {
                                return { single: async () => ({ data: bookingsById[value] || null, error: bookingsById[value] ? null : { message: 'not found' } }) };
                            }
                        };
                    }
                };
            }
            if (table === 'bus_tickets') {
                return { select() { return { eq() { return { single: async () => ({ data: { from_city: 'A', to_city: 'B' } }) }; } }; } };
            }
            if (table === 'booking_claim_sessions') {
                return {
                    insert(rowsToInsert) {
                        return { select() { return { single: async () => ({ data: { id: sessionAutoId++, ...rowsToInsert[0] }, error: null }) }; } };
                    }
                };
            }
            return { select() { return { eq() { return { single: async () => ({ data: null }) }; }, in() { return this; } }; } };
        }
    };
}

describe('OSON SMS RETRY SWEEP — start/stop state machine', () => {
    beforeEach(resetEnv);
    afterEach(resetEnv);

    it('[RS-1] enabled=true → sweep starts', () => {
        enabledConfig({ OSON_SMS_RETRY_SWEEP_ENABLED: 'true' });
        const result = startManualBookingSmsRetrySweep({ intervalMs: 10_000, supabaseClient: { rpc: async () => ({ data: [], error: null }) } });
        assert.equal(result.started, true);
        assert.equal(result.intervalMs, 10_000);
    });

    it('[RS-2] disabled (false) → sweep does not start', () => {
        enabledConfig({ OSON_SMS_RETRY_SWEEP_ENABLED: 'false' });
        const result = startManualBookingSmsRetrySweep({ supabaseClient: { rpc: async () => ({ data: [], error: null }) } });
        assert.equal(result.started, false);
    });

    it('[RS-2b] missing (unset) → fail-closed, sweep does not start', () => {
        enabledConfig();
        delete process.env.OSON_SMS_RETRY_SWEEP_ENABLED;
        const result = startManualBookingSmsRetrySweep({ supabaseClient: { rpc: async () => ({ data: [], error: null }) } });
        assert.equal(result.started, false);
    });

    it('[RS-7] repeated start() while running does not create a second timer', async () => {
        enabledConfig({ OSON_SMS_RETRY_SWEEP_ENABLED: 'true' });
        let claimCount = 0;
        const client = { rpc: async () => { claimCount++; return { data: [], error: null }; } };
        const first = startManualBookingSmsRetrySweep({ intervalMs: 30, supabaseClient: client });
        const second = startManualBookingSmsRetrySweep({ intervalMs: 30, supabaseClient: client });
        assert.equal(first.started, true);
        assert.equal(second.started, false, 'second start() must be a no-op while already running');

        await sleep(130); // ~4 ticks at 30ms if only one interval is alive
        stopManualBookingSmsRetrySweep();
        const countAtStop = claimCount;
        await sleep(100); // if a second interval existed, more ticks would still land
        assert.equal(claimCount, countAtStop, 'no further ticks after stop — confirms only one interval was ever running');
        // With a single 30ms interval over ~130ms we expect roughly 3-5 ticks,
        // not roughly double that (which a duplicate interval would produce).
        assert.ok(claimCount >= 2 && claimCount <= 8, `claimCount=${claimCount} outside the single-interval range`);
    });

    it('[RS-8] stop() clears the timer — no ticks fire afterward', async () => {
        enabledConfig({ OSON_SMS_RETRY_SWEEP_ENABLED: 'true' });
        let claimCount = 0;
        const client = { rpc: async () => { claimCount++; return { data: [], error: null }; } };
        startManualBookingSmsRetrySweep({ intervalMs: 20, supabaseClient: client });
        await sleep(60);
        stopManualBookingSmsRetrySweep();
        const countAtStop = claimCount;
        assert.ok(countAtStop > 0, 'sanity: at least one tick happened before stop');
        await sleep(80);
        assert.equal(claimCount, countAtStop, 'no ticks after stop()');
    });

    it('[RS-8b] stop() when nothing is running is a safe no-op', () => {
        assert.doesNotThrow(() => stopManualBookingSmsRetrySweep());
        assert.doesNotThrow(() => stopManualBookingSmsRetrySweep());
    });
});

describe('OSON SMS RETRY SWEEP — picks up existing rows without a new booking', () => {
    beforeEach(resetEnv);
    afterEach(resetEnv);

    it('[RS-3] an eligible retry row (scheduled_at already past) is picked up automatically by the sweep', async () => {
        enabledConfig({ OSON_SMS_RETRY_SWEEP_ENABLED: 'true', OSON_SMS_DAILY_CAP: '10' });
        const bookingsById = { 489: { id: 489, status: 'confirmed', claim_status: 'unclaimed', phone: '992900000001', bus_ticket_id: 1 } };
        const client = makeMockOutbox(
            [{ outbox_id: 'row-489', booking_id: 489, idempotency_key: 'k489', locale: 'ru', status: 'retry', attempts_count: 1, scheduled_at: new Date(Date.now() - 1000).toISOString() }],
            bookingsById
        );

        startManualBookingSmsRetrySweep({ intervalMs: 25, supabaseClient: client });
        await sleep(120);
        stopManualBookingSmsRetrySweep();

        assert.ok(client.claimCalls >= 1, 'sweep must have attempted at least one claim');
        assert.equal(client.rows.get('row-489').status, 'sent', 'the eligible retry row must have been picked up and sent (dry-run) without any new booking being created');
    });

    it('[RS-4] a retry row scheduled in the FUTURE is not picked up early', async () => {
        enabledConfig({ OSON_SMS_RETRY_SWEEP_ENABLED: 'true', OSON_SMS_DAILY_CAP: '10' });
        const bookingsById = { 490: { id: 490, status: 'confirmed', claim_status: 'unclaimed', phone: '992900000001', bus_ticket_id: 1 } };
        const client = makeMockOutbox(
            [{ outbox_id: 'row-future', booking_id: 490, idempotency_key: 'kfuture', locale: 'ru', status: 'retry', attempts_count: 1, scheduled_at: new Date(Date.now() + 60 * 60 * 1000).toISOString() }],
            bookingsById
        );

        startManualBookingSmsRetrySweep({ intervalMs: 25, supabaseClient: client });
        await sleep(120);
        stopManualBookingSmsRetrySweep();

        assert.equal(client.rows.get('row-future').status, 'retry', 'a row scheduled an hour from now must remain untouched');
    });

    it('[RS-5/RS-6] restart-safety: stopping and re-starting the sweep (simulating a process restart) still picks up an already-overdue row, with no per-row memory carried between runs', async () => {
        enabledConfig({ OSON_SMS_RETRY_SWEEP_ENABLED: 'true', OSON_SMS_DAILY_CAP: '10' });
        const bookingsById = { 491: { id: 491, status: 'confirmed', claim_status: 'unclaimed', phone: '992900000001', bus_ticket_id: 1 } };
        const client = makeMockOutbox(
            [{ outbox_id: 'row-491', booking_id: 491, idempotency_key: 'k491', locale: 'ru', status: 'retry', attempts_count: 2, scheduled_at: new Date(Date.now() - 5000).toISOString() }],
            bookingsById
        );

        // "First process lifetime": starts, but stops before ticking (simulates a crash/redeploy before the row was ever claimed).
        startManualBookingSmsRetrySweep({ intervalMs: 10_000, supabaseClient: client });
        stopManualBookingSmsRetrySweep();
        assert.equal(client.rows.get('row-491').status, 'retry', 'sanity: untouched before the simulated restart');

        // "Second process lifetime": a fresh start() call, exactly what boot does after a restart — no state from the call above is reused.
        startManualBookingSmsRetrySweep({ intervalMs: 25, supabaseClient: client });
        await sleep(120);
        stopManualBookingSmsRetrySweep();

        assert.equal(client.rows.get('row-491').status, 'sent', 'the overdue row must be picked up by the freshly re-registered sweep, proving state lives in the DB, not in the process');
    });
});

describe('OSON SMS RETRY SWEEP — overlap guard', () => {
    beforeEach(resetEnv);
    afterEach(resetEnv);

    it('[RS-9] a slow tick causes the next local tick to be skipped, not run concurrently', async () => {
        enabledConfig({ OSON_SMS_RETRY_SWEEP_ENABLED: 'true', OSON_SMS_DAILY_CAP: '10' });
        let inFlight = 0;
        let maxConcurrent = 0;
        let claimCalls = 0;
        const client = {
            rpc: async (name) => {
                if (name !== 'fn_claim_manual_booking_sms_batch') return { data: { allowed: true }, error: null };
                claimCalls++;
                inFlight++;
                maxConcurrent = Math.max(maxConcurrent, inFlight);
                await sleep(80); // slower than the sweep interval below
                inFlight--;
                return { data: [], error: null };
            }
        };

        startManualBookingSmsRetrySweep({ intervalMs: 20, supabaseClient: client });
        await sleep(200); // several interval ticks while one claim call is still "in flight"
        stopManualBookingSmsRetrySweep();
        await sleep(100); // let the last in-flight call finish

        assert.equal(maxConcurrent, 1, 'the overlap guard must prevent two processManualBookingSmsOutbox() calls from running at the same time in this process');
        assert.ok(claimCalls >= 2, 'sanity: the sweep did run more than one tick across the 200ms window');
    });
});

describe('OSON SMS RETRY SWEEP — concurrency with fast trigger / recovery / other instances', () => {
    beforeEach(resetEnv);
    afterEach(resetEnv);

    it('[RS-10/RS-12] a sweep tick racing another concurrent processManualBookingSmsOutbox() call (fast trigger or another instance) never double-sends the same row', async () => {
        enabledConfig({ OSON_SMS_DAILY_CAP: '10' });
        const bookingsById = { 500: { id: 500, status: 'confirmed', claim_status: 'unclaimed', phone: '992900000001', bus_ticket_id: 1 } };
        const client = makeMockOutbox(
            [{ outbox_id: 'row-500', booking_id: 500, idempotency_key: 'k500', locale: 'ru', status: 'retry', attempts_count: 1, scheduled_at: new Date(Date.now() - 1000).toISOString() }],
            bookingsById
        );

        const [sweepLikeResult, fastTriggerLikeResult] = await Promise.all([
            processManualBookingSmsOutbox({ supabaseClient: client }),
            processManualBookingSmsOutbox({ supabaseClient: client })
        ]);

        const totalSent = sweepLikeResult.sent + fastTriggerLikeResult.sent;
        assert.equal(totalSent, 1, 'exactly one of the two concurrent callers must have sent the row');
    });

    it('[RS-11] a sweep-style call racing a GitHub-recovery-style call (same function, different worker token) never double-sends', async () => {
        enabledConfig({ OSON_SMS_DAILY_CAP: '10' });
        const bookingsById = { 501: { id: 501, status: 'confirmed', claim_status: 'unclaimed', phone: '992900000001', bus_ticket_id: 1 } };
        const client = makeMockOutbox(
            [{ outbox_id: 'row-501', booking_id: 501, idempotency_key: 'k501', locale: 'ru', status: 'retry', attempts_count: 1, scheduled_at: new Date(Date.now() - 1000).toISOString() }],
            bookingsById
        );

        const [sweepResult, recoveryResult] = await Promise.all([
            processManualBookingSmsOutbox({ supabaseClient: client, workerToken: 'sweep-tick' }),
            processManualBookingSmsOutbox({ supabaseClient: client, workerToken: 'github-recovery' })
        ]);

        assert.equal(sweepResult.sent + recoveryResult.sent, 1);
    });
});

describe('OSON SMS RETRY SWEEP — DAILY_CAP atomicity unaffected', () => {
    beforeEach(resetEnv);
    afterEach(resetEnv);

    it('[RS-13] DAILY_CAP=1 still allows exactly one send across two concurrent callers on two different rows', async () => {
        enabledConfig({ OSON_SMS_DAILY_CAP: '1' });
        let slotsLeft = 1;
        const bookingsById = {
            502: { id: 502, status: 'confirmed', claim_status: 'unclaimed', phone: '992900000001', bus_ticket_id: 1 },
            503: { id: 503, status: 'confirmed', claim_status: 'unclaimed', phone: '992900000002', bus_ticket_id: 1 }
        };
        const client = makeMockOutbox(
            [
                { outbox_id: 'row-502', booking_id: 502, idempotency_key: 'k502', locale: 'ru' },
                { outbox_id: 'row-503', booking_id: 503, idempotency_key: 'k503', locale: 'ru' }
            ],
            bookingsById,
            { capMode: () => (slotsLeft-- > 0 ? { allowed: true } : { allowed: false, reason: 'DAILY_CAP_EXCEEDED' }) }
        );

        const [r1, r2] = await Promise.all([
            processManualBookingSmsOutbox({ supabaseClient: client }),
            processManualBookingSmsOutbox({ supabaseClient: client })
        ]);

        assert.equal(r1.sent + r2.sent, 1);
    });
});

describe('OSON SMS RETRY SWEEP — existing gates unaffected', () => {
    beforeEach(resetEnv);
    afterEach(resetEnv);

    it('[RS-14] OSON_SMS_ENABLED=false → sweep tick is a no-op, zero claims, no real send', async () => {
        resetEnv();
        process.env.OSON_SMS_RETRY_SWEEP_ENABLED = 'true';
        let claimCalls = 0;
        const client = { rpc: async () => { claimCalls++; return { data: [], error: null }; } };
        startManualBookingSmsRetrySweep({ intervalMs: 20, supabaseClient: client });
        await sleep(90);
        stopManualBookingSmsRetrySweep();
        assert.equal(claimCalls, 0, 'kill switch must stop the sweep tick before any DB claim call');
    });

    it('[RS-15] provider timeout still uses the pre-existing 30-minute backoff, unchanged by this feature', async () => {
        enabledConfig({ OSON_SMS_ENABLED: 'true', OSON_SMS_DELIVERY_ENABLED: 'true', OSON_SMS_DRY_RUN: 'false', OSON_SMS_DAILY_CAP: '10', OSON_SMS_SENDER: 'Poputki', OSON_SMS_LOGIN: 'test', OSON_SMS_TOKEN: 'test-token', OSON_SMS_BASE_URL: 'https://api.osonsms.com/sendsms_v1.php' });
        const bookingsById = { 504: { id: 504, status: 'confirmed', claim_status: 'unclaimed', phone: '992900000001', bus_ticket_id: 1 } };
        const client = makeMockOutbox(
            [{ outbox_id: 'row-504', booking_id: 504, idempotency_key: 'k504', locale: 'ru', attempts_count: 0, max_attempts: 5 }],
            bookingsById
        );
        const abortFetch = async () => { const err = new Error('aborted'); err.name = 'AbortError'; throw err; };

        const before = Date.now();
        const result = await processManualBookingSmsOutbox({ supabaseClient: client, fetchImpl: abortFetch });
        assert.equal(result.retried, 1);
        const row = client.rows.get('row-504');
        assert.equal(row.last_error_code, 'PROVIDER_TIMEOUT');
        const scheduledDeltaSec = (new Date(row.scheduled_at).getTime() - before) / 1000;
        assert.ok(scheduledDeltaSec > 29 * 60 && scheduledDeltaSec < 31 * 60, `expected ~30min backoff, got ${scheduledDeltaSec}s`);
    });

    it('[RS-16] a permanent error (e.g. unconfirmed sender) dead-letters immediately, never loops', async () => {
        enabledConfig({ OSON_SMS_ENABLED: 'true', OSON_SMS_DELIVERY_ENABLED: 'true', OSON_SMS_DRY_RUN: 'false', OSON_SMS_DAILY_CAP: '10', OSON_SMS_SENDER: 'WrongSender', OSON_SMS_LOGIN: 'test', OSON_SMS_TOKEN: 'test-token', OSON_SMS_BASE_URL: 'https://api.osonsms.com/sendsms_v1.php' });
        const bookingsById = { 505: { id: 505, status: 'confirmed', claim_status: 'unclaimed', phone: '992900000001', bus_ticket_id: 1 } };
        const client = makeMockOutbox(
            [{ outbox_id: 'row-505', booking_id: 505, idempotency_key: 'k505', locale: 'ru', attempts_count: 0, max_attempts: 5 }],
            bookingsById
        );
        const result = await processManualBookingSmsOutbox({ supabaseClient: client });
        assert.equal(result.dead_letter, 1);
        assert.equal(client.rows.get('row-505').status, 'dead_letter');
        assert.equal(client.rows.get('row-505').last_error_code, 'OSON_SMS_UNCONFIRMED_SENDER');
    });
});

describe('OSON SMS RETRY SWEEP — DAILY_CAP retry semantics fix (Stage D1 finding)', () => {
    beforeEach(resetEnv);
    afterEach(resetEnv);

    it('[RS-17] repeated DAILY_CAP_EXCEEDED never burns attempts_count toward max_attempts, and uses the 15-minute cap backoff, not the generic 5-minute one', async () => {
        enabledConfig({ OSON_SMS_DAILY_CAP: '1' });
        const bookingsById = { 489: { id: 489, status: 'confirmed', claim_status: 'unclaimed', phone: '992900000001', bus_ticket_id: 1 } };
        // Starts already at attempts_count=4 (one below max_attempts=5) to
        // prove the fix even in the worst case just before exhaustion.
        const client = makeMockOutbox(
            [{ outbox_id: 'row-489b', booking_id: 489, idempotency_key: 'k489b', locale: 'ru', status: 'retry', attempts_count: 4, max_attempts: 5, scheduled_at: new Date(Date.now() - 1000).toISOString() }],
            bookingsById,
            { capMode: () => ({ allowed: false, reason: 'DAILY_CAP_EXCEEDED' }) }
        );

        for (let i = 0; i < 5; i++) {
            client.rows.get('row-489b').scheduled_at = new Date(Date.now() - 1000).toISOString(); // force-eligible again for this test, bypassing the real 15min wait
            const before = Date.now();
            const result = await processManualBookingSmsOutbox({ supabaseClient: client });
            assert.equal(result.retried, 1, `iteration ${i}: must retry, not dead_letter`);
            const row = client.rows.get('row-489b');
            assert.equal(row.status, 'retry');
            assert.equal(row.last_error_code, 'DAILY_CAP_EXCEEDED');
            assert.equal(row.attempts_count, 4, 'attempts_count must be refunded back to its pre-claim value every single time — never net-incrementing from a pure cap rejection');
            const scheduledDeltaSec = (new Date(row.scheduled_at).getTime() - before) / 1000;
            assert.ok(scheduledDeltaSec > 14 * 60 && scheduledDeltaSec < 16 * 60, `iteration ${i}: expected ~15min cap backoff, got ${scheduledDeltaSec}s`);
        }
    });

    it('[RS-18] raising DAILY_CAP mid-day lets a previously cap-blocked row succeed on its very next attempt, without waiting until the next UTC day', async () => {
        enabledConfig({ OSON_SMS_DAILY_CAP: '1' });
        const bookingsById = { 489: { id: 489, status: 'confirmed', claim_status: 'unclaimed', phone: '992900000001', bus_ticket_id: 1 } };
        let capAllowsNow = false; // simulates DAILY_CAP=1 already exhausted by another booking earlier today
        const client = makeMockOutbox(
            [{ outbox_id: 'row-489c', booking_id: 489, idempotency_key: 'k489c', locale: 'ru', status: 'retry', attempts_count: 1, max_attempts: 5, scheduled_at: new Date(Date.now() - 1000).toISOString() }],
            bookingsById,
            { capMode: () => (capAllowsNow ? { allowed: true } : { allowed: false, reason: 'DAILY_CAP_EXCEEDED' }) }
        );

        const first = await processManualBookingSmsOutbox({ supabaseClient: client });
        assert.equal(first.retried, 1);
        assert.equal(client.rows.get('row-489c').attempts_count, 1, 'still refunded back to 1 — no budget spent');

        // Owner raises DAILY_CAP mid-day (simulated here as the cap check
        // now allowing) and the row's scheduled_at has since elapsed
        // (15-minute cap backoff, not next-UTC-day) — force it eligible
        // again for this assertion rather than sleeping 15 real minutes.
        capAllowsNow = true;
        client.rows.get('row-489c').scheduled_at = new Date(Date.now() - 1000).toISOString();

        const second = await processManualBookingSmsOutbox({ supabaseClient: client });
        assert.equal(second.sent, 1, 'once the cap opens up, the same row must succeed on its next claim — same-day recovery, not deferred to tomorrow');
        assert.equal(client.rows.get('row-489c').status, 'sent');
    });
});

describe('OSON SMS RETRY SWEEP — regression: manual handoff channels and bootstrap wiring untouched', () => {
    it('[RS-M] the manual /handoff route (SMS button backend) still never imports the OSON SMS worker/outbox', () => {
        const src = fs.readFileSync(path.join(__dirname, '../routes/busAdmin.js'), 'utf8');
        const handoffRouteStart = src.indexOf("router.post('/bookings/:bookingId/handoff'");
        assert.ok(handoffRouteStart > -1);
        const nextRouteStart = src.indexOf('router.', handoffRouteStart + 10);
        const handoffRouteBody = src.slice(handoffRouteStart, nextRouteStart > -1 ? nextRouteStart : handoffRouteStart + 3000);
        assert.ok(!/manualBookingSmsOutboxService|osonSmsClient|manual_booking_sms_outbox/.test(handoffRouteBody));
    });

    it('[RS-bootstrap] index.js calls startManualBookingSmsRetrySweep() exactly once, gated behind its own fail-closed check inside the module (no duplicate wiring)', () => {
        const src = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
        const callSites = src.match(/startManualBookingSmsRetrySweep\(\s*\)/g) || [];
        assert.equal(callSites.length, 1, 'startManualBookingSmsRetrySweep() must be CALLED exactly once in index.js (the require/destructure line is separate and expected)');
    });
});
