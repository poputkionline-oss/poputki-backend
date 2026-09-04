/**
 * services/acquisition/outboxService.js
 *
 * Phase P.1G.3: Persistent Outbox & Reliable Event Ingestion Engine
 *
 * Provides transactional / durable asynchronous delivery of critical acquisition
 * lifecycle events without losing events across Render restarts or network drops.
 *
 * Invariants:
 * - Persistent storage: PostgreSQL public.acquisition_event_outbox
 * - Atomic lease acquisition: fn_claim_outbox_events (FOR UPDATE SKIP LOCKED)
 * - Zero raw PII in properties or error codes
 * - Exponential backoff up to max_attempts before dead-lettering
 */

'use strict';

const { getServiceRoleClient } = require('../../dbServiceRole');

/**
 * Enqueues a server acquisition event into the persistent outbox.
 *
 * @param {Object} params
 * @param {string} params.eventName Name of the event (e.g. BOOKING_CREATED)
 * @param {string} [params.eventSource='backend']
 * @param {string} params.idempotencyKey Unique business deduplication key
 * @param {string} [params.visitorId] Anonymous visitor UUID
 * @param {string} [params.sessionId] Acquisition session UUID
 * @param {number} [params.userId] Canonical user ID
 * @param {number} [params.bookingId] Bus ticket booking ID
 * @param {number} [params.busTicketId] Bus ticket / ride ID
 * @param {string} [params.campaignId] Campaign UUID
 * @param {string} [params.partnerId] Partner UUID
 * @param {Object} [params.properties] Safe event properties (zero PII)
 * @param {Object} [params.dbClient] Optional client
 * @returns {Promise<Object>} Outcome descriptor
 */
async function enqueueOutboxEvent({
    eventName,
    eventSource = 'backend',
    idempotencyKey,
    visitorId = null,
    sessionId = null,
    userId = null,
    bookingId = null,
    busTicketId = null,
    campaignId = null,
    partnerId = null,
    properties = {},
    dbClient = null
}) {
    if (!eventName || !idempotencyKey) {
        return { success: false, error: 'EVENT_NAME_AND_IDEMPOTENCY_KEY_REQUIRED' };
    }

    const db = dbClient || getServiceRoleClient();

    // Sanitize properties: strip any inadvertent PII
    const safeProps = { ...(properties || {}) };
    delete safeProps.phone;
    delete safeProps.phoneNumber;
    delete safeProps.contact;
    delete safeProps.passport;
    delete safeProps.token;
    delete safeProps.rawToken;
    delete safeProps.password;

    try {
        const { data, error } = await db
            .from('acquisition_event_outbox')
            .upsert({
                event_name: eventName,
                event_source: eventSource,
                idempotency_key: idempotencyKey,
                anonymous_visitor_id: visitorId,
                session_id: sessionId,
                user_id: userId ? Number(userId) : null,
                booking_id: bookingId ? Number(bookingId) : null,
                bus_ticket_id: busTicketId ? Number(busTicketId) : null,
                campaign_id: campaignId,
                partner_id: partnerId,
                properties: safeProps,
                status: 'pending',
                next_attempt_at: new Date().toISOString()
            }, {
                onConflict: 'idempotency_key',
                ignoreDuplicates: true
            })
            .select('id, status, idempotency_key')
            .maybeSingle();

        if (error) {
            console.error('[OutboxService] Enqueue error:', error.message);
            return { success: false, error: error.message };
        }

        return { success: true, outboxId: data ? data.id : null, status: 'enqueued' };
    } catch (err) {
        console.error('[OutboxService] Enqueue exception:', err.message);
        return { success: false, error: err.message };
    }
}

/**
 * Claims a batch of ready outbox events using atomic PostgreSQL leasing.
 *
 * @param {Object} [options]
 * @param {number} [options.batchSize=50]
 * @param {number} [options.leaseSeconds=60]
 * @param {Object} [options.dbClient]
 * @returns {Promise<Array>} List of claimed events
 */
async function claimOutboxBatch({ batchSize = 50, leaseSeconds = 60, dbClient = null } = {}) {
    const db = dbClient || getServiceRoleClient();
    try {
        const { data, error } = await db.rpc('fn_claim_outbox_events', {
            p_batch_size: batchSize,
            p_lease_seconds: leaseSeconds
        });

        if (error) {
            console.error('[OutboxService] Claim RPC error:', error.message);
            return [];
        }

        return Array.isArray(data) ? data : [];
    } catch (err) {
        console.error('[OutboxService] Claim exception:', err.message);
        return [];
    }
}

/**
 * Resolves a claimed outbox event with success or failure.
 *
 * @param {Object} params
 * @param {string} params.id Outbox event UUID
 * @param {string} params.leaseToken Lease token from claim
 * @param {boolean} params.success True if successfully ingested
 * @param {string} [params.errorCode] Sanitized error code (no PII)
 * @param {Object} [params.dbClient]
 * @returns {Promise<boolean>}
 */
async function resolveOutboxEvent({ id, leaseToken, success, errorCode = null, dbClient = null }) {
    const db = dbClient || getServiceRoleClient();
    try {
        const { data, error } = await db.rpc('fn_resolve_outbox_event', {
            p_id: id,
            p_lease_token: leaseToken,
            p_success: Boolean(success),
            p_error_code: errorCode ? String(errorCode).slice(0, 64) : null
        });

        if (error) {
            console.error('[OutboxService] Resolve RPC error:', error.message);
            return false;
        }

        return Boolean(data);
    } catch (err) {
        console.error('[OutboxService] Resolve exception:', err.message);
        return false;
    }
}

/**
 * Processes a single claimed outbox event by inserting it into public.acquisition_events.
 *
 * @param {Object} event Claimed outbox row
 * @param {Object} [dbClient]
 * @returns {Promise<Object>} Ingestion outcome
 */
async function processOutboxEvent(event, dbClient = null) {
    const db = dbClient || getServiceRoleClient();
    const now = new Date().toISOString();

    try {
        const { error: insertErr } = await db.from('acquisition_events').insert({
            event_name: event.event_name,
            anonymous_visitor_id: event.anonymous_visitor_id || '00000000-0000-0000-0000-000000000000',
            session_id: event.session_id || null,
            user_id: event.user_id ? Number(event.user_id) : null,
            booking_id: event.booking_id ? Number(event.booking_id) : null,
            bus_ticket_id: event.bus_ticket_id ? Number(event.bus_ticket_id) : null,
            campaign_id: event.campaign_id || null,
            partner_id: event.partner_id || null,
            event_source: event.event_source || 'backend',
            idempotency_key: event.idempotency_key,
            properties: event.properties || {},
            occurred_at: now,
            received_at: now
        });

        if (insertErr) {
            // Check for unique idempotency key violation (PostgreSQL code 23505)
            // If already inserted, treat as idempotent success
            if (insertErr.code === '23505' || (insertErr.message && insertErr.message.includes('unique'))) {
                await resolveOutboxEvent({
                    id: event.id,
                    leaseToken: event.lease_token,
                    success: true,
                    dbClient: db
                });
                return { success: true, idempotent: true };
            }

            // Real failure: mark for retry or dead-letter
            const safeErrorCode = insertErr.code || 'INSERT_ERROR';
            await resolveOutboxEvent({
                id: event.id,
                leaseToken: event.lease_token,
                success: false,
                errorCode: safeErrorCode,
                dbClient: db
            });
            return { success: false, error: safeErrorCode };
        }

        // Successfully written to acquisition_events
        await resolveOutboxEvent({
            id: event.id,
            leaseToken: event.lease_token,
            success: true,
            dbClient: db
        });

        return { success: true };
    } catch (err) {
        console.error('[OutboxService] Process exception:', err.message);
        await resolveOutboxEvent({
            id: event.id,
            leaseToken: event.lease_token,
            success: false,
            errorCode: 'PROCESS_EXCEPTION',
            dbClient: db
        });
        return { success: false, error: 'PROCESS_EXCEPTION' };
    }
}

/**
 * Executes a full outbox worker tick: claims ready events and processes them.
 *
 * @param {Object} [options]
 * @param {number} [options.batchSize=50]
 * @param {Object} [options.dbClient]
 * @returns {Promise<Object>} Processing summary
 */
async function processOutboxBatch({ batchSize = 50, dbClient = null } = {}) {
    const events = await claimOutboxBatch({ batchSize, dbClient });
    const summary = {
        claimed: events.length,
        succeeded: 0,
        failed: 0,
        idempotent: 0
    };

    for (const event of events) {
        const result = await processOutboxEvent(event, dbClient);
        if (result.success) {
            summary.succeeded += 1;
            if (result.idempotent) summary.idempotent += 1;
        } else {
            summary.failed += 1;
        }
    }

    return summary;
}

/**
 * Returns outbox health metrics without PII.
 *
 * @param {Object} [dbClient]
 * @returns {Promise<Object>}
 */
async function getOutboxMetrics(dbClient = null) {
    const db = dbClient || getServiceRoleClient();
    try {
        const { data: rows, error } = await db
            .from('acquisition_event_outbox')
            .select('status, attempt_count');

        if (error || !rows) return { pending: 0, processing: 0, completed: 0, dead_letter: 0, total: 0 };

        const metrics = {
            pending: 0,
            processing: 0,
            completed: 0,
            dead_letter: 0,
            total: rows.length
        };

        for (const row of rows) {
            if (metrics[row.status] !== undefined) {
                metrics[row.status] += 1;
            }
        }

        return metrics;
    } catch (err) {
        return { error: err.message };
    }
}

module.exports = {
    enqueueOutboxEvent,
    claimOutboxBatch,
    resolveOutboxEvent,
    processOutboxEvent,
    processOutboxBatch,
    getOutboxMetrics
};
