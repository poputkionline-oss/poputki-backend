/**
 * services/acquisition/campaignManagementService.js
 *
 * Phase P.1G.5: Admin Campaign, Tracked Link & Partner Management Service
 *
 * Security & Integrity Invariants:
 * - Admin-only, timing-safe authentication via route middleware.
 * - Raw token is generated cryptographically and returned ONLY ONCE upon link creation.
 * - Database stores only SHA-256 hash of the short token.
 * - target_path is strictly validated against relative paths (no open redirect).
 * - Physical deletion (DELETE) is forbidden.
 * - Campaign codes and attribution identity are immutable once links/clicks exist.
 * - Zero PII exposed.
 */

'use strict';

const crypto = require('crypto');
const { getServiceRoleClient } = require('../../dbServiceRole');

const ALLOWED_PLATFORMS = new Set([
    'instagram', 'facebook', 'telegram', 'whatsapp', 'tiktok', 'youtube',
    'google', 'yandex', 'website', 'direct', 'offline', 'unknown'
]);

const ALLOWED_MEDIUMS = new Set([
    'organic_social', 'paid_social', 'messenger', 'search_organic',
    'search_paid', 'influencer', 'referral', 'qr', 'direct', 'offline',
    'carrier_link', 'unknown'
]);

const ALLOWED_ATTRIBUTION_TYPES = new Set([
    'marketing', 'passenger_referral', 'carrier_handoff',
    'partner_affiliate', 'direct_organic', 'unknown'
]);

const ALLOWED_CURRENCIES = new Set(['TJS', 'RUB', 'USD']);

function getCanonicalFrontendUrl() {
    let base = process.env.FRONTEND_URL || 'https://www.poputki.online';
    base = base.trim().replace(/\/+$/, '');
    if (base === 'https://poputki.online' || base === 'http://poputki.online') {
        base = 'https://www.poputki.online';
    }
    return base;
}

const FRONTEND_BASE_URL = getCanonicalFrontendUrl();

/**
 * Validates target path for internal relative redirect safety.
 * Matches DB constraint: (((target_path ~~ '/%') AND (target_path !~~ '%//%') AND (target_path !~~ '%\\\\%') AND (target_path !~~ '%..%') AND (target_path !~~ '%:%')))
 */
function isValidTargetPath(path) {
    if (typeof path !== 'string' || !path.startsWith('/')) return false;
    if (path.includes('//') || path.includes('\\') || path.includes('..') || path.includes(':')) {
        return false;
    }
    // Allowed URL chars in path and query
    const safeRegex = /^\/[a-zA-Z0-9_\-\/?=&%#.~]*$/;
    return safeRegex.test(path);
}

/**
 * Validates campaign machine code.
 * Lowercase, alphanumeric, hyphen, underscore, 2 to 64 chars.
 */
function isValidCampaignCode(code) {
    if (typeof code !== 'string') return false;
    return /^[a-z0-9_\-]{2,64}$/.test(code.trim());
}

/**
 * Computes SHA-256 hash of a string.
 */
function hashToken(raw) {
    if (!raw || typeof raw !== 'string') return '';
    return crypto.createHash('sha256').update(raw.trim()).digest('hex');
}

/**
 * Generates a cryptographically random URL-safe token.
 * 9 random bytes base64url-encoded produces a 12-character token.
 */
function generateRawToken() {
    return crypto.randomBytes(9).toString('base64url');
}

// -----------------------------------------------------------------------------
// CAMPAIGNS
// -----------------------------------------------------------------------------

/**
 * Creates a new marketing campaign.
 */
async function createCampaign(payload, dbClient = null) {
    let {
        code,
        name,
        source_platform,
        source_medium,
        campaign_type = 'organic',
        budget_amount = null,
        currency = 'TJS',
        starts_at = null,
        ends_at = null,
        is_active = true
    } = payload || {};

    if (!name || typeof name !== 'string' || !name.trim()) {
        const err = new Error('Campaign name is required');
        err.code = 'VALIDATION_ERROR';
        err.status = 400;
        throw err;
    }
    name = name.trim();

    if (!code || typeof code !== 'string' || !isValidCampaignCode(code)) {
        const err = new Error('Campaign code must be 2-64 lowercase latin alphanumeric, hyphen or underscore characters');
        err.code = 'VALIDATION_ERROR';
        err.status = 400;
        throw err;
    }
    code = code.trim().toLowerCase();

    if (!source_platform || !ALLOWED_PLATFORMS.has(source_platform)) {
        const err = new Error(`Invalid source_platform: ${source_platform}`);
        err.code = 'VALIDATION_ERROR';
        err.status = 400;
        throw err;
    }

    if (!source_medium || !ALLOWED_MEDIUMS.has(source_medium)) {
        const err = new Error(`Invalid source_medium: ${source_medium}`);
        err.code = 'VALIDATION_ERROR';
        err.status = 400;
        throw err;
    }

    if (campaign_type !== 'organic' && campaign_type !== 'paid') {
        const err = new Error('campaign_type must be either organic or paid');
        err.code = 'VALIDATION_ERROR';
        err.status = 400;
        throw err;
    }

    if (budget_amount !== null && budget_amount !== undefined && budget_amount !== '') {
        const num = Number(budget_amount);
        if (isNaN(num) || num < 0) {
            const err = new Error('budget_amount must be a non-negative number');
            err.code = 'VALIDATION_ERROR';
            err.status = 400;
            throw err;
        }
        budget_amount = num;
    } else {
        budget_amount = null;
    }

    if (currency) {
        currency = currency.toUpperCase();
        if (!ALLOWED_CURRENCIES.has(currency)) {
            const err = new Error(`Invalid currency: ${currency}. Allowed: TJS, RUB, USD`);
            err.code = 'VALIDATION_ERROR';
            err.status = 400;
            throw err;
        }
    } else {
        currency = 'TJS';
    }

    if (starts_at && ends_at) {
        const s = new Date(starts_at);
        const e = new Date(ends_at);
        if (isNaN(s.getTime()) || isNaN(e.getTime()) || e < s) {
            const err = new Error('ends_at cannot be earlier than starts_at');
            err.code = 'VALIDATION_ERROR';
            err.status = 400;
            throw err;
        }
    }

    const db = dbClient || getServiceRoleClient();

    // Check unique code
    const { data: existing, error: checkErr } = await db
        .from('acquisition_campaigns')
        .select('id')
        .eq('code', code)
        .maybeSingle();

    if (checkErr) {
        console.error('[CampaignService] Check code error:', checkErr.message);
        const err = new Error('Failed to check campaign code');
        err.status = 500;
        throw err;
    }

    if (existing) {
        const err = new Error(`Campaign with code "${code}" already exists`);
        err.code = 'CAMPAIGN_CODE_EXISTS';
        err.status = 409;
        throw err;
    }

    const insertData = {
        code,
        name,
        source_platform,
        source_medium,
        campaign_type,
        budget_amount,
        currency: budget_amount !== null ? currency : null,
        starts_at: starts_at ? new Date(starts_at).toISOString() : null,
        ends_at: ends_at ? new Date(ends_at).toISOString() : null,
        is_active: Boolean(is_active)
    };

    const { data: created, error: insertErr } = await db
        .from('acquisition_campaigns')
        .insert(insertData)
        .select('*')
        .single();

    if (insertErr) {
        console.error('[CampaignService] Insert error:', insertErr.message);
        if (insertErr.code === '23505') {
            const err = new Error(`Campaign with code "${code}" already exists`);
            err.code = 'CAMPAIGN_CODE_EXISTS';
            err.status = 409;
            throw err;
        }
        const err = new Error('Failed to create campaign');
        err.status = 500;
        throw err;
    }

    return created;
}

/**
 * Retrieves campaign details by ID including its associated tracked links.
 */
async function getCampaignDetails(campaignId, dbClient = null) {
    const db = dbClient || getServiceRoleClient();

    const { data: campaign, error: cErr } = await db
        .from('acquisition_campaigns')
        .select('*')
        .eq('id', campaignId)
        .maybeSingle();

    if (cErr) {
        console.error('[CampaignService] Fetch campaign error:', cErr.message);
        const err = new Error('Failed to load campaign');
        err.status = 500;
        throw err;
    }

    if (!campaign) {
        const err = new Error('Campaign not found');
        err.code = 'CAMPAIGN_NOT_FOUND';
        err.status = 404;
        throw err;
    }

    // Fetch links for this campaign
    const { data: links, error: lErr } = await db
        .from('acquisition_links')
        .select('id, campaign_id, partner_id, source_platform, source_medium, attribution_type, content_code, placement_code, target_path, is_active, expires_at, created_at')
        .eq('campaign_id', campaignId)
        .order('created_at', { ascending: false });

    if (lErr) {
        console.error('[CampaignService] Fetch links error:', lErr.message);
    }

    // Attach click counts to each link
    const enrichedLinks = [];
    for (const link of (links || [])) {
        const { count: clickCount } = await db
            .from('acquisition_link_clicks')
            .select('id', { count: 'exact', head: true })
            .eq('link_id', link.id);

        enrichedLinks.push({
            ...link,
            clicks_count: clickCount || 0
        });
    }

    return {
        campaign,
        links: enrichedLinks
    };
}

/**
 * Updates campaign mutable fields.
 * If campaign has links or clicks, immutable fields (code, platform, medium, type) cannot be changed.
 */
async function updateCampaign(campaignId, patch, dbClient = null) {
    const db = dbClient || getServiceRoleClient();

    const { data: campaign, error: cErr } = await db
        .from('acquisition_campaigns')
        .select('*')
        .eq('id', campaignId)
        .maybeSingle();

    if (cErr || !campaign) {
        const err = new Error('Campaign not found');
        err.code = 'CAMPAIGN_NOT_FOUND';
        err.status = 404;
        throw err;
    }

    // Check if links or sessions exist for this campaign
    const { count: linkCount } = await db
        .from('acquisition_links')
        .select('id', { count: 'exact', head: true })
        .eq('campaign_id', campaignId);

    const hasLinksOrEvents = (linkCount || 0) > 0;

    const updates = {
        updated_at: new Date().toISOString()
    };

    if (patch.name !== undefined) {
        if (typeof patch.name !== 'string' || !patch.name.trim()) {
            const err = new Error('Campaign name cannot be empty');
            err.code = 'VALIDATION_ERROR';
            err.status = 400;
            throw err;
        }
        updates.name = patch.name.trim();
    }

    if (patch.code !== undefined && patch.code !== campaign.code) {
        if (hasLinksOrEvents) {
            const err = new Error('Campaign code cannot be changed after links have been issued');
            err.code = 'CAMPAIGN_IMMUTABLE_FIELD';
            err.status = 409;
            throw err;
        }
        if (!isValidCampaignCode(patch.code)) {
            const err = new Error('Invalid campaign code format');
            err.code = 'VALIDATION_ERROR';
            err.status = 400;
            throw err;
        }
        updates.code = patch.code.trim().toLowerCase();
    }

    if (patch.source_platform !== undefined && patch.source_platform !== campaign.source_platform) {
        if (hasLinksOrEvents) {
            const err = new Error('Campaign platform cannot be changed after links have been issued');
            err.code = 'CAMPAIGN_IMMUTABLE_FIELD';
            err.status = 409;
            throw err;
        }
        if (!ALLOWED_PLATFORMS.has(patch.source_platform)) {
            const err = new Error(`Invalid platform: ${patch.source_platform}`);
            err.code = 'VALIDATION_ERROR';
            err.status = 400;
            throw err;
        }
        updates.source_platform = patch.source_platform;
    }

    if (patch.source_medium !== undefined && patch.source_medium !== campaign.source_medium) {
        if (hasLinksOrEvents) {
            const err = new Error('Campaign medium cannot be changed after links have been issued');
            err.code = 'CAMPAIGN_IMMUTABLE_FIELD';
            err.status = 409;
            throw err;
        }
        if (!ALLOWED_MEDIUMS.has(patch.source_medium)) {
            const err = new Error(`Invalid medium: ${patch.source_medium}`);
            err.code = 'VALIDATION_ERROR';
            err.status = 400;
            throw err;
        }
        updates.source_medium = patch.source_medium;
    }

    if (patch.budget_amount !== undefined) {
        if (patch.budget_amount === null || patch.budget_amount === '') {
            updates.budget_amount = null;
        } else {
            const num = Number(patch.budget_amount);
            if (isNaN(num) || num < 0) {
                const err = new Error('budget_amount must be a non-negative number');
                err.code = 'VALIDATION_ERROR';
                err.status = 400;
                throw err;
            }
            updates.budget_amount = num;
        }
    }

    if (patch.currency !== undefined) {
        if (patch.currency) {
            const curr = patch.currency.toUpperCase();
            if (!ALLOWED_CURRENCIES.has(curr)) {
                const err = new Error(`Invalid currency: ${curr}`);
                err.code = 'VALIDATION_ERROR';
                err.status = 400;
                throw err;
            }
            updates.currency = curr;
        }
    }

    if (patch.starts_at !== undefined) {
        updates.starts_at = patch.starts_at ? new Date(patch.starts_at).toISOString() : null;
    }

    if (patch.ends_at !== undefined) {
        updates.ends_at = patch.ends_at ? new Date(patch.ends_at).toISOString() : null;
    }

    const effectiveStarts = updates.starts_at !== undefined ? updates.starts_at : campaign.starts_at;
    const effectiveEnds = updates.ends_at !== undefined ? updates.ends_at : campaign.ends_at;

    if (effectiveStarts && effectiveEnds && new Date(effectiveEnds) < new Date(effectiveStarts)) {
        const err = new Error('ends_at cannot be earlier than starts_at');
        err.code = 'VALIDATION_ERROR';
        err.status = 400;
        throw err;
    }

    const { data: updated, error: uErr } = await db
        .from('acquisition_campaigns')
        .update(updates)
        .eq('id', campaignId)
        .select('*')
        .single();

    if (uErr) {
        console.error('[CampaignService] Update error:', uErr.message);
        const err = new Error('Failed to update campaign');
        err.status = 500;
        throw err;
    }

    return updated;
}

/**
 * Updates campaign status (pause / resume).
 */
async function updateCampaignStatus(campaignId, { is_active }, dbClient = null) {
    const db = dbClient || getServiceRoleClient();

    if (typeof is_active !== 'boolean') {
        const err = new Error('is_active must be a boolean');
        err.code = 'VALIDATION_ERROR';
        err.status = 400;
        throw err;
    }

    const { data: updated, error: uErr } = await db
        .from('acquisition_campaigns')
        .update({
            is_active,
            updated_at: new Date().toISOString()
        })
        .eq('id', campaignId)
        .select('*')
        .maybeSingle();

    if (uErr || !updated) {
        const err = new Error('Campaign not found or update failed');
        err.code = 'CAMPAIGN_NOT_FOUND';
        err.status = 404;
        throw err;
    }

    return updated;
}

// -----------------------------------------------------------------------------
// TRACKED LINKS
// -----------------------------------------------------------------------------

/**
 * Issues a new tracked acquisition link for a campaign.
 * Returns raw token ONCE.
 */
async function createTrackedLink(campaignId, linkPayload, dbClient = null) {
    const db = dbClient || getServiceRoleClient();

    // Verify campaign exists
    const { data: campaign, error: cErr } = await db
        .from('acquisition_campaigns')
        .select('*')
        .eq('id', campaignId)
        .maybeSingle();

    if (cErr || !campaign) {
        const err = new Error('Campaign not found');
        err.code = 'CAMPAIGN_NOT_FOUND';
        err.status = 404;
        throw err;
    }

    let {
        partner_id = null,
        source_platform = null,
        source_medium = null,
        attribution_type = 'marketing',
        content_code = null,
        placement_code = null,
        target_path = '/',
        expires_at = null,
        is_active = true
    } = linkPayload || {};

    // Default platform & medium from campaign if omitted
    source_platform = source_platform || campaign.source_platform;
    source_medium = source_medium || campaign.source_medium;

    if (!ALLOWED_PLATFORMS.has(source_platform)) {
        const err = new Error(`Invalid source_platform: ${source_platform}`);
        err.code = 'VALIDATION_ERROR';
        err.status = 400;
        throw err;
    }

    if (!ALLOWED_MEDIUMS.has(source_medium)) {
        const err = new Error(`Invalid source_medium: ${source_medium}`);
        err.code = 'VALIDATION_ERROR';
        err.status = 400;
        throw err;
    }

    if (!ALLOWED_ATTRIBUTION_TYPES.has(attribution_type)) {
        const err = new Error(`Invalid attribution_type: ${attribution_type}`);
        err.code = 'VALIDATION_ERROR';
        err.status = 400;
        throw err;
    }

    if (!isValidTargetPath(target_path)) {
        const err = new Error('Invalid target_path: must be an internal relative path starting with / without .., //, :, or backslashes');
        err.code = 'VALIDATION_ERROR';
        err.status = 400;
        throw err;
    }

    if (partner_id) {
        const { data: partner, error: pErr } = await db
            .from('acquisition_partners')
            .select('id')
            .eq('id', partner_id)
            .maybeSingle();

        if (pErr || !partner) {
            const err = new Error('Specified partner does not exist');
            err.code = 'VALIDATION_ERROR';
            err.status = 400;
            throw err;
        }
    } else {
        partner_id = null;
    }

    if (expires_at) {
        const expDate = new Date(expires_at);
        if (isNaN(expDate.getTime()) || expDate <= new Date()) {
            const err = new Error('expires_at must be a valid future date');
            err.code = 'VALIDATION_ERROR';
            err.status = 400;
            throw err;
        }
        expires_at = expDate.toISOString();
    } else {
        expires_at = null;
    }

    // Generate cryptographic raw token
    const rawToken = generateRawToken();
    const tokenHash = hashToken(rawToken);

    const insertData = {
        short_token_hash: tokenHash,
        campaign_id: campaign.id,
        partner_id,
        source_platform,
        source_medium,
        attribution_type,
        content_code: content_code ? String(content_code).trim().slice(0, 100) : null,
        placement_code: placement_code ? String(placement_code).trim().slice(0, 100) : null,
        target_path,
        is_active: Boolean(is_active),
        expires_at
    };

    const { data: createdLink, error: insertErr } = await db
        .from('acquisition_links')
        .insert(insertData)
        .select('id, campaign_id, partner_id, source_platform, source_medium, attribution_type, content_code, placement_code, target_path, is_active, expires_at, created_at')
        .single();

    if (insertErr) {
        console.error('[CampaignService] Insert link error:', insertErr.message);
        const err = new Error('Failed to create tracked link');
        err.status = 500;
        throw err;
    }

    if (createdLink && createdLink.short_token_hash) {
        delete createdLink.short_token_hash;
    }

    const publicUrl = `${FRONTEND_BASE_URL}/l/${rawToken}`;

    return {
        link: createdLink,
        raw_token: rawToken,
        public_url: publicUrl,
        warning: 'Raw token and URL are shown once. Ensure you save or copy the link.'
    };
}

/**
 * Returns all links for a given campaign.
 */
async function getCampaignLinks(campaignId, dbClient = null) {
    const db = dbClient || getServiceRoleClient();

    const { data: links, error: lErr } = await db
        .from('acquisition_links')
        .select('id, campaign_id, partner_id, source_platform, source_medium, attribution_type, content_code, placement_code, target_path, is_active, expires_at, created_at')
        .eq('campaign_id', campaignId)
        .order('created_at', { ascending: false });

    if (lErr) {
        console.error('[CampaignService] Fetch links error:', lErr.message);
        const err = new Error('Failed to load campaign links');
        err.status = 500;
        throw err;
    }

    const result = [];
    for (const link of (links || [])) {
        const { count: clickCount } = await db
            .from('acquisition_link_clicks')
            .select('id', { count: 'exact', head: true })
            .eq('link_id', link.id);

        result.push({
            ...link,
            clicks_count: clickCount || 0
        });
    }

    return result;
}

/**
 * Updates link status (active/inactive).
 */
async function updateLinkStatus(linkId, { is_active }, dbClient = null) {
    const db = dbClient || getServiceRoleClient();

    if (typeof is_active !== 'boolean') {
        const err = new Error('is_active must be a boolean');
        err.code = 'VALIDATION_ERROR';
        err.status = 400;
        throw err;
    }

    const { data: updated, error: uErr } = await db
        .from('acquisition_links')
        .update({ is_active })
        .eq('id', linkId)
        .select('id, campaign_id, partner_id, source_platform, source_medium, attribution_type, content_code, placement_code, target_path, is_active, expires_at, created_at')
        .maybeSingle();

    if (uErr || !updated) {
        const err = new Error('Link not found or update failed');
        err.code = 'LINK_NOT_FOUND';
        err.status = 404;
        throw err;
    }

    return updated;
}

// -----------------------------------------------------------------------------
// PARTNERS
// -----------------------------------------------------------------------------

/**
 * Creates a partner in the acquisition_partners dictionary.
 */
async function createPartner(payload, dbClient = null) {
    const db = dbClient || getServiceRoleClient();

    let {
        code,
        display_name,
        partner_type = 'influencer',
        is_active = true
    } = payload || {};

    if (!display_name || typeof display_name !== 'string' || !display_name.trim()) {
        const err = new Error('display_name is required');
        err.code = 'VALIDATION_ERROR';
        err.status = 400;
        throw err;
    }
    display_name = display_name.trim();

    if (!code || typeof code !== 'string' || !isValidCampaignCode(code)) {
        const err = new Error('Partner code must be 2-64 lowercase alphanumeric, hyphen or underscore characters');
        err.code = 'VALIDATION_ERROR';
        err.status = 400;
        throw err;
    }
    code = code.trim().toLowerCase();

    // Check unique code
    const { data: existing, error: checkErr } = await db
        .from('acquisition_partners')
        .select('id')
        .eq('code', code)
        .maybeSingle();

    if (checkErr) {
        console.error('[CampaignService] Check partner code error:', checkErr.message);
        const err = new Error('Failed to verify partner code');
        err.status = 500;
        throw err;
    }

    if (existing) {
        const err = new Error(`Partner with code "${code}" already exists`);
        err.code = 'PARTNER_CODE_EXISTS';
        err.status = 409;
        throw err;
    }

    const { data: created, error: insertErr } = await db
        .from('acquisition_partners')
        .insert({
            code,
            display_name,
            partner_type: String(partner_type || 'influencer').trim().toLowerCase(),
            is_active: Boolean(is_active)
        })
        .select('id, code, display_name, partner_type, is_active, created_at, updated_at')
        .single();

    if (insertErr) {
        console.error('[CampaignService] Insert partner error:', insertErr.message);
        if (insertErr.code === '23505') {
            const err = new Error(`Partner with code "${code}" already exists`);
            err.code = 'PARTNER_CODE_EXISTS';
            err.status = 409;
            throw err;
        }
        const err = new Error('Failed to create partner');
        err.status = 500;
        throw err;
    }

    return created;
}

/**
 * Lists all partners from acquisition_partners dictionary.
 */
async function listPartners(dbClient = null) {
    const db = dbClient || getServiceRoleClient();

    const { data: partners, error: pErr } = await db
        .from('acquisition_partners')
        .select('id, code, display_name, partner_type, is_active, created_at, updated_at')
        .order('created_at', { ascending: false });

    if (pErr) {
        console.error('[CampaignService] List partners error:', pErr.message);
        const err = new Error('Failed to list partners');
        err.status = 500;
        throw err;
    }

    return partners || [];
}

/**
 * Updates partner active status.
 */
async function updatePartnerStatus(partnerId, { is_active }, dbClient = null) {
    const db = dbClient || getServiceRoleClient();

    if (typeof is_active !== 'boolean') {
        const err = new Error('is_active must be a boolean');
        err.code = 'VALIDATION_ERROR';
        err.status = 400;
        throw err;
    }

    const { data: updated, error: uErr } = await db
        .from('acquisition_partners')
        .update({
            is_active,
            updated_at: new Date().toISOString()
        })
        .eq('id', partnerId)
        .select('id, code, display_name, partner_type, is_active, created_at, updated_at')
        .maybeSingle();

    if (uErr || !updated) {
        const err = new Error('Partner not found or update failed');
        err.code = 'PARTNER_NOT_FOUND';
        err.status = 404;
        throw err;
    }

    return updated;
}

module.exports = {
    ALLOWED_PLATFORMS,
    ALLOWED_MEDIUMS,
    ALLOWED_ATTRIBUTION_TYPES,
    ALLOWED_CURRENCIES,
    isValidTargetPath,
    isValidCampaignCode,
    hashToken,
    generateRawToken,
    createCampaign,
    getCampaignDetails,
    updateCampaign,
    updateCampaignStatus,
    createTrackedLink,
    getCampaignLinks,
    updateLinkStatus,
    createPartner,
    listPartners,
    updatePartnerStatus
};
