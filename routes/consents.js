/**
 * routes/consents.js
 *
 * Phase P.1G.2: Marketing Consent Endpoints
 *
 * Protected endpoints (require passenger JWT):
 * - POST /api/marketing-consents
 * - POST /api/marketing-consents/revoke
 * - GET  /api/marketing-consents/me
 */

'use strict';

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { userAuth } = require('../utils/userAuth');
const { getServiceRoleClient } = require('../dbServiceRole');
const { resolveCanonicalUserId } = require('../utils/identityMergeHelper');

const ALLOWED_CHANNELS = new Set(['sms', 'telegram', 'whatsapp', 'email', 'push']);
const BACKEND_POLICY_VERSION = process.env.MARKETING_POLICY_VERSION || 'v1.0_2026';

// All consent routes require passenger JWT
router.use(userAuth);

// -----------------------------------------------------------------------------
// POST /api/marketing-consents (Grant Consent)
// -----------------------------------------------------------------------------
router.post('/', async (req, res) => {
    try {
        const { channel, purpose, consent_source } = req.body || {};
        const rawUserId = req.user.id;

        if (!channel || !ALLOWED_CHANNELS.has(channel)) {
            return res.status(400).json({ error: 'INVALID_OR_MISSING_CHANNEL' });
        }

        if (!purpose || typeof purpose !== 'string') {
            return res.status(400).json({ error: 'PURPOSE_REQUIRED' });
        }

        const canonicalUserId = await resolveCanonicalUserId(rawUserId);
        const db = getServiceRoleClient();

        const idempotencyKey = `grant_${canonicalUserId}_${channel}_${purpose.slice(0, 16)}_${crypto.randomBytes(8).toString('hex')}`;
        const source = (consent_source && typeof consent_source === 'string')
            ? consent_source.slice(0, 32)
            : 'web_settings';

        const { data: rpcResult, error: rpcErr } = await db.rpc('fn_record_marketing_consent', {
            p_user_id: canonicalUserId,
            p_channel: channel,
            p_purpose: purpose.slice(0, 32),
            p_action: 'granted',
            p_policy_version: BACKEND_POLICY_VERSION,
            p_consent_source: source,
            p_idempotency_key: idempotencyKey,
            p_occurred_at: new Date().toISOString()
        });

        if (rpcErr || !rpcResult || !rpcResult.success) {
            console.error('[Consent API] RPC grant error:', rpcErr ? rpcErr.message : rpcResult);
            return res.status(500).json({ error: 'FAILED_TO_RECORD_CONSENT' });
        }

        return res.status(200).json({
            success: true,
            status: 'granted',
            channel,
            purpose,
            policy_version: BACKEND_POLICY_VERSION
        });
    } catch (err) {
        console.error('[Consent API] Grant exception:', err.message);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

// -----------------------------------------------------------------------------
// POST /api/marketing-consents/revoke (Revoke Consent)
// -----------------------------------------------------------------------------
router.post('/revoke', async (req, res) => {
    try {
        const { channel, purpose } = req.body || {};
        const rawUserId = req.user.id;

        if (!channel || !ALLOWED_CHANNELS.has(channel)) {
            return res.status(400).json({ error: 'INVALID_OR_MISSING_CHANNEL' });
        }

        if (!purpose || typeof purpose !== 'string') {
            return res.status(400).json({ error: 'PURPOSE_REQUIRED' });
        }

        const canonicalUserId = await resolveCanonicalUserId(rawUserId);
        const db = getServiceRoleClient();

        const idempotencyKey = `revoke_${canonicalUserId}_${channel}_${purpose.slice(0, 16)}_${crypto.randomBytes(8).toString('hex')}`;

        const { data: rpcResult, error: rpcErr } = await db.rpc('fn_record_marketing_consent', {
            p_user_id: canonicalUserId,
            p_channel: channel,
            p_purpose: purpose.slice(0, 32),
            p_action: 'revoked',
            p_policy_version: BACKEND_POLICY_VERSION,
            p_consent_source: 'user_revocation',
            p_idempotency_key: idempotencyKey,
            p_occurred_at: new Date().toISOString()
        });

        if (rpcErr || !rpcResult || !rpcResult.success) {
            console.error('[Consent API] RPC revoke error:', rpcErr ? rpcErr.message : rpcResult);
            return res.status(500).json({ error: 'FAILED_TO_REVOKE_CONSENT' });
        }

        return res.status(200).json({
            success: true,
            status: 'revoked',
            channel,
            purpose
        });
    } catch (err) {
        console.error('[Consent API] Revoke exception:', err.message);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

// -----------------------------------------------------------------------------
// GET /api/marketing-consents/me (Get User Consents)
// -----------------------------------------------------------------------------
router.get('/me', async (req, res) => {
    try {
        const rawUserId = req.user.id;
        const canonicalUserId = await resolveCanonicalUserId(rawUserId);
        const db = getServiceRoleClient();

        const { data: consents, error: cErr } = await db
            .from('marketing_consent_current')
            .select('channel, purpose, status, updated_at')
            .eq('user_id', canonicalUserId);

        if (cErr) {
            console.error('[Consent API] Read error:', cErr.message);
            return res.status(500).json({ error: 'FAILED_TO_FETCH_CONSENTS' });
        }

        return res.status(200).json({
            success: true,
            consents: consents || []
        });
    } catch (err) {
        console.error('[Consent API] Me exception:', err.message);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
