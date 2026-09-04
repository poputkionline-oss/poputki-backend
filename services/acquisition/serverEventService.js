/**
 * services/acquisition/serverEventService.js
 *
 * Phase P.1G.3: Server-Side Protected Event Emitters with Persistent Outbox Guarantee
 *
 * Safely creates server-only lifecycle events:
 * - BOOKING_CREATED & REPEAT_BOOKING
 * - PAYMENT_COMPLETED
 * - TRIP_COMPLETED
 * - USER_IDENTIFIED
 *
 * Delivery Semantics: DURABLE_QUEUE_PLUS_RECONCILIATION
 * - Events are persisted into PostgreSQL public.acquisition_event_outbox
 * - Immediate processing is attempted non-blockingly
 * - Any transient network or process failure is reliably recovered by outbox retries and reconciliation
 * - Zero raw PII in properties or logs
 */

'use strict';

const crypto = require('crypto');
const { getServiceRoleClient } = require('../../dbServiceRole');
const { resolveCanonicalUserId } = require('../../utils/identityMergeHelper');
const { enqueueOutboxEvent, processOutboxBatch } = require('./outboxService');

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

        // 3. Enqueue BOOKING_CREATED into persistent outbox
        const bookingIdempKey = `booking_created_${bookingId}`;
        await enqueueOutboxEvent({
            eventName: 'BOOKING_CREATED',
            eventSource: 'backend',
            idempotencyKey: bookingIdempKey,
            visitorId: visitorId || (sessionData ? sessionData.anonymous_visitor_id : null),
            sessionId: sessionId || null,
            userId: canonicalUserId || null,
            bookingId: Number(bookingId),
            busTicketId: busTicketId ? Number(busTicketId) : null,
            campaignId: sessionData ? sessionData.campaign_id : null,
            partnerId: sessionData ? sessionData.partner_id : null,
            properties: { booking_id: Number(bookingId) },
            dbClient: db
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
                await enqueueOutboxEvent({
                    eventName: 'REPEAT_BOOKING',
                    eventSource: 'backend',
                    idempotencyKey: repeatIdempKey,
                    visitorId: visitorId || (sessionData ? sessionData.anonymous_visitor_id : null),
                    sessionId: sessionId || null,
                    userId: canonicalUserId,
                    bookingId: Number(bookingId),
                    busTicketId: busTicketId ? Number(busTicketId) : null,
                    campaignId: sessionData ? sessionData.campaign_id : null,
                    partnerId: sessionData ? sessionData.partner_id : null,
                    properties: { prior_bookings_count: priorCount - 1 },
                    dbClient: db
                });
            }
        }

        // Immediately trigger non-blocking outbox processing
        processOutboxBatch({ batchSize: 5, dbClient: db }).catch(() => {});

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
        const idempKey = `payment_completed_${bookingId}`;

        // Enqueue into persistent outbox
        await enqueueOutboxEvent({
            eventName: 'PAYMENT_COMPLETED',
            eventSource: 'backend',
            idempotencyKey: idempKey,
            userId: canonicalUserId,
            bookingId: Number(bookingId),
            busTicketId: booking ? Number(booking.bus_ticket_id) : null,
            properties: {
                payment_order_id: String(paymentOrderId || ''),
                amount: Number(amount) || 0
            },
            dbClient: db
        });

        // Immediately trigger non-blocking outbox processing
        processOutboxBatch({ batchSize: 5, dbClient: db }).catch(() => {});

        return { success: true };
    } catch (err) {
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

        let count = 0;
        for (const b of bookings) {
            try {
                const canonicalUserId = await resolveCanonicalUserId(b.passenger_id);
                const idempKey = `trip_completed_${b.id}`;

                await enqueueOutboxEvent({
                    eventName: 'TRIP_COMPLETED',
                    eventSource: 'backend',
                    idempotencyKey: idempKey,
                    userId: canonicalUserId,
                    bookingId: b.id,
                    busTicketId: Number(tripId),
                    properties: { trip_id: Number(tripId) },
                    dbClient: db
                });
                count++;
            } catch (itemErr) {
                console.warn(`[ServerEventService] Booking ${b.id} trip completion event error:`, itemErr.message);
            }
        }

        // Immediately trigger non-blocking outbox processing
        processOutboxBatch({ batchSize: 10, dbClient: db }).catch(() => {});

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

        // 3. Enqueue USER_IDENTIFIED event into persistent outbox
        const idempKey = `user_identified_${visitorId.slice(0, 8)}_${canonicalUserId}`;
        await enqueueOutboxEvent({
            eventName: 'USER_IDENTIFIED',
            eventSource: 'backend',
            idempotencyKey: idempKey,
            visitorId,
            sessionId: sessionId || null,
            userId: canonicalUserId,
            properties: { link_method: String(linkMethod) },
            dbClient: db
        });

        // Immediately trigger non-blocking outbox processing
        processOutboxBatch({ batchSize: 5, dbClient: db }).catch(() => {});

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
