/**
 * claimHelper.js
 * 
 * Offline Booking Claim & Passenger Onboarding Engine (Phase E.2A.1)
 * Project: POPUTKI.ONLINE
 * 
 * Atomicity & Invariants:
 * - Atomic predicate: status = 'confirmed' AND claim_status != 'claimed' AND claimed_by_user_id IS NULL
 * - SHA-256 token hash storage: raw bearer token is NEVER stored in database
 * - Safe Telegram deep links (https://t.me/Poputkionline_bot?start=claim_<opaqueToken>)
 * - Session lifecycle: created -> opened (trip summary) -> consumed (claim completion)
 * - Auto-claim verification policy:
 *     - Only when contact_role === 'passenger' AND Telegram-verified phone matches booking phone
 * - Family / Coordinator / Unknown / Mismatch protection:
 *     - Never auto-claims; routes to idempotent pending carrier verification request
 * - Concurrency protection: exactly one owner establishes claim; losing requests superseded
 * - Carrier review and approval workflow with tenant isolation
 */

const crypto = require('crypto');
const supabase = require('../db');
const { cleanPhoneForStorage } = require('./phoneHelper');

const CLAIM_SESSION_TTL_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Computes a SHA-256 hash for secure bearer token storage and lookup.
 * @param {string} token - Raw random token
 * @returns {string} Hex SHA-256 hash
 */
function hashSessionToken(token) {
    if (!token || typeof token !== 'string') return '';
    return crypto.createHash('sha256').update(token.trim()).digest('hex');
}

/**
 * Creates a short-lived opaque claim session for an eligible manual booking.
 * 
 * @param {number|Object} booking - Booking ID or booking object
 * @param {Object} [options={}] - { supabaseClient, ttlMs }
 * @returns {Promise<{ sessionToken: string, expiresAt: string, deepLink: string }>}
 */
async function generateClaimSession(booking, options = {}) {
    const dbClient = options.supabaseClient || supabase;
    const bookingId = typeof booking === 'object' ? booking.id : booking;
    const ttl = options.ttlMs || CLAIM_SESSION_TTL_MS;

    const rawToken = crypto.randomBytes(16).toString('hex');
    const tokenHash = hashSessionToken(rawToken);
    const expiresAt = new Date(Date.now() + ttl).toISOString();

    const { data: session, error } = await dbClient
        .from('booking_claim_sessions')
        .insert([{
            booking_id: bookingId,
            session_token_hash: tokenHash,
            expires_at: expiresAt,
            created_at: new Date().toISOString()
        }])
        .select('*')
        .single();

    if (error) {
        throw new Error('Failed to create claim session: ' + error.message);
    }

    const botUsername = process.env.TELEGRAM_BOT_USERNAME || 'Poputkionline_bot';
    const deepLink = `https://t.me/${botUsername}?start=claim_${rawToken}`;

    return {
        sessionToken: rawToken,
        expiresAt,
        deepLink
    };
}

/**
 * Resolves and validates a claim session token via SHA-256 hash.
 * 
 * @param {string} sessionToken - Raw bearer token
 * @param {Object} [options={}] - { supabaseClient, markOpened }
 * @returns {Promise<{ isValid: boolean, reason?: string, session?: Object, booking?: Object }>}
 */
async function resolveClaimSession(sessionToken, options = {}) {
    const dbClient = options.supabaseClient || supabase;
    if (!sessionToken || typeof sessionToken !== 'string') {
        return { isValid: false, reason: 'INVALID_SESSION_TOKEN' };
    }

    const cleanToken = sessionToken.replace(/^claim_/, '').trim();
    if (!cleanToken || cleanToken.length < 16) {
        return { isValid: false, reason: 'INVALID_SESSION_TOKEN' };
    }

    const tokenHash = hashSessionToken(cleanToken);

    const { data: session, error: sessionErr } = await dbClient
        .from('booking_claim_sessions')
        .select('*')
        .eq('session_token_hash', tokenHash)
        .single();

    if (sessionErr || !session) {
        return { isValid: false, reason: 'SESSION_NOT_FOUND' };
    }

    if (session.consumed_at) {
        return { isValid: false, reason: 'SESSION_ALREADY_CONSUMED', session };
    }

    if (new Date(session.expires_at) < new Date()) {
        return { isValid: false, reason: 'SESSION_EXPIRED', session };
    }

    // Fetch linked booking
    const { data: booking, error: bookErr } = await dbClient
        .from('bus_ticket_bookings')
        .select('*')
        .eq('id', session.booking_id)
        .single();

    if (bookErr || !booking) {
        return { isValid: false, reason: 'BOOKING_NOT_FOUND', session };
    }

    if (booking.status !== 'confirmed') {
        return { isValid: false, reason: 'BOOKING_NOT_CONFIRMED', session, booking };
    }

    if (booking.claim_status === 'claimed' || booking.claimed_by_user_id) {
        return { isValid: false, reason: 'ALREADY_CLAIMED', session, booking };
    }

    // Mark opened if requested and not yet marked
    if (options.markOpened && !session.opened_at) {
        await dbClient
            .from('booking_claim_sessions')
            .update({ opened_at: new Date().toISOString() })
            .eq('id', session.id);
    }

    return {
        isValid: true,
        session,
        booking
    };
}

/**
 * Evaluates whether an authenticated Telegram user can auto-claim the booking.
 * 
 * @param {Object} booking - Booking row
 * @param {Object} verifiedUser - Platform user { id, phone, telegram_id }
 * @param {Object} telegramContact - Verified Telegram contact payload { phone_number, user_id }
 * @param {number|string} telegramSenderId - message.from.id
 * @returns {{ canAutoClaim: boolean, reason?: string }}
 */
function evaluateAutoClaimEligibility(booking, verifiedUser, telegramContact = {}, telegramSenderId = null) {
    if (!booking || booking.claim_status === 'claimed' || booking.claimed_by_user_id) {
        return { canAutoClaim: false, reason: 'ALREADY_CLAIMED' };
    }

    if (booking.status !== 'confirmed') {
        return { canAutoClaim: false, reason: 'BOOKING_INELIGIBLE' };
    }

    // 1. Contact security: Telegram contact must be shared natively from the sender
    if (telegramContact.user_id && telegramSenderId && String(telegramContact.user_id) !== String(telegramSenderId)) {
        return { canAutoClaim: false, reason: 'TELEGRAM_CONTACT_USER_ID_MISMATCH' };
    }

    // Reject manually typed contact without native user_id or native contact flag
    if (!telegramContact.phone_number) {
        return { canAutoClaim: false, reason: 'MISSING_CONTACT_PHONE' };
    }

    const sharedPhone = cleanPhoneForStorage(telegramContact.phone_number || (verifiedUser && verifiedUser.phone));
    const bookingPhone = cleanPhoneForStorage(booking.phone);

    // 2. Strict Role Policy: Only contact_role === 'passenger' can auto-claim
    if (booking.contact_role !== 'passenger') {
        return {
            canAutoClaim: false,
            reason: booking.contact_role === 'family_or_group'
                ? 'FAMILY_GROUP_CONTACT_REQUIRES_APPROVAL'
                : booking.contact_role === 'coordinator'
                    ? 'COORDINATOR_CONTACT_REQUIRES_APPROVAL'
                    : 'UNKNOWN_ROLE_REQUIRES_APPROVAL'
        };
    }

    // 3. Phone matching: normalized shared phone must match normalized booking phone
    if (!bookingPhone || !sharedPhone || sharedPhone !== bookingPhone) {
        return { canAutoClaim: false, reason: 'PHONE_MISMATCH_REQUIRES_APPROVAL' };
    }

    return { canAutoClaim: true };
}

/**
 * Atomically claims an offline booking for a verified passenger account.
 * 
 * @param {number} bookingId
 * @param {number} userId - Claiming user ID
 * @param {Object} [options={}] - { supabaseClient, sessionId }
 * @returns {Promise<{ success: boolean, booking?: Object, error?: string }>}
 */
async function executeAtomicClaim(bookingId, userId, options = {}) {
    const dbClient = options.supabaseClient || supabase;
    const nowIso = new Date().toISOString();

    try {
        // Atomic conditional update predicate: status = confirmed AND claim_status != claimed AND claimed_by_user_id IS NULL
        const { data: updated, error } = await dbClient
            .from('bus_ticket_bookings')
            .update({
                claim_status: 'claimed',
                claimed_by_user_id: userId,
                claimed_at: nowIso
            })
            .eq('id', bookingId)
            .eq('status', 'confirmed') // Atomic confirmation invariant
            .neq('claim_status', 'claimed') // Concurrency guard
            .is('claimed_by_user_id', null) // Immutability guard
            .select('*')
            .single();

        if (error || !updated) {
            return { success: false, error: 'BOOKING_INELIGIBLE_OR_ALREADY_CLAIMED' };
        }

        // Mark claim session consumed only after successful atomic update
        if (options.sessionId) {
            await dbClient
                .from('booking_claim_sessions')
                .update({ consumed_at: nowIso })
                .eq('id', options.sessionId);
        }

        // Supersede competing pending requests
        await dbClient
            .from('booking_claim_requests')
            .update({
                status: 'superseded',
                failure_reason_code: 'SUPERSEDED_BY_CLAIM'
            })
            .eq('booking_id', bookingId)
            .eq('status', 'pending');

        return { success: true, booking: updated };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

/**
 * Submits an idempotent pending claim verification request for carrier review.
 * 
 * @param {number} bookingId
 * @param {number} userId
 * @param {Object} verificationDetails - { method, reason }
 * @param {Object} [options={}] - { supabaseClient, sessionId }
 * @returns {Promise<{ success: boolean, requestId?: string, isExisting?: boolean, error?: string }>}
 */
async function createClaimRequest(bookingId, userId, verificationDetails = {}, options = {}) {
    const dbClient = options.supabaseClient || supabase;

    try {
        // Check for existing pending request (idempotency guard)
        const { data: existing } = await dbClient
            .from('booking_claim_requests')
            .select('*')
            .eq('booking_id', bookingId)
            .eq('requesting_user_id', userId)
            .eq('status', 'pending')
            .maybeSingle();

        if (existing) {
            await dbClient
                .from('booking_claim_requests')
                .update({
                    attempt_count: (existing.attempt_count || 1) + 1,
                    failure_reason_code: verificationDetails.reason || existing.failure_reason_code
                })
                .eq('id', existing.id);

            // Mark session consumed
            if (options.sessionId) {
                await dbClient
                    .from('booking_claim_sessions')
                    .update({ consumed_at: new Date().toISOString() })
                    .eq('id', options.sessionId);
            }

            return { success: true, requestId: existing.id, isExisting: true };
        }

        // Update booking state to pending_verification if still unclaimed
        await dbClient
            .from('bus_ticket_bookings')
            .update({ claim_status: 'pending_verification' })
            .eq('id', bookingId)
            .eq('status', 'confirmed')
            .eq('claim_status', 'unclaimed');

        const { data: request, error } = await dbClient
            .from('booking_claim_requests')
            .insert([{
                booking_id: bookingId,
                requesting_user_id: userId,
                verification_method: verificationDetails.method || 'telegram_contact',
                status: 'pending',
                failure_reason_code: verificationDetails.reason || null,
                created_at: new Date().toISOString()
            }])
            .select('*')
            .single();

        if (error) throw error;

        // Mark claim session consumed only after successfully recording request
        if (options.sessionId) {
            await dbClient
                .from('booking_claim_sessions')
                .update({ consumed_at: new Date().toISOString() })
                .eq('id', options.sessionId);
        }

        return { success: true, requestId: request.id, isExisting: false };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

/**
 * Allows authorized carrier dispatcher to review and approve/reject a claim request.
 * 
 * @param {string} requestId
 * @param {number} carrierUserId
 * @param {'approved'|'rejected'} decision
 * @param {Object} [options={}] - { reason, supabaseClient, enforceTenant }
 * @returns {Promise<{ success: boolean, status?: string, error?: string }>}
 */
async function reviewClaimRequest(requestId, carrierUserId, decision, options = {}) {
    const dbClient = options.supabaseClient || supabase;
    const nowIso = new Date().toISOString();

    const { data: request, error: reqErr } = await dbClient
        .from('booking_claim_requests')
        .select('*, bus_ticket_bookings!inner(*, bus_tickets!inner(*))')
        .eq('id', requestId)
        .single();

    if (reqErr || !request) {
        return { success: false, error: 'CLAIM_REQUEST_NOT_FOUND' };
    }

    if (request.status !== 'pending') {
        return { success: false, error: 'REQUEST_ALREADY_REVIEWED' };
    }

    // Tenant isolation: verify booking belongs to carrier's trips
    const trip = request.bus_ticket_bookings?.bus_tickets;
    if (trip && trip.carrier_id && trip.carrier_id !== carrierUserId && trip.created_by_user_id !== carrierUserId) {
        if (options.enforceTenant !== false) {
            return { success: false, error: 'TENANT_UNAUTHORIZED' };
        }
    }

    if (decision === 'approved') {
        const claimResult = await executeAtomicClaim(request.booking_id, request.requesting_user_id, { supabaseClient: dbClient });
        if (!claimResult.success) {
            // Supersede request due to booking ineligibility
            await dbClient
                .from('booking_claim_requests')
                .update({
                    status: 'superseded',
                    failure_reason_code: 'BOOKING_NO_LONGER_ELIGIBLE',
                    reviewed_by_user_id: carrierUserId,
                    reviewed_at: nowIso
                })
                .eq('id', requestId);

            return { success: false, error: claimResult.error };
        }

        await dbClient
            .from('booking_claim_requests')
            .update({
                status: 'approved',
                reviewed_by_user_id: carrierUserId,
                reviewed_at: nowIso
            })
            .eq('id', requestId);

        // Supersede competing pending requests
        await dbClient
            .from('booking_claim_requests')
            .update({
                status: 'superseded',
                failure_reason_code: 'SUPERSEDED_BY_CARRIER_APPROVAL'
            })
            .eq('booking_id', request.booking_id)
            .neq('id', requestId)
            .eq('status', 'pending');

        return { success: true, status: 'approved' };
    } else {
        // Rejected: record rejection metadata
        await dbClient
            .from('booking_claim_requests')
            .update({
                status: 'rejected',
                failure_reason_code: options.reason || 'CARRIER_REJECTED',
                reviewed_by_user_id: carrierUserId,
                reviewed_at: nowIso
            })
            .eq('id', requestId);

        // Restore booking claim_status to unclaimed IF no other pending requests exist
        const { data: otherPending } = await dbClient
            .from('booking_claim_requests')
            .select('id')
            .eq('booking_id', request.booking_id)
            .eq('status', 'pending')
            .limit(1);

        if (!otherPending || otherPending.length === 0) {
            await dbClient
                .from('bus_ticket_bookings')
                .update({ claim_status: 'unclaimed' })
                .eq('id', request.booking_id)
                .eq('claim_status', 'pending_verification')
                .is('claimed_by_user_id', null);
        }

        return { success: true, status: 'rejected' };
    }
}

module.exports = {
    CLAIM_SESSION_TTL_MS,
    hashSessionToken,
    generateClaimSession,
    resolveClaimSession,
    evaluateAutoClaimEligibility,
    executeAtomicClaim,
    createClaimRequest,
    reviewClaimRequest
};
