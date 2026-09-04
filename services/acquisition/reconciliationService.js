/**
 * services/acquisition/reconciliationService.js
 *
 * Phase P.1G.3: Periodic Funnel Reconciliation & Event Gap Recovery
 *
 * Recovers missing server-only acquisition events and attributions
 * without mass backfilling historical bookings.
 *
 * Rules:
 * - Strictly respects the launch watermark from public.acquisition_system_config
 * - All historical bookings (created before watermark) are skipped (LEGACY_BACKFILL_PERFORMED: NO)
 * - If attribution context is lost, uses safe unknown/fallback source
 * - Idempotent execution: duplicate runs produce 0 duplicate events
 * - Zero raw PII in events and logs
 */

'use strict';

const { getServiceRoleClient } = require('../../dbServiceRole');
const { enqueueOutboxEvent } = require('./outboxService');
const { resolveCanonicalUserId } = require('../../utils/identityMergeHelper');

const DEFAULT_WATERMARK_UTC = '2026-09-04T18:50:00.000Z';

/**
 * Retrieves the controlled launch watermark timestamp from the database.
 *
 * @param {Object} [dbClient]
 * @returns {Promise<{ watermark_utc: string, source: string }>}
 */
async function getReconciliationWatermark(dbClient = null) {
    const db = dbClient || getServiceRoleClient();
    try {
        const { data, error } = await db
            .from('acquisition_system_config')
            .select('value')
            .eq('key', 'reconciliation_launch_watermark')
            .maybeSingle();

        if (error || !data || !data.value || !data.value.watermark_utc) {
            return {
                watermark_utc: DEFAULT_WATERMARK_UTC,
                source: 'default_fallback'
            };
        }

        return {
            watermark_utc: data.value.watermark_utc,
            source: 'public.acquisition_system_config'
        };
    } catch (err) {
        return {
            watermark_utc: DEFAULT_WATERMARK_UTC,
            source: 'exception_fallback'
        };
    }
}

/**
 * Executes a full reconciliation pass over operations created after the launch watermark.
 *
 * @param {Object} [options]
 * @param {string} [options.overrideWatermark] Optional watermark for isolated testing
 * @param {Object} [options.dbClient] Optional DB client
 * @returns {Promise<Object>} Reconciliation summary
 */
async function runReconciliationPass({ overrideWatermark = null, dbClient = null } = {}) {
    const db = dbClient || getServiceRoleClient();
    const watermarkInfo = overrideWatermark
        ? { watermark_utc: overrideWatermark, source: 'test_override' }
        : await getReconciliationWatermark(db);

    const watermarkUtc = watermarkInfo.watermark_utc;

    const summary = {
        watermark_utc: watermarkUtc,
        watermark_source: watermarkInfo.source,
        scanned_bookings: 0,
        skipped_legacy: 0,
        recovered_attributions: 0,
        recovered_booking_events: 0,
        recovered_payments: 0,
        recovered_trips: 0
    };

    try {
        // 1. Fetch count of legacy bookings to prove they are tracked and excluded
        const { count: legacyCount } = await db
            .from('bus_ticket_bookings')
            .select('id', { count: 'exact', head: true })
            .lt('created_at', watermarkUtc);

        summary.skipped_legacy = legacyCount || 0;

        // 2. Fetch all post-watermark bookings
        const { data: eligibleBookings, error: bErr } = await db
            .from('bus_ticket_bookings')
            .select('id, passenger_id, bus_ticket_id, status, created_at, total_price, paid_amount')
            .gte('created_at', watermarkUtc)
            .order('created_at', { ascending: true });

        if (bErr || !eligibleBookings) {
            console.error('[Reconciliation] Failed to fetch eligible bookings:', bErr?.message);
            return summary;
        }

        summary.scanned_bookings = eligibleBookings.length;

        for (const booking of eligibleBookings) {
            const canonicalUserId = await resolveCanonicalUserId(booking.passenger_id);

            // -----------------------------------------------------------------
            // A. Check & Recover Missing Attribution (Booking Level)
            // -----------------------------------------------------------------
            const { data: existingAttr } = await db
                .from('booking_acquisition_attributions')
                .select('id')
                .eq('booking_id', booking.id)
                .maybeSingle();

            if (!existingAttr) {
                // Attribution is missing! Recover with fallback attribution context
                try {
                    await db.rpc('fn_create_booking_acquisition_attribution', {
                        p_booking_id: Number(booking.id),
                        p_anonymous_visitor_id: '00000000-0000-0000-0000-000000000000',
                        p_acquisition_session_id: null,
                        p_acquisition_link_id: null,
                        p_campaign_id: null,
                        p_partner_id: null,
                        p_referral_attribution_id: null,
                        p_source_platform: 'unknown',
                        p_source_medium: 'unknown',
                        p_attribution_type: 'unknown',
                        p_attribution_confidence: 'fallback',
                        p_content_code: null,
                        p_placement_code: null,
                        p_initial_platform: 'unknown',
                        p_first_non_direct_platform: null,
                        p_last_non_direct_platform: null,
                        p_converting_platform: 'unknown'
                    });
                    summary.recovered_attributions += 1;
                } catch (attrErr) {
                    console.warn('[Reconciliation] Attribution recovery error:', attrErr.message);
                }
            }

            // -----------------------------------------------------------------
            // B. Check & Recover BOOKING_CREATED event
            // -----------------------------------------------------------------
            const bookingIdempKey = `booking_created_${booking.id}`;
            const { data: existingBookingEvt } = await db
                .from('acquisition_events')
                .select('id')
                .eq('idempotency_key', bookingIdempKey)
                .maybeSingle();

            if (!existingBookingEvt) {
                await enqueueOutboxEvent({
                    eventName: 'BOOKING_CREATED',
                    eventSource: 'reconciliation',
                    idempotencyKey: bookingIdempKey,
                    userId: canonicalUserId,
                    bookingId: booking.id,
                    busTicketId: booking.bus_ticket_id,
                    properties: {
                        recovered_by: 'reconciliation',
                        recovered_at: new Date().toISOString()
                    },
                    dbClient: db
                });
                summary.recovered_booking_events += 1;
            }

            // -----------------------------------------------------------------
            // C. Check & Recover PAYMENT_COMPLETED event
            // -----------------------------------------------------------------
            const isConfirmedOrPaid = booking.status === 'confirmed' || Number(booking.paid_amount || 0) > 0;
            if (isConfirmedOrPaid) {
                const paymentIdempKey = `payment_completed_${booking.id}`;
                const { data: existingPaymentEvt } = await db
                    .from('acquisition_events')
                    .select('id')
                    .eq('idempotency_key', paymentIdempKey)
                    .maybeSingle();

                if (!existingPaymentEvt) {
                    await enqueueOutboxEvent({
                        eventName: 'PAYMENT_COMPLETED',
                        eventSource: 'reconciliation',
                        idempotencyKey: paymentIdempKey,
                        userId: canonicalUserId,
                        bookingId: booking.id,
                        busTicketId: booking.bus_ticket_id,
                        properties: {
                            recovered_by: 'reconciliation',
                            recovered_at: new Date().toISOString()
                        },
                        dbClient: db
                    });
                    summary.recovered_payments += 1;
                }
            }

            // -----------------------------------------------------------------
            // D. Check & Recover TRIP_COMPLETED event
            // -----------------------------------------------------------------
            if (booking.bus_ticket_id) {
                const { data: ticket } = await db
                    .from('bus_tickets')
                    .select('status')
                    .eq('id', booking.bus_ticket_id)
                    .maybeSingle();

                if (ticket && ticket.status === 'completed' && booking.status !== 'cancelled') {
                    const tripIdempKey = `trip_completed_${booking.id}`;
                    const { data: existingTripEvt } = await db
                        .from('acquisition_events')
                        .select('id')
                        .eq('idempotency_key', tripIdempKey)
                        .maybeSingle();

                    if (!existingTripEvt) {
                        await enqueueOutboxEvent({
                            eventName: 'TRIP_COMPLETED',
                            eventSource: 'reconciliation',
                            idempotencyKey: tripIdempKey,
                            userId: canonicalUserId,
                            bookingId: booking.id,
                            busTicketId: booking.bus_ticket_id,
                            properties: {
                                recovered_by: 'reconciliation',
                                recovered_at: new Date().toISOString()
                            },
                            dbClient: db
                        });
                        summary.recovered_trips += 1;
                    }
                }
            }
        }

        return summary;
    } catch (err) {
        console.error('[Reconciliation] Pass exception:', err.message);
        return summary;
    }
}

module.exports = {
    runReconciliationPass,
    getReconciliationWatermark,
    DEFAULT_WATERMARK_UTC
};
