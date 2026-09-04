/**
 * services/acquisition/serverEventService.js
 *
 * Phase P.1G.2: Server-Side Protected Event Emitters
 *
 * Safely creates server-only lifecycle events:
 * - BOOKING_CREATED & REPEAT_BOOKING
 * - PAYMENT_COMPLETED
 * - TRIP_COMPLETED
 * - USER_IDENTIFIED
 *
 * Non-blocking dual-write guarantee: Analytics execution is wrapped in safe
 * try/catch and never rolls back core business transactions.
 */

'use strict';

const crypto = require('crypto');
const { getServiceRoleClient } = require('../../dbServiceRole');
const { resolveCanonicalUserId } = require('../../utils/identityMergeHelper');

/**
 * Emits BOOKING_CREATED and REPEAT_BOOKING events upon verified booking creation.
 *
 * @param {Object} params
 * @param {number} params.bookingId
 * @param {number} params.passengerId
 * @param {number} params.busTicketId
 * @param {string} [params.visitorId]
 * @param {string} [params.sessionId]
 * @param {Object} [params.dbClient]
 * @returns {Promise<Object>} Outcome descriptor
 */
async function recordBookingCreated({
    bookingId,
    passengerId,
    busTicketId,
    visitorId = null,
    sessionId = null,
    dbClient = null
}) {
    if (!bookingId) return { success: false, error: 'BOOKING_ID_REQUIRED' };

    const db = dbClient || getServiceRoleClient();

    try {
        const canonicalUserId = await resolveCanonicalUserId(passengerId);

        // 1. Resolve session context if provided
        let sessionData = null;
        if (sessionId) {
            const { data: s } = await db
                .from('acquisition_sessions')
                .select('*')
                .eq('id', sessionId)
                .maybeSingle();
            sessionData = s;
        }

        const sourcePlatform = sessionData ? sessionData.source_platform : 'direct';
        const sourceMedium = sessionData ? sessionData.source_medium : 'direct';
        const attrType = sessionData ? sessionData.attribution_type : 'direct_organic';
        const attrConf = sessionData ? sessionData.attribution_confidence : 'direct';

        // 2. Call fn_create_booking_acquisition_attribution RPC
        try {
            await db.rpc('fn_create_booking_acquisition_attribution', {
                p_booking_id: Number(bookingId),
                p_anonymous_visitor_id: visitorId || (sessionData ? sessionData.anonymous_visitor_id : null),
                p_acquisition_session_id: sessionId || null,
                p_acquisition_link_id: sessionData ? sessionData.acquisition_link_id : null,
                p_campaign_id: sessionData ? sessionData.campaign_id : null,
                p_partner_id: sessionData ? sessionData.partner_id : null,
                p_referral_attribution_id: null,
                p_source_platform: sourcePlatform,
                p_source_medium: sourceMedium,
                p_attribution_type: attrType,
                p_attribution_confidence: attrConf,
                p_content_code: sessionData ? sessionData.content_code : null,
                p_placement_code: sessionData ? sessionData.placement_code : null,
                p_initial_platform: sourcePlatform,
                p_first_non_direct_platform: sourcePlatform !== 'direct' ? sourcePlatform : null,
                p_last_non_direct_platform: sourcePlatform !== 'direct' ? sourcePlatform : null,
                p_converting_platform: sourcePlatform
            });
        } catch (rpcErr) {
            console.warn('[ServerEventService] Attribution RPC error (non-blocking):', rpcErr.message);
        }

        // 3. Emit BOOKING_CREATED event
        const bookingIdempKey = `booking_created_${bookingId}`;
        const now = new Date().toISOString();

        await db.from('acquisition_events').insert({
            event_name: 'BOOKING_CREATED',
            anonymous_visitor_id: visitorId || (sessionData ? sessionData.anonymous_visitor_id : '00000000-0000-0000-0000-000000000000'),
            session_id: sessionId || null,
            user_id: canonicalUserId || null,
            booking_id: Number(bookingId),
            bus_ticket_id: busTicketId ? Number(busTicketId) : null,
            campaign_id: sessionData ? sessionData.campaign_id : null,
            partner_id: sessionData ? sessionData.partner_id : null,
            event_source: 'backend',
            idempotency_key: bookingIdempKey,
            properties: { booking_id: Number(bookingId) },
            occurred_at: now,
            received_at: now
        });

        // 4. Check for repeat booking (resolving canonical user)
        if (canonicalUserId) {
            const { count: priorCount } = await db
                .from('bus_ticket_bookings')
                .select('id', { count: 'exact', head: true })
                .eq('passenger_id', canonicalUserId)
                .neq('status', 'cancelled');

            if (priorCount && priorCount > 1) {
                const repeatIdempKey = `repeat_booking_${bookingId}`;
                await db.from('acquisition_events').insert({
                    event_name: 'REPEAT_BOOKING',
                    anonymous_visitor_id: visitorId || (sessionData ? sessionData.anonymous_visitor_id : '00000000-0000-0000-0000-000000000000'),
                    session_id: sessionId || null,
                    user_id: canonicalUserId,
                    booking_id: Number(bookingId),
                    bus_ticket_id: busTicketId ? Number(busTicketId) : null,
                    campaign_id: sessionData ? sessionData.campaign_id : null,
                    partner_id: sessionData ? sessionData.partner_id : null,
                    event_source: 'backend',
                    idempotency_key: repeatIdempKey,
                    properties: { prior_bookings_count: priorCount - 1 },
                    occurred_at: now,
                    received_at: now
                });
            }
        }

        return { success: true, booking_id: Number(bookingId) };
    } catch (err) {
        console.warn('[ServerEventService] recordBookingCreated non-blocking error:', err.message);
        return { success: false, error: err.message };
    }
}

/**
 * Emits PAYMENT_COMPLETED event upon SmartPay webhook payment success.
 *
 * @param {Object} params
 * @param {number} params.bookingId
 * @param {string} params.paymentOrderId
 * @param {number} params.amount
 * @param {Object} [params.dbClient]
 * @returns {Promise<Object>}
 */
async function recordPaymentCompleted({
    bookingId,
    paymentOrderId,
    amount = 0,
    dbClient = null
}) {
    if (!bookingId) return { success: false, error: 'BOOKING_ID_REQUIRED' };

    const db = dbClient || getServiceRoleClient();

    try {
        // Fetch booking details for user & ticket binding
        const { data: booking } = await db
            .from('bus_ticket_bookings')
            .select('id, passenger_id, bus_ticket_id')
            .eq('id', bookingId)
            .maybeSingle();

        const canonicalUserId = booking ? await resolveCanonicalUserId(booking.passenger_id) : null;
        const idempKey = `smartpay_${paymentOrderId || bookingId}`;
        const now = new Date().toISOString();

        await db.from('acquisition_events').insert({
            event_name: 'PAYMENT_COMPLETED',
            anonymous_visitor_id: '00000000-0000-0000-0000-000000000000',
            session_id: null,
            user_id: canonicalUserId || null,
            booking_id: Number(bookingId),
            bus_ticket_id: booking ? Number(booking.bus_ticket_id) : null,
            campaign_id: null,
            partner_id: null,
            event_source: 'payment_webhook',
            idempotency_key: idempKey,
            properties: {
                payment_order_id: String(paymentOrderId || ''),
                amount: Number(amount) || 0
            },
            occurred_at: now,
            received_at: now
        });

        return { success: true };
    } catch (err) {
        // Idempotency conflict is safe and expected on webhook retries
        if (err.code === '23505') {
            return { success: true, idempotent: true };
        }
        console.warn('[ServerEventService] recordPaymentCompleted non-blocking error:', err.message);
        return { success: false, error: err.message };
    }
}

/**
 * Emits TRIP_COMPLETED events for confirmed bookings of a completed trip.
 *
 * @param {Object} params
 * @param {number} params.tripId
 * @param {Object} [params.dbClient]
 * @returns {Promise<Object>}
 */
async function recordTripCompleted({ tripId, dbClient = null }) {
    if (!tripId) return { success: false, error: 'TRIP_ID_REQUIRED' };

    const db = dbClient || getServiceRoleClient();

    try {
        const { data: bookings } = await db
            .from('bus_ticket_bookings')
            .select('id, passenger_id')
            .eq('bus_ticket_id', tripId)
            .in('status', ['confirmed', 'boarded']);

        if (!bookings || bookings.length === 0) {
            return { success: true, completed_count: 0 };
        }

        const now = new Date().toISOString();
        let count = 0;

        for (const b of bookings) {
            try {
                const canonicalUserId = await resolveCanonicalUserId(b.passenger_id);
                const idempKey = `trip_completed_${b.id}`;

                await db.from('acquisition_events').insert({
                    event_name: 'TRIP_COMPLETED',
                    anonymous_visitor_id: '00000000-0000-0000-0000-000000000000',
                    session_id: null,
                    user_id: canonicalUserId,
                    booking_id: b.id,
                    bus_ticket_id: Number(tripId),
                    event_source: 'system',
                    idempotency_key: idempKey,
                    properties: { trip_id: Number(tripId) },
                    occurred_at: now,
                    received_at: now
                });
                count++;
            } catch (itemErr) {
                if (itemErr.code !== '23505') {
                    console.warn(`[ServerEventService] Booking ${b.id} trip completion event error:`, itemErr.message);
                }
            }
        }

        return { success: true, completed_count: count };
    } catch (err) {
        console.warn('[ServerEventService] recordTripCompleted non-blocking error:', err.message);
        return { success: false, error: err.message };
    }
}

/**
 * Links an anonymous visitor with an authenticated user identity and emits USER_IDENTIFIED.
 *
 * @param {Object} params
 * @param {string} params.visitorId
 * @param {number} params.userId
 * @param {string} [params.sessionId]
 * @param {string} [params.linkMethod='login']
 * @param {Object} [params.dbClient]
 * @returns {Promise<Object>}
 */
async function recordUserIdentified({
    visitorId,
    userId,
    sessionId = null,
    linkMethod = 'login',
    dbClient = null
}) {
    if (!visitorId || !userId) return { success: false, error: 'VISITOR_AND_USER_REQUIRED' };

    const db = dbClient || getServiceRoleClient();

    try {
        const canonicalUserId = await resolveCanonicalUserId(userId);
        const now = new Date().toISOString();

        // 1. Insert identity link (append-only)
        try {
            await db.from('acquisition_identity_links').insert({
                anonymous_visitor_id: visitorId,
                user_id: canonicalUserId,
                link_method: String(linkMethod).slice(0, 32),
                session_id: sessionId || null,
                linked_at: now
            });
        } catch (linkErr) {
            // Already linked (uq_acq_ident_link)
            if (linkErr.code !== '23505') {
                console.warn('[ServerEventService] Identity link error:', linkErr.message);
            }
        }

        // 2. Update visitor current_user_id & identified_at
        await db
            .from('acquisition_visitors')
            .update({
                current_user_id: canonicalUserId,
                identified_at: now,
                last_seen_at: now
            })
            .eq('anonymous_visitor_id', visitorId);

        // 3. Emit USER_IDENTIFIED event
        const idempKey = `user_identified_${visitorId.slice(0, 8)}_${canonicalUserId}`;
        try {
            await db.from('acquisition_events').insert({
                event_name: 'USER_IDENTIFIED',
                anonymous_visitor_id: visitorId,
                session_id: sessionId || null,
                user_id: canonicalUserId,
                event_source: 'backend',
                idempotency_key: idempKey,
                properties: { link_method: String(linkMethod) },
                occurred_at: now,
                received_at: now
            });
        } catch (eventErr) {
            if (eventErr.code !== '23505') {
                console.warn('[ServerEventService] USER_IDENTIFIED event insert error:', eventErr.message);
            }
        }

        return { success: true, canonical_user_id: canonicalUserId };
    } catch (err) {
        console.warn('[ServerEventService] recordUserIdentified non-blocking error:', err.message);
        return { success: false, error: err.message };
    }
}

module.exports = {
    recordBookingCreated,
    recordPaymentCompleted,
    recordTripCompleted,
    recordUserIdentified
};
