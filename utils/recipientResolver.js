/**
 * recipientResolver.js
 * 
 * Booking Notification Recipient Resolution Engine (Phase A.1 - Family & Group Support)
 * Project: POPUTKI.ONLINE
 */

const { normalizePhone, maskPhone } = require('./phoneHelper');

/**
 * Finds a platform user matching the normalized phone who has an active Telegram linkage.
 * Strictly relies on the local database (NO Telegram API phone lookup).
 * 
 * @param {string} phone - Normalized phone number
 * @param {Array<Object>} users - List of user records from Supabase
 * @returns {Object|null} Matching user object or null
 */
function findTelegramUserByVerifiedPhone(phone, users = []) {
    const norm = normalizePhone(phone);
    if (!norm) return null;

    const matched = users.find(u => {
        const uNorm = normalizePhone(u.phone);
        return uNorm === norm && Boolean(u.telegram_id);
    });

    return matched || null;
}

/**
 * Resolves candidate notification recipients for a given booking record.
 * 
 * CRITICAL RULE:
 * Repeated phone count (2+, 3+, 6+ passengers) MUST NEVER automatically change
 * the contact_role. It is purely an advisory signal (MULTI_PASSENGER_CONTACT).
 * 
 * @param {Object} booking - Booking row from bus_ticket_bookings
 * @param {Object} [context={}] - Context containing { users: [], creator: null, tripBookings: [] }
 * @returns {Object} { passenger, familyOrGroup, coordinator, creator, trustClassification, advisoryWarning }
 */
function resolveBookingRecipients(booking, context = {}) {
    const users = context.users || [];
    const creator = context.creator || null;
    const tripBookings = context.tripBookings || [];

    const normPhone = normalizePhone(booking.phone);
    const rawRole = booking.contact_role || 'unknown';

    // Advisory Signal: Check if this phone is shared across 2+ distinct passenger names on the same trip
    let isMultiPassengerContact = false;
    let distinctPassengersCount = 0;
    if (normPhone && tripBookings.length > 0) {
        const distinctNames = new Set(
            tripBookings
                .filter(b => normalizePhone(b.phone) === normPhone && b.passenger_name)
                .map(b => b.passenger_name.trim().toLowerCase())
        );
        distinctPassengersCount = distinctNames.size;
        if (distinctPassengersCount >= 2) {
            isMultiPassengerContact = true;
        }
    }

    const advisoryWarning = isMultiPassengerContact ? 'MULTI_PASSENGER_CONTACT' : null;

    // Contact role is ALWAYS explicit; never mutated by heuristic counters
    const effectiveRole = rawRole;

    // Trust Classification
    let trustClassification = 'UNKNOWN_PHONE';
    if (!normPhone) {
        trustClassification = 'MISSING_PHONE';
    } else if (effectiveRole === 'coordinator') {
        trustClassification = 'COORDINATOR_CONTACT';
    } else if (effectiveRole === 'family_or_group') {
        const tgUser = findTelegramUserByVerifiedPhone(normPhone, users);
        trustClassification = tgUser ? 'KNOWN_TELEGRAM_FAMILY_CONTACT' : 'FAMILY_OR_GROUP_CONTACT';
    } else if (effectiveRole === 'passenger') {
        const tgUser = findTelegramUserByVerifiedPhone(normPhone, users);
        trustClassification = tgUser ? 'KNOWN_TELEGRAM_PASSENGER' : 'TRUSTED_PASSENGER_PHONE';
    } else {
        trustClassification = 'UNKNOWN_PHONE';
    }

    // 1. Passenger Recipient
    let passenger = null;
    if (normPhone && effectiveRole === 'passenger') {
        const tgUser = findTelegramUserByVerifiedPhone(normPhone, users);
        passenger = {
            type: 'passenger',
            phone: normPhone,
            maskedPhone: maskPhone(normPhone),
            passengerName: booking.passenger_name || 'Пассажир',
            userId: tgUser ? tgUser.id : (booking.claimed_by_user_id || null),
            telegramEligible: Boolean(tgUser && tgUser.telegram_id),
            telegramChatId: tgUser ? tgUser.telegram_id : null,
            isClaimed: booking.claim_status === 'claimed'
        };
    }

    // 2. Family or Group Contact Recipient
    let familyOrGroup = null;
    if (normPhone && effectiveRole === 'family_or_group') {
        const tgUser = findTelegramUserByVerifiedPhone(normPhone, users);
        familyOrGroup = {
            type: 'family_or_group',
            phone: normPhone,
            maskedPhone: maskPhone(normPhone),
            contactName: booking.passenger_name || 'Представитель семьи / группы',
            userId: tgUser ? tgUser.id : null,
            telegramEligible: Boolean(tgUser && tgUser.telegram_id),
            telegramChatId: tgUser ? tgUser.telegram_id : null,
            isMultiPassengerContact,
            distinctPassengersCount
        };
    }

    // 3. Coordinator Recipient
    let coordinator = null;
    if (normPhone && effectiveRole === 'coordinator') {
        const tgUser = findTelegramUserByVerifiedPhone(normPhone, users);
        coordinator = {
            type: 'coordinator',
            phone: normPhone,
            maskedPhone: maskPhone(normPhone),
            userId: tgUser ? tgUser.id : null,
            telegramEligible: Boolean(tgUser && tgUser.telegram_id),
            telegramChatId: tgUser ? tgUser.telegram_id : null,
            isMultiPassengerContact,
            distinctPassengersCount
        };
    }

    // 4. Creator Recipient (Authenticated carrier manager / dispatcher who issued the ticket)
    let creatorRecipient = null;
    const creatorUserId = booking.created_by_user_id || (creator ? creator.id : null);
    if (creatorUserId) {
        const creatorUser = creator || users.find(u => u.id === creatorUserId);
        creatorRecipient = {
            type: 'creator',
            userId: creatorUserId,
            phone: creatorUser ? normalizePhone(creatorUser.phone) : null,
            maskedPhone: creatorUser ? maskPhone(creatorUser.phone) : 'N/A',
            telegramEligible: Boolean(creatorUser && creatorUser.telegram_id),
            telegramChatId: creatorUser ? creatorUser.telegram_id : null
        };
    }

    return {
        bookingId: booking.id,
        contactRole: rawRole,
        effectiveRole,
        trustClassification,
        advisoryWarning,
        passenger,
        familyOrGroup,
        coordinator,
        creator: creatorRecipient
    };
}

module.exports = {
    findTelegramUserByVerifiedPhone,
    resolveBookingRecipients
};
