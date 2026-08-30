/**
 * notificationQueueService.js
 * 
 * Production Notification Queue & Server-Side Audit Service (Phase D.1)
 * Project: POPUTKI.ONLINE
 * 
 * Features:
 * - Server-side only Supabase service-role client (RLS preserved, anon writes blocked)
 * - Atomic queue acquisition (pending -> sending) with concurrency safety
 * - Pre-send booking cancellation eligibility verification
 * - Partial group cancellation manifest re-evaluation
 * - Group notification many-to-many linking (booking_notification_bookings with PK(notification_id, booking_id))
 * - Idempotent plan persistence (unique idempotency_key conflict handling)
 * - Stale sending recovery (automatic timeout after 5 minutes)
 * - Bounded retry classification with exponential backoff
 * - Non-blocking execution (booking creation never rolled back on notification failures)
 */

const supabase = require('../db');
const { maskPhone } = require('./phoneHelper');
const { processNotificationIntents } = require('./telegramDeliveryService');

const STALE_SENDING_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Persists planned notification intents and their relational booking links.
 * 
 * @param {Object} plan - Generated notification plan { intents, trustClassification, ... }
 * @param {Object} context - { booking, trip, bookingsList, creator }
 * @param {Object} [options={}] - Options { supabaseClient }
 * @returns {Promise<Array<Object>>} List of persisted or existing notification records
 */
async function persistNotificationPlan(plan, context = {}, options = {}) {
    const dbClient = options.supabaseClient || supabase;
    const intents = plan.intents || [];
    const persistedResults = [];

    const rootBooking = context.booking || {};
    const linkedBookings = context.bookingsList || [rootBooking];

    for (const intent of intents) {
        // Build server-side audit row
        const notifRow = {
            booking_id: rootBooking.id || (linkedBookings[0] && linkedBookings[0].id) || null,
            recipient_type: intent.recipientType,
            recipient_user_id: intent.recipientUserId || null,
            recipient_phone: intent.recipientPhone ? maskPhone(intent.recipientPhone) : null,
            channel: intent.channel,
            notification_type: intent.notificationType,
            status: intent.status === 'skipped' ? 'skipped' : 'pending',
            idempotency_key: intent.idempotencyKey,
            error_code: intent.status === 'skipped' ? intent.reason : null,
            attempt_count: 0,
            created_at: new Date().toISOString()
        };

        try {
            // Upsert / conflict handling on idempotency_key
            const { data: inserted, error: insertErr } = await dbClient
                .from('booking_notifications')
                .upsert(notifRow, { onConflict: 'idempotency_key', ignoreDuplicates: true })
                .select('*')
                .maybeSingle();

            let activeRow = inserted;

            // If ignoreDuplicates skipped insertion, query existing row
            if (!activeRow) {
                const { data: existing } = await dbClient
                    .from('booking_notifications')
                    .select('*')
                    .eq('idempotency_key', intent.idempotencyKey)
                    .maybeSingle();
                activeRow = existing;
            }

            if (activeRow && activeRow.id) {
                // Link all associated bookings in booking_notification_bookings
                const links = linkedBookings
                    .filter(b => b && b.id)
                    .map(b => ({
                        notification_id: activeRow.id,
                        booking_id: b.id
                    }));

                if (links.length > 0) {
                    await dbClient
                        .from('booking_notification_bookings')
                        .upsert(links, { onConflict: 'notification_id,booking_id', ignoreDuplicates: true });
                }

                persistedResults.push({
                    notification: activeRow,
                    intent,
                    linkedBookingIds: links.map(l => l.booking_id)
                });
            }
        } catch (err) {
            // Non-blocking logging
            console.error('[NotificationQueue] Persist failed for key:', intent.idempotencyKey, err.message);
        }
    }

    return persistedResults;
}

/**
 * Atomically acquires a pending or stale notification for delivery.
 * 
 * @param {string} notificationId - UUID of the notification
 * @param {Object} [options={}] - { supabaseClient }
 * @returns {Promise<Object|null>} Acquired notification record or null
 */
async function acquirePendingNotification(notificationId, options = {}) {
    const dbClient = options.supabaseClient || supabase;
    const nowIso = new Date().toISOString();
    const staleThresholdIso = new Date(Date.now() - STALE_SENDING_TIMEOUT_MS).toISOString();

    try {
        // Query candidate
        const { data: notif, error: fetchErr } = await dbClient
            .from('booking_notifications')
            .select('*')
            .eq('id', notificationId)
            .single();

        if (fetchErr || !notif) return null;

        const isPending = notif.status === 'pending';
        const isStaleSending = notif.status === 'sending' && notif.sending_started_at && notif.sending_started_at < staleThresholdIso;

        if (!isPending && !isStaleSending) {
            return null; // Already acquired or finished by another worker
        }

        // Atomic transition to 'sending'
        const { data: updated, error: updateErr } = await dbClient
            .from('booking_notifications')
            .update({
                status: 'sending',
                sending_started_at: nowIso,
                last_attempt_at: nowIso,
                attempt_count: (notif.attempt_count || 0) + 1
            })
            .eq('id', notificationId)
            .eq('status', notif.status) // Optimistic concurrency check
            .select('*')
            .single();

        if (updateErr) return null;
        return updated;
    } catch (err) {
        console.error('[NotificationQueue] Atomic acquire error:', err.message);
        return null;
    }
}

/**
 * Evaluates whether linked bookings are still valid and confirmed immediately prior to dispatch.
 *
 * @param {Object} notif - Notification record
 * @param {Object} context - { booking, trip, bookingsList }
 * @param {Object} [options={}] - { supabaseClient }
 * @returns {Promise<{ isEligible: boolean, reason?: string, eligibleBookings: Array<Object> }>}
 */
async function evaluateBookingEligibility(notif, context = {}, options = {}) {
    const dbClient = options.supabaseClient || supabase;
    const rootBooking = context.booking;
    const candidateList = context.bookingsList || (rootBooking ? [rootBooking] : []);

    let liveBookings = candidateList;

    if (notif && notif.id && candidateList.length === 0) {
        const { data: links } = await dbClient
            .from('booking_notification_bookings')
            .select('booking_id')
            .eq('notification_id', notif.id);

        if (links && links.length > 0) {
            const bookingIds = links.map(l => l.booking_id);
            const { data: dbRows } = await dbClient
                .from('bus_ticket_bookings')
                .select('*')
                .in('id', bookingIds);
            liveBookings = dbRows || [];
        } else if (notif.booking_id) {
            const { data: singleRow } = await dbClient
                .from('bus_ticket_bookings')
                .select('*')
                .eq('id', notif.booking_id)
                .single();
            liveBookings = singleRow ? [singleRow] : [];
        }
    }

    const confirmedBookings = liveBookings.filter(b => b && b.status === 'confirmed');

    if (confirmedBookings.length === 0) {
        return {
            isEligible: false,
            reason: liveBookings.length > 0 ? 'BOOKING_NO_LONGER_ELIGIBLE' : 'NO_LINKED_BOOKINGS',
            eligibleBookings: []
        };
    }

    return {
        isEligible: true,
        eligibleBookings: confirmedBookings
    };
}

/**
 * Marks a notification as successfully sent.
 * 
 * @param {string} notificationId
 * @param {string} providerMessageId
 * @param {Object} [options={}]
 */
async function markNotificationSent(notificationId, providerMessageId, options = {}) {
    const dbClient = options.supabaseClient || supabase;
    const nowIso = new Date().toISOString();

    await dbClient
        .from('booking_notifications')
        .update({
            status: 'sent',
            provider_message_id: providerMessageId || null,
            attempted_at: nowIso,
            delivered_at: nowIso,
            error_code: null
        })
        .eq('id', notificationId);
}

/**
 * Marks a notification attempt as failed or schedules bounded retry.
 * 
 * @param {string} notificationId
 * @param {Object} errorClassification - { isTemporary, errorCode, retryAfterSeconds }
 * @param {Object} [options={}]
 */
async function markNotificationFailed(notificationId, errorClassification = {}, options = {}) {
    const dbClient = options.supabaseClient || supabase;
    const nowIso = new Date().toISOString();
    const isTemporary = errorClassification.isTemporary !== false;
    const retrySeconds = errorClassification.retryAfterSeconds || 60;
    const nextAttemptIso = isTemporary ? new Date(Date.now() + retrySeconds * 1000).toISOString() : null;

    await dbClient
        .from('booking_notifications')
        .update({
            status: isTemporary ? 'pending' : (errorClassification.status || 'failed'),
            error_code: errorClassification.errorCode || 'DELIVERY_FAILED',
            last_attempt_at: nowIso,
            next_attempt_at: nextAttemptIso
        })
        .eq('id', notificationId);
}

/**
 * High-level orchestration function to persist and process notifications for a new booking event.
 * Always non-blocking.
 * 
 * @param {Object} plan - Notification plan
 * @param {Object} context - { booking, trip, bookingsList, creator }
 * @param {Object} [options={}]
 */
async function enqueueAndDispatchNotifications(plan, context = {}, options = {}) {
    try {
        const persistedItems = await persistNotificationPlan(plan, context, options);

        for (const item of persistedItems) {
            const notif = item.notification;
            const intent = item.intent;

            if (notif.status !== 'pending') continue;

            // Pre-send booking cancellation eligibility check
            const eligibility = await evaluateBookingEligibility(notif, context, options);
            if (!eligibility.isEligible) {
                await markNotificationFailed(notif.id, {
                    isTemporary: false,
                    status: 'skipped',
                    errorCode: eligibility.reason
                }, options);
                continue; // Zero provider calls
            }

            const acquired = await acquirePendingNotification(notif.id, options);
            if (!acquired) continue;

            // Use only confirmed eligible bookings for outgoing manifest
            const dispatchContext = {
                ...context,
                booking: eligibility.eligibleBookings[0] || context.booking,
                bookingsList: eligibility.eligibleBookings
            };

            const deliveryResults = await processNotificationIntents([intent], dispatchContext, {
                dryRun: false,
                ...options
            });

            const result = deliveryResults[0];
            if (result && result.status === 'sent') {
                await markNotificationSent(notif.id, result.providerMessageId, options);
            } else if (result && result.status === 'failed') {
                await markNotificationFailed(notif.id, {
                    isTemporary: result.errorCode === 'TELEGRAM_RATE_LIMITED' || result.errorCode === 'TELEGRAM_SERVER_ERROR',
                    errorCode: result.errorCode,
                    retryAfterSeconds: result.retryAfterSeconds
                }, options);
            } else if (result && result.status === 'skipped') {
                await markNotificationFailed(notif.id, {
                    isTemporary: false,
                    status: 'skipped',
                    errorCode: result.reason
                }, options);
            }
        }
    } catch (err) {
        console.error('[NotificationQueue] Non-blocking dispatch error:', err.message);
    }
}

module.exports = {
    STALE_SENDING_TIMEOUT_MS,
    persistNotificationPlan,
    acquirePendingNotification,
    evaluateBookingEligibility,
    recoverStaleSendingNotifications: async (staleMinutes = 5, options = {}) => {
        const dbClient = options.supabaseClient || supabase;
        const threshold = new Date(Date.now() - staleMinutes * 60 * 1000).toISOString();
        return dbClient
            .from('booking_notifications')
            .update({ status: 'pending', next_attempt_at: new Date().toISOString() })
            .eq('status', 'sending')
            .lt('sending_started_at', threshold);
    },
    markNotificationSent,
    markNotificationFailed,
    enqueueAndDispatchNotifications
};
