/**
 * services/acquisition/attributionResolver.js
 *
 * Phase P.1G.2: Unified Server-Side Attribution Resolver
 *
 * Enforces strict attribution precedence:
 * 1. Valid passenger referral link
 * 2. Valid tracked acquisition link
 * 3. Valid partner/campaign link
 * 4. Valid external referrer from whitelist
 * 5. Valid unverified UTM parameters
 * 6. Direct
 * 7. Unknown
 *
 * Invariant: Client UTM cannot forge internal campaign_id, partner_id,
 * or elevate attribution confidence to verified.
 */

'use strict';

const crypto = require('crypto');
const { normalizeReferrer } = require('./referrerWhitelist');

const VALID_PLATFORMS = new Set([
    'instagram', 'facebook', 'telegram', 'whatsapp', 'tiktok', 'youtube',
    'google', 'yandex', 'website', 'direct', 'offline', 'unknown'
]);

const VALID_MEDIUMS = new Set([
    'organic_social', 'paid_social', 'messenger', 'search_organic',
    'search_paid', 'influencer', 'referral', 'qr', 'direct', 'offline',
    'carrier_link', 'cpc', 'cpm', 'banner', 'social', 'email', 'push', 'unknown'
]);

const VALID_ATTRIBUTION_TYPES = new Set([
    'marketing', 'passenger_referral', 'carrier_handoff',
    'partner_affiliate', 'direct_organic', 'unknown'
]);

/**
 * Computes SHA-256 hash of a raw string.
 *
 * @param {string} raw
 * @returns {string} Hex-encoded SHA-256 hash
 */
function hashToken(raw) {
    if (!raw || typeof raw !== 'string') return '';
    return crypto.createHash('sha256').update(raw.trim()).digest('hex');
}

/**
 * Resolves attribution parameters from incoming request context and database records.
 *
 * @param {Object} input
 * @param {string} [input.trackedToken] - Raw token from tracked acquisition link
 * @param {string} [input.referralCode] - Raw code from passenger referral link
 * @param {string} [input.referrer] - HTTP Referer header or client referrer URL
 * @param {Object} [input.utm] - Client-submitted UTM query parameters
 * @param {Object} [input.dbClient] - Supabase DB client for token resolution
 * @returns {Promise<Object>} Normalized attribution object
 */
async function resolveAttribution({
    trackedToken = null,
    referralCode = null,
    referrer = null,
    utm = {},
    dbClient = null
} = {}) {
    const defaultDirect = {
        source_platform: 'direct',
        source_medium: 'direct',
        attribution_type: 'direct_organic',
        attribution_confidence: 'direct',
        campaign_id: null,
        partner_id: null,
        acquisition_link_id: null,
        referral_link_id: null,
        content_code: null,
        placement_code: null,
        referrer_host: null,
        is_direct: true
    };

    // 1. PRIORITY 1: Passenger Referral Link
    if (referralCode && dbClient) {
        try {
            const tokenHash = hashToken(referralCode);
            const { data: refLink } = await dbClient
                .from('referral_links')
                .select('id, owner_user_id, is_active, expires_at, revoked_at')
                .eq('short_code_hash', tokenHash)
                .maybeSingle();

            if (refLink && refLink.is_active && !refLink.revoked_at) {
                const isNotExpired = !refLink.expires_at || new Date(refLink.expires_at) > new Date();
                if (isNotExpired) {
                    return {
                        source_platform: 'telegram',
                        source_medium: 'referral',
                        attribution_type: 'passenger_referral',
                        attribution_confidence: 'verified_referral',
                        campaign_id: null,
                        partner_id: null,
                        acquisition_link_id: null,
                        referral_link_id: refLink.id,
                        referrer_user_id: refLink.owner_user_id,
                        content_code: null,
                        placement_code: null,
                        referrer_host: null,
                        is_direct: false
                    };
                }
            }
        } catch (err) {
            console.warn('[AttributionResolver] Referral link resolution error:', err.message);
        }
    }

    // 2. PRIORITY 2 & 3: Tracked Acquisition / Partner Link
    if (trackedToken && dbClient) {
        try {
            const tokenHash = hashToken(trackedToken);
            const { data: acqLink } = await dbClient
                .from('acquisition_links')
                .select('*')
                .eq('short_token_hash', tokenHash)
                .maybeSingle();

            if (acqLink && acqLink.is_active) {
                const isNotExpired = !acqLink.expires_at || new Date(acqLink.expires_at) > new Date();
                if (isNotExpired) {
                    const platform = VALID_PLATFORMS.has(acqLink.source_platform) ? acqLink.source_platform : 'unknown';
                    const medium = VALID_MEDIUMS.has(acqLink.source_medium) ? acqLink.source_medium : 'unknown';
                    const attrType = VALID_ATTRIBUTION_TYPES.has(acqLink.attribution_type) ? acqLink.attribution_type : 'marketing';
                    const confidence = acqLink.partner_id ? 'verified_partner' : 'verified_link';

                    return {
                        source_platform: platform,
                        source_medium: medium,
                        attribution_type: attrType,
                        attribution_confidence: confidence,
                        campaign_id: acqLink.campaign_id || null,
                        partner_id: acqLink.partner_id || null,
                        acquisition_link_id: acqLink.id,
                        referral_link_id: null,
                        content_code: acqLink.content_code || null,
                        placement_code: acqLink.placement_code || null,
                        referrer_host: null,
                        is_direct: false
                    };
                }
            }
        } catch (err) {
            console.warn('[AttributionResolver] Tracked link resolution error:', err.message);
        }
    }

    // 3. PRIORITY 4: Whitelisted External Referrer
    const refData = normalizeReferrer(referrer);
    if (!refData.is_direct && refData.attribution_confidence === 'verified_referrer') {
        return {
            source_platform: refData.source_platform,
            source_medium: refData.source_medium,
            attribution_type: refData.attribution_type,
            attribution_confidence: refData.attribution_confidence,
            campaign_id: null,
            partner_id: null,
            acquisition_link_id: null,
            referral_link_id: null,
            content_code: null,
            placement_code: null,
            referrer_host: refData.referrer_host,
            is_direct: false
        };
    }

    // 4. PRIORITY 5: Client-Provided UTM Parameters (Unverified)
    const rawSource = utm && utm.utm_source ? String(utm.utm_source).toLowerCase().trim() : '';
    const rawMedium = utm && utm.utm_medium ? String(utm.utm_medium).toLowerCase().trim() : '';
    if (rawSource || rawMedium) {
        let mappedPlatform = 'unknown';
        if (VALID_PLATFORMS.has(rawSource)) {
            mappedPlatform = rawSource;
        } else if (rawSource.includes('insta')) {
            mappedPlatform = 'instagram';
        } else if (rawSource.includes('face') || rawSource.includes('fb')) {
            mappedPlatform = 'facebook';
        } else if (rawSource.includes('tg') || rawSource.includes('tele')) {
            mappedPlatform = 'telegram';
        } else if (rawSource.includes('wa') || rawSource.includes('what')) {
            mappedPlatform = 'whatsapp';
        } else if (rawSource.includes('tik')) {
            mappedPlatform = 'tiktok';
        } else if (rawSource.includes('tube')) {
            mappedPlatform = 'youtube';
        } else if (rawSource.includes('goog')) {
            mappedPlatform = 'google';
        } else if (rawSource.includes('yand')) {
            mappedPlatform = 'yandex';
        }

        let mappedMedium = 'unknown';
        if (VALID_MEDIUMS.has(rawMedium)) {
            mappedMedium = rawMedium;
        } else if (rawMedium.includes('cpc') || rawMedium.includes('paid')) {
            mappedMedium = 'paid_social';
        } else if (rawMedium.includes('social')) {
            mappedMedium = 'organic_social';
        } else if (rawMedium.includes('qr')) {
            mappedMedium = 'qr';
        }

        const contentCode = utm && utm.utm_content ? String(utm.utm_content).slice(0, 64) : null;
        const placementCode = utm && utm.utm_term ? String(utm.utm_term).slice(0, 64) : null;

        return {
            source_platform: mappedPlatform,
            source_medium: mappedMedium,
            attribution_type: 'marketing',
            attribution_confidence: 'unverified_utm',
            campaign_id: null,       // Never allow client to forge UUID
            partner_id: null,        // Never allow client to forge UUID
            acquisition_link_id: null,
            referral_link_id: null,
            content_code: contentCode,
            placement_code: placementCode,
            referrer_host: refData.referrer_host || null,
            is_direct: false
        };
    }

    // 5. PRIORITY 6: Unknown external referrer fallback
    if (!refData.is_direct && refData.source_platform === 'unknown') {
        return {
            source_platform: 'unknown',
            source_medium: 'unknown',
            attribution_type: 'unknown',
            attribution_confidence: 'fallback',
            campaign_id: null,
            partner_id: null,
            acquisition_link_id: null,
            referral_link_id: null,
            content_code: null,
            placement_code: null,
            referrer_host: refData.referrer_host,
            is_direct: false
        };
    }

    // 6. PRIORITY 7: Direct traffic
    return defaultDirect;
}

module.exports = {
    resolveAttribution,
    hashToken
};
