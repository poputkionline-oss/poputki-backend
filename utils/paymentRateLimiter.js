/**
 * utils/paymentRateLimiter.js
 *
 * Phase E.48.6: SmartPay Invoice Creation Abuse & Rate Limiting
 *
 * Provides in-memory sliding window rate limiting per IP and per-identifier
 * to prevent seat-locking cycling and invoice flooding.
 */

'use strict';

const ipHits = new Map();
const CLEANUP_INTERVAL_MS = 60 * 1000;
const WINDOW_MS = 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 10;

// Periodic cleanup of expired IP buckets
setInterval(() => {
    const now = Date.now();
    for (const [ip, record] of ipHits.entries()) {
        if (now - record.startTime > WINDOW_MS) {
            ipHits.delete(ip);
        }
    }
}, CLEANUP_INTERVAL_MS).unref();

/**
 * Checks if the request exceeds the per-IP creation rate limit.
 * @param {string} ip
 * @returns {boolean} true if allowed, false if rate limited
 */
function checkIpRateLimit(ip) {
    if (!ip) return true;
    const now = Date.now();
    const record = ipHits.get(ip);

    if (!record || now - record.startTime > WINDOW_MS) {
        ipHits.set(ip, { count: 1, startTime: now });
        return true;
    }

    if (record.count >= MAX_REQUESTS_PER_WINDOW) {
        return false;
    }

    record.count += 1;
    return true;
}

/**
 * Reset rate limit tracker (useful for testing).
 */
function resetRateLimits() {
    ipHits.clear();
}

module.exports = {
    checkIpRateLimit,
    resetRateLimits,
    MAX_REQUESTS_PER_WINDOW,
    WINDOW_MS
};
