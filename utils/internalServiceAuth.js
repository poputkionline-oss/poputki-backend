/**
 * utils/internalServiceAuth.js
 *
 * Phase P.1G.3: Internal Service-to-Service Authentication & Persistent Replay Protection
 *
 * Enforces HMAC-SHA256 request signatures for bot -> backend communication.
 * Protects against replay attacks using timestamp freshness (5 min window)
 * and PERSISTENT cryptographic nonces stored in PostgreSQL public.internal_service_nonces.
 * Survives Render process restarts and synchronizes across multiple instances. Fails closed.
 */

'use strict';

const crypto = require('crypto');
const { getServiceRoleClient } = require('../dbServiceRole');

const REPLAY_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const memoryNonceCache = new Map(); // Fast L1 cache

/**
 * Returns the configured internal service secret.
 *
 * Phase P.1G.3A: this is now the ONLY source — no silent fallback to
 * CLAIM_BOT_SHARED_SECRET or TELEGRAM_BOT_TOKEN. Those are separate secrets
 * for separate concerns (the pre-existing ticket-claim flow's
 * X-Claim-Bot-Secret header, and the raw bot token respectively); reusing
 * either here would mean a leak of one secret compromises both mechanisms,
 * and would make "distinct secret" claims false. If INTERNAL_SERVICE_SECRET
 * is not set, every internal-service call fails closed (500 below).
 */
function getInternalSecret() {
    return process.env.INTERNAL_SERVICE_SECRET || null;
}

/**
 * Computes SHA-256 hash of request body.
 *
 * @param {any} body
 * @returns {string} Hex digest
 */
function computeBodyHash(body) {
    if (body == null) return crypto.createHash('sha256').update('').digest('hex');
    const str = typeof body === 'string' ? body : JSON.stringify(body);
    return crypto.createHash('sha256').update(str).digest('hex');
}

/**
 * Computes HMAC-SHA256 signature for internal request.
 *
 * @param {Object} params
 * @param {string} params.method HTTP method (GET, POST, etc.)
 * @param {string} params.path Request path (e.g. /api/internal/acquisition/consume-telegram-session)
 * @param {string|number} params.timestamp Millisecond timestamp
 * @param {string} params.nonce Cryptographic nonce
 * @param {any} params.body Request body
 * @param {string} params.secret Shared secret
 * @returns {string} Hex signature
 */
function computeSignature({ method, path, timestamp, nonce, body, secret }) {
    const bodyHash = computeBodyHash(body);
    const normalizedPath = (path || '').split('?')[0];
    const stringToSign = `${(method || 'POST').toUpperCase()}:${normalizedPath}:${timestamp}:${nonce}:${bodyHash}`;
    return crypto.createHmac('sha256', secret).update(stringToSign).digest('hex');
}

/**
 * Atomically checks and records a nonce into persistent PostgreSQL storage.
 *
 * @param {string} nonce
 * @param {number} [ttlSeconds=300]
 * @param {Object} [dbClient]
 * @returns {Promise<boolean>} True if nonce is fresh and recorded; false if replayed
 */
async function recordPersistentNonce(nonce, ttlSeconds = 300, dbClient = null) {
    // 1. Check in-memory L1 cache
    if (memoryNonceCache.has(nonce)) {
        return false;
    }

    const db = dbClient || getServiceRoleClient();
    try {
        const { data, error } = await db.rpc('fn_record_internal_service_nonce', {
            p_nonce: nonce,
            p_ttl_seconds: ttlSeconds
        });

        if (error) {
            console.error('[InternalServiceAuth] Persistent nonce RPC error:', error.message);
            // Fail closed on database authorization/execution errors
            return false;
        }

        if (data === true) {
            memoryNonceCache.set(nonce, Date.now() + (ttlSeconds * 1000));
            return true;
        }

        return false; // Nonce already existed (replay detected)
    } catch (err) {
        console.error('[InternalServiceAuth] Persistent nonce exception:', err.message);
        return false;
    }
}

/**
 * Express middleware for verifying internal service HMAC signature and
 * persistent replay protection.
 *
 * Phase P.1G.3A: the legacy static `x-internal-service-secret` bypass
 * (zero nonce, zero timestamp, fully replayable) has been removed. Only a
 * valid HMAC-SHA256 signature + timestamp + nonce is accepted; anything
 * else fails closed with 401.
 */
async function internalServiceAuth(req, res, next) {
    const secret = getInternalSecret();
    if (!secret) {
        console.error('[InternalServiceAuth] INTERNAL_SERVICE_SECRET is not configured in environment!');
        return res.status(500).json({ error: 'INTERNAL_SECURITY_NOT_CONFIGURED' });
    }

    const sigHeader = req.headers['x-internal-signature'];
    const tsHeader = req.headers['x-internal-timestamp'];
    const nonceHeader = req.headers['x-internal-nonce'];

    if (!sigHeader || !tsHeader || !nonceHeader) {
        return res.status(401).json({
            error: 'UNAUTHORIZED_SIGNATURE_REQUIRED',
            message: 'Valid internal HMAC signature, timestamp, and nonce are required'
        });
    }

    // Timestamp Freshness Check (5-minute window)
    const timestamp = parseInt(tsHeader, 10);
    if (isNaN(timestamp)) {
        return res.status(401).json({ error: 'INVALID_TIMESTAMP' });
    }

    const now = Date.now();
    if (Math.abs(now - timestamp) > REPLAY_WINDOW_MS) {
        return res.status(401).json({ error: 'STALE_TIMESTAMP' });
    }

    // Cryptographic Nonce Validation (Persistent Check)
    if (typeof nonceHeader !== 'string' || nonceHeader.length < 8) {
        return res.status(401).json({ error: 'INVALID_NONCE' });
    }

    // Signature Verification
    const normalizedPath = (req.originalUrl || req.url || '').split('?')[0];
    const expectedSignature = computeSignature({
        method: req.method,
        path: normalizedPath,
        timestamp: tsHeader,
        nonce: nonceHeader,
        body: req.body,
        secret
    });

    const sigBuf = Buffer.from(sigHeader);
    const expectedBuf = Buffer.from(expectedSignature);

    if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
        return res.status(401).json({ error: 'INVALID_SIGNATURE' });
    }

    // Atomically record nonce in persistent PostgreSQL table to prevent replays across restarts
    const isFreshNonce = await recordPersistentNonce(nonceHeader, 300);
    if (!isFreshNonce) {
        return res.status(401).json({ error: 'NONCE_REPLAY_DETECTED' });
    }

    return next();
}

/**
 * Resets in-memory L1 cache (useful for testing replay across process restarts).
 */
function _resetMemoryNonceCache() {
    memoryNonceCache.clear();
}

module.exports = {
    internalServiceAuth,
    computeSignature,
    computeBodyHash,
    recordPersistentNonce,
    getInternalSecret,
    _resetMemoryNonceCache,
    REPLAY_WINDOW_MS
};
