/**
 * routes/acquisition.js
 *
 * Phase P.1G.2: Acquisition Ingestion, Session Management & Tracked Link Routing
 *
 * Public ingestion endpoints:
 * - POST /api/acquisition/session
 * - POST /api/acquisition/events
 * - POST /api/acquisition/telegram-link-session
 * - GET  /l/:rawToken (Tracked link redirect)
 * - GET  /r/:rawCode (Referral link redirect)
 */

'use strict';

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { getServiceRoleClient } = require('../dbServiceRole');
const { getOrCreateSession } = require('../services/acquisition/sessionService');
const { ingestClientEvents } = require('../services/acquisition/eventIngestionService');
const { hashToken } = require('../services/acquisition/attributionResolver');

function getCanonicalFrontendUrl() {
    let base = process.env.FRONTEND_URL || 'https://www.poputki.online';
    base = base.trim().replace(/\/+$/, '');
    if (base === 'https://poputki.online' || base === 'http://poputki.online') {
        base = 'https://www.poputki.online';
    }
    return base;
}

function setNoCacheHeaders(res) {
    res.set({
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
    });
}

const FRONTEND_BASE_URL = getCanonicalFrontendUrl();

const BOT_UA_REGEX = /(bot|crawler|spider|telegrambot|facebookexternalhit|whatsapp|twitterbot|slackbot|applebot|linkedinbot|embedly|quora link preview|pinterest)/i;

/**
 * Heuristic bot preview detector based on User-Agent header.
 *
 * @param {string} ua
 * @returns {boolean}
 */
function isSuspectedBot(ua) {
    if (!ua || typeof ua !== 'string') return false;
    return BOT_UA_REGEX.test(ua);
}

// -----------------------------------------------------------------------------
// POST /api/acquisition/session
// -----------------------------------------------------------------------------
router.post('/session', async (req, res) => {
    try {
        const {
            anonymous_visitor_id,
            tracked_token,
            referral_code,
            referrer,
            utm,
            landing_path,
            is_telegram_webapp
        } = req.body || {};

        const headerVisitorId = req.headers['x-visitor-id'];
        const visitorId = headerVisitorId || anonymous_visitor_id;
        const reqReferrer = req.headers['referer'] || referrer;

        // Extract optional user context if authenticated
        const userId = req.user ? req.user.id : null;

        const sessionResult = await getOrCreateSession({
            visitorId,
            trackedToken: tracked_token,
            referralCode: referral_code,
            referrer: reqReferrer,
            utm: utm || {},
            isTelegramWebApp: is_telegram_webapp === true,
            userId,
            landingPath: landing_path
        });

        return res.status(200).json({
            success: true,
            data: sessionResult
        });
    } catch (err) {
        console.error('[Acquisition API] Session error:', err.message);
        return res.status(500).json({
            success: false,
            error: 'Failed to process acquisition session'
        });
    }
});

// -----------------------------------------------------------------------------
// POST /api/acquisition/events
// -----------------------------------------------------------------------------
router.post('/events', async (req, res) => {
    try {
        const {
            anonymous_visitor_id,
            session_id,
            events
        } = req.body || {};

        const headerVisitorId = req.headers['x-visitor-id'];
        const visitorId = headerVisitorId || anonymous_visitor_id;

        const outcome = await ingestClientEvents({
            visitorId,
            sessionId: session_id,
            events
        });

        if (!outcome.success) {
            return res.status(outcome.code || 400).json({
                success: false,
                error: outcome.error,
                details: outcome.details
            });
        }

        return res.status(200).json({
            success: true,
            ingested_count: outcome.ingested_count,
            idempotent: outcome.idempotent
        });
    } catch (err) {
        console.error('[Acquisition API] Events error:', err.message);
        return res.status(500).json({
            success: false,
            error: 'Failed to ingest acquisition events'
        });
    }
});

// -----------------------------------------------------------------------------
// POST /api/acquisition/telegram-link-session
// -----------------------------------------------------------------------------
router.post('/telegram-link-session', async (req, res) => {
    try {
        const {
            anonymous_visitor_id,
            session_id,
            acquisition_link_id
        } = req.body || {};

        const headerVisitorId = req.headers['x-visitor-id'];
        const visitorId = headerVisitorId || anonymous_visitor_id;

        if (!visitorId || !session_id) {
            return res.status(400).json({
                success: false,
                error: 'VISITOR_AND_SESSION_REQUIRED'
            });
        }

        const db = getServiceRoleClient();

        // Verify session belongs to visitor
        const { data: sessionData, error: sErr } = await db
            .from('acquisition_sessions')
            .select('id, anonymous_visitor_id, acquisition_link_id')
            .eq('id', session_id)
            .maybeSingle();

        if (sErr || !sessionData) {
            return res.status(404).json({ success: false, error: 'SESSION_NOT_FOUND' });
        }

        if (sessionData.anonymous_visitor_id.toLowerCase() !== visitorId.toLowerCase()) {
            return res.status(403).json({ success: false, error: 'SESSION_MISMATCH' });
        }

        // Generate cryptographically secure raw handshake token
        const rawToken = crypto.randomBytes(24).toString('hex');
        const tokenHash = hashToken(rawToken);
        const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString(); // 15 min TTL

        const { error: insertErr } = await db
            .from('telegram_link_sessions')
            .insert({
                token_hash: tokenHash,
                anonymous_visitor_id: visitorId,
                acquisition_session_id: session_id,
                acquisition_link_id: acquisition_link_id || sessionData.acquisition_link_id || null,
                expires_at: expiresAt
            });

        if (insertErr) {
            console.error('[Acquisition API] Telegram session insert error:', insertErr.message);
            return res.status(500).json({ success: false, error: 'FAILED_TO_CREATE_TELEGRAM_SESSION' });
        }

        const botUsername = process.env.TELEGRAM_BOT_NAME || 'Poputkionline_bot';
        const deepLink = `https://t.me/${botUsername}?start=w_${rawToken}`;

        return res.status(200).json({
            success: true,
            telegram_deep_link: deepLink,
            expires_at: expiresAt
        });
    } catch (err) {
        console.error('[Acquisition API] Telegram session exception:', err.message);
        return res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// -----------------------------------------------------------------------------
// GET /l/:rawToken (Tracked Link Redirect)
// -----------------------------------------------------------------------------
router.get('/l/:rawToken', async (req, res) => {
    const { rawToken } = req.params;
    const fallbackUrl = `${FRONTEND_BASE_URL}/`;

    if (!rawToken || typeof rawToken !== 'string' || rawToken.length < 8) {
        setNoCacheHeaders(res);
        return res.redirect(302, fallbackUrl);
    }

    try {
        const db = getServiceRoleClient();
        const tokenHash = hashToken(rawToken);

        const { data: link, error: linkErr } = await db
            .from('acquisition_links')
            .select('id, target_path, is_active, expires_at')
            .eq('short_token_hash', tokenHash)
            .maybeSingle();

        if (linkErr || !link || !link.is_active) {
            setNoCacheHeaders(res);
            return res.redirect(302, fallbackUrl);
        }

        if (link.expires_at && new Date(link.expires_at) <= new Date()) {
            setNoCacheHeaders(res);
            return res.redirect(302, fallbackUrl);
        }

        const isBot = isSuspectedBot(req.headers['user-agent']);

        // Record click without raw IP / full UA
        try {
            await db.from('acquisition_link_clicks').insert({
                link_id: link.id,
                is_bot_suspected: isBot,
                clicked_at: new Date().toISOString()
            });
        } catch (clickErr) {
            console.warn('[Acquisition Link] Click recording warning:', clickErr.message);
        }

        // Safe relative target path validation
        let safePath = link.target_path || '/';
        if (!safePath.startsWith('/') || safePath.includes('//') || safePath.includes('\\') || safePath.includes('..') || safePath.includes(':')) {
            safePath = '/';
        }

        const redirectUrl = new URL(safePath, FRONTEND_BASE_URL);
        redirectUrl.searchParams.set('acq_token', rawToken);

        setNoCacheHeaders(res);
        return res.redirect(302, redirectUrl.toString());
    } catch (err) {
        console.error('[Acquisition Link] Redirect exception:', err.message);
        setNoCacheHeaders(res);
        return res.redirect(302, fallbackUrl);
    }
});

// -----------------------------------------------------------------------------
// GET /r/:rawCode (Referral Link Redirect)
// -----------------------------------------------------------------------------
router.get('/r/:rawCode', async (req, res) => {
    const { rawCode } = req.params;
    const fallbackUrl = `${FRONTEND_BASE_URL}/`;

    if (!rawCode || typeof rawCode !== 'string' || rawCode.length < 4) {
        setNoCacheHeaders(res);
        return res.redirect(302, fallbackUrl);
    }

    try {
        const db = getServiceRoleClient();
        const codeHash = hashToken(rawCode);

        const { data: refLink, error: refErr } = await db
            .from('referral_links')
            .select('id, is_active, expires_at, revoked_at')
            .eq('short_code_hash', codeHash)
            .maybeSingle();

        if (refErr || !refLink || !refLink.is_active || refLink.revoked_at) {
            setNoCacheHeaders(res);
            return res.redirect(302, fallbackUrl);
        }

        if (refLink.expires_at && new Date(refLink.expires_at) <= new Date()) {
            setNoCacheHeaders(res);
            return res.redirect(302, fallbackUrl);
        }

        const redirectUrl = new URL('/', FRONTEND_BASE_URL);
        redirectUrl.searchParams.set('ref', rawCode);

        setNoCacheHeaders(res);
        return res.redirect(302, redirectUrl.toString());
    } catch (err) {
        console.error('[Referral Link] Redirect exception:', err.message);
        setNoCacheHeaders(res);
        return res.redirect(302, fallbackUrl);
    }
});

module.exports = router;
