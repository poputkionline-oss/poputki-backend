/**
 * tests/phase_e47_8_1_maintenance_auth_hardening.test.js
 *
 * PHASE E.47.8.1 — Maintenance Auth Hardening / Remove Public Header Dependency
 *
 * x-mana-man is NOT confidential (its value ships in the public frontend
 * bundle, the Flutter mobile binary, and the server-side bot), so it must
 * never be treated as a meaningful authorization boundary. This suite
 * verifies that POST /api/admin/maintenance/tick no longer depends on it —
 * its real, server-side-only authorization is X-Admin-Token /
 * ADMIN_SECRET_TOKEN (adminAuth) — while every other route's existing
 * x-mana-man requirement is completely untouched.
 *
 * Two layers of verification, matching the convention established in
 * tests/phase_e44_bot_claim_middleware.test.js:
 *  1. A hand-mirrored replica of index.js's global security middleware
 *     (pure function, no live server needed).
 *  2. A static source-inspection check on the real index.js, guarding
 *     against the mirror drifting from reality and directly confirming the
 *     exemption is scoped to exactly this one POST route, not /api/admin/*.
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
    isTripEligibleForAutoComplete,
    isPostWatermarkTrip,
    AUTO_COMPLETE_WATERMARK_AT,
    AUTO_COMPLETE_GRACE_MS
} = require('../utils/tripCompletionHelper');
const { generateTicketVerificationToken } = require('../utils/ticketHelper');
const { evaluateAutoClaimEligibility } = require('../utils/claimHelper');
const { runMaintenanceTick } = require('../utils/maintenanceHelper');

// ---------------------------------------------------------------------------
// Mirror of index.js's global security middleware, updated for E.47.8.1.
// req.path (query-string-free) vs req.url (may carry ?dry_run=true) are
// modeled separately, exactly as Express provides them.
// ---------------------------------------------------------------------------
function runGlobalSecurityMiddleware(method, reqPath, headers = {}, fullUrl = null) {
    const req = { method, path: reqPath, url: fullUrl || reqPath, headers };
    let statusCode = null;
    let responseBody = null;
    let nextCalled = false;
    const next = () => { nextCalled = true; };

    if (
        req.method === 'OPTIONS' ||
        req.url === '/health' ||
        req.url.startsWith('/api-docs') ||
        req.url.startsWith('/api/call/') ||
        req.url.startsWith('/api/claims/bot/') ||
        (req.method === 'POST' && req.path === '/api/admin/maintenance/tick')
    ) {
        next();
    } else {
        const clientHeader = req.headers['x-mana-man'];
        if (clientHeader !== 'nasa.2006') {
            statusCode = 403;
            responseBody = { error: 'Forbidden' };
        } else {
            next();
        }
    }

    return { statusCode, responseBody, nextCalled };
}

// Mirror of routes/admin.js's adminAuth
function runAdminAuth(headers = {}, configuredToken = 'test-admin-secret') {
    const token = headers['x-admin-token'];
    return token === configuredToken;
}

// Full pipeline a real request to POST /api/admin/maintenance/tick goes
// through: global security middleware, then adminAuth.
function runMaintenanceTickAuthPipeline(headers = {}) {
    const security = runGlobalSecurityMiddleware('POST', '/api/admin/maintenance/tick', headers, '/api/admin/maintenance/tick?dry_run=true');
    if (!security.nextCalled) {
        return { blocked: true, blockedBy: 'x-mana-man', statusCode: security.statusCode };
    }
    if (!runAdminAuth(headers)) {
        return { blocked: true, blockedBy: 'admin-auth', statusCode: 401 };
    }
    return { blocked: false, statusCode: 200 };
}

describe('Phase E.47.8.1 — maintenance/tick no longer requires x-mana-man', () => {
    it('A. no x-mana-man, no admin token -> blocked', () => {
        const r = runMaintenanceTickAuthPipeline({});
        assert.strictEqual(r.blocked, true);
        assert.strictEqual(r.blockedBy, 'admin-auth', 'must be blocked by the real auth boundary, not the public header');
    });

    it('B. no x-mana-man, wrong admin token -> blocked', () => {
        const r = runMaintenanceTickAuthPipeline({ 'x-admin-token': 'wrong-token' });
        assert.strictEqual(r.blocked, true);
        assert.strictEqual(r.blockedBy, 'admin-auth');
    });

    it('C. no x-mana-man, valid admin token -> allowed (reaches handler)', () => {
        const r = runMaintenanceTickAuthPipeline({ 'x-admin-token': 'test-admin-secret' });
        assert.strictEqual(r.blocked, false);
    });

    it('D. x-mana-man alone (any value), no admin token -> blocked', () => {
        // Deliberately NOT the real value — proves it's irrelevant to this
        // route now: the global middleware skips the header check entirely
        // for POST /api/admin/maintenance/tick before ever inspecting it.
        const r = runMaintenanceTickAuthPipeline({ 'x-mana-man': 'placeholder-not-the-real-value' });
        assert.strictEqual(r.blocked, true);
        assert.strictEqual(r.blockedBy, 'admin-auth');
    });

    it('E. unrelated protected endpoint without x-mana-man -> still blocked by the global middleware', () => {
        const r1 = runGlobalSecurityMiddleware('POST', '/api/admin/bookings/expire-pending', {}, '/api/admin/bookings/expire-pending');
        assert.strictEqual(r1.nextCalled, false);
        assert.strictEqual(r1.statusCode, 403);

        const r2 = runGlobalSecurityMiddleware('POST', '/api/admin/trips/auto-complete', {}, '/api/admin/trips/auto-complete');
        assert.strictEqual(r2.nextCalled, false);
        assert.strictEqual(r2.statusCode, 403);

        const r3 = runGlobalSecurityMiddleware('GET', '/api/cities', {}, '/api/cities');
        assert.strictEqual(r3.nextCalled, false);
        assert.strictEqual(r3.statusCode, 403);

        const r4 = runGlobalSecurityMiddleware('DELETE', '/api/admin/purge', {}, '/api/admin/purge');
        assert.strictEqual(r4.nextCalled, false, '/api/admin/* is NOT globally exempted, only the exact maintenance/tick POST route');
        assert.strictEqual(r4.statusCode, 403);
    });

    it('F. existing /health exemption unchanged', () => {
        const r = runGlobalSecurityMiddleware('GET', '/health', {}, '/health');
        assert.strictEqual(r.nextCalled, true);
        assert.strictEqual(r.statusCode, null);
    });

    it('G. existing OPTIONS behavior unchanged', () => {
        const r = runGlobalSecurityMiddleware('OPTIONS', '/api/admin/maintenance/tick', {}, '/api/admin/maintenance/tick');
        assert.strictEqual(r.nextCalled, true);
        assert.strictEqual(r.statusCode, null);
    });

    it('GET to the maintenance/tick path is NOT exempted (only POST is)', () => {
        const r = runGlobalSecurityMiddleware('GET', '/api/admin/maintenance/tick', {}, '/api/admin/maintenance/tick');
        assert.strictEqual(r.nextCalled, false, 'GET must still require x-mana-man like any other route — only POST is carved out');
        assert.strictEqual(r.statusCode, 403);
    });

    it('the ?dry_run=true query string does not defeat the exact-path exemption match', () => {
        const r = runGlobalSecurityMiddleware('POST', '/api/admin/maintenance/tick', { 'x-admin-token': 'test-admin-secret' }, '/api/admin/maintenance/tick?dry_run=true');
        assert.strictEqual(r.nextCalled, true);
    });
});

describe('Phase E.47.8.1 — source parity: real index.js matches the mirror, exemption is narrow', () => {
    const indexPath = path.resolve(__dirname, '../index.js');
    const source = fs.readFileSync(indexPath, 'utf8');

    it('index.js contains the exact narrow POST + path exemption', () => {
        assert.ok(
            source.includes("req.method === 'POST' && req.path === '/api/admin/maintenance/tick'"),
            'the exemption must be scoped to exactly this method+path, not a prefix'
        );
    });

    it('index.js does NOT exempt /api/admin/* broadly', () => {
        assert.ok(!source.includes("req.url.startsWith('/api/admin')"), 'no broad /api/admin prefix exemption must exist');
        assert.ok(!source.includes("req.path.startsWith('/api/admin')"), 'no broad /api/admin prefix exemption must exist');
    });

    it('the maintenance/tick route documents that x-mana-man is not a security boundary here', () => {
        const adminRoutesPath = path.resolve(__dirname, '../routes/admin.js');
        const adminSource = fs.readFileSync(adminRoutesPath, 'utf8');
        assert.ok(adminSource.includes('exempt from the global\n * x-mana-man check'));
        assert.ok(adminSource.includes("router.post('/maintenance/tick', adminAuth,"), 'adminAuth must still gate the route');
    });
});

describe('Phase E.47.8.1 — cross-cutting regressions unaffected', () => {
    it('H. maintenance dry_run is still provably mutation-free (unrelated to the auth change)', async () => {
        const trip = { id: 1, operator_id: 1, status: 'active', created_at: '2026-09-01T00:00:00.000Z', arrival_date: '2020-01-01', arrival_time: '00:00:00' };
        const mockDb = {
            from(table) {
                const builder = {
                    select: () => builder,
                    eq: () => builder,
                    then(resolve) {
                        if (table === 'bus_tickets') return resolve({ data: [trip], error: null });
                        return resolve({ data: [], error: null });
                    }
                };
                return builder;
            }
        };
        const result = await runMaintenanceTick({ dryRun: true, dbClient: mockDb });
        assert.strictEqual(result.tasks.auto_complete.dry_run, true);
        assert.strictEqual(trip.status, 'active', 'dry_run must never mutate');
    });

    it('I. watermark unchanged', () => {
        assert.strictEqual(AUTO_COMPLETE_WATERMARK_AT.toISOString(), '2026-08-15T00:00:00.000Z');
        assert.strictEqual(isPostWatermarkTrip({ created_at: '2026-08-06T17:31:56.000Z' }), false);
        assert.strictEqual(isPostWatermarkTrip({ created_at: '2026-08-29T10:20:00.000Z' }), true);
    });

    it('J. arrival + 12h grace unchanged', () => {
        assert.strictEqual(AUTO_COMPLETE_GRACE_MS, 12 * 60 * 60 * 1000);
        const trip = { status: 'active', created_at: '2026-09-01T00:00:00.000Z', arrival_date: '2026-09-01', arrival_time: '13:00:00' };
        const arrival = new Date('2026-09-01T08:00:00.000Z'); // 13:00 Asia/Dushanbe (UTC+5) -> 08:00 UTC
        const justBefore = new Date(arrival.getTime() + 12 * 3600 * 1000 - 1000);
        const justAfter = new Date(arrival.getTime() + 12 * 3600 * 1000 + 1000);
        assert.strictEqual(isTripEligibleForAutoComplete(trip, justBefore), false);
        assert.strictEqual(isTripEligibleForAutoComplete(trip, justAfter), true);
    });

    it('K. atomic RPC completion path unchanged (structural)', () => {
        const helperSource = fs.readFileSync(path.resolve(__dirname, '../utils/tripCompletionHelper.js'), 'utf8');
        assert.ok(helperSource.includes("db.rpc('fn_complete_bus_trip'"));
    });

    it('L. E45 unified verified-phone auto-claim unchanged', () => {
        const verifiedUser = { id: 1121, telegram_id: '99887766', phone: '+992900000000', name: 'Test Passenger' };
        const familyGroupBooking = {
            id: 504, status: 'confirmed', claim_status: null, claimed_by_user_id: null,
            phone: '+992900000000', contact_role: 'family_or_group'
        };
        const res = evaluateAutoClaimEligibility(familyGroupBooking, verifiedUser, {}, '99887766');
        assert.strictEqual(res.canAutoClaim, true);
        assert.strictEqual(res.method, 'known_user_phone_match');
    });

    it('M. QR scanner / Ticket V1.1 verification token derivation unchanged', () => {
        const a = generateTicketVerificationToken(72001);
        const b = generateTicketVerificationToken(72001);
        assert.strictEqual(a, b);
    });
});
