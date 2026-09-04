/**
 * journeyHelper.js
 *
 * Manual Booking Journey & Passenger Activation Funnel Engine (Phase P.1)
 * Project: POPUTKI.ONLINE
 *
 * Principles:
 * - Append-only event logging for passenger activation lifecycle.
 * - Strict Privacy: No raw phones, no JWTs, no tokens, no passport PII in event metadata.
 * - Multi-level Idempotency: Enforces uniqueness per booking, per handoff, and per session.
 * - Distinguishes between ATTEMPTED/INITIATED vs DELIVERED (no fake delivery confirmation).
 * - Analytical calculations: BOT_ABANDONED and CLAIM_EXPIRED calculated on-the-fly without synthetic DB rows.
 * - Atomic handoff creation: Uses PostgreSQL RPC fn_create_booking_handoff when available, with strict compensation fallback.
 * - Resilient Failure Isolation: Analytics failures never crash core business booking or claim operations.
 */

const { normalizePhone } = require('./phoneHelper');
const { getServiceRoleClient } = require('../dbServiceRole');

// 1. Valid Event Types (CLAIM_EXPIRED removed - calculated analytically per Phase P.1B.1)
const JOURNEY_EVENT_TYPES = Object.freeze({
    BOOKING_CREATED: 'BOOKING_CREATED',
    SHARE_INITIATED: 'SHARE_INITIATED',
    LINK_OPENED: 'LINK_OPENED',
    TELEGRAM_CTA_CLICKED: 'TELEGRAM_CTA_CLICKED',
    TELEGRAM_BOT_STARTED: 'TELEGRAM_BOT_STARTED',
    PHONE_SHARE_REQUESTED: 'PHONE_SHARE_REQUESTED',
    PHONE_SHARED: 'PHONE_SHARED',
    PHONE_VERIFIED: 'PHONE_VERIFIED',
    PHONE_MISMATCH: 'PHONE_MISMATCH',
    CLAIM_REQUEST_CREATED: 'CLAIM_REQUEST_CREATED',
    CLAIM_COMPLETED: 'CLAIM_COMPLETED',
    BOOKING_LINKED_TO_USER: 'BOOKING_LINKED_TO_USER',
    ACTIVATION_COMPLETED: 'ACTIVATION_COMPLETED'
});

// 2. Journey Activation Statuses (Distinct from booking.status and boarding_status)
const JOURNEY_STATUSES = Object.freeze({
    NOT_SHARED: 'NOT_SHARED',
    SHARE_INITIATED: 'SHARE_INITIATED',
    LINK_OPENED: 'LINK_OPENED',
    BOT_STARTED: 'BOT_STARTED',
    PHONE_PENDING: 'PHONE_PENDING',
    PHONE_MISMATCH: 'PHONE_MISMATCH',
    UNDER_REVIEW: 'UNDER_REVIEW',
    ACTIVATED: 'ACTIVATED',
    EXPIRED: 'EXPIRED'
});

// 3. Recommended Next Actions for Carrier
const NEXT_ACTIONS = Object.freeze({
    SEND_TICKET: 'Отправить билет',
    REMIND_PASSENGER: 'Напомнить пассажиру',
    REMIND_TELEGRAM: 'Напомнить о Telegram',
    REQUEST_PHONE: 'Попросить подтвердить номер',
    CHECK_PHONE: 'Сверить номер пассажира',
    REVIEW_REQUEST: 'Проверить заявку подтверждения',
    COMPLETED: 'Пассажир подключен ✓',
    RENEW_LINK: 'Обновить ссылку'
});

// 4. Allowed Share Channels
const ALLOWED_CHANNELS = Object.freeze(['whatsapp', 'sms', 'telegram', 'copy_link']);

// 5. Allowed Actor Types
const ALLOWED_ACTOR_TYPES = Object.freeze(['carrier', 'passenger', 'bot', 'system']);

/**
 * Safely masks a phone number for UI display and audit logging without leaking full PII.
 * Example: '+992900115050' -> '+992 ** *** 5050'
 * Example: '+79261234567' -> '+7 *** *** 4567'
 *
 * @param {string|null|undefined} rawPhone
 * @returns {string|null} Masked phone string or null if empty
 */
function maskPhoneNumber(rawPhone) {
    const normalized = normalizePhone(rawPhone);
    if (!normalized) return null;

    // +992 (Tajikistan: 9 digits after code)
    if (normalized.startsWith('+992') && normalized.length === 13) {
        const prefix = normalized.slice(0, 4); // '+992'
        const last4 = normalized.slice(-4);
        return `${prefix} ** *** ${last4}`;
    }

    // +7 (Russia / Kazakhstan: 10 digits after code)
    if (normalized.startsWith('+7') && normalized.length === 12) {
        const prefix = normalized.slice(0, 2); // '+7'
        const last4 = normalized.slice(-4);
        return `${prefix} *** *** ${last4}`;
    }

    // +998 (Uzbekistan: 9 digits after code)
    if (normalized.startsWith('+998') && normalized.length === 13) {
        const prefix = normalized.slice(0, 4);
        const last4 = normalized.slice(-4);
        return `${prefix} ** *** ${last4}`;
    }

    // Generic fallback: keep leading 3 chars and trailing 4 chars
    if (normalized.length >= 8) {
        const prefix = normalized.slice(0, 3);
        const last4 = normalized.slice(-4);
        return `${prefix} *** ${last4}`;
    }

    return '***';
}

/**
 * Sanitizes metadata to ensure no prohibited PII or secrets are logged into analytics.
 *
 * @param {Object} metadata
 * @returns {Object} Cleaned metadata object
 */
function sanitizeMetadata(metadata = {}) {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
        return {};
    }

    const cleaned = {};
    const forbiddenKeys = new Set([
        'passport', 'docnumber', 'doc_number', 'birthdate', 'birth_date',
        'rawtoken', 'raw_token', 'token', 'jwt', 'secret', 'bot_token',
        'password', 'credentials', 'card', 'cvv', 'fullphone', 'full_phone',
        'ip', 'user_agent', 'useragent'
    ]);

    for (const [key, value] of Object.entries(metadata)) {
        const lowerKey = key.toLowerCase();
        if (forbiddenKeys.has(lowerKey)) {
            continue;
        }

        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) {
            cleaned[key] = value;
        } else if (Array.isArray(value) && value.length <= 10) {
            cleaned[key] = value.slice(0, 10);
        } else if (typeof value === 'object' && value !== null) {
            cleaned[key] = sanitizeMetadata(value);
        }
    }

    return cleaned;
}

/**
 * Resolves the Supabase/PostgreSQL client.
 */
function getDb(options = {}) {
    return options.supabaseClient || options.dbClient || getServiceRoleClient() || require('../db');
}

/**
 * Computes the passenger activation status and recommended next action based on recorded events.
 * Analytical calculations:
 * - BOT_ABANDONED: bot started > 2 hours ago with no phone shared.
 * - EXPIRED: claim session expired without completed claim.
 *
 * @param {Array<Object>} events - Chronological array of journey events for a booking
 * @param {Object} [options={}] - Options including booking record, claim session, and reference time
 * @returns {Object} { status, nextAction, isBotAbandoned, isExpired, channel, recipientPhoneMasked }
 */
function computeJourneyStatusAndNextAction(events = [], options = {}) {
    const booking = options.booking || null;
    const claimSession = options.claimSession || null;
    const nowMs = options.nowMs || Date.now();
    const abandonThresholdMs = options.abandonThresholdMs || (2 * 60 * 60 * 1000); // 2 hours default

    // If booking is already confirmed claimed
    if (booking && (booking.claim_status === 'claimed' || booking.claimed_by_user_id)) {
        return {
            status: JOURNEY_STATUSES.ACTIVATED,
            nextAction: NEXT_ACTIONS.COMPLETED,
            isBotAbandoned: false,
            isExpired: false,
            latestEvent: events[events.length - 1] || null
        };
    }

    // Analytical check for claim session expiration
    let isExpired = false;
    if (claimSession?.expires_at) {
        const expiresAtMs = new Date(claimSession.expires_at).getTime();
        if (expiresAtMs > 0 && expiresAtMs < nowMs) {
            isExpired = true;
        }
    }

    // Scan events for milestone presence and latest occurrences
    let hasCreated = false;
    let hasShareInitiated = false;
    let hasLinkOpened = false;
    let hasTgCtaClicked = false;
    let hasBotStarted = false;
    let hasPhoneShared = false;
    let hasPhoneMismatch = false;
    let hasClaimRequest = false;
    let hasClaimCompleted = false;

    let botStartedAtMs = null;
    let latestShareChannel = null;
    let latestPhoneMasked = null;

    // Events are sorted chronologically
    for (const ev of events) {
        if (!ev || !ev.event_type) continue;

        if (ev.recipient_phone_masked) latestPhoneMasked = ev.recipient_phone_masked;
        if (ev.channel) latestShareChannel = ev.channel;

        switch (ev.event_type) {
            case JOURNEY_EVENT_TYPES.BOOKING_CREATED:
                hasCreated = true;
                break;
            case JOURNEY_EVENT_TYPES.SHARE_INITIATED:
                hasShareInitiated = true;
                break;
            case JOURNEY_EVENT_TYPES.LINK_OPENED:
                hasLinkOpened = true;
                break;
            case JOURNEY_EVENT_TYPES.TELEGRAM_CTA_CLICKED:
                hasTgCtaClicked = true;
                break;
            case JOURNEY_EVENT_TYPES.TELEGRAM_BOT_STARTED:
                hasBotStarted = true;
                if (ev.created_at) {
                    botStartedAtMs = new Date(ev.created_at).getTime();
                }
                break;
            case JOURNEY_EVENT_TYPES.PHONE_SHARED:
                hasPhoneShared = true;
                break;
            case JOURNEY_EVENT_TYPES.PHONE_MISMATCH:
                hasPhoneMismatch = true;
                break;
            case JOURNEY_EVENT_TYPES.CLAIM_REQUEST_CREATED:
                hasClaimRequest = true;
                break;
            case JOURNEY_EVENT_TYPES.CLAIM_COMPLETED:
            case JOURNEY_EVENT_TYPES.ACTIVATION_COMPLETED:
                hasClaimCompleted = true;
                break;
            default:
                break;
        }
    }

    // 1. Activated
    if (hasClaimCompleted) {
        return {
            status: JOURNEY_STATUSES.ACTIVATED,
            nextAction: NEXT_ACTIONS.COMPLETED,
            isBotAbandoned: false,
            isExpired: false,
            channel: latestShareChannel,
            recipientPhoneMasked: latestPhoneMasked
        };
    }

    // 2. Expired session analytical state
    if (isExpired && !hasClaimCompleted) {
        return {
            status: JOURNEY_STATUSES.EXPIRED,
            nextAction: NEXT_ACTIONS.RENEW_LINK,
            isBotAbandoned: false,
            isExpired: true,
            channel: latestShareChannel,
            recipientPhoneMasked: latestPhoneMasked
        };
    }

    // 3. Phone Mismatch or Under Review
    if (hasClaimRequest || hasPhoneMismatch) {
        return {
            status: hasClaimRequest ? JOURNEY_STATUSES.UNDER_REVIEW : JOURNEY_STATUSES.PHONE_MISMATCH,
            nextAction: hasClaimRequest ? NEXT_ACTIONS.REVIEW_REQUEST : NEXT_ACTIONS.CHECK_PHONE,
            isBotAbandoned: false,
            isExpired: false,
            channel: latestShareChannel,
            recipientPhoneMasked: latestPhoneMasked
        };
    }

    // 4. Bot Started
    if (hasBotStarted) {
        const isBotAbandoned = !hasPhoneShared && botStartedAtMs != null && (nowMs - botStartedAtMs > abandonThresholdMs);
        return {
            status: hasPhoneShared ? JOURNEY_STATUSES.PHONE_PENDING : JOURNEY_STATUSES.BOT_STARTED,
            nextAction: NEXT_ACTIONS.REQUEST_PHONE,
            isBotAbandoned,
            isExpired: false,
            channel: latestShareChannel,
            recipientPhoneMasked: latestPhoneMasked
        };
    }

    // 5. Link Opened
    if (hasLinkOpened || hasTgCtaClicked) {
        return {
            status: JOURNEY_STATUSES.LINK_OPENED,
            nextAction: NEXT_ACTIONS.REMIND_TELEGRAM,
            isBotAbandoned: false,
            isExpired: false,
            channel: latestShareChannel,
            recipientPhoneMasked: latestPhoneMasked
        };
    }

    // 6. Share Initiated
    if (hasShareInitiated) {
        return {
            status: JOURNEY_STATUSES.SHARE_INITIATED,
            nextAction: NEXT_ACTIONS.REMIND_PASSENGER,
            isBotAbandoned: false,
            isExpired: false,
            channel: latestShareChannel,
            recipientPhoneMasked: latestPhoneMasked
        };
    }

    // 7. Not Shared
    return {
        status: JOURNEY_STATUSES.NOT_SHARED,
        nextAction: NEXT_ACTIONS.SEND_TICKET,
        isBotAbandoned: false,
        isExpired: false,
        channel: latestShareChannel,
        recipientPhoneMasked: latestPhoneMasked
    };
}

/**
 * Records an append-only event in booking_journey_events.
 * Enforces multi-level idempotency, phone masking, metadata sanitization, and graceful failure isolation.
 *
 * @param {number} bookingId - Numeric booking ID (int4)
 * @param {Object} eventData - { eventType, handoffId, sessionId, channel, actorType, actorId, phone, metadata }
 * @param {Object} [options={}] - DB client and runtime options
 * @returns {Promise<Object>} { success, event, isDuplicate, error }
 */
async function recordJourneyEvent(bookingId, eventData = {}, options = {}) {
    if (!bookingId || isNaN(Number(bookingId))) {
        throw new Error('Valid bookingId is required to record journey event');
    }

    const eventType = eventData.eventType;
    if (!eventType || !JOURNEY_EVENT_TYPES[eventType]) {
        throw new Error(`Invalid eventType: ${eventType}`);
    }

    const actorType = eventData.actorType || 'system';
    if (!ALLOWED_ACTOR_TYPES.includes(actorType)) {
        throw new Error(`Invalid actorType: ${actorType}`);
    }

    const channel = eventData.channel && ALLOWED_CHANNELS.includes(eventData.channel) ? eventData.channel : null;
    const dbClient = getDb(options);
    const nowIso = new Date().toISOString();
    const maskedPhone = eventData.phone ? maskPhoneNumber(eventData.phone) : (eventData.recipientPhoneMasked || null);
    const sanitizedMeta = sanitizeMetadata(eventData.metadata || {});

    try {
        // Multi-level Idempotency Check:
        // A. Booking-level milestones (max 1 per booking_id)
        const bookingMilestones = [
            JOURNEY_EVENT_TYPES.BOOKING_CREATED,
            JOURNEY_EVENT_TYPES.CLAIM_COMPLETED,
            JOURNEY_EVENT_TYPES.BOOKING_LINKED_TO_USER,
            JOURNEY_EVENT_TYPES.ACTIVATION_COMPLETED
        ];

        if (bookingMilestones.includes(eventType)) {
            const { data: existing } = await dbClient
                .from('booking_journey_events')
                .select('id, event_type, created_at')
                .eq('booking_id', Number(bookingId))
                .eq('event_type', eventType)
                .maybeSingle();

            if (existing) {
                return { success: true, event: existing, isDuplicate: true };
            }
        }

        // B. Handoff-level milestones (SHARE_INITIATED, LINK_OPENED with handoff)
        if (eventData.handoffId && eventType === JOURNEY_EVENT_TYPES.SHARE_INITIATED) {
            const { data: existing } = await dbClient
                .from('booking_journey_events')
                .select('id, event_type, created_at')
                .eq('handoff_id', eventData.handoffId)
                .eq('event_type', eventType)
                .maybeSingle();

            if (existing) {
                return { success: true, event: existing, isDuplicate: true };
            }
        }

        // C. Dual LINK_OPENED Idempotency
        if (eventType === JOURNEY_EVENT_TYPES.LINK_OPENED) {
            if (eventData.handoffId) {
                // Case A: Attributed to handoff
                const { data: existing } = await dbClient
                    .from('booking_journey_events')
                    .select('id, event_type, created_at')
                    .eq('handoff_id', eventData.handoffId)
                    .eq('event_type', eventType)
                    .maybeSingle();

                if (existing) {
                    return { success: true, event: existing, isDuplicate: true };
                }
            } else {
                // Case B: Unattributed (max 1 per booking_id where handoff_id is null)
                const { data: existing } = await dbClient
                    .from('booking_journey_events')
                    .select('id, event_type, handoff_id')
                    .eq('booking_id', Number(bookingId))
                    .eq('event_type', eventType)
                    .is('handoff_id', null)
                    .maybeSingle();

                if (existing) {
                    return { success: true, event: existing, isDuplicate: true };
                }
            }
        }

        // C. Session-level milestones (max 1 per session_id)
        const sessionMilestones = [
            JOURNEY_EVENT_TYPES.TELEGRAM_BOT_STARTED,
            JOURNEY_EVENT_TYPES.PHONE_SHARE_REQUESTED,
            JOURNEY_EVENT_TYPES.PHONE_SHARED
        ];

        if (eventData.sessionId && sessionMilestones.includes(eventType)) {
            const { data: existing } = await dbClient
                .from('booking_journey_events')
                .select('id, event_type, created_at')
                .eq('session_id', eventData.sessionId)
                .eq('event_type', eventType)
                .maybeSingle();

            if (existing) {
                return { success: true, event: existing, isDuplicate: true };
            }
        }

        // D. Session phone outcome (only 1 verification outcome per session: PHONE_VERIFIED or PHONE_MISMATCH)
        if (eventData.sessionId && [JOURNEY_EVENT_TYPES.PHONE_VERIFIED, JOURNEY_EVENT_TYPES.PHONE_MISMATCH].includes(eventType)) {
            const { data: existing } = await dbClient
                .from('booking_journey_events')
                .select('id, event_type, created_at')
                .eq('session_id', eventData.sessionId)
                .in('event_type', [JOURNEY_EVENT_TYPES.PHONE_VERIFIED, JOURNEY_EVENT_TYPES.PHONE_MISMATCH])
                .maybeSingle();

            if (existing) {
                return { success: true, event: existing, isDuplicate: true };
            }
        }

        // Insert the new journey event
        const insertPayload = {
            booking_id: Number(bookingId),
            handoff_id: eventData.handoffId || null,
            session_id: eventData.sessionId || null,
            event_type: eventType,
            channel: channel,
            actor_type: actorType,
            actor_id: eventData.actorId ? String(eventData.actorId) : null,
            recipient_phone_masked: maskedPhone,
            metadata: sanitizedMeta,
            created_at: nowIso
        };

        const { data: inserted, error: insertError } = await dbClient
            .from('booking_journey_events')
            .insert([insertPayload])
            .select('*')
            .single();

        if (insertError) {
            // Handle PostgreSQL unique constraint conflict (code 23505) gracefully
            if (insertError.code === '23505') {
                return { success: true, isDuplicate: true, error: insertError.message };
            }
            // Failure isolation: log warning without crashing caller
            console.warn('[JourneyHelper] recordJourneyEvent insert failed:', insertError.message);
            return { success: false, error: insertError.message, tableMissing: insertError.code === '42P01' };
        }

        // Update handoff last_event_at and opened_at if handoff_id is provided
        if (eventData.handoffId) {
            try {
                const handoffUpdates = { last_event_at: nowIso };
                if (eventType === JOURNEY_EVENT_TYPES.LINK_OPENED) {
                    handoffUpdates.opened_at = nowIso;
                }

                await dbClient
                    .from('booking_handoffs')
                    .update(handoffUpdates)
                    .eq('id', eventData.handoffId);
            } catch (updateErr) {
                console.warn('[JourneyHelper] Failed to update handoff timestamp:', updateErr.message);
            }
        }

        return { success: true, event: inserted, isDuplicate: false };
    } catch (err) {
        // Failure isolation: unexpected error never bubbles up to break core operations
        console.warn('[JourneyHelper] recordJourneyEvent caught unexpected error:', err.message);
        return { success: false, error: err.message };
    }
}

/**
 * Creates a new booking handoff attempt in booking_handoffs and automatically
 * logs the SHARE_INITIATED event linked to this handoff.
 *
 * Atomicity guarantee:
 * 1. Attempts PostgreSQL RPC function fn_create_booking_handoff (atomic transaction).
 * 2. If RPC not available (e.g. mock DB or prior to migration), executes 2-step insert
 *    with strict compensation: if SHARE_INITIATED fails, the created handoff is rolled back.
 *
 * @param {number} bookingId - Numeric booking ID (int4)
 * @param {Object} handoffData - { channel, claimSessionId, phone, initiatedByUserId, metadata }
 * @param {Object} [options={}] - DB client and runtime options
 * @returns {Promise<Object>} { success, handoff, event }
 */
async function createBookingHandoff(bookingId, handoffData = {}, options = {}) {
    if (!bookingId || isNaN(Number(bookingId))) {
        throw new Error('Valid bookingId is required to create handoff');
    }

    const channel = handoffData.channel;
    if (!channel || !ALLOWED_CHANNELS.includes(channel)) {
        throw new Error(`Invalid channel: ${channel}. Must be one of: ${ALLOWED_CHANNELS.join(', ')}`);
    }

    const dbClient = getDb(options);
    const maskedPhone = handoffData.phone ? maskPhoneNumber(handoffData.phone) : null;
    const sanitizedMeta = sanitizeMetadata(handoffData.metadata || {});

    // 1. Unit Testing Mock Adapter ONLY (when options.isMock is explicitly true or mock DB object is flagged)
    if (options.isMock === true || options.dbClient?.isMock === true) {
        const nowIso = new Date().toISOString();
        const handoffPayload = {
            booking_id: Number(bookingId),
            claim_session_id: handoffData.claimSessionId || null,
            channel: channel,
            recipient_phone_masked: maskedPhone,
            initiated_by_user_id: handoffData.initiatedByUserId ? Number(handoffData.initiatedByUserId) : null,
            created_at: nowIso,
            opened_at: null,
            last_event_at: nowIso
        };

        const { data: handoff, error: handoffError } = await dbClient
            .from('booking_handoffs')
            .insert([handoffPayload])
            .select('*')
            .single();

        if (handoffError || !handoff) {
            throw new Error(handoffError?.message || 'Failed to create booking handoff in mock adapter');
        }

        const eventRes = await recordJourneyEvent(bookingId, {
            eventType: JOURNEY_EVENT_TYPES.SHARE_INITIATED,
            handoffId: handoff.id,
            sessionId: handoffData.claimSessionId || null,
            channel: channel,
            actorType: 'carrier',
            actorId: handoffData.initiatedByUserId ? String(handoffData.initiatedByUserId) : null,
            recipientPhoneMasked: maskedPhone,
            metadata: sanitizedMeta
        }, options);

        if (!eventRes.success && !eventRes.isDuplicate) {
            await dbClient.from('booking_handoffs').delete().eq('id', handoff.id);
            throw new Error(eventRes.error || 'Failed to record initial share event for handoff in mock adapter');
        }

        return {
            success: true,
            handoff,
            event: eventRes.event
        };
    }

    // 2. PRODUCTION SUPABASE ADAPTER:
    // Strictly requires atomic PostgreSQL RPC fn_create_booking_handoff.
    // Non-atomic two-step inserts with compensation DELETE are strictly prohibited in production.
    if (typeof dbClient.rpc !== 'function') {
        throw new Error('Database client does not support RPC calls');
    }

    const { data: rpcRes, error: rpcErr } = await dbClient.rpc('fn_create_booking_handoff', {
        p_booking_id: Number(bookingId),
        p_channel: channel,
        p_claim_session_id: handoffData.claimSessionId || null,
        p_recipient_phone_masked: maskedPhone,
        p_initiated_by_user_id: handoffData.initiatedByUserId ? Number(handoffData.initiatedByUserId) : null,
        p_metadata: sanitizedMeta
    });

    if (rpcErr || !rpcRes || !rpcRes.success) {
        const errorMsg = rpcErr?.message || rpcRes?.error || 'RPC fn_create_booking_handoff failed';
        console.error('[JourneyHelper] fn_create_booking_handoff error:', errorMsg);
        throw new Error(errorMsg);
    }

    return {
        success: true,
        handoff: {
            id: rpcRes.handoff_id,
            booking_id: Number(bookingId),
            claim_session_id: handoffData.claimSessionId || null,
            channel: channel,
            recipient_phone_masked: maskedPhone,
            initiated_by_user_id: handoffData.initiatedByUserId ? Number(handoffData.initiatedByUserId) : null,
            created_at: rpcRes.created_at,
            opened_at: null,
            last_event_at: rpcRes.created_at
        },
        event: {
            id: rpcRes.event_id,
            booking_id: Number(bookingId),
            handoff_id: rpcRes.handoff_id,
            event_type: JOURNEY_EVENT_TYPES.SHARE_INITIATED,
            channel: channel
        }
    };
}

/**
 * Loads the full journey state and timeline for a booking.
 *
 * @param {number} bookingId - Numeric booking ID (int4)
 * @param {Object} [options={}] - DB client and runtime options
 * @returns {Promise<Object>} { success, bookingId, status, nextAction, isBotAbandoned, isExpired, handoffs, events }
 */
async function getBookingJourney(bookingId, options = {}) {
    if (!bookingId || isNaN(Number(bookingId))) {
        throw new Error('Valid bookingId is required to get booking journey');
    }

    const dbClient = getDb(options);

    // Fetch booking
    const { data: booking, error: bErr } = await dbClient
        .from('bus_ticket_bookings')
        .select('id, bus_ticket_id, status, claim_status, claimed_by_user_id, claimed_at, phone, channel, source_type')
        .eq('id', Number(bookingId))
        .single();

    if (bErr || !booking) {
        return { success: false, error: 'BOOKING_NOT_FOUND' };
    }

    // Fetch handoffs
    const { data: handoffs } = await dbClient
        .from('booking_handoffs')
        .select('*')
        .eq('booking_id', Number(bookingId))
        .order('created_at', { ascending: true });

    // Fetch events
    const { data: events } = await dbClient
        .from('booking_journey_events')
        .select('*')
        .eq('booking_id', Number(bookingId))
        .order('created_at', { ascending: true });

    const safeEvents = events || [];
    const statusData = computeJourneyStatusAndNextAction(safeEvents, {
        booking,
        nowMs: options.nowMs || Date.now()
    });

    return {
        success: true,
        bookingId: Number(bookingId),
        status: statusData.status,
        nextAction: statusData.nextAction,
        isBotAbandoned: statusData.isBotAbandoned,
        isExpired: statusData.isExpired,
        channel: statusData.channel,
        recipientPhoneMasked: statusData.recipientPhoneMasked,
        handoffs: handoffs || [],
        events: safeEvents
    };
}

module.exports = {
    JOURNEY_EVENT_TYPES,
    JOURNEY_STATUSES,
    NEXT_ACTIONS,
    ALLOWED_CHANNELS,
    ALLOWED_ACTOR_TYPES,
    maskPhoneNumber,
    sanitizeMetadata,
    computeJourneyStatusAndNextAction,
    recordJourneyEvent,
    createBookingHandoff,
    getBookingJourney
};
