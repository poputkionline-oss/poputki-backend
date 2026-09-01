/**
 * claimHelper.js
 *
 * Offline Booking Claim & Passenger Onboarding Engine (Phase E.2B)
 * Project: POPUTKI.ONLINE
 *
 * Security & invariants:
 * - Claim-table access is server-only via Supabase service role by default.
 * - Raw claim bearer tokens are never stored; only SHA-256 hashes are persisted.
 * - Production ownership transitions use transactional PostgreSQL RPCs.
 * - Tests may inject a mock Supabase client; injected mocks keep the previous
 *   conditional-update behavior and never require production credentials.
 * - Legacy trips with carrier_id = NULL belong only to created_by_user_id.
 */

const crypto = require('crypto');
const { getServiceRoleClient } = require('../dbServiceRole');
const { cleanPhoneForStorage } = require('./phoneHelper');

const CLAIM_SESSION_TTL_MS = 15 * 60 * 1000;

function getClaimDb(options = {}) {
    return options.supabaseClient || getServiceRoleClient();
}

function isInjectedMock(options = {}) {
    return Boolean(options.supabaseClient && typeof options.supabaseClient.rpc !== 'function');
}

function tripBelongsToCarrier(trip, carrierId) {
    if (!trip || carrierId == null) return false;

    const normalizedCarrierId = Number(carrierId);
    if (!Number.isFinite(normalizedCarrierId)) return false;

    if (trip.carrier_id != null) {
        return Number(trip.carrier_id) === normalizedCarrierId;
    }

    return trip.created_by_user_id != null
        && Number(trip.created_by_user_id) === normalizedCarrierId;
}

function hashSessionToken(token) {
    if (!token || typeof token !== 'string') return '';
    return crypto.createHash('sha256').update(token.trim()).digest('hex');
}

async function generateClaimSession(booking, options = {}) {
    const dbClient = getClaimDb(options);
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

async function resolveClaimSession(sessionToken, options = {}) {
    const dbClient = getClaimDb(options);
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

    if (new Date(session.expires_at) <= new Date()) {
        return { isValid: false, reason: 'SESSION_EXPIRED', session };
    }

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

    if (options.markOpened && !session.opened_at) {
        if (isInjectedMock(options)) {
            await dbClient
                .from('booking_claim_sessions')
                .update({ opened_at: new Date().toISOString() })
                .eq('id', session.id);
        } else {
            await dbClient
                .from('booking_claim_sessions')
                .update({ opened_at: new Date().toISOString() })
                .eq('id', session.id)
                .eq('booking_id', booking.id)
                .is('consumed_at', null);
        }
    }

    return {
        isValid: true,
        session,
        booking
    };
}

function evaluateAutoClaimEligibility(booking, verifiedUser, telegramContact = {}, telegramSenderId = null) {
    if (!booking || booking.claim_status === 'claimed' || booking.claimed_by_user_id) {
        return { canAutoClaim: false, reason: 'ALREADY_CLAIMED' };
    }

    if (booking.status !== 'confirmed') {
        return { canAutoClaim: false, reason: 'BOOKING_INELIGIBLE' };
    }

    if (!verifiedUser || !verifiedUser.id) {
        return { canAutoClaim: false, reason: 'USER_NOT_REGISTERED' };
    }

    // STRICT FORGED CONTACT GUARD:
    // If a contact card object is provided with a user_id that differs from telegramSenderId, reject immediately.
    if (telegramContact && telegramContact.user_id && telegramSenderId
        && String(telegramContact.user_id) !== String(telegramSenderId)) {
        return { canAutoClaim: false, reason: 'TELEGRAM_CONTACT_USER_ID_MISMATCH' };
    }

    const bookingPhone = cleanPhoneForStorage(booking.phone);

    // SAFE KNOWN-USER AUTO-CLAIM PATH:
    // If the Telegram sender is an existing platform user (verifiedUser.telegram_id === telegramSenderId)
    // AND the user has a verified phone that matches the booking phone 100%,
    // allow auto-claim for passenger & unknown contact roles WITHOUT requiring Telegram contact button re-share!
    if (telegramSenderId && verifiedUser.telegram_id != null && String(verifiedUser.telegram_id) === String(telegramSenderId)) {
        const userPhone = cleanPhoneForStorage(verifiedUser.phone);

        if (booking.contact_role === 'family_or_group') {
            return { canAutoClaim: false, reason: 'FAMILY_GROUP_CONTACT_REQUIRES_APPROVAL' };
        }

        if (booking.contact_role === 'coordinator') {
            return { canAutoClaim: false, reason: 'COORDINATOR_CONTACT_REQUIRES_APPROVAL' };
        }

        if (userPhone && bookingPhone && userPhone === bookingPhone) {
            if (booking.contact_role === 'passenger' || booking.contact_role === 'unknown') {
                return { canAutoClaim: true, method: 'known_user_phone_match' };
            }
        }
    }

    // FALLBACK: Native Telegram Contact Verification Path
    if (!telegramContact || !telegramContact.user_id || !telegramSenderId
        || String(telegramContact.user_id) !== String(telegramSenderId)) {
        return { canAutoClaim: false, reason: 'TELEGRAM_CONTACT_USER_ID_MISMATCH' };
    }

    if (!telegramContact.phone_number) {
        return { canAutoClaim: false, reason: 'MISSING_CONTACT_PHONE' };
    }

    if (verifiedUser.telegram_id != null
        && String(verifiedUser.telegram_id) !== String(telegramSenderId)) {
        return { canAutoClaim: false, reason: 'TELEGRAM_ACCOUNT_MISMATCH' };
    }

    const sharedPhone = cleanPhoneForStorage(telegramContact.phone_number);

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

    if (!bookingPhone || !sharedPhone || sharedPhone !== bookingPhone) {
        return { canAutoClaim: false, reason: 'PHONE_MISMATCH_REQUIRES_APPROVAL' };
    }

    return { canAutoClaim: true };
}

async function executeAtomicClaim(bookingId, userId, options = {}) {
    if (isInjectedMock(options)) {
        const dbClient = options.supabaseClient;
        const nowIso = new Date().toISOString();

        try {
            const { data: updated, error } = await dbClient
                .from('bus_ticket_bookings')
                .update({
                    claim_status: 'claimed',
                    claimed_by_user_id: userId,
                    claimed_at: nowIso
                })
                .eq('id', bookingId)
                .eq('status', 'confirmed')
                .neq('claim_status', 'claimed')
                .is('claimed_by_user_id', null)
                .select('*')
                .single();

            if (error || !updated) {
                return { success: false, error: 'BOOKING_INELIGIBLE_OR_ALREADY_CLAIMED' };
            }

            if (options.sessionId) {
                await dbClient
                    .from('booking_claim_sessions')
                    .update({ consumed_at: nowIso })
                    .eq('id', options.sessionId);
            }

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

    try {
        const rpcClient = options.rpcClient || getClaimDb(options);
        const { data, error } = await rpcClient.rpc('fn_claim_booking_auto', {
            p_booking_id: bookingId,
            p_user_id: userId,
            p_session_id: options.sessionId || null
        });

        if (error) {
            return { success: false, error: error.message || 'CLAIM_RPC_FAILED' };
        }

        if (!data || data.success !== true) {
            return {
                success: false,
                error: data?.error || 'BOOKING_INELIGIBLE_OR_ALREADY_CLAIMED'
            };
        }

        return {
            success: true,
            booking: { id: data.booking_id }
        };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

async function createClaimRequest(bookingId, userId, verificationDetails = {}, options = {}) {
    const dbClient = getClaimDb(options);

    // Keep the established injected mock path for the existing deterministic
    // Phase E unit suite. Production uses the stricter service-role path below.
    if (isInjectedMock(options)) {
        try {
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

                if (options.sessionId) {
                    await dbClient
                        .from('booking_claim_sessions')
                        .update({ consumed_at: new Date().toISOString() })
                        .eq('id', options.sessionId);
                }

                return { success: true, requestId: existing.id, isExisting: true };
            }

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

    try {
        const nowIso = new Date().toISOString();
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
                .eq('id', existing.id)
                .eq('status', 'pending');

            if (options.sessionId) {
                const { data: consumedSession, error: consumeError } = await dbClient
                    .from('booking_claim_sessions')
                    .update({ consumed_at: nowIso })
                    .eq('id', options.sessionId)
                    .eq('booking_id', bookingId)
                    .is('consumed_at', null)
                    .gt('expires_at', nowIso)
                    .select('id')
                    .maybeSingle();

                if (consumeError || !consumedSession) {
                    return { success: false, error: 'SESSION_INVALID_EXPIRED_OR_CONSUMED' };
                }
            }

            return { success: true, requestId: existing.id, isExisting: true };
        }

        const { data: bookingUpdate, error: bookingUpdateError } = await dbClient
            .from('bus_ticket_bookings')
            .update({ claim_status: 'pending_verification' })
            .eq('id', bookingId)
            .eq('status', 'confirmed')
            .eq('claim_status', 'unclaimed')
            .is('claimed_by_user_id', null)
            .select('id')
            .maybeSingle();

        if (bookingUpdateError || !bookingUpdate) {
            return { success: false, error: 'BOOKING_INELIGIBLE_OR_ALREADY_CLAIMED' };
        }

        const { data: request, error } = await dbClient
            .from('booking_claim_requests')
            .insert([{
                booking_id: bookingId,
                requesting_user_id: userId,
                verification_method: verificationDetails.method || 'telegram_contact',
                status: 'pending',
                failure_reason_code: verificationDetails.reason || null,
                created_at: nowIso
            }])
            .select('*')
            .single();

        if (error) throw error;

        if (options.sessionId) {
            const { data: consumedSession, error: consumeError } = await dbClient
                .from('booking_claim_sessions')
                .update({ consumed_at: nowIso })
                .eq('id', options.sessionId)
                .eq('booking_id', bookingId)
                .is('consumed_at', null)
                .gt('expires_at', nowIso)
                .select('id')
                .maybeSingle();

            if (consumeError || !consumedSession) {
                return { success: false, error: 'SESSION_INVALID_EXPIRED_OR_CONSUMED' };
            }
        }

        return { success: true, requestId: request.id, isExisting: false };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

async function reviewClaimRequest(requestId, carrierId, decision, options = {}) {
    const dbClient = getClaimDb(options);
    const reviewerUserId = options.reviewerUserId || carrierId;

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

    const trip = request.bus_ticket_bookings?.bus_tickets;
    if (options.enforceTenant !== false && !tripBelongsToCarrier(trip, carrierId)) {
        return { success: false, error: 'TENANT_UNAUTHORIZED' };
    }

    if (!isInjectedMock(options)) {
        try {
            const rpcClient = options.rpcClient || dbClient;
            const { data, error } = await rpcClient.rpc('fn_review_claim_request', {
                p_request_id: requestId,
                p_carrier_user_id: reviewerUserId,
                p_decision: decision,
                p_reason: options.reason || null
            });

            if (error) {
                return { success: false, error: error.message || 'CLAIM_REVIEW_RPC_FAILED' };
            }

            if (!data || data.success !== true) {
                return { success: false, error: data?.error || 'CLAIM_REVIEW_FAILED' };
            }

            return { success: true, status: data.status };
        } catch (err) {
            return { success: false, error: err.message };
        }
    }

    const nowIso = new Date().toISOString();
    if (decision === 'approved') {
        const claimResult = await executeAtomicClaim(request.booking_id, request.requesting_user_id, {
            supabaseClient: dbClient
        });

        if (!claimResult.success) {
            await dbClient
                .from('booking_claim_requests')
                .update({
                    status: 'superseded',
                    failure_reason_code: 'BOOKING_NO_LONGER_ELIGIBLE',
                    reviewed_by_user_id: reviewerUserId,
                    reviewed_at: nowIso
                })
                .eq('id', requestId);

            return { success: false, error: claimResult.error };
        }

        await dbClient
            .from('booking_claim_requests')
            .update({
                status: 'approved',
                reviewed_by_user_id: reviewerUserId,
                reviewed_at: nowIso
            })
            .eq('id', requestId);

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
    }

    if (decision === 'rejected') {
        await dbClient
            .from('booking_claim_requests')
            .update({
                status: 'rejected',
                failure_reason_code: options.reason || 'CARRIER_REJECTED',
                reviewed_by_user_id: reviewerUserId,
                reviewed_at: nowIso
            })
            .eq('id', requestId);

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

    return { success: false, error: 'INVALID_DECISION' };
}

/**
 * Server-side helper that safely resolves an existing registered Telegram passenger
 * by matching the normalized booking phone against users table.
 *
 * Requirements:
 * 1. Exactly 1 user record matched.
 * 2. User has a valid telegram_id linked.
 * 3. Ambiguous matches (>1) or 0 matches return null.
 *
 * @param {string} phone - Normalized or raw booking phone
 * @param {Object} [options={}] - Options { supabaseClient }
 * @returns {Promise<Object|null>} Resolved user object or null
 */
async function resolveRegisteredPassenger(phone, options = {}) {
    const cleanPhone = cleanPhoneForStorage(phone);
    if (!cleanPhone || cleanPhone.length < 8) {
        return null;
    }

    const dbClient = getClaimDb(options);
    const { data: users, error } = await dbClient
        .from('users')
        .select('*')
        .eq('phone', cleanPhone)
        .not('telegram_id', 'is', null);

    if (error || !users || users.length === 0) {
        return null;
    }

    if (users.length > 1) {
        console.warn('[ClaimHelper] AMBIGUOUS_REGISTERED_PASSENGER: multiple users found for phone');
        return null;
    }

    return users[0];
}

module.exports = {
    CLAIM_SESSION_TTL_MS,
    hashSessionToken,
    generateClaimSession,
    resolveClaimSession,
    evaluateAutoClaimEligibility,
    executeAtomicClaim,
    resolveRegisteredPassenger,
    createClaimRequest,
    reviewClaimRequest,
    tripBelongsToCarrier
};
