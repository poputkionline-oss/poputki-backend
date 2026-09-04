/**
 * services/acquisition/sessionService.js
 *
 * Phase P.1G.2: Visitor & Session State Machine
 *
 * Manages visitor lifecycle, attribution inheritance (first touch, first non-direct,
 * last non-direct), and 30-minute session inactivity boundary.
 */

'use strict';

const crypto = require('crypto');
const { getServiceRoleClient } = require('../../dbServiceRole');
const { resolveAttribution } = require('./attributionResolver');

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SESSION_INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Validates or generates a valid UUIDv4 for anonymous_visitor_id.
 *
 * @param {string} candidate
 * @returns {string} Valid UUID
 */
function sanitizeVisitorId(candidate) {
    if (candidate && typeof candidate === 'string' && UUID_V4_REGEX.test(candidate.trim())) {
        return candidate.trim().toLowerCase();
    }
    return crypto.randomUUID();
}

/**
 * Obtains or initializes a visitor and active attribution session.
 *
 * @param {Object} params
 * @param {string} [params.visitorId] - Incoming visitor ID from client header/body
 * @param {string} [params.trackedToken] - Raw token from /l/:rawToken
 * @param {string} [params.referralCode] - Raw code from /r/:rawCode
 * @param {string} [params.referrer] - HTTP Referer header or document.referrer
 * @param {Object} [params.utm] - Client-submitted UTM parameters
 * @param {number} [params.userId] - Optional authenticated user ID
 * @param {string} [params.landingPath] - Relative landing path
 * @param {Object} [params.dbClient] - Optional DB client override
 * @returns {Promise<Object>} Session descriptor
 */
async function getOrCreateSession({
    visitorId = null,
    trackedToken = null,
    referralCode = null,
    referrer = null,
    utm = {},
    userId = null,
    landingPath = null,
    dbClient = null
} = {}) {
    const db = dbClient || getServiceRoleClient();
    const cleanVisitorId = sanitizeVisitorId(visitorId);
    const now = new Date();

    // 1. Resolve normalized attribution context
    const attribution = await resolveAttribution({
        trackedToken,
        referralCode,
        referrer,
        utm,
        dbClient: db
    });

    const isNonDirect = !attribution.is_direct && attribution.source_platform !== 'direct';

    // 2. Fetch or create visitor
    const { data: existingVisitor } = await db
        .from('acquisition_visitors')
        .select('*')
        .eq('anonymous_visitor_id', cleanVisitorId)
        .maybeSingle();

    if (!existingVisitor) {
        // First touch for this visitor: immutable initial values
        const visitorPayload = {
            anonymous_visitor_id: cleanVisitorId,
            current_user_id: userId ? Number(userId) : null,
            initial_platform: attribution.source_platform,
            initial_medium: attribution.source_medium,
            initial_attribution_type: attribution.attribution_type,
            initial_campaign_id: attribution.campaign_id || null,
            initial_partner_id: attribution.partner_id || null,
            first_seen_at: now.toISOString(),
            last_seen_at: now.toISOString(),
            identified_at: userId ? now.toISOString() : null
        };

        if (isNonDirect) {
            visitorPayload.first_non_direct_platform = attribution.source_platform;
            visitorPayload.first_non_direct_medium = attribution.source_medium;
            visitorPayload.first_non_direct_campaign_id = attribution.campaign_id || null;
            visitorPayload.first_non_direct_partner_id = attribution.partner_id || null;

            visitorPayload.last_non_direct_platform = attribution.source_platform;
            visitorPayload.last_non_direct_medium = attribution.source_medium;
            visitorPayload.last_non_direct_campaign_id = attribution.campaign_id || null;
            visitorPayload.last_non_direct_partner_id = attribution.partner_id || null;
        }

        await db.from('acquisition_visitors').insert(visitorPayload);
    } else {
        // Visitor exists: update last_seen_at and last_non_direct if current touch is non-direct
        const updates = {
            last_seen_at: now.toISOString()
        };

        if (userId && !existingVisitor.current_user_id) {
            updates.current_user_id = Number(userId);
            if (!existingVisitor.identified_at) {
                updates.identified_at = now.toISOString();
            }
        }

        if (isNonDirect) {
            updates.last_non_direct_platform = attribution.source_platform;
            updates.last_non_direct_medium = attribution.source_medium;
            updates.last_non_direct_campaign_id = attribution.campaign_id || null;
            updates.last_non_direct_partner_id = attribution.partner_id || null;

            // If visitor never had a non-direct touch before
            if (!existingVisitor.first_non_direct_platform) {
                updates.first_non_direct_platform = attribution.source_platform;
                updates.first_non_direct_medium = attribution.source_medium;
                updates.first_non_direct_campaign_id = attribution.campaign_id || null;
                updates.first_non_direct_partner_id = attribution.partner_id || null;
            }
        }

        await db
            .from('acquisition_visitors')
            .update(updates)
            .eq('anonymous_visitor_id', cleanVisitorId);
    }

    // 3. Find active session (within 30m window)
    const { data: latestSession } = await db
        .from('acquisition_sessions')
        .select('*')
        .eq('anonymous_visitor_id', cleanVisitorId)
        .order('last_activity_at', { ascending: false })
        .limit(1)
        .maybeSingle();

    let sessionId;
    let sessionExpiresAt;

    const isSessionActive = latestSession &&
        !latestSession.ended_at &&
        (now.getTime() - new Date(latestSession.last_activity_at).getTime() < SESSION_INACTIVITY_TIMEOUT_MS);

    // Rule: new valid non-direct source triggers a new session even if within 30m
    const isNewNonDirectSource = isNonDirect &&
        latestSession &&
        (latestSession.source_platform !== attribution.source_platform ||
         latestSession.source_medium !== attribution.source_medium);

    if (isSessionActive && !isNewNonDirectSource) {
        // Reuse active session, update activity timestamp
        sessionId = latestSession.id;
        sessionExpiresAt = new Date(now.getTime() + SESSION_INACTIVITY_TIMEOUT_MS).toISOString();

        const sessionUpdates = {
            last_activity_at: now.toISOString()
        };
        if (userId && !latestSession.user_id) {
            sessionUpdates.user_id = Number(userId);
        }

        await db
            .from('acquisition_sessions')
            .update(sessionUpdates)
            .eq('id', sessionId);
    } else {
        // Close previous session if was still unended
        if (latestSession && !latestSession.ended_at) {
            await db
                .from('acquisition_sessions')
                .update({ ended_at: now.toISOString() })
                .eq('id', latestSession.id);
        }

        // Create new session
        sessionId = crypto.randomUUID();
        sessionExpiresAt = new Date(now.getTime() + SESSION_INACTIVITY_TIMEOUT_MS).toISOString();

        const safeLandingPath = landingPath && typeof landingPath === 'string'
            ? landingPath.slice(0, 255)
            : null;

        await db.from('acquisition_sessions').insert({
            id: sessionId,
            anonymous_visitor_id: cleanVisitorId,
            user_id: userId ? Number(userId) : null,
            source_platform: attribution.source_platform,
            source_medium: attribution.source_medium,
            attribution_type: attribution.attribution_type,
            campaign_id: attribution.campaign_id || null,
            partner_id: attribution.partner_id || null,
            acquisition_link_id: attribution.acquisition_link_id || null,
            content_code: attribution.content_code || null,
            placement_code: attribution.placement_code || null,
            landing_path: safeLandingPath,
            referrer_host: attribution.referrer_host || null,
            is_direct: attribution.is_direct,
            attribution_confidence: attribution.attribution_confidence,
            started_at: now.toISOString(),
            last_activity_at: now.toISOString()
        });
    }

    // 4. Record referral attribution if user is identified and referral link is active
    if (attribution.referral_link_id && attribution.referrer_user_id && userId) {
        const inviteeId = Number(userId);
        const referrerId = Number(attribution.referrer_user_id);

        if (inviteeId !== referrerId) {
            try {
                // Check existing attribution (invitee_user_id is unique)
                const { data: existingAttr } = await db
                    .from('referral_attributions')
                    .select('id')
                    .eq('invitee_user_id', inviteeId)
                    .maybeSingle();

                if (!existingAttr) {
                    await db.from('referral_attributions').insert({
                        invitee_user_id: inviteeId,
                        referrer_user_id: referrerId,
                        referral_link_id: attribution.referral_link_id,
                        acquisition_session_id: sessionId,
                        created_at: now.toISOString()
                    });
                }
            } catch (err) {
                console.warn('[SessionService] Non-blocking referral attribution recording error:', err.message);
            }
        }
    }

    return {
        anonymous_visitor_id: cleanVisitorId,
        session_id: sessionId,
        session_expires_at: sessionExpiresAt,
        attribution: {
            source_platform: attribution.source_platform,
            source_medium: attribution.source_medium,
            attribution_type: attribution.attribution_type,
            attribution_confidence: attribution.attribution_confidence,
            is_direct: attribution.is_direct
        }
    };
}

module.exports = {
    getOrCreateSession,
    sanitizeVisitorId,
    UUID_V4_REGEX,
    SESSION_INACTIVITY_TIMEOUT_MS
};
