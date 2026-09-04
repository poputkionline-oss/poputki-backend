/**
 * routes/internalAcquisition.js
 *
 * Phase P.1G.2: Internal Bot & Server-to-Server Acquisition Endpoints
 *
 * Endpoints for future Phase P.1G.3 Bot Handshake:
 * - POST /api/internal/acquisition/bot-start
 * - POST /api/internal/acquisition/contact-shared
 * - POST /api/internal/acquisition/consume-telegram-session
 *
 * Security: Strictly guarded by internal service-to-service secret
 * with constant-time comparison. Fails closed.
 */

'use strict';

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { getServiceRoleClient } = require('../dbServiceRole');
const { hashToken } = require('../services/acquisition/attributionResolver');
const { resolveCanonicalUserId } = require('../utils/identityMergeHelper');

const INTERNAL_SECRET = process.env.INTERNAL_SERVICE_SECRET || process.env.TELEGRAM_BOT_TOKEN;

/**
 * Constant-time string comparison middleware.
 */
function internalServiceAuth(req, res, next) {
    if (!INTERNAL_SECRET) {
        console.error('[InternalAcquisition] INTERNAL_SERVICE_SECRET is not configured in environment!');
        return res.status(500).json({ error: 'Internal server security configuration error' });
    }

    const providedSecret = req.headers['x-internal-service-secret'];
    if (!providedSecret || typeof providedSecret !== 'string') {
        return res.status(401).json({ error: 'Unauthorized: Internal service secret required' });
    }

    const expectedBuf = Buffer.from(INTERNAL_SECRET);
    const providedBuf = Buffer.from(providedSecret);

    if (expectedBuf.length !== providedBuf.length || !crypto.timingSafeEqual(expectedBuf, providedBuf)) {
        return res.status(401).json({ error: 'Unauthorized: Invalid service secret' });
    }

    next();
}

router.use(internalServiceAuth);

// -----------------------------------------------------------------------------
// POST /api/internal/acquisition/consume-telegram-session
// -----------------------------------------------------------------------------
router.post('/consume-telegram-session', async (req, res) => {
    try {
        const { raw_token, telegram_chat_id } = req.body || {};

        if (!raw_token || typeof raw_token !== 'string') {
            return res.status(400).json({ error: 'RAW_TOKEN_REQUIRED' });
        }

        const tokenHash = hashToken(raw_token);
        const db = getServiceRoleClient();

        const { data: rpcResult, error: rpcErr } = await db.rpc('fn_consume_telegram_link_session', {
            p_token_hash: tokenHash,
            p_telegram_chat_id: telegram_chat_id ? Number(telegram_chat_id) : null
        });

        if (rpcErr || !rpcResult || !rpcResult.success) {
            return res.status(400).json({
                success: false,
                error: (rpcResult && rpcResult.error) || (rpcErr && rpcErr.message) || 'CONSUME_FAILED'
            });
        }

        return res.status(200).json({
            success: true,
            session_id: rpcResult.session_id,
            anonymous_visitor_id: rpcResult.anonymous_visitor_id,
            acquisition_session_id: rpcResult.acquisition_session_id,
            acquisition_link_id: rpcResult.acquisition_link_id
        });
    } catch (err) {
        console.error('[InternalAcquisition] Consume exception:', err.message);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

// -----------------------------------------------------------------------------
// POST /api/internal/acquisition/bot-start
// -----------------------------------------------------------------------------
router.post('/bot-start', async (req, res) => {
    try {
        const {
            visitor_id,
            session_id,
            telegram_chat_id,
            user_id
        } = req.body || {};

        const db = getServiceRoleClient();
        const now = new Date().toISOString();
        const canonicalUserId = user_id ? await resolveCanonicalUserId(user_id) : null;

        const idempKey = `bot_start_${telegram_chat_id || visitor_id || crypto.randomBytes(8).toString('hex')}_${Date.now()}`;

        await db.from('acquisition_events').insert({
            event_name: 'BOT_STARTED',
            anonymous_visitor_id: visitor_id || '00000000-0000-0000-0000-000000000000',
            session_id: session_id || null,
            user_id: canonicalUserId,
            event_source: 'bot',
            idempotency_key: idempKey,
            properties: {
                telegram_chat_id_provided: Boolean(telegram_chat_id)
            },
            occurred_at: now,
            received_at: now
        });

        return res.status(200).json({ success: true, event_name: 'BOT_STARTED' });
    } catch (err) {
        console.error('[InternalAcquisition] Bot start error:', err.message);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

// -----------------------------------------------------------------------------
// POST /api/internal/acquisition/contact-shared
// -----------------------------------------------------------------------------
router.post('/contact-shared', async (req, res) => {
    try {
        const {
            visitor_id,
            session_id,
            user_id
        } = req.body || {};

        const db = getServiceRoleClient();
        const now = new Date().toISOString();
        const canonicalUserId = user_id ? await resolveCanonicalUserId(user_id) : null;

        const idempKey = `contact_shared_${canonicalUserId || visitor_id || crypto.randomBytes(8).toString('hex')}_${Date.now()}`;

        // Invariant: zero PII (phone number) stored in properties
        await db.from('acquisition_events').insert({
            event_name: 'CONTACT_SHARED',
            anonymous_visitor_id: visitor_id || '00000000-0000-0000-0000-000000000000',
            session_id: session_id || null,
            user_id: canonicalUserId,
            event_source: 'bot',
            idempotency_key: idempKey,
            properties: {
                contact_received: true
            },
            occurred_at: now,
            received_at: now
        });

        return res.status(200).json({ success: true, event_name: 'CONTACT_SHARED' });
    } catch (err) {
        console.error('[InternalAcquisition] Contact shared error:', err.message);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
