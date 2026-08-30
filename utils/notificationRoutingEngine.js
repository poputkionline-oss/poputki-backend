/**
 * notificationRoutingEngine.js
 * 
 * Notification Planning & Routing Engine (Phase B)
 * Project: POPUTKI.ONLINE
 * 
 * Determines:
 * - WHO should receive a notification
 * - WHY (trust & role classification)
 * - BY WHICH CHANNEL (independent Telegram & WhatsApp evaluation)
 * - WHICH TEMPLATE
 * - IDEMPOTENCY KEY (fingerprinted, no raw phone exposure)
 * 
 * Strict boundary:
 * Pure planning / logging engine. NO external network or provider calls are made in Phase B.
 */

const crypto = require('crypto');
const { normalizePhone, maskPhone } = require('./phoneHelper');
const { resolveBookingRecipients } = require('./recipientResolver');
const { generateTicketVerificationToken } = require('./ticketHelper');

/**
 * Creates a deterministic 12-character hex fingerprint of an identity string
 * to prevent leaking raw phone numbers inside database idempotency keys.
 * 
 * @param {string|number} identifier
 * @returns {string}
 */
function hashIdentity(identifier) {
    if (!identifier) return 'anon';
    return crypto.createHash('sha256').update(String(identifier)).digest('hex').substring(0, 12);
}

/**
 * Generates a safe, non-PII idempotency key for booking or aggregate notifications.
 * 
 * @param {Object} params
 * @param {number|string} params.scopeId - bookingId or tripId
 * @param {string} params.scopeType - 'booking' | 'trip'
 * @param {string} params.recipientType - 'passenger' | 'family_or_group' | 'coordinator' | 'creator'
 * @param {string|number} params.recipientIdentity - user_id or phone number (will be fingerprinted)
 * @param {string} params.channel - 'telegram' | 'whatsapp'
 * @param {string} params.notificationType - 'ticket_issued' | 'coordinator_manifest' | etc.
 * @returns {string}
 */
function generateSafeIdempotencyKey({ scopeId, scopeType = 'booking', recipientType, recipientIdentity, channel, notificationType }) {
    const sId = String(scopeId || 0);
    const sType = String(scopeType).toLowerCase();
    const rType = String(recipientType || 'unknown').toLowerCase();
    const identFingerprint = hashIdentity(recipientIdentity);
    const chan = String(channel || 'unknown').toLowerCase();
    const notif = String(notificationType || 'default').toLowerCase();
    return `${sType}:${sId}:${rType}:${identFingerprint}:${chan}:${notif}`;
}

/**
 * Builds a safe public ticket link for a booking.
 * 
 * @param {Object} booking
 * @param {Object} [trip]
 * @returns {string}
 */
function buildShareableTicketUrl(booking, trip) {
    const token = generateTicketVerificationToken(booking.id);
    return `https://www.poputki.online/ticket-verify/${token}`;
}

/**
 * Builds a notification plan for a single manual booking.
 * 
 * @param {Object} booking - Row from bus_ticket_bookings
 * @param {Object} [context={}] - Context containing { users: [], creator: null, trip: null, tripBookings: [] }
 * @returns {Object} { bookingId, recipientResolution, intents: [], summary: {} }
 */
function buildNotificationPlan(booking, context = {}) {
    const recipients = resolveBookingRecipients(booking, context);
    const trip = context.trip || null;
    const tripBookings = context.tripBookings || [];

    const intents = [];
    const shareableUrl = buildShareableTicketUrl(booking, trip);

    const normPhone = normalizePhone(booking.phone);
    const contactRole = booking.contact_role || 'unknown';

    // Check count of bookings sharing this phone on the same trip
    const matchingTripBookings = normPhone ? tripBookings.filter(b => normalizePhone(b.phone) === normPhone) : [];
    const isMultiBooking = matchingTripBookings.length > 1;

    // =========================================================================
    // 1. PASSENGER CONTACT ROUTE
    // =========================================================================
    if (contactRole === 'passenger' && recipients.passenger) {
        const p = recipients.passenger;

        // Channel A: Telegram
        if (p.telegramEligible && p.telegramChatId) {
            intents.push({
                channel: 'telegram',
                recipientType: 'passenger',
                recipientUserId: p.userId,
                recipientPhone: p.phone,
                recipientMaskedPhone: p.maskedPhone,
                telegramChatId: p.telegramChatId,
                notificationType: 'ticket_issued',
                templateKey: 'passenger_ticket_issued',
                status: 'pending',
                reason: 'VERIFIED_TELEGRAM_PASSENGER',
                bookingId: booking.id,
                tripId: booking.bus_ticket_id,
                shareableUrl,
                idempotencyKey: generateSafeIdempotencyKey({
                    scopeId: booking.id,
                    scopeType: 'booking',
                    recipientType: 'passenger',
                    recipientIdentity: p.userId || p.phone,
                    channel: 'telegram',
                    notificationType: 'ticket_issued'
                })
            });
        } else {
            intents.push({
                channel: 'telegram',
                recipientType: 'passenger',
                recipientUserId: p.userId,
                recipientPhone: p.phone,
                recipientMaskedPhone: p.maskedPhone,
                notificationType: 'ticket_issued',
                templateKey: 'passenger_ticket_issued',
                status: 'skipped',
                reason: 'NO_LINKED_TELEGRAM_ACCOUNT',
                bookingId: booking.id,
                tripId: booking.bus_ticket_id,
                idempotencyKey: generateSafeIdempotencyKey({
                    scopeId: booking.id,
                    scopeType: 'booking',
                    recipientType: 'passenger',
                    recipientIdentity: p.userId || p.phone,
                    channel: 'telegram',
                    notificationType: 'ticket_issued'
                })
            });
        }

        // Channel B: WhatsApp (Independent Evaluation)
        intents.push({
            channel: 'whatsapp',
            recipientType: 'passenger',
            recipientPhone: p.phone,
            recipientMaskedPhone: p.maskedPhone,
            notificationType: 'ticket_issued',
            templateKey: 'passenger_ticket_issued',
            status: 'skipped',
            reason: 'WHATSAPP_BUSINESS_API_NOT_CONFIGURED',
            bookingId: booking.id,
            tripId: booking.bus_ticket_id,
            idempotencyKey: generateSafeIdempotencyKey({
                scopeId: booking.id,
                scopeType: 'booking',
                recipientType: 'passenger',
                recipientIdentity: p.phone,
                channel: 'whatsapp',
                notificationType: 'ticket_issued'
            })
        });
    }

    // =========================================================================
    // 2. FAMILY OR GROUP CONTACT ROUTE
    // =========================================================================
    else if (contactRole === 'family_or_group' && recipients.familyOrGroup) {
        const fg = recipients.familyOrGroup;
        const notifType = isMultiBooking ? 'family_group_manifest' : 'ticket_issued';

        // Channel A: Telegram
        if (fg.telegramEligible && fg.telegramChatId) {
            intents.push({
                channel: 'telegram',
                recipientType: 'family_or_group',
                recipientUserId: fg.userId,
                recipientPhone: fg.phone,
                recipientMaskedPhone: fg.maskedPhone,
                telegramChatId: fg.telegramChatId,
                notificationType: notifType,
                templateKey: 'family_group_tickets_ready',
                status: 'pending',
                reason: 'VERIFIED_TELEGRAM_FAMILY_CONTACT',
                bookingId: booking.id,
                tripId: booking.bus_ticket_id,
                isMultiBooking,
                shareableUrl,
                idempotencyKey: generateSafeIdempotencyKey({
                    scopeId: booking.id,
                    scopeType: 'booking',
                    recipientType: 'family_or_group',
                    recipientIdentity: fg.userId || fg.phone,
                    channel: 'telegram',
                    notificationType: notifType
                })
            });
        } else {
            intents.push({
                channel: 'telegram',
                recipientType: 'family_or_group',
                recipientUserId: fg.userId,
                recipientPhone: fg.phone,
                recipientMaskedPhone: fg.maskedPhone,
                notificationType: notifType,
                templateKey: 'family_group_tickets_ready',
                status: 'skipped',
                reason: 'NO_LINKED_TELEGRAM_ACCOUNT',
                bookingId: booking.id,
                tripId: booking.bus_ticket_id,
                idempotencyKey: generateSafeIdempotencyKey({
                    scopeId: booking.id,
                    scopeType: 'booking',
                    recipientType: 'family_or_group',
                    recipientIdentity: fg.userId || fg.phone,
                    channel: 'telegram',
                    notificationType: notifType
                })
            });
        }

        // Channel B: WhatsApp (Independent Evaluation)
        intents.push({
            channel: 'whatsapp',
            recipientType: 'family_or_group',
            recipientPhone: fg.phone,
            recipientMaskedPhone: fg.maskedPhone,
            notificationType: notifType,
            templateKey: 'family_group_tickets_ready',
            status: 'skipped',
            reason: 'WHATSAPP_BUSINESS_API_NOT_CONFIGURED',
            bookingId: booking.id,
            tripId: booking.bus_ticket_id,
            idempotencyKey: generateSafeIdempotencyKey({
                scopeId: booking.id,
                scopeType: 'booking',
                recipientType: 'family_or_group',
                recipientIdentity: fg.phone,
                channel: 'whatsapp',
                notificationType: notifType
            })
        });
    }

    // =========================================================================
    // 3. COORDINATOR CONTACT ROUTE
    // =========================================================================
    else if (contactRole === 'coordinator' && recipients.coordinator) {
        const c = recipients.coordinator;
        const notifType = isMultiBooking ? 'coordinator_manifest' : 'ticket_issued';

        // Channel A: Telegram
        if (c.telegramEligible && c.telegramChatId) {
            intents.push({
                channel: 'telegram',
                recipientType: 'coordinator',
                recipientUserId: c.userId,
                recipientPhone: c.phone,
                recipientMaskedPhone: c.maskedPhone,
                telegramChatId: c.telegramChatId,
                notificationType: notifType,
                templateKey: 'coordinator_tickets_ready',
                status: 'pending',
                reason: 'VERIFIED_TELEGRAM_COORDINATOR',
                bookingId: booking.id,
                tripId: booking.bus_ticket_id,
                isMultiBooking,
                shareableUrl,
                idempotencyKey: generateSafeIdempotencyKey({
                    scopeId: booking.id,
                    scopeType: 'booking',
                    recipientType: 'coordinator',
                    recipientIdentity: c.userId || c.phone,
                    channel: 'telegram',
                    notificationType: notifType
                })
            });
        } else {
            intents.push({
                channel: 'telegram',
                recipientType: 'coordinator',
                recipientUserId: c.userId,
                recipientPhone: c.phone,
                recipientMaskedPhone: c.maskedPhone,
                notificationType: notifType,
                templateKey: 'coordinator_tickets_ready',
                status: 'skipped',
                reason: 'NO_LINKED_TELEGRAM_ACCOUNT',
                bookingId: booking.id,
                tripId: booking.bus_ticket_id,
                idempotencyKey: generateSafeIdempotencyKey({
                    scopeId: booking.id,
                    scopeType: 'booking',
                    recipientType: 'coordinator',
                    recipientIdentity: c.userId || c.phone,
                    channel: 'telegram',
                    notificationType: notifType
                })
            });
        }

        // Channel B: WhatsApp (Independent Evaluation)
        intents.push({
            channel: 'whatsapp',
            recipientType: 'coordinator',
            recipientPhone: c.phone,
            recipientMaskedPhone: c.maskedPhone,
            notificationType: notifType,
            templateKey: 'coordinator_tickets_ready',
            status: 'skipped',
            reason: 'WHATSAPP_BUSINESS_API_NOT_CONFIGURED',
            bookingId: booking.id,
            tripId: booking.bus_ticket_id,
            idempotencyKey: generateSafeIdempotencyKey({
                scopeId: booking.id,
                scopeType: 'booking',
                recipientType: 'coordinator',
                recipientIdentity: c.phone,
                channel: 'whatsapp',
                notificationType: notifType
            })
        });
    }

    // =========================================================================
    // 4. UNKNOWN CONTACT / MISSING PHONE -> CREATOR HANDOFF FALLBACK
    // =========================================================================
    else {
        // Unknown or missing phone: NEVER spam arbitrary passenger numbers.
        // Instead, create a creator handoff notification candidate.
        if (recipients.creator) {
            const cr = recipients.creator;
            intents.push({
                channel: 'telegram',
                recipientType: 'creator',
                recipientUserId: cr.userId,
                recipientPhone: cr.phone,
                recipientMaskedPhone: cr.maskedPhone,
                telegramChatId: cr.telegramChatId,
                notificationType: 'creator_handoff',
                templateKey: 'creator_tickets_ready_for_handoff',
                status: cr.telegramEligible ? 'pending' : 'skipped',
                reason: cr.telegramEligible ? 'CREATOR_TELEGRAM_AVAILABLE' : 'CREATOR_NO_TELEGRAM',
                bookingId: booking.id,
                tripId: booking.bus_ticket_id,
                shareableUrl,
                idempotencyKey: generateSafeIdempotencyKey({
                    scopeId: booking.id,
                    scopeType: 'booking',
                    recipientType: 'creator',
                    recipientIdentity: cr.userId || cr.phone,
                    channel: 'telegram',
                    notificationType: 'creator_handoff'
                })
            });
        }
    }

    return {
        bookingId: booking.id,
        trustClassification: recipients.trustClassification,
        advisoryWarning: recipients.advisoryWarning,
        intents
    };
}

/**
 * Builds aggregate notification plans for an entire trip (batch/grouping mode).
 * 
 * @param {number|string} tripId
 * @param {Array<Object>} bookings
 * @param {Object} [context={}]
 * @returns {Array<Object>} List of grouped notification intents
 */
function buildTripNotificationPlans(tripId, bookings = [], context = {}) {
    const plans = bookings.map(b => buildNotificationPlan(b, { ...context, tripBookings: bookings }));
    return plans;
}

module.exports = {
    hashIdentity,
    generateSafeIdempotencyKey,
    buildShareableTicketUrl,
    buildNotificationPlan,
    buildTripNotificationPlans
};
