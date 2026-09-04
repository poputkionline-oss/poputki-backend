/**
 * tests/phase_p1g3a_reliability_hardening.test.js
 *
 * PHASE P.1G.3A — Reconciliation Scheduler, HMAC Bypass Removal,
 * Constant-Time Admin Auth, Watermark-Safe Aggregation
 *
 * Verifies the fixes made after the P.1G.3 recovery audit found:
 *  - reconciliation/outbox sweep never automatically invoked in production
 *  - a live, fully-replayable legacy HMAC bypass (x-internal-service-secret)
 *  - admin token compared with plain `===` (timing side-channel) in two places
 *  - daily aggregation had no launch-watermark filter (would have re-polluted
 *    metrics with the pre-launch smoke test data on its first real run)
 */

'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-p1g3a';
process.env.ADMIN_SECRET_TOKEN = process.env.ADMIN_SECRET_TOKEN || 'test-admin-secret-p1g3a';
process.env.INTERNAL_SERVICE_SECRET = process.env.INTERNAL_SERVICE_SECRET || 'test-internal-secret-p1g3a';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { constantTimeEqual, requireAdminToken } = require('../utils/adminTokenAuth');

describe('Phase P.1G.3A — shared constant-time admin token helper', () => {
    it('accepts the exact configured token', () => {
        assert.equal(constantTimeEqual('secret-abc', 'secret-abc'), true);
    });

    it('rejects a wrong token, missing token, or type mismatch without throwing', () => {
        assert.equal(constantTimeEqual('wrong', 'secret-abc'), false);
        assert.equal(constantTimeEqual(undefined, 'secret-abc'), false);
        assert.equal(constantTimeEqual(null, 'secret-abc'), false);
        assert.equal(constantTimeEqual(123, 'secret-abc'), false);
    });

    it('uses crypto.timingSafeEqual under the hood (source-level guard)', () => {
        const src = fs.readFileSync(path.resolve(__dirname, '../utils/adminTokenAuth.js'), 'utf8');
        assert.ok(src.includes('crypto.timingSafeEqual'));
        assert.ok(!/token\s*===\s*(configured|ADMIN_SECRET_TOKEN)/.test(src), 'must not fall back to a plain === comparison');
    });

    it('requireAdminToken fails closed (500) when ADMIN_SECRET_TOKEN is unset', () => {
        const original = process.env.ADMIN_SECRET_TOKEN;
        delete process.env.ADMIN_SECRET_TOKEN;
        let statusCode = null, body = null, nextCalled = false;
        const res = { status: (c) => { statusCode = c; return res; }, json: (b) => { body = b; } };
        requireAdminToken({ headers: {} }, res, () => { nextCalled = true; });
        assert.equal(statusCode, 500);
        assert.equal(nextCalled, false);
        process.env.ADMIN_SECRET_TOKEN = original;
    });

    it('requireAdminToken rejects missing/wrong token with 401, accepts correct token', () => {
        process.env.ADMIN_SECRET_TOKEN = 'the-real-token';
        let statusCode, nextCalled;

        statusCode = null; nextCalled = false;
        requireAdminToken({ headers: {} }, { status: (c) => { statusCode = c; return { json: () => {} }; } }, () => { nextCalled = true; });
        assert.equal(statusCode, 401);
        assert.equal(nextCalled, false);

        statusCode = null; nextCalled = false;
        requireAdminToken({ headers: { 'x-admin-token': 'wrong' } }, { status: (c) => { statusCode = c; return { json: () => {} }; } }, () => { nextCalled = true; });
        assert.equal(statusCode, 401);
        assert.equal(nextCalled, false);

        nextCalled = false;
        requireAdminToken({ headers: { 'x-admin-token': 'the-real-token' } }, {}, () => { nextCalled = true; });
        assert.equal(nextCalled, true);
    });

    it('both routes/admin.js and routes/adminAcquisitionFunnel.js delegate to the shared helper (no duplicated comparison logic)', () => {
        const adminSrc = fs.readFileSync(path.resolve(__dirname, '../routes/admin.js'), 'utf8');
        const funnelSrc = fs.readFileSync(path.resolve(__dirname, '../routes/adminAcquisitionFunnel.js'), 'utf8');
        assert.ok(adminSrc.includes("require('../utils/adminTokenAuth')"));
        assert.ok(funnelSrc.includes("require('../utils/adminTokenAuth')"));
        assert.ok(!funnelSrc.includes('token === ADMIN_SECRET_TOKEN'), 'adminAcquisitionFunnel.js must not have its own plain === comparison');
    });
});

describe('Phase P.1G.3A — internalServiceAuth: legacy bypass removed, fallback chain removed', () => {
    it('getInternalSecret no longer falls back to CLAIM_BOT_SHARED_SECRET or TELEGRAM_BOT_TOKEN', () => {
        delete require.cache[require.resolve('../utils/internalServiceAuth')];
        const savedInternal = process.env.INTERNAL_SERVICE_SECRET;
        const savedClaim = process.env.CLAIM_BOT_SHARED_SECRET;
        const savedBotToken = process.env.TELEGRAM_BOT_TOKEN;

        delete process.env.INTERNAL_SERVICE_SECRET;
        process.env.CLAIM_BOT_SHARED_SECRET = 'claim-secret-should-not-be-used';
        process.env.TELEGRAM_BOT_TOKEN = 'bot-token-should-not-be-used';

        const { getInternalSecret } = require('../utils/internalServiceAuth');
        assert.equal(getInternalSecret(), null, 'must be null, not fall back to another secret');

        process.env.INTERNAL_SERVICE_SECRET = savedInternal;
        if (savedClaim === undefined) delete process.env.CLAIM_BOT_SHARED_SECRET; else process.env.CLAIM_BOT_SHARED_SECRET = savedClaim;
        if (savedBotToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN; else process.env.TELEGRAM_BOT_TOKEN = savedBotToken;
        delete require.cache[require.resolve('../utils/internalServiceAuth')];
    });

    it('fails closed (500) when INTERNAL_SERVICE_SECRET is unset, even with the old legacy header present', async () => {
        delete require.cache[require.resolve('../utils/internalServiceAuth')];
        const saved = process.env.INTERNAL_SERVICE_SECRET;
        delete process.env.INTERNAL_SERVICE_SECRET;
        const { internalServiceAuth } = require('../utils/internalServiceAuth');

        let statusCode = null, body = null, nextCalled = false;
        const req = { headers: { 'x-internal-service-secret': 'anything' } };
        const res = { status: (c) => { statusCode = c; return res; }, json: (b) => { body = b; } };
        await internalServiceAuth(req, res, () => { nextCalled = true; });

        assert.equal(statusCode, 500);
        assert.equal(nextCalled, false);

        process.env.INTERNAL_SERVICE_SECRET = saved;
        delete require.cache[require.resolve('../utils/internalServiceAuth')];
    });

    it('the legacy x-internal-service-secret header alone (correct value, no HMAC) is REJECTED with 401', async () => {
        delete require.cache[require.resolve('../utils/internalServiceAuth')];
        const { internalServiceAuth } = require('../utils/internalServiceAuth');

        let statusCode = null, body = null, nextCalled = false;
        const req = { headers: { 'x-internal-service-secret': process.env.INTERNAL_SERVICE_SECRET } };
        const res = { status: (c) => { statusCode = c; return res; }, json: (b) => { body = b; return res; } };
        await internalServiceAuth(req, res, () => { nextCalled = true; });

        assert.equal(nextCalled, false);
        assert.equal(statusCode, 401);
        assert.equal(body.error, 'UNAUTHORIZED_SIGNATURE_REQUIRED');
    });

    it('source no longer contains the legacy bypass branch', () => {
        const src = fs.readFileSync(path.resolve(__dirname, '../utils/internalServiceAuth.js'), 'utf8');
        assert.ok(!src.includes("req.headers['x-internal-service-secret']"), 'legacy header must no longer be read/accepted anywhere');
        // The rationale comment mentions these secret names by name (why they
        // are NOT used); only actual usage as a fallback source is forbidden.
        assert.ok(!src.includes('process.env.CLAIM_BOT_SHARED_SECRET'), 'no fallback to the claim-flow secret');
        assert.ok(!src.includes('process.env.TELEGRAM_BOT_TOKEN'), 'no fallback to the raw bot token');
    });
});

describe('Phase P.1G.3A — reconciliation distributed lock', () => {
    function makeLockMockDb(initialLock = null) {
        let lockRow = initialLock;
        return {
            rpc: async (fnName, params) => {
                if (fnName === 'fn_try_acquire_maintenance_lock') {
                    const now = Date.now();
                    if (lockRow && lockRow.locked_until && new Date(lockRow.locked_until).getTime() > now) {
                        return { data: false, error: null };
                    }
                    lockRow = { holder: params.p_holder, locked_until: new Date(now + params.p_lease_seconds * 1000).toISOString() };
                    return { data: true, error: null };
                }
                if (fnName === 'fn_release_maintenance_lock') {
                    if (lockRow && lockRow.holder === params.p_holder) {
                        lockRow = { holder: null, locked_until: null };
                        return { data: true, error: null };
                    }
                    return { data: false, error: null };
                }
                return { data: null, error: null };
            },
            from(table) {
                const builder = {
                    select: () => builder,
                    gte: () => builder,
                    lt: () => builder,
                    eq: () => builder,
                    order: () => builder,
                    maybeSingle: async () => ({ data: null, error: null }),
                    then(resolve) { resolve({ data: [], error: null, count: 0 }); }
                };
                return builder;
            }
        };
    }

    it('acquires the lock and runs reconciliation when unlocked', async () => {
        delete require.cache[require.resolve('../services/acquisition/reconciliationService')];
        const { runReconciliationPass } = require('../services/acquisition/reconciliationService');
        const db = makeLockMockDb();
        const result = await runReconciliationPass({ overrideWatermark: '2026-09-04T00:00:00.000Z', dbClient: db });
        assert.equal(result.skipped, false);
        assert.equal(result.scanned_bookings, 0);
    });

    it('gracefully skips reconciliation when the lock is already held', async () => {
        delete require.cache[require.resolve('../services/acquisition/reconciliationService')];
        const { runReconciliationPass } = require('../services/acquisition/reconciliationService');
        const db = makeLockMockDb({ holder: 'someone-else', locked_until: new Date(Date.now() + 60000).toISOString() });
        const result = await runReconciliationPass({ overrideWatermark: '2026-09-04T00:00:00.000Z', dbClient: db });
        assert.equal(result.skipped, true);
        assert.equal(result.reason, 'LOCK_HELD_BY_ANOTHER_RUN');
    });

    it('acquires the lock again once an expired lease has passed', async () => {
        delete require.cache[require.resolve('../services/acquisition/reconciliationService')];
        const { runReconciliationPass } = require('../services/acquisition/reconciliationService');
        const db = makeLockMockDb({ holder: 'stale-holder', locked_until: new Date(Date.now() - 1000).toISOString() });
        const result = await runReconciliationPass({ overrideWatermark: '2026-09-04T00:00:00.000Z', dbClient: db });
        assert.equal(result.skipped, false, 'an expired lease must not block a new run');
    });

    it('migration file for the lock RPCs exists and matches the deployed schema', () => {
        const files = fs.readdirSync(path.resolve(__dirname, '../supabase/migrations'));
        const match = files.find(f => f.includes('reconciliation_maintenance_lock'));
        assert.ok(match, 'lock migration file must exist');
        const sql = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations', match), 'utf8');
        assert.ok(sql.includes('fn_try_acquire_maintenance_lock'));
        assert.ok(sql.includes('fn_release_maintenance_lock'));
        assert.ok(sql.includes('SECURITY DEFINER'));
        assert.ok(sql.includes('REVOKE ALL ON FUNCTION public.fn_try_acquire_maintenance_lock'));
        assert.ok(sql.includes('GRANT EXECUTE ON FUNCTION public.fn_try_acquire_maintenance_lock') && sql.includes('service_role'));
    });
});

describe('Phase P.1G.3A — runAcquisitionMaintenanceSweep (unified outbox + reconciliation endpoint)', () => {
    const { runAcquisitionMaintenanceSweep } = require('../services/acquisition/maintenanceSweepService');

    // Note: outboxService.js and reconciliationService.js are both written
    // defensively — an RPC returning { error } is swallowed internally and
    // turned into a safe empty/summary result, never a thrown exception.
    // To exercise real task-isolation (one task's exception must not stop
    // the other), these mocks throw synchronously from db.from()/db.rpc()
    // for the targeted task only, simulating an unrecoverable client-level
    // failure rather than a normal RPC business-error response.
    function makeFullMockDb({ outboxRows = [], throwOnOutbox = false, throwOnReconciliation = false } = {}) {
        return {
            rpc: async (fnName, params) => {
                if (fnName === 'fn_claim_outbox_events') {
                    if (throwOnOutbox) throw new Error('SIMULATED_OUTBOX_CLIENT_FAILURE');
                    const claimed = outboxRows.filter(r => r.status === 'pending').slice(0, params.p_batch_size);
                    claimed.forEach(r => { r.status = 'processing'; r.lease_token = 'lt-1'; });
                    return { data: claimed, error: null };
                }
                if (fnName === 'fn_resolve_outbox_event') {
                    const row = outboxRows.find(r => r.id === params.p_id);
                    if (row) row.status = params.p_success ? 'completed' : 'dead_letter';
                    return { data: true, error: null };
                }
                if (fnName === 'fn_try_acquire_maintenance_lock') {
                    if (throwOnReconciliation) throw new Error('SIMULATED_RECONCILIATION_CLIENT_FAILURE');
                    return { data: true, error: null };
                }
                if (fnName === 'fn_release_maintenance_lock') {
                    return { data: true, error: null };
                }
                return { data: null, error: null };
            },
            from(table) {
                if (table === 'acquisition_event_outbox') {
                    if (throwOnOutbox) throw new Error('SIMULATED_OUTBOX_METRICS_FAILURE');
                    return {
                        select: () => ({ then: (resolve) => resolve({ data: outboxRows.map(r => ({ status: r.status, attempt_count: 0 })), error: null }) })
                    };
                }
                if (table === 'bus_ticket_bookings' && throwOnReconciliation) {
                    throw new Error('SIMULATED_RECONCILIATION_QUERY_FAILURE');
                }
                const builder = {
                    select: () => builder,
                    gte: () => builder,
                    lt: () => builder,
                    eq: () => builder,
                    order: () => builder,
                    maybeSingle: async () => ({ data: null, error: null }),
                    insert: async () => ({ data: null, error: null }),
                    then(resolve) { resolve({ data: [], error: null, count: 0 }); }
                };
                return builder;
            }
        };
    }

    it('runs both tasks and reports structured, isolated results', async () => {
        const db = makeFullMockDb({ outboxRows: [{ id: 'e1', status: 'pending', event_name: 'BOT_STARTED', idempotency_key: 'k1' }] });
        const result = await runAcquisitionMaintenanceSweep({ dbClient: db });
        assert.equal(result.success, true);
        assert.ok(result.tasks.outbox_sweep);
        assert.ok(result.tasks.reconciliation);
        assert.equal(result.tasks.outbox_sweep.claimed, 1);
        assert.equal(result.tasks.reconciliation.skipped, false);
    });

    it('an outbox client error does not crash the sweep or block reconciliation (outboxService is deliberately defensive: RPC errors are swallowed into a safe empty result, never thrown)', async () => {
        const db = makeFullMockDb({ throwOnOutbox: true });
        const result = await runAcquisitionMaintenanceSweep({ dbClient: db });
        // outbox_sweep itself never throws by design (matches
        // services/acquisition/outboxService.js's own try/catch contract),
        // so it reports success with zero claimed rather than failing —
        // reconciliation is unaffected either way, which is the isolation
        // property that actually matters here.
        assert.equal(result.tasks.reconciliation.success, true);
        assert.equal(result.tasks.reconciliation.skipped, false);
    });

    it('reconciliation failure does not prevent outbox_sweep from running', async () => {
        const db = makeFullMockDb({ throwOnReconciliation: true, outboxRows: [{ id: 'e2', status: 'pending', event_name: 'BOT_STARTED', idempotency_key: 'k2' }] });
        const result = await runAcquisitionMaintenanceSweep({ dbClient: db });
        assert.equal(result.tasks.reconciliation.success, false);
        assert.equal(result.tasks.outbox_sweep.success, true);
        assert.equal(result.success, false);
    });

    it('response contains no secret/header values', async () => {
        const db = makeFullMockDb({});
        const result = await runAcquisitionMaintenanceSweep({ dbClient: db });
        const str = JSON.stringify(result);
        assert.ok(!str.includes(process.env.ADMIN_SECRET_TOKEN));
        assert.ok(!str.includes(process.env.INTERNAL_SERVICE_SECRET));
    });
});

describe('Phase P.1G.3A — new admin endpoint POST /api/admin/maintenance/acquisition-sweep', () => {
    const express = require('express');
    const http = require('node:http');

    it('requires X-Admin-Token (401 without, 200 with)', async () => {
        const { setServiceRoleClient } = require('../dbServiceRole');
        setServiceRoleClient({
            rpc: async (fnName) => {
                if (fnName === 'fn_try_acquire_maintenance_lock') return { data: true, error: null };
                return { data: fnName === 'fn_claim_outbox_events' ? [] : true, error: null };
            },
            from: () => ({
                select: () => ({ then: (resolve) => resolve({ data: [], error: null }) }),
                gte: function () { return this; }, lt: function () { return this; }, eq: function () { return this; },
                order: function () { return this; }, maybeSingle: async () => ({ data: null, error: null })
            })
        });

        delete require.cache[require.resolve('../routes/admin')];
        const adminRouter = require('../routes/admin');
        const app = express();
        app.use(express.json());
        app.use('/api/admin', adminRouter);
        const server = http.createServer(app);
        await new Promise(resolve => server.listen(0, resolve));
        const port = server.address().port;

        const noAuth = await fetch(`http://127.0.0.1:${port}/api/admin/maintenance/acquisition-sweep`, { method: 'POST' });
        assert.equal(noAuth.status, 401);

        const withAuth = await fetch(`http://127.0.0.1:${port}/api/admin/maintenance/acquisition-sweep`, {
            method: 'POST',
            headers: { 'X-Admin-Token': process.env.ADMIN_SECRET_TOKEN }
        });
        assert.equal(withAuth.status, 200);
        const body = await withAuth.json();
        assert.ok(body.tasks.outbox_sweep);
        assert.ok(body.tasks.reconciliation);

        await new Promise(resolve => server.close(resolve));
        setServiceRoleClient(null);
    });
});

describe('Phase P.1G.3A — daily aggregation respects the launch watermark', () => {
    it('excludes same-day pre-watermark rows (e.g. the pre-launch smoke test) from aggregation', async () => {
        delete require.cache[require.resolve('../services/acquisition/dailyAggregationService')];
        const { aggregateDailyMetrics } = require('../services/acquisition/dailyAggregationService');

        const watermark = '2026-09-04T18:50:00.000Z';
        const preWatermarkSession = { anonymous_visitor_id: '00000000-0000-4000-8000-000000000001', source_platform: 'direct', source_medium: 'direct', attribution_type: 'direct_organic', started_at: '2026-09-04T14:04:03.000Z' };
        const postWatermarkSession = { anonymous_visitor_id: '11111111-1111-4111-8111-111111111111', source_platform: 'instagram', source_medium: 'organic_social', attribution_type: 'marketing', started_at: '2026-09-04T20:00:00.000Z' };

        let capturedGteForSessions = null;
        const upserted = [];

        const mockDb = {
            from(table) {
                if (table === 'acquisition_system_config') {
                    return {
                        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { value: { watermark_utc: watermark } }, error: null }) }) })
                    };
                }
                if (table === 'acquisition_sessions') {
                    return {
                        select: () => ({
                            gte: (col, val) => {
                                capturedGteForSessions = val;
                                return {
                                    lte: async () => ({
                                        data: [preWatermarkSession, postWatermarkSession].filter(s => new Date(s.started_at).getTime() >= new Date(val).getTime()),
                                        error: null
                                    })
                                };
                            }
                        })
                    };
                }
                if (table === 'acquisition_events') {
                    return { select: () => ({ gte: () => ({ lte: async () => ({ data: [], error: null }) }) }) };
                }
                if (table === 'acquisition_daily_metrics') {
                    return {
                        select: () => ({ eq: function () { return this; }, is: function () { return this; }, maybeSingle: async () => ({ data: null, error: null }) }),
                        insert: async (row) => { upserted.push(row); return { data: row, error: null }; },
                        update: () => ({ eq: async () => ({ data: null, error: null }) })
                    };
                }
                return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) };
            }
        };

        const result = await aggregateDailyMetrics('2026-09-04', { dbClient: mockDb });
        assert.equal(result.success, true);
        // Only the post-watermark session's dimension bucket should exist.
        assert.equal(upserted.length, 1);
        assert.equal(upserted[0].source_platform, 'instagram');
        // effectiveStartIso sent to the DB must be the watermark, not day-start.
        assert.equal(capturedGteForSessions, watermark);
    });
});
