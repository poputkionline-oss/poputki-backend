/**
 * manualBookingSmsOutboxService.js
 *
 * Background worker for the manual_booking_sms_outbox transactional outbox.
 * Claims a batch via fn_claim_manual_booking_sms_batch (FOR UPDATE SKIP
 * LOCKED + lease), re-validates eligibility live, applies cost/abuse caps,
 * renders the deterministic SMS template, generates the claim session at
 * SEND TIME ONLY (never persisted — see migration comments), and calls
 * osonSmsClient. Never sends from within an HTTP request handler.
 * Project: POPUTKI.ONLINE
 */

'use strict';

const { getServiceRoleClient } = require('../dbServiceRole');
const { sendServiceSms, classifyPhone } = require('./osonSmsClient');
const { queryOsonSmsStatus } = require('./osonSmsStatusClient');
const { renderManualBookingTicketSms } = require('./smsTemplates');
const { checkSendCaps, hmacPhone } = require('./osonSmsCaps');
const { maskPhone, cleanPhoneForStorage } = require('./phoneHelper');

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://www.poputki.online';

// Timeout results are ambiguous (OSON may or may not have actually sent).
// Do not hammer retries on an ambiguous outcome — long backoff, low ceiling,
// pending a confirmed OSON delivery-status API (see audit report §1).
const TIMEOUT_BACKOFF_SECONDS = 30 * 60;
const DEFAULT_BACKOFF_SECONDS = 5 * 60;

async function markOutboxRow(client, id, patch) {
    await client.from('manual_booking_sms_outbox').update(patch).eq('id', id);
}

/**
 * Claims and processes up to batchSize manual-booking SMS outbox entries.
 * @param {Object} options - { supabaseClient, batchSize, dryRun, workerToken }
 * @returns {Promise<{processed:number, sent:number, cancelled:number, failed:number, dead_letter:number, retried:number, reconciliation:number, killSwitchOff?: boolean}>}
 *   reconciliation counts rows moved to 'reconciliation_required' — a
 *   duplicate (409) with no durably known msg_id, which this worker will
 *   never automatically retry, resend, or resolve; a human must check
 *   OSON's own dashboard/support.
 */
async function processManualBookingSmsOutbox(options = {}) {
    const { batchSize = 10, dryRun = false, workerToken = null } = options;
    const client = options.supabaseClient || getServiceRoleClient();
    if (!client) throw new Error('SERVICE_ROLE_CLIENT_UNAVAILABLE');

    // Global kill switch, checked BEFORE claiming anything so pending rows
    // are left untouched (no lease churn) when the feature is off.
    if (process.env.OSON_SMS_ENABLED !== 'true') {
        return { processed: 0, sent: 0, cancelled: 0, failed: 0, dead_letter: 0, retried: 0, reconciliation: 0, killSwitchOff: true };
    }

    const token = workerToken || `oson-worker-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    let claimed = [];
    if (typeof client.rpc === 'function') {
        const { data, error } = await client.rpc('fn_claim_manual_booking_sms_batch', {
            p_batch_size: batchSize,
            p_worker_token: token,
            p_lease_seconds: 60
        });
        if (error) {
            // Migration not applied yet in this environment — safe no-op, not a crash.
            return { processed: 0, sent: 0, cancelled: 0, failed: 0, dead_letter: 0, retried: 0, reconciliation: 0, migrationMissing: true };
        }
        claimed = data || [];
    } else {
        // Mock client fallback for unit tests without a real rpc().
        const { data } = await client.from('manual_booking_sms_outbox').select('*').eq('status', 'pending').limit(batchSize);
        claimed = data || [];
    }

    let sent = 0, cancelled = 0, failed = 0, deadLetter = 0, retried = 0, reconciliation = 0;

    for (const entry of claimed) {
        const entryId = entry.outbox_id || entry.id;
        const bookingId = entry.booking_id;

        const { data: booking, error: bookingErr } = await client
            .from('bus_ticket_bookings')
            .select('id, status, claim_status, claimed_by_user_id, phone, bus_ticket_id, created_by_user_id')
            .eq('id', bookingId)
            .single();

        if (bookingErr || !booking) {
            await markOutboxRow(client, entryId, { status: 'cancelled', cancelled_at: new Date().toISOString(), last_error_code: 'BOOKING_NOT_FOUND' });
            cancelled++; continue;
        }

        if (booking.status !== 'confirmed') {
            await markOutboxRow(client, entryId, { status: 'cancelled', cancelled_at: new Date().toISOString(), last_error_code: 'BOOKING_NO_LONGER_ELIGIBLE' });
            cancelled++; continue;
        }

        if (booking.claim_status === 'claimed' || booking.claimed_by_user_id) {
            // Passenger already linked (e.g. via Telegram) since this row was queued — never double-deliver.
            await markOutboxRow(client, entryId, { status: 'cancelled', cancelled_at: new Date().toISOString(), last_error_code: 'ALREADY_CLAIMED_SKIP_SMS' });
            cancelled++; continue;
        }

        const phone = cleanPhoneForStorage(booking.phone);
        if (!phone) {
            await markOutboxRow(client, entryId, { status: 'dead_letter', last_error_code: 'NO_PHONE' });
            deadLetter++; continue;
        }

        const phoneCheck = classifyPhone(phone);
        if (!phoneCheck.valid) {
            await markOutboxRow(client, entryId, {
                status: 'dead_letter',
                last_error_code: phoneCheck.reason,
                recipient_phone_masked: maskPhone(phone),
                recipient_phone_hmac: safeHmac(phone)
            });
            deadLetter++; continue;
        }

        const capResult = await checkSendCaps({ dbClient: client, phone, carrierId: entry.carrier_id || booking.created_by_user_id, outboxId: entryId });
        if (!capResult.allowed) {
            // Cap failures are temporary (reset daily) — retry later, don't burn the attempt budget hard.
            await markOutboxRow(client, entryId, {
                status: 'retry',
                scheduled_at: new Date(Date.now() + DEFAULT_BACKOFF_SECONDS * 1000).toISOString(),
                last_error_code: capResult.reason,
                recipient_phone_masked: maskPhone(phone),
                recipient_phone_hmac: safeHmac(phone)
            });
            retried++; continue;
        }

        let trip = null;
        try {
            const { data } = await client
                .from('bus_tickets')
                .select('from_city, to_city')
                .eq('id', booking.bus_ticket_id)
                .single();
            trip = data;
        } catch { /* non-fatal, template falls back to em-dash */ }

        let claimUrl;
        let claimTokenHash = null;
        try {
            const { generateClaimSession, hashSessionToken } = require('./claimHelper');
            const session = await generateClaimSession(booking.id, { supabaseClient: client });
            // Web landing page reuses the SAME raw token as the bot deep link
            // (both validate against the same booking_claim_sessions hash).
            const rawToken = session?.deepLink ? session.deepLink.split('claim_')[1] : null;
            if (!rawToken) throw new Error('CLAIM_SESSION_TOKEN_MISSING');
            claimUrl = `${FRONTEND_URL}/t/${rawToken}`;
            claimTokenHash = hashSessionToken ? hashSessionToken(rawToken) : null;
        } catch (sessionErr) {
            await markOutboxRow(client, entryId, { status: 'failed', last_error_code: 'CLAIM_SESSION_GENERATION_FAILED' });
            failed++; continue;
        }

        const rendered = renderManualBookingTicketSms({
            locale: entry.locale || 'ru',
            fromCity: trip?.from_city,
            toCity: trip?.to_city,
            claimUrl
        });

        if (dryRun || process.env.OSON_SMS_DELIVERY_ENABLED !== 'true') {
            await markOutboxRow(client, entryId, {
                status: 'sent',
                sent_at: new Date().toISOString(),
                recipient_phone_masked: maskPhone(phone),
                recipient_phone_hmac: safeHmac(phone),
                claim_token_hash: claimTokenHash
            });
            sent++; continue;
        }

        const result = await sendServiceSms({
            recipientPhone: phone,
            message: rendered.text,
            idempotencyKey: entry.idempotency_key
        }, options.fetchImpl ? { fetchImpl: options.fetchImpl } : {});

        if (result.success) {
            await markOutboxRow(client, entryId, {
                status: 'sent',
                sent_at: new Date().toISOString(),
                provider_message_id: result.providerMessageId || null,
                recipient_phone_masked: maskPhone(phone),
                recipient_phone_hmac: safeHmac(phone),
                claim_token_hash: claimTokenHash
            });
            sent++;
        } else if (result.errorCode === 'PROVIDER_TIMEOUT') {
            const attempts = entry.attempts_count || 1;
            const maxAttempts = entry.max_attempts || 3;
            if (attempts >= maxAttempts) {
                await markOutboxRow(client, entryId, { status: 'dead_letter', last_error_code: 'PROVIDER_TIMEOUT_MAX_ATTEMPTS' });
                deadLetter++;
            } else {
                await markOutboxRow(client, entryId, {
                    status: 'retry',
                    scheduled_at: new Date(Date.now() + TIMEOUT_BACKOFF_SECONDS * 1000).toISOString(),
                    last_error_code: 'PROVIDER_TIMEOUT'
                });
                retried++;
            }
        } else if (result.duplicate) {
            // HTTP 409 / DUPLICATE_TXN_ID: OSON already has a message under
            // this exact txn_id (stable per outbox row — never a fresh one
            // per attempt, so a duplicate here means a PRIOR attempt of
            // THIS SAME row got through even though our own client never
            // saw a success response for it, e.g. a timeout that actually
            // sent). NEVER mark delivered on a duplicate by itself.
            //
            // CRITICAL: the confirmed OSON SMS API 2.0.2 contract requires
            // login + txn_id + msg_id for query_sms.php — nothing confirms
            // txn_id alone is a valid lookup, and nothing confirms the 409
            // response itself echoes the original msg_id. So:
            //   Variant A — a msg_id was already durably stored for this
            //     row (from an earlier confirmed 201 send) -> resolve via
            //     query_sms.php with that stored msg_id.
            //   Variant B — no msg_id is known at all -> do NOT call the
            //     status endpoint (osonSmsStatusClient fails closed on this
            //     anyway), do NOT retry with a new txn_id, do NOT assume
            //     any outcome -> 'reconciliation_required', excluded from
            //     all automatic re-claiming, for a human to resolve via
            //     OSON's own dashboard/support.
            const { data: currentRow } = await client
                .from('manual_booking_sms_outbox')
                .select('provider_message_id')
                .eq('id', entryId)
                .single();
            const knownMsgId = currentRow && currentRow.provider_message_id ? String(currentRow.provider_message_id) : null;

            if (!knownMsgId) {
                // Variant B: no confirmed basis to query, retry, or assume
                // any outcome. Masked phone/hmac only — never the full
                // response, token, URL, or raw phone.
                await markOutboxRow(client, entryId, {
                    status: 'reconciliation_required',
                    last_error_code: 'DUPLICATE_WITHOUT_PROVIDER_ID',
                    recipient_phone_masked: maskPhone(phone),
                    recipient_phone_hmac: safeHmac(phone),
                    claim_token_hash: claimTokenHash
                });
                reconciliation++;
                continue;
            }

            // Variant A
            const statusResult = await queryOsonSmsStatus(
                { txnId: result.txnId, msgId: knownMsgId },
                options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}
            );

            if (statusResult.success && statusResult.internalStatus === 'delivered') {
                await markOutboxRow(client, entryId, {
                    status: 'delivered',
                    sent_at: new Date().toISOString(),
                    delivered_at: new Date().toISOString(),
                    recipient_phone_masked: maskPhone(phone),
                    recipient_phone_hmac: safeHmac(phone),
                    claim_token_hash: claimTokenHash,
                    last_error_code: null
                });
                sent++;
            } else if (statusResult.success && statusResult.internalStatus === 'sent') {
                await markOutboxRow(client, entryId, {
                    status: 'sent',
                    sent_at: new Date().toISOString(),
                    recipient_phone_masked: maskPhone(phone),
                    recipient_phone_hmac: safeHmac(phone),
                    claim_token_hash: claimTokenHash,
                    last_error_code: null
                });
                sent++;
            } else if (statusResult.success && statusResult.terminal) {
                // EXPIRED/UNDELIVERABLE/REJECTED -> failed; DELETED -> cancelled.
                await markOutboxRow(client, entryId, {
                    status: statusResult.internalStatus,
                    last_error_code: statusResult.errorCode || 'PROVIDER_DUPLICATE_RESOLVED_TERMINAL'
                });
                if (statusResult.internalStatus === 'cancelled') cancelled++; else deadLetter++;
            } else {
                // Status query itself failed, or came back UNKNOWN — do NOT
                // mint a new txn_id and do NOT assume success. Bounded retry
                // with the same idempotency_key (same txn_id next attempt too).
                const attempts = entry.attempts_count || 1;
                const maxAttempts = entry.max_attempts || 5;
                if (attempts >= maxAttempts) {
                    await markOutboxRow(client, entryId, { status: 'dead_letter', last_error_code: 'PROVIDER_DUPLICATE_TXN_ID_UNRESOLVED' });
                    deadLetter++;
                } else {
                    await markOutboxRow(client, entryId, {
                        status: 'retry',
                        scheduled_at: new Date(Date.now() + DEFAULT_BACKOFF_SECONDS * 1000).toISOString(),
                        last_error_code: 'PROVIDER_DUPLICATE_TXN_ID'
                    });
                    retried++;
                }
            }
        } else if (['ERR_INSECURE_TRANSPORT', 'ERR_UNEXPECTED_HOST', 'ERR_REDIRECT_BLOCKED', 'OSON_SMS_CONFIG_INCOMPLETE', 'OSON_SMS_DISABLED', 'OSON_SMS_UNCONFIRMED_SENDER', 'INVALID_PHONE', 'UNSUPPORTED_COUNTRY', 'TXN_ID_MISMATCH'].includes(result.errorCode)) {
            await markOutboxRow(client, entryId, { status: 'dead_letter', last_error_code: result.errorCode });
            deadLetter++;
        } else {
            const attempts = entry.attempts_count || 1;
            const maxAttempts = entry.max_attempts || 5;
            if (attempts >= maxAttempts) {
                await markOutboxRow(client, entryId, { status: 'dead_letter', last_error_code: result.errorCode || 'MAX_ATTEMPTS_EXCEEDED' });
                deadLetter++;
            } else {
                const backoff = Math.min(DEFAULT_BACKOFF_SECONDS * Math.pow(2, attempts - 1), 6 * 60 * 60);
                await markOutboxRow(client, entryId, {
                    status: 'retry',
                    scheduled_at: new Date(Date.now() + backoff * 1000).toISOString(),
                    last_error_code: result.errorCode || 'DELIVERY_RETRY'
                });
                retried++;
            }
        }
    }

    return { processed: claimed.length, sent, cancelled, failed, dead_letter: deadLetter, retried, reconciliation };
}

function safeHmac(phone) {
    try {
        return hmacPhone(phone);
    } catch {
        return null; // missing OSON_SMS_PHONE_HASH_SECRET — cap-by-phone degrades, doesn't crash the worker
    }
}

module.exports = { processManualBookingSmsOutbox };
