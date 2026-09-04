/**
 * routes/referrals.js
 *
 * Phase P.1G.2: Passenger Referral Backend
 *
 * Protected endpoints (require passenger JWT):
 * - POST /api/referrals/link
 * - GET  /api/referrals/me
 *
 * Strict non-financial guarantee: No commissions, balances, rewards, or cash.
 */

'use strict';

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { userAuth } = require('../utils/userAuth');
const { getServiceRoleClient } = require('../dbServiceRole');
const { resolveCanonicalUserId } = require('../utils/identityMergeHelper');
const { hashToken } = require('../services/acquisition/attributionResolver');

const FRONTEND_BASE_URL = process.env.FRONTEND_URL || 'https://www.poputki.online';

router.use(userAuth);

// -----------------------------------------------------------------------------
// POST /api/referrals/link (Generate or Retrieve Referral Link)
// -----------------------------------------------------------------------------
router.post('/link', async (req, res) => {
    try {
        const rawUserId = req.user.id;
        const canonicalUserId = await resolveCanonicalUserId(rawUserId);
        const db = getServiceRoleClient();

        const rawCode = crypto.createHmac('sha256', process.env.INTERNAL_HMAC_SECRET || 'poputki_referral_salt')
            .update(`ref_user_${canonicalUserId}`)
            .digest('hex')
            .slice(0, 12);
        const codeHash = hashToken(rawCode);
        const referralUrl = `${FRONTEND_BASE_URL}/r/${rawCode}`;

        // 1. Check if user already has an active referral link
        const { data: existingLink } = await db
            .from('referral_links')
            .select('id, short_code_hash, created_at')
            .eq('owner_user_id', canonicalUserId)
            .eq('is_active', true)
            .is('revoked_at', null)
            .maybeSingle();

        if (existingLink) {
            return res.status(200).json({
                success: true,
                message: 'ACTIVE_REFERRAL_LINK_EXISTS',
                referral_code: rawCode,
                referral_url: referralUrl,
                referral_link_id: existingLink.id
            });
        }

        const { data: newLink, error: insErr } = await db
            .from('referral_links')
            .insert({
                short_code_hash: codeHash,
                owner_user_id: canonicalUserId,
                is_active: true
            })
            .select('id, created_at')
            .single();

        if (insErr) {
            console.error('[Referral API] Insert error:', insErr.message);
            return res.status(500).json({ error: 'FAILED_TO_CREATE_REFERRAL_LINK' });
        }

        return res.status(201).json({
            success: true,
            referral_code: rawCode,
            referral_url: referralUrl,
            referral_link_id: newLink.id
        });
    } catch (err) {
        console.error('[Referral API] Link creation exception:', err.message);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

// -----------------------------------------------------------------------------
// GET /api/referrals/me (Referral Status & Attributed Friends Count)
// -----------------------------------------------------------------------------
router.get('/me', async (req, res) => {
    try {
        const rawUserId = req.user.id;
        const canonicalUserId = await resolveCanonicalUserId(rawUserId);
        const db = getServiceRoleClient();

        const rawCode = crypto.createHmac('sha256', process.env.INTERNAL_HMAC_SECRET || 'poputki_referral_salt')
            .update(`ref_user_${canonicalUserId}`)
            .digest('hex')
            .slice(0, 12);
        const referralUrl = `${FRONTEND_BASE_URL}/r/${rawCode}`;

        const { data: link } = await db
            .from('referral_links')
            .select('id, is_active, created_at')
            .eq('owner_user_id', canonicalUserId)
            .eq('is_active', true)
            .is('revoked_at', null)
            .maybeSingle();

        const { count: invitedCount } = await db
            .from('referral_attributions')
            .select('id', { count: 'exact', head: true })
            .eq('referrer_user_id', canonicalUserId);

        return res.status(200).json({
            success: true,
            has_active_link: Boolean(link),
            referral_code: Boolean(link) ? rawCode : null,
            referral_url: Boolean(link) ? referralUrl : null,
            referral_link_id: link ? link.id : null,
            total_invitees: invitedCount || 0
        });
    } catch (err) {
        console.error('[Referral API] Me exception:', err.message);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
