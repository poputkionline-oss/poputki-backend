/**
 * utils/adminTokenAuth.js
 *
 * Phase P.1G.3A: Single canonical, constant-time admin token comparison,
 * shared by every route that gates on X-Admin-Token / ADMIN_SECRET_TOKEN
 * (routes/admin.js, routes/adminAcquisitionFunnel.js), replacing
 * independent `=== ` comparisons that leaked a timing side-channel.
 *
 * Fail-closed: missing/misconfigured ADMIN_SECRET_TOKEN never authorizes.
 */

'use strict';

const crypto = require('crypto');

/**
 * Constant-time comparison of two strings. Returns false (never throws) for
 * any non-string/empty input rather than falling through to a length-based
 * short-circuit that could leak timing information.
 *
 * @param {string} received
 * @param {string} expected
 * @returns {boolean}
 */
function constantTimeEqual(received, expected) {
    if (!received || !expected || typeof received !== 'string' || typeof expected !== 'string') {
        return false;
    }
    const receivedBuf = Buffer.from(received);
    const expectedBuf = Buffer.from(expected);
    if (receivedBuf.length !== expectedBuf.length) {
        return false;
    }
    return crypto.timingSafeEqual(receivedBuf, expectedBuf);
}

/**
 * Express middleware factory: verifies req.headers['x-admin-token'] against
 * process.env.ADMIN_SECRET_TOKEN using constant-time comparison. Fails
 * closed (500) if the secret itself is not configured, and never logs the
 * received or expected token value.
 *
 * @returns {import('express').RequestHandler}
 */
function requireAdminToken(req, res, next) {
    const configured = process.env.ADMIN_SECRET_TOKEN;
    if (!configured) {
        console.error('[AdminTokenAuth] ADMIN_SECRET_TOKEN is not configured in environment!');
        return res.status(500).json({ error: 'Internal server security configuration error' });
    }

    const token = req.headers['x-admin-token'];
    if (constantTimeEqual(token, configured)) {
        return next();
    }

    return res.status(401).json({ error: 'Unauthorized: Admin access required' });
}

module.exports = { constantTimeEqual, requireAdminToken };
