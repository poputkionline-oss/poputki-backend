/**
 * phase_oson_sms_fast_trigger.test.js
 *
 * Test Suite: OSON SMS FAST DELIVERY — in-process fast trigger
 * POPUTKI.ONLINE, Stage B implementation.
 *
 * Scope: triggerManualBookingSmsOutboxFast() (utils/manualBookingSmsOutboxService.js)
 * — the fast-path scheduling wrapper added on top of the existing,
 * already-tested processManualBookingSmsOutbox() (see
 * phase_oson_sms_outbox.test.js for claim/lease/cap/allowlist/kill-switch
 * coverage, which is unmodified and unaffected by this feature).
 *
 * Real PostgreSQL FOR UPDATE SKIP LOCKED / pg_advisory_xact_lock atomicity
 * is proven separately against a real local database (see
 * docs/oson-sms-audit-report.md, "PostgreSQL Integration Gate") and is not
 * re-provable against a mocked query builder. The concurrency tests below
 * prove the orchestration layer's own behavior: it never re-processes a
 * row that a claim call did not return to it — which is exactly the
 * contract real SKIP LOCKED guarantees on the DB side.
 */

require('dotenv').config();
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { processManualBookingSmsOutbox, triggerManualBookingSmsOutboxFast } = require('../utils/manualBookingSmsOutboxService');
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
    process.env.OSON_SMS_DELIVERY_ENABLED = 'false'; // dry-run-equivalent: worker marks "sent" without any network call
    process.env.OSON_SMS_DRY_RUN = 'true';
    process.env.OSON_SMS_PHONE_HASH_SECRET = 'test-phone-hash-secret'; // required by checkSendCaps' hmacPhone() whenever DAILY_CAP is configured — synthetic value, never a real secret
    Object.assign(process.env, overrides);
}

// Mock Supabase-like client shared by the concurrency tests below.
//
// - rpc('fn_claim_manual_booking_sms_batch') mirrors FOR UPDATE SKIP LOCKED:
//   a row already marked 'processing' by a concurrent caller is never
//   returned again. Its body has no internal `await`, so — because JS is
//   single-threaded — one call always runs to completion before another
//   can start, exactly mirroring the mutual exclusion a real Postgres
//   transaction provides.
// - rpc('fn_oson_sms_check_cap') defaults to always-allow; pass
//   `capSharedState` (an object with a `slotsLeft` counter) to simulate a
//   real atomic reservation — same single-threaded-body argument as above.
// - `booking_claim_sessions` insert is stubbed so the worker's real
//   claimHelper.generateClaimSession() call succeeds without a live DB.
function makeSharedOutboxMock(initialRows, bookingsById, options = {}) {
    const rows = new Map(initialRows.map(r => [r.outbox_id, { ...r, status: 'pending' }]));
    const updates = [];
    const capSharedState = options.capSharedState || null;
    let sessionAutoId = 1;
    return {
        updates,
        rpc: async (name, params) => {
            if (name === 'fn_claim_manual_booking_sms_batch') {
                const claimable = [...rows.values()].filter(r => r.status === 'pending');
                const batch = claimable.slice(0, params.p_batch_size || 10);
                for (const r of batch) r.status = 'processing'; // atomic claim, mirrors SKIP LOCKED exclusivity
                return { data: batch.map(r => ({ ...r })), error: null };
            }
            if (name === 'fn_oson_sms_check_cap') {
                if (!capSharedState) {
                    return { data: { allowed: true }, error: null };
                }
                if (capSharedState.slotsLeft <= 0) {
                    return { data: { allowed: false, reason: 'DAILY_CAP_EXCEEDED' }, error: null };
                }
                capSharedState.slotsLeft -= 1; // atomic reservation, mirrors cap_reserved_at under pg_advisory_xact_lock
                return { data: { allowed: true }, error: null };
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
                        return {
                            select() {
                                return {
                                    single: async () => ({ data: { id: sessionAutoId++, ...rowsToInsert[0] }, error: null })
                                };
                            }
                        };
                    }
                };
            }
            return { select() { return { eq() { return { single: async () => ({ data: null }) }; }, in() { return this; } }; } };
        }
    };
}

describe('OSON SMS FAST TRIGGER — kill switch semantics (OSON_SMS_FAST_TRIGGER_ENABLED)', () => {
    beforeEach(resetEnv);
    afterEach(resetEnv);

    it('[FT-B] OSON_SMS_FAST_TRIGGER_ENABLED=false → fast processor never scheduled, returns null synchronously', () => {
        enabledConfig({ OSON_SMS_FAST_TRIGGER_ENABLED: 'false' });
        let processorCalled = false;
        const client = { rpc: async () => { processorCalled = true; return { data: [], error: null }; } };
        const result = triggerManualBookingSmsOutboxFast({ bookingId: 999, supabaseClient: client });
        assert.equal(result, null);
        assert.equal(processorCalled, false);
    });

    it('[FT-C] OSON_SMS_FAST_TRIGGER_ENABLED absent (unset) → fail-closed, fast processor never scheduled', () => {
        enabledConfig();
        delete process.env.OSON_SMS_FAST_TRIGGER_ENABLED;
        let processorCalled = false;
        const client = { rpc: async () => { processorCalled = true; return { data: [], error: null }; } };
        const result = triggerManualBookingSmsOutboxFast({ bookingId: 999, supabaseClient: client });
        assert.equal(result, null);
        assert.equal(processorCalled, false);
    });

    it('[FT-B2] a misspelled/truthy-but-not-exact value ("TRUE", "1", true) is treated as OFF — only the exact string \'true\' enables it', () => {
        for (const badValue of ['TRUE', '1', 'yes']) {
            enabledConfig({ OSON_SMS_FAST_TRIGGER_ENABLED: badValue });
            let processorCalled = false;
            const client = { rpc: async () => { processorCalled = true; return { data: [], error: null }; } };
            const result = triggerManualBookingSmsOutboxFast({ bookingId: 999, supabaseClient: client });
            assert.equal(result, null, `expected OFF for OSON_SMS_FAST_TRIGGER_ENABLED=${badValue}`);
            assert.equal(processorCalled, false);
        }
    });

    it('[FT-D] OSON_SMS_FAST_TRIGGER_ENABLED=true → fast processor IS scheduled and eventually invoked', async () => {
        enabledConfig({ OSON_SMS_FAST_TRIGGER_ENABLED: 'true' });
        let claimCalled = false;
        const client = { rpc: async () => { claimCalled = true; return { data: [], error: null }; } };
        const promise = triggerManualBookingSmsOutboxFast({ bookingId: 42, supabaseClient: client });
        assert.notEqual(promise, null);
        await promise;
        assert.equal(claimCalled, true);
    });
});

describe('OSON SMS FAST TRIGGER — failure isolation (fast trigger failure must never surface to the caller)', () => {
    beforeEach(resetEnv);
    afterEach(resetEnv);

    it('[FT-E/F] processor throwing synchronously never rejects the returned promise (no unhandled rejection for an ignoring caller)', async () => {
        enabledConfig({ OSON_SMS_FAST_TRIGGER_ENABLED: 'true' });
        // A client whose .rpc() throws synchronously simulates the worst case:
        // processManualBookingSmsOutbox's internal call throws instead of
        // rejecting cleanly.
        const client = { rpc: () => { throw new Error('simulated hard failure'); } };
        const promise = triggerManualBookingSmsOutboxFast({ bookingId: 1, supabaseClient: client });
        // Must resolve, not reject — this is the whole point of the
        // internal .catch() in triggerManualBookingSmsOutboxFast.
        const result = await promise;
        assert.equal(result, undefined);
    });

    it('[FT-E2] a caller that never attaches .then()/.catch() to the returned promise produces no unhandled rejection', async () => {
        enabledConfig({ OSON_SMS_FAST_TRIGGER_ENABLED: 'true' });
        const client = { rpc: async () => { throw new Error('async failure'); } };

        let unhandled = false;
        const onUnhandled = () => { unhandled = true; };
        process.on('unhandledRejection', onUnhandled);
        try {
            triggerManualBookingSmsOutboxFast({ bookingId: 2, supabaseClient: client }); // intentionally not awaited/caught, mirrors the real booking route
            // Give the event loop enough ticks to surface an unhandled
            // rejection if one were going to happen.
            await new Promise(resolve => setImmediate(resolve));
            await new Promise(resolve => setImmediate(resolve));
            await new Promise(resolve => setTimeout(resolve, 10));
        } finally {
            process.removeListener('unhandledRejection', onUnhandled);
        }
        assert.equal(unhandled, false);
    });
});

describe('OSON SMS FAST TRIGGER — concurrency (no double-send)', () => {
    beforeEach(resetEnv);
    afterEach(resetEnv);

    it('[FT-G] two simultaneous fast triggers over the SAME shared outbox never both send the same row', async () => {
        enabledConfig({ OSON_SMS_FAST_TRIGGER_ENABLED: 'true', OSON_SMS_DAILY_CAP: '10' });
        const bookingsById = { 10: { id: 10, status: 'confirmed', claim_status: 'unclaimed', phone: '992900000001', bus_ticket_id: 1 } };
        const client = makeSharedOutboxMock(
            [{ outbox_id: 'row-A', booking_id: 10, idempotency_key: 'k10', locale: 'ru', attempts_count: 0, max_attempts: 5 }],
            bookingsById
        );

        const [r1, r2] = await Promise.all([
            triggerManualBookingSmsOutboxFast({ bookingId: 10, supabaseClient: client }),
            triggerManualBookingSmsOutboxFast({ bookingId: 10, supabaseClient: client })
        ]);

        const totalSent = (r1 ? r1.sent : 0) + (r2 ? r2.sent : 0);
        assert.equal(totalSent, 1, 'exactly one of the two concurrent fast triggers must have sent the row, never both');
        const sentUpdates = client.updates.filter(u => u.patch.status === 'sent');
        assert.equal(sentUpdates.length, 1);
    });

    it('[FT-H] a fast trigger racing a recovery-style call (same processManualBookingSmsOutbox, different worker token) never double-sends', async () => {
        enabledConfig({ OSON_SMS_FAST_TRIGGER_ENABLED: 'true', OSON_SMS_DAILY_CAP: '10' });
        const bookingsById = { 20: { id: 20, status: 'confirmed', claim_status: 'unclaimed', phone: '992900000001', bus_ticket_id: 1 } };
        const client = makeSharedOutboxMock(
            [{ outbox_id: 'row-B', booking_id: 20, idempotency_key: 'k20', locale: 'ru', attempts_count: 0, max_attempts: 5 }],
            bookingsById
        );

        const fastPromise = triggerManualBookingSmsOutboxFast({ bookingId: 20, supabaseClient: client });
        // Simulates the GitHub Actions recovery tick calling the very same
        // function directly, with its own worker token, at the same time.
        const recoveryPromise = processManualBookingSmsOutbox({ supabaseClient: client, workerToken: 'recovery-tick' });

        const [fastResult, recoveryResult] = await Promise.all([fastPromise, recoveryPromise]);
        const totalSent = (fastResult ? fastResult.sent : 0) + recoveryResult.sent;
        assert.equal(totalSent, 1, 'fast + recovery racing the same row must never both send it');
    });
});

describe('OSON SMS FAST TRIGGER — daily cap atomicity under concurrent fast triggers', () => {
    beforeEach(resetEnv);
    afterEach(resetEnv);

    it('[FT-I] two concurrent fast triggers on TWO DIFFERENT rows, DAILY_CAP=1, never both get an allowed send', async () => {
        enabledConfig({ OSON_SMS_FAST_TRIGGER_ENABLED: 'true', OSON_SMS_DAILY_CAP: '1' });
        const bookingsById = {
            30: { id: 30, status: 'confirmed', claim_status: 'unclaimed', phone: '992900000001', bus_ticket_id: 1 },
            31: { id: 31, status: 'confirmed', claim_status: 'unclaimed', phone: '992900000002', bus_ticket_id: 1 }
        };
        const client = makeSharedOutboxMock(
            [
                { outbox_id: 'row-C', booking_id: 30, idempotency_key: 'k30', locale: 'ru', attempts_count: 0, max_attempts: 5 },
                { outbox_id: 'row-D', booking_id: 31, idempotency_key: 'k31', locale: 'ru', attempts_count: 0, max_attempts: 5 }
            ],
            bookingsById,
            { capSharedState: { slotsLeft: 1 } }
        );

        const [r1, r2] = await Promise.all([
            triggerManualBookingSmsOutboxFast({ bookingId: 30, supabaseClient: client }),
            triggerManualBookingSmsOutboxFast({ bookingId: 31, supabaseClient: client })
        ]);

        const totalSent = (r1 ? r1.sent : 0) + (r2 ? r2.sent : 0);
        assert.equal(totalSent, 1, 'DAILY_CAP=1 must allow exactly one send across two concurrent fast triggers on two DIFFERENT rows');
        const sentUpdates = client.updates.filter(u => u.patch.status === 'sent');
        assert.equal(sentUpdates.length, 1);
        const retriedUpdates = client.updates.filter(u => u.patch.status === 'retry' && u.patch.last_error_code === 'DAILY_CAP_EXCEEDED');
        assert.equal(retriedUpdates.length, 1, 'the second row must be scheduled for retry, not silently dropped or sent anyway');
    });
});

describe('OSON SMS FAST TRIGGER — existing safety gates are never bypassed', () => {
    beforeEach(resetEnv);
    afterEach(resetEnv);

    it('[FT-J] OSON_SMS_ENABLED=false → fast trigger schedules the run, but the run itself is a kill-switch no-op (zero claims)', async () => {
        resetEnv();
        process.env.OSON_SMS_FAST_TRIGGER_ENABLED = 'true';
        // OSON_SMS_ENABLED intentionally left unset/false.
        let claimCalled = false;
        const client = { rpc: async () => { claimCalled = true; return { data: [], error: null }; } };
        const result = await triggerManualBookingSmsOutboxFast({ bookingId: 5, supabaseClient: client });
        assert.equal(result.killSwitchOff, true);
        assert.equal(claimCalled, false);
    });

    it('[FT-source] the fast trigger module never imports or calls sendServiceSms/OSON directly — it only ever calls the existing processManualBookingSmsOutbox', () => {
        const src = fs.readFileSync(path.join(__dirname, '../utils/manualBookingSmsOutboxService.js'), 'utf8');
        const fastFnStart = src.indexOf('function triggerManualBookingSmsOutboxFast');
        assert.ok(fastFnStart > -1, 'triggerManualBookingSmsOutboxFast must exist');
        const fastFnBody = src.slice(fastFnStart, src.indexOf('\nmodule.exports', fastFnStart));
        assert.ok(!/sendServiceSms|osonSmsClient|fetch\(/.test(fastFnBody), 'fast trigger must not contain its own send logic or call OSON directly — it only schedules the existing processor');
        assert.ok(/processManualBookingSmsOutbox\(/.test(fastFnBody), 'fast trigger must delegate to the existing processManualBookingSmsOutbox()');
    });
});

describe('OSON SMS FAST TRIGGER — regression: manual handoff channels untouched (source-level)', () => {
    it('[FT-M] the manual booking handoff endpoint (SMS button backend) still never imports the OSON SMS worker/outbox — the two channels remain independent', () => {
        const src = fs.readFileSync(path.join(__dirname, '../routes/busAdmin.js'), 'utf8');
        const handoffRouteStart = src.indexOf("router.post('/bookings/:bookingId/handoff'");
        assert.ok(handoffRouteStart > -1, 'handoff route must still exist');
        const nextRouteStart = src.indexOf('router.', handoffRouteStart + 10);
        const handoffRouteBody = src.slice(handoffRouteStart, nextRouteStart > -1 ? nextRouteStart : handoffRouteStart + 3000);
        assert.ok(!/manualBookingSmsOutboxService|osonSmsClient|manual_booking_sms_outbox/.test(handoffRouteBody), 'the manual /handoff route (used by the "Отправить по SMS" button) must remain fully independent of the automatic OSON SMS outbox pipeline');
    });

    it('[FT-N] the manual /bookings/manual enqueue block still gates on shouldEnqueueOsonSms before touching the outbox — fast trigger only extends this block, never replaces its eligibility check', () => {
        const src = fs.readFileSync(path.join(__dirname, '../routes/busAdmin.js'), 'utf8');
        const enqueueBlockIdx = src.indexOf("require('../utils/osonSmsRouting')");
        assert.ok(enqueueBlockIdx > -1);
        const nearby = src.slice(enqueueBlockIdx, enqueueBlockIdx + 1500);
        assert.ok(/shouldEnqueueOsonSms\(/.test(nearby), 'eligibility gate must still run before any outbox write');
        assert.ok(/triggerManualBookingSmsOutboxFast/.test(nearby), 'fast trigger call must be present within the same gated block, not bypassing it');
        assert.ok(/enqueueDecision\.enqueue/.test(nearby), 'fast trigger must remain inside the enqueueDecision.enqueue branch');
    });
});
