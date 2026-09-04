/**
 * services/acquisition/eventIngestionService.js
 *
 * Phase P.1G.2: Client Event Ingestion, Allowlist Validation & Recursive PII Defense
 *
 * Enforces client event restrictions, schema validation, recursive PII blocking,
 * and session verification.
 */

'use strict';

const crypto = require('crypto');
const { getServiceRoleClient } = require('../../dbServiceRole');
const { UUID_V4_REGEX } = require('./sessionService');

const ALLOWED_CLIENT_EVENTS = new Set([
    'LANDING_VIEWED',
    'ROUTE_SEARCHED',
    'TRIP_VIEWED',
    'BOOKING_STARTED',
    'TELEGRAM_OPENED',
    'SHARE_CLICKED'
]);

const PROHIBITED_CLIENT_EVENTS = new Set([
    'BOT_STARTED',
    'CONTACT_SHARED',
    'USER_IDENTIFIED',
    'MARKETING_CONSENT_GRANTED',
    'MARKETING_CONSENT_REVOKED',
    'BOOKING_CREATED',
    'PAYMENT_COMPLETED',
    'TRIP_COMPLETED',
    'REPEAT_BOOKING',
    'REFERRAL_OPENED'
]);

const FORBIDDEN_PII_KEYS = new Set([
    'phone',
    'passport',
    'password',
    'token',
    'jwt',
    'telegram_token',
    'card_number',
    'cvv',
    'full_name',
    'email'
]);

const EVENT_ALLOWED_PROPERTIES = {
    LANDING_VIEWED: new Set(['page_path', 'locale', 'referrer_host']),
    ROUTE_SEARCHED: new Set(['from_city', 'to_city', 'departure_date', 'seats_requested']),
    TRIP_VIEWED: new Set(['trip_id', 'from_city', 'to_city', 'price_tier']),
    BOOKING_STARTED: new Set(['trip_id', 'seats_count']),
    TELEGRAM_OPENED: new Set(['target_channel', 'handoff_point']),
    SHARE_CLICKED: new Set(['share_channel', 'target_content'])
};

const MAX_BATCH_EVENTS = 10;
const MAX_OCCURRED_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours back
const MAX_FUTURE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes future

/**
 * Recursively scans an object for forbidden PII keys.
 *
 * @param {*} obj
 * @returns {string|null} Name of offending key if found, null if clean
 */
function scanForPiiKeys(obj) {
    if (!obj || typeof obj !== 'object') return null;

    if (Array.isArray(obj)) {
        for (const item of obj) {
            const found = scanForPiiKeys(item);
            if (found) return found;
        }
        return null;
    }

    for (const key of Object.keys(obj)) {
        const normalizedKey = key.toLowerCase().replace(/[^a-z0-9_]/g, '');
        for (const forbidden of FORBIDDEN_PII_KEYS) {
            if (normalizedKey === forbidden || normalizedKey.includes(forbidden)) {
                return key;
            }
        }
        const nested = scanForPiiKeys(obj[key]);
        if (nested) return nested;
    }

    return null;
}

/**
 * Filters properties to only allowed keys for a given event.
 *
 * @param {string} eventName
 * @param {Object} rawProperties
 * @returns {Object} Filtered properties object
 */
function sanitizeProperties(eventName, rawProperties) {
    if (!rawProperties || typeof rawProperties !== 'object' || Array.isArray(rawProperties)) {
        return {};
    }

    const allowed = EVENT_ALLOWED_PROPERTIES[eventName] || new Set();
    const sanitized = {};

    for (const [key, value] of Object.entries(rawProperties)) {
        if (allowed.has(key)) {
            // Primitive or string representation only
            if (typeof value === 'string') {
                sanitized[key] = value.slice(0, 128);
            } else if (typeof value === 'number' || typeof value === 'boolean') {
                sanitized[key] = value;
            }
        }
    }

    return sanitized;
}

/**
 * Validates and ingests a batch of client acquisition events.
 *
 * @param {Object} params
 * @param {string} params.visitorId - Anonymous visitor UUID
 * @param {string} params.sessionId - Acquisition session UUID
 * @param {Array<Object>} params.events - Array of event descriptors
 * @param {Object} [params.dbClient] - Optional Supabase client override
 * @returns {Promise<Object>} Ingestion outcome
 */
async function ingestClientEvents({ visitorId, sessionId, events, dbClient = null }) {
    if (!visitorId || !UUID_V4_REGEX.test(visitorId)) {
        return { success: false, error: 'INVALID_VISITOR_ID', code: 400 };
    }

    if (!sessionId || !UUID_V4_REGEX.test(sessionId)) {
        return { success: false, error: 'INVALID_SESSION_ID', code: 400 };
    }

    if (!Array.isArray(events) || events.length === 0) {
        return { success: false, error: 'EMPTY_EVENTS_BATCH', code: 400 };
    }

    if (events.length > MAX_BATCH_EVENTS) {
        return { success: false, error: `BATCH_LIMIT_EXCEEDED: max ${MAX_BATCH_EVENTS}`, code: 400 };
    }

    const db = dbClient || getServiceRoleClient();

    // Verify session exists and belongs to visitor
    const { data: sessionRecord, error: sessionErr } = await db
        .from('acquisition_sessions')
        .select('id, anonymous_visitor_id, campaign_id, partner_id, user_id')
        .eq('id', sessionId)
        .maybeSingle();

    if (sessionErr || !sessionRecord) {
        return { success: false, error: 'SESSION_NOT_FOUND', code: 404 };
    }

    if (sessionRecord.anonymous_visitor_id.toLowerCase() !== visitorId.toLowerCase()) {
        return { success: false, error: 'SESSION_VISITOR_MISMATCH', code: 403 };
    }

    const now = new Date();
    const rowsToInsert = [];

    for (let i = 0; i < events.length; i++) {
        const item = events[i];
        const eventName = item && item.event_name ? String(item.event_name).trim().toUpperCase() : '';

        if (!eventName) {
            return { success: false, error: `EVENT_NAME_REQUIRED at index ${i}`, code: 400 };
        }

        if (PROHIBITED_CLIENT_EVENTS.has(eventName)) {
            return { success: false, error: `SERVER_ONLY_EVENT_REJECTED: ${eventName}`, code: 403 };
        }

        if (!ALLOWED_CLIENT_EVENTS.has(eventName)) {
            return { success: false, error: `UNKNOWN_CLIENT_EVENT: ${eventName}`, code: 400 };
        }

        // Recursive PII check
        const piiKey = scanForPiiKeys(item.properties);
        if (piiKey) {
            return { success: false, error: `PII_DETECTED_IN_PAYLOAD: key '${piiKey}' is forbidden`, code: 400 };
        }

        // Validate occurred_at timestamp
        let occurredAt = now;
        if (item.occurred_at) {
            const parsed = new Date(item.occurred_at);
            if (!isNaN(parsed.getTime())) {
                const diff = now.getTime() - parsed.getTime();
                if (diff <= MAX_OCCURRED_WINDOW_MS && (parsed.getTime() - now.getTime()) <= MAX_FUTURE_WINDOW_MS) {
                    occurredAt = parsed;
                }
            }
        }

        // Server-managed idempotency key
        const clientKey = item.idempotency_key && typeof item.idempotency_key === 'string'
            ? item.idempotency_key.slice(0, 64)
            : crypto.randomBytes(16).toString('hex');
        const finalIdempotencyKey = `${visitorId.slice(0, 8)}_${eventName}_${clientKey}`;

        const sanitizedProps = sanitizeProperties(eventName, item.properties);

        rowsToInsert.push({
            event_name: eventName,
            anonymous_visitor_id: visitorId,
            session_id: sessionId,
            user_id: sessionRecord.user_id || null, // Inherited from verified session, never client override
            booking_id: null,                      // Client cannot inject booking_id
            bus_ticket_id: null,
            campaign_id: sessionRecord.campaign_id || null,
            partner_id: sessionRecord.partner_id || null,
            event_source: 'client',
            idempotency_key: finalIdempotencyKey,
            properties: sanitizedProps,
            occurred_at: occurredAt.toISOString(),
            received_at: now.toISOString()
        });
    }

    // Insert events using service_role client (protected from client mutations)
    const { data: inserted, error: insertErr } = await db
        .from('acquisition_events')
        .insert(rowsToInsert)
        .select('id, event_name, idempotency_key');

    if (insertErr) {
        // If unique idempotency conflict, ignore duplicates gracefully
        if (insertErr.code === '23505') {
            return {
                success: true,
                ingested_count: 0,
                idempotent: true
            };
        }
        console.error('[EventIngestion] Insert error:', insertErr.message);
        return { success: false, error: 'EVENT_INSERT_FAILED', details: insertErr.message, code: 500 };
    }

    return {
        success: true,
        ingested_count: (inserted || []).length,
        idempotent: false
    };
}

module.exports = {
    ingestClientEvents,
    scanForPiiKeys,
    sanitizeProperties,
    ALLOWED_CLIENT_EVENTS,
    PROHIBITED_CLIENT_EVENTS
};
