/**
 * routes/internalAcquisition.js
 *
 * Phase P.1G.3: Internal Bot & Server-to-Service Acquisition Endpoints
 *
 * Endpoints:
 * - POST /api/internal/acquisition/consume-telegram-session
 * - POST /api/internal/acquisition/bot-start
 * - POST /api/internal/acquisition/contact-shared
 * - POST /api/internal/acquisition/outbox/tick (Worker trigger)
 * - POST /api/internal/acquisition/reconcile (Reconciliation trigger)
 * - GET  /api/internal/acquisition/outbox/metrics (Monitoring)
 *
 * Security: Strictly guarded by HMAC-SHA256 signature verification with
 * persistent PostgreSQL nonce replay protection and 5-min timestamp window. Fails closed.
 */

'use strict';

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { getServiceRoleClient } = require('../dbServiceRole');
const { hashToken } = require('../services/acquisition/attributionResolver');
const { resolveCanonicalUserId } = require('../utils/identityMergeHelper');
const { internalServiceAuth } = require('../utils/internalServiceAuth');
const { enqueueOutboxEvent, processOutboxBatch, getOutboxMetrics } = require('../services/acquisition/outboxService');
const { runReconciliationPass } = require('../services/acquisition/reconciliationService');

// Apply HMAC-SHA256 + persistent nonce replay authentication to all routes in this router
router.use(internalServiceAuth);

// -----------------------------------------------------------------------------
// POST /api/internal/acquisition/consume-telegram-session
// -----------------------------------------------------------------------------
router.post('/consume-telegram-session', async (req, res) => {
    try {
        const { raw_token, telegram_chat_id, telegram_user_id } = req.body || {};

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
            const errorCode = (rpcResult && rpcResult.error) || (rpcErr && rpcErr.message) || 'CONSUME_FAILED';
            return res.status(400).json({
                success: false,
                error: errorCode
            });
        }

        const canonicalUserId = telegram_user_id ? await resolveCanonicalUserId(telegram_user_id) : null;
        const sessionId = rpcResult.acquisition_session_id || rpcResult.session_id;
        const visitorId = rpcResult.anonymous_visitor_id;

        // Enqueue BOT_STARTED event into persistent outbox
        const idempKey = `bot_start_w_${tokenHash.slice(0, 16)}_${Date.now()}`;
        await enqueueOutboxEvent({
            eventName: 'BOT_STARTED',
            eventSource: 'bot',
            idempotencyKey: idempKey,
            visitorId,
            sessionId,
            userId: canonicalUserId,
            properties: {
                handshake_type: 'web_to_telegram',
                has_telegram_chat_id: Boolean(telegram_chat_id)
            },
            dbClient: db
        });

        // Invariant: Consuming a handshake token NEVER grants marketing consent
        return res.status(200).json({
            success: true,
            session_id: sessionId,
            anonymous_visitor_id: visitorId,
            acquisition_session_id: sessionId,
            acquisition_link_id: rpcResult.acquisition_link_id || null,
            marketing_consent: false
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
            user_id,
            source_platform = 'telegram',
            source_medium = 'messenger',
            attribution_type = 'direct_organic'
        } = req.body || {};

        const db = getServiceRoleClient();
        const canonicalUserId = user_id ? await resolveCanonicalUserId(user_id) : null;

        // Idempotency: One direct organic start per chat ID per day if no session
        const dateTag = new Date().toISOString().slice(0, 10);
        const idempKey = `bot_start_${telegram_chat_id || visitor_id || crypto.randomBytes(8).toString('hex')}_${dateTag}`;

        await enqueueOutboxEvent({
            eventName: 'BOT_STARTED',
            eventSource: 'bot',
            idempotencyKey: idempKey,
            visitorId: visitor_id || null,
            sessionId: session_id || null,
            userId: canonicalUserId,
            properties: {
                source_platform,
                source_medium,
                attribution_type,
                telegram_chat_id_provided: Boolean(telegram_chat_id)
            },
            dbClient: db
        });

        // Immediately trigger non-blocking outbox delivery tick
        processOutboxBatch({ batchSize: 10, dbClient: db }).catch(() => {});

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
            user_id,
            telegram_user_id
        } = req.body || {};

        const db = getServiceRoleClient();
        const resolvedUserId = user_id || telegram_user_id;
        const canonicalUserId = resolvedUserId ? await resolveCanonicalUserId(resolvedUserId) : null;

        const idempKey = `contact_shared_${canonicalUserId || visitor_id || crypto.randomBytes(8).toString('hex')}_${Date.now()}`;

        // Invariant: ZERO PII (phone number, name) stored in properties!
        // Invariant: CONTACT_DOES_NOT_GRANT_CONSENT: YES (marketing consent remains strictly false)
        await enqueueOutboxEvent({
            eventName: 'CONTACT_SHARED',
            eventSource: 'bot',
            idempotencyKey: idempKey,
            visitorId: visitor_id || null,
            sessionId: session_id || null,
            userId: canonicalUserId,
            properties: {
                contact_received: true,
                marketing_consent_granted: false
            },
            dbClient: db
        });

        // If a canonical user was resolved, also enqueue USER_IDENTIFIED
        if (canonicalUserId) {
            const identifyKey = `user_identified_${canonicalUserId}_${visitor_id || 'bot'}`;
            await enqueueOutboxEvent({
                eventName: 'USER_IDENTIFIED',
                eventSource: 'bot',
                idempotencyKey: identifyKey,
                visitorId: visitor_id || null,
                sessionId: session_id || null,
                userId: canonicalUserId,
                properties: {
                    identity_source: 'telegram_contact',
                    marketing_consent_granted: false
                },
                dbClient: db
            });

            // If visitor ID exists, record acquisition identity link
            if (visitor_id && visitor_id !== '00000000-0000-0000-0000-000000000000') {
                try {
                    await db.from('acquisition_identity_links').upsert({
                        anonymous_visitor_id: visitor_id,
                        canonical_user_id: canonicalUserId,
                        link_source: 'telegram_contact',
                        confidence_score: 1.0,
                        created_at: new Date().toISOString()
                    }, {
                        onConflict: 'anonymous_visitor_id,canonical_user_id',
                        ignoreDuplicates: true
                    });
                } catch (linkErr) {
                    console.warn('[InternalAcquisition] Identity link warning:', linkErr.message);
                }
            }
        }

        // Immediately trigger non-blocking outbox processing
        processOutboxBatch({ batchSize: 10, dbClient: db }).catch(() => {});

        return res.status(200).json({
            success: true,
            event_name: 'CONTACT_SHARED',
            user_identified: Boolean(canonicalUserId),
            marketing_consent_granted: false
        });
    } catch (err) {
        console.error('[InternalAcquisition] Contact shared error:', err.message);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

// -----------------------------------------------------------------------------
// POST /api/internal/acquisition/outbox/tick
// -----------------------------------------------------------------------------
router.post('/outbox/tick', async (req, res) => {
    try {
        const batchSize = Math.min(Math.max(parseInt(req.body?.batch_size || 50, 10), 1), 100);
        const result = await processOutboxBatch({ batchSize });
        return res.status(200).json({ success: true, ...result });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// -----------------------------------------------------------------------------
// POST /api/internal/acquisition/reconcile
// -----------------------------------------------------------------------------
router.post('/reconcile', async (req, res) => {
    try {
        const result = await runReconciliationPass();
        return res.status(200).json({ success: true, ...result });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// -----------------------------------------------------------------------------
// GET /api/internal/acquisition/outbox/metrics
// -----------------------------------------------------------------------------
router.get('/outbox/metrics', async (req, res) => {
    try {
        const metrics = await getOutboxMetrics();
        return res.status(200).json({ success: true, metrics });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;
