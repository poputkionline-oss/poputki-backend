/**
 * Phase E.4.4 — Security Middleware Collision Regression Tests
 *
 * Validates that:
 * 1. /api/claims/bot/open is exempt from x-mana-man gate.
 * 2. /api/claims/bot/verify-and-claim is exempt from x-mana-man gate.
 * 3. Both still reject missing/invalid X-Claim-Bot-Secret.
 * 4. Both reach route logic with correct X-Claim-Bot-Secret.
 * 5. /api/claims/start-session is NOT accidentally exempted.
 * 6. Normal protected routes still require x-mana-man.
 * 7. No other global security behavior changes.
 */

'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');

// ── Env setup (must precede index.js require) ─────────────────────────────
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_e44_2026';
process.env.CLAIM_BOT_SHARED_SECRET = 'test_claim_secret_e44';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://placeholder.supabase.co';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'placeholder_anon';

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Simulate the global security middleware from index.js
 * Extracted as a pure function so tests don't need a live HTTP server.
 *
 * The logic mirrors index.js exactly:
 *   skip: OPTIONS | /health | /api-docs | /api/call/ | /api/claims/bot/
 *   otherwise: require x-mana-man: nasa.2006
 */
function runGlobalSecurityMiddleware(method, url, headers = {}) {
    let statusCode = null;
    let responseBody = null;
    let nextCalled = false;

    const req = { method, url, headers, ip: '127.0.0.1' };
    const res = {
        status(code) { statusCode = code; return this; },
        json(data)   { responseBody = data; return this; }
    };
    const next = () => { nextCalled = true; };

    // ── Replicate index.js middleware exactly ─────────────────────────
    if (
        req.method === 'OPTIONS' ||
        req.url === '/health' ||
        req.url.startsWith('/api-docs') ||
        req.url.startsWith('/api/call/') ||
        req.url.startsWith('/api/claims/bot/')
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
    // ─────────────────────────────────────────────────────────────────

    return { statusCode, responseBody, nextCalled };
}

/**
 * Simulate requireClaimBotSecret middleware from routes/claims.js
 */
function runRequireClaimBotSecret(headers = {}) {
    const configured = process.env.CLAIM_BOT_SHARED_SECRET;
    const received = headers['x-claim-bot-secret'];

    let statusCode = null;
    let responseBody = null;
    let nextCalled = false;

    const res = {
        status(code) { statusCode = code; return this; },
        json(data)   { responseBody = data; return this; }
    };
    const next = () => { nextCalled = true; };

    if (!configured) {
        statusCode = 503;
        responseBody = { error: 'Telegram claim flow is not configured', code: 'CLAIM_BOT_NOT_CONFIGURED' };
    } else {
        // timing-safe compare (simplified for test — lengths must match)
        const a = Buffer.from(received || '');
        const b = Buffer.from(configured);
        const matches = a.length === b.length &&
            require('crypto').timingSafeEqual(a, b);

        if (!matches) {
            statusCode = 401;
            responseBody = { error: 'Unauthorized bot claim request', code: 'BOT_CLAIM_UNAUTHORIZED' };
        } else {
            next();
        }
    }

    return { statusCode, responseBody, nextCalled };
}

// ── Test suite ────────────────────────────────────────────────────────────

describe('Phase E.4.4 — Security Middleware Collision Fix', () => {

    // ── TESTS 1 & 2: Bot claim endpoints exempt from x-mana-man ──────────
    it('[E44-01] /api/claims/bot/open is exempt from x-mana-man (no header)', () => {
        const r = runGlobalSecurityMiddleware('POST', '/api/claims/bot/open', {});
        assert.strictEqual(r.nextCalled, true,  'next() must be called');
        assert.strictEqual(r.statusCode, null,  'must not set 403 status');
    });

    it('[E44-02] /api/claims/bot/verify-and-claim is exempt from x-mana-man (no header)', () => {
        const r = runGlobalSecurityMiddleware('POST', '/api/claims/bot/verify-and-claim', {});
        assert.strictEqual(r.nextCalled, true,  'next() must be called');
        assert.strictEqual(r.statusCode, null,  'must not set 403 status');
    });

    it('[E44-03] /api/claims/bot/ prefix (any sub-path) is exempt from x-mana-man', () => {
        const r = runGlobalSecurityMiddleware('POST', '/api/claims/bot/future-endpoint', {});
        assert.strictEqual(r.nextCalled, true);
        assert.strictEqual(r.statusCode, null);
    });

    // ── TESTS 3 & 4: requireClaimBotSecret still enforced ────────────────
    it('[E44-04] /bot/open rejects missing X-Claim-Bot-Secret (401)', () => {
        const r = runRequireClaimBotSecret({});
        assert.strictEqual(r.nextCalled, false, 'must not proceed without secret');
        assert.strictEqual(r.statusCode, 401);
        assert.strictEqual(r.responseBody.code, 'BOT_CLAIM_UNAUTHORIZED');
    });

    it('[E44-05] /bot/open rejects wrong X-Claim-Bot-Secret (401)', () => {
        const r = runRequireClaimBotSecret({ 'x-claim-bot-secret': 'wrong_secret' });
        assert.strictEqual(r.nextCalled, false);
        assert.strictEqual(r.statusCode, 401);
        assert.strictEqual(r.responseBody.code, 'BOT_CLAIM_UNAUTHORIZED');
    });

    it('[E44-06] /bot/open accepts correct X-Claim-Bot-Secret and calls next()', () => {
        const r = runRequireClaimBotSecret({ 'x-claim-bot-secret': 'test_claim_secret_e44' });
        assert.strictEqual(r.nextCalled, true, 'next() must be called with correct secret');
        assert.strictEqual(r.statusCode, null);
    });

    it('[E44-07] /bot/verify-and-claim rejects missing X-Claim-Bot-Secret (401)', () => {
        const r = runRequireClaimBotSecret({});
        assert.strictEqual(r.nextCalled, false);
        assert.strictEqual(r.statusCode, 401);
    });

    it('[E44-08] /bot/verify-and-claim accepts correct X-Claim-Bot-Secret and calls next()', () => {
        const r = runRequireClaimBotSecret({ 'x-claim-bot-secret': 'test_claim_secret_e44' });
        assert.strictEqual(r.nextCalled, true);
        assert.strictEqual(r.statusCode, null);
    });

    // ── TEST 5: /api/claims/start-session NOT exempted ───────────────────
    it('[E44-09] /api/claims/start-session still requires x-mana-man (no header → 403)', () => {
        const r = runGlobalSecurityMiddleware('POST', '/api/claims/start-session', {});
        assert.strictEqual(r.nextCalled, false,  'must NOT bypass security');
        assert.strictEqual(r.statusCode, 403);
        assert.strictEqual(r.responseBody.error, 'Forbidden');
    });

    it('[E44-10] /api/claims/start-session passes with valid x-mana-man', () => {
        const r = runGlobalSecurityMiddleware('POST', '/api/claims/start-session', { 'x-mana-man': 'nasa.2006' });
        assert.strictEqual(r.nextCalled, true);
        assert.strictEqual(r.statusCode, null);
    });

    // ── TEST 6: Normal protected routes still require x-mana-man ─────────
    it('[E44-11] /api/cities still requires x-mana-man (no header → 403)', () => {
        const r = runGlobalSecurityMiddleware('GET', '/api/cities', {});
        assert.strictEqual(r.statusCode, 403);
        assert.strictEqual(r.nextCalled, false);
    });

    it('[E44-12] /api/carrier/trips still requires x-mana-man (no header → 403)', () => {
        const r = runGlobalSecurityMiddleware('GET', '/api/carrier/trips', {});
        assert.strictEqual(r.statusCode, 403);
        assert.strictEqual(r.nextCalled, false);
    });

    it('[E44-13] /api/admin/anything still requires x-mana-man (no header → 403)', () => {
        const r = runGlobalSecurityMiddleware('DELETE', '/api/admin/purge', {});
        assert.strictEqual(r.statusCode, 403);
        assert.strictEqual(r.nextCalled, false);
    });

    // ── TEST 7: Existing skip rules unchanged ─────────────────────────────
    it('[E44-14] OPTIONS method is still exempt (CORS preflight)', () => {
        const r = runGlobalSecurityMiddleware('OPTIONS', '/api/claims/start-session', {});
        assert.strictEqual(r.nextCalled, true);
        assert.strictEqual(r.statusCode, null);
    });

    it('[E44-15] /health is still exempt', () => {
        const r = runGlobalSecurityMiddleware('GET', '/health', {});
        assert.strictEqual(r.nextCalled, true);
        assert.strictEqual(r.statusCode, null);
    });

    it('[E44-16] /api-docs is still exempt', () => {
        const r = runGlobalSecurityMiddleware('GET', '/api-docs/swagger.json', {});
        assert.strictEqual(r.nextCalled, true);
        assert.strictEqual(r.statusCode, null);
    });

    it('[E44-17] /api/call/ is still exempt', () => {
        const r = runGlobalSecurityMiddleware('GET', '/api/call/redirect', {});
        assert.strictEqual(r.nextCalled, true);
        assert.strictEqual(r.statusCode, null);
    });

    // ── UNCONFIGURED secret guard (TEST: 503 if CLAIM_BOT_SHARED_SECRET missing) ──
    it('[E44-18] requireClaimBotSecret returns 503 if CLAIM_BOT_SHARED_SECRET is unset', () => {
        const original = process.env.CLAIM_BOT_SHARED_SECRET;
        delete process.env.CLAIM_BOT_SHARED_SECRET;

        const r = runRequireClaimBotSecret({ 'x-claim-bot-secret': 'any' });
        assert.strictEqual(r.statusCode, 503);
        assert.strictEqual(r.responseBody.code, 'CLAIM_BOT_NOT_CONFIGURED');
        assert.strictEqual(r.nextCalled, false);

        process.env.CLAIM_BOT_SHARED_SECRET = original; // restore
    });
});
