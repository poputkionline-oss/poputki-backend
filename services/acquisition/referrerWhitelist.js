/**
 * services/acquisition/referrerWhitelist.js
 *
 * Phase P.1G.2: Referrer Normalization & Domain Whitelist
 *
 * Extracts clean hostname from incoming referrer URLs, excluding query parameters
 * and sensitive paths. Classifies known platforms into standard platform & medium values.
 */

'use strict';

const KNOWN_PLATFORM_PATTERNS = [
    {
        regex: /(^|\.)instagram\.com$/i,
        platform: 'instagram',
        medium: 'organic_social'
    },
    {
        regex: /(^|\.)(facebook\.com|fb\.me)$/i,
        platform: 'facebook',
        medium: 'organic_social'
    },
    {
        regex: /(^|\.)(t\.me|telegram\.me|telegram\.org)$/i,
        platform: 'telegram',
        medium: 'messenger'
    },
    {
        regex: /(^|\.)(whatsapp\.com|wa\.me)$/i,
        platform: 'whatsapp',
        medium: 'messenger'
    },
    {
        regex: /(^|\.)tiktok\.com$/i,
        platform: 'tiktok',
        medium: 'organic_social'
    },
    {
        regex: /(^|\.)(youtube\.com|youtu\.be)$/i,
        platform: 'youtube',
        medium: 'organic_social'
    },
    {
        regex: /(^|\.)google\.(com|[a-z]{2,3})(\.[a-z]{2})?$/i,
        platform: 'google',
        medium: 'search_organic'
    },
    {
        regex: /(^|\.)(yandex\.(ru|com|tj|kz|by|uz)|ya\.ru)$/i,
        platform: 'yandex',
        medium: 'search_organic'
    }
];

const INTERNAL_HOST_PATTERNS = [
    /(^|\.)poputki\.online$/i,
    /(^|\.)onrender\.com$/i,
    /^localhost$/i
];

/**
 * Normalizes an incoming referrer string.
 *
 * @param {string} rawReferrer - Full referrer URL or hostname
 * @returns {Object} Normalized referrer metadata
 */
function normalizeReferrer(rawReferrer) {
    if (!rawReferrer || typeof rawReferrer !== 'string' || !rawReferrer.trim()) {
        return {
            referrer_host: null,
            is_direct: true,
            is_internal: false,
            source_platform: 'direct',
            source_medium: 'direct',
            attribution_type: 'direct_organic',
            attribution_confidence: 'direct'
        };
    }

    let hostname = '';
    try {
        let urlToParse = rawReferrer.trim();
        if (!/^https?:\/\//i.test(urlToParse)) {
            urlToParse = 'https://' + urlToParse;
        }
        const parsed = new URL(urlToParse);
        hostname = (parsed.hostname || '').toLowerCase().trim();
    } catch {
        return {
            referrer_host: null,
            is_direct: true,
            is_internal: false,
            source_platform: 'direct',
            source_medium: 'direct',
            attribution_type: 'direct_organic',
            attribution_confidence: 'direct'
        };
    }

    if (!hostname) {
        return {
            referrer_host: null,
            is_direct: true,
            is_internal: false,
            source_platform: 'direct',
            source_medium: 'direct',
            attribution_type: 'direct_organic',
            attribution_confidence: 'direct'
        };
    }

    // Check if internal domain
    for (const pattern of INTERNAL_HOST_PATTERNS) {
        if (pattern.test(hostname)) {
            return {
                referrer_host: hostname,
                is_direct: true,
                is_internal: true,
                source_platform: 'direct',
                source_medium: 'direct',
                attribution_type: 'direct_organic',
                attribution_confidence: 'direct'
            };
        }
    }

    // Check against known platform patterns
    for (const item of KNOWN_PLATFORM_PATTERNS) {
        if (item.regex.test(hostname)) {
            return {
                referrer_host: hostname,
                clean_host: hostname,
                is_direct: false,
                is_internal: false,
                is_whitelisted: true,
                source_platform: item.platform,
                source_medium: item.medium,
                attribution_type: 'marketing',
                attribution_confidence: 'verified_referrer'
            };
        }
    }

    // Fallback: unrecognized external referrer
    return {
        referrer_host: hostname,
        clean_host: hostname,
        is_direct: false,
        is_internal: false,
        is_whitelisted: false,
        source_platform: 'unknown',
        source_medium: 'unknown',
        attribution_type: 'unknown',
        attribution_confidence: 'fallback'
    };
}

module.exports = {
    normalizeReferrer
};
