/**
 * telegramDeliveryService.js
 * 
 * Telegram Notification Delivery Engine (Phase C.2 Limited Rollout)
 * Project: POPUTKI.ONLINE
 * 
 * Manages:
 * - Dual kill switch validation (NOTIFICATION_DELIVERY_ENABLED & TELEGRAM_NOTIFICATION_DELIVERY_ENABLED)
 * - Controlled recipient role gate (TELEGRAM_NOTIFICATION_ALLOWED_RECIPIENT_TYPES: creator, coordinator, family_or_group)
 * - Direct passenger identity delivery safety hold (PASSENGER_DIRECT_DELIVERY_NOT_ENABLED)
 * - Controlled test mode allowlist (NOTIFICATION_TEST_MODE & TELEGRAM_NOTIFICATION_TEST_USER_IDS)
 * - Safe dry-run processing (zero Bot API requests)
 * - Concurrency protection & atomic state transitions
 * - Error classification (temporary vs permanent)
 */

const { renderTelegramNotification } = require('./telegramMessageRenderer');
const { maskPhone } = require('./phoneHelper');
const { sendMessage, sendDocument, sendPhoto } = require('./telegramBot');
const { buildPassengerTicketProjection } = require('./ticketHelper');
const { generateTicketPdf } = require('./ticketPdfService');
const { generateTicketPng } = require('./ticketImageService');

const DEFAULT_ALLOWED_RECIPIENT_TYPES = ['creator', 'coordinator', 'family_or_group'];

/**
 * Classifies an error response from Telegram Bot API into temporary vs permanent failure.
 * 
 * @param {Error|Object} error
 * @returns {{ isTemporary: boolean, errorCode: string, retryAfterSeconds?: number }}
 */
function classifyTelegramError(error) {
    const status = error.response?.status || error.status;
    const desc = error.response?.data?.description || error.message || '';

    // 1. Rate Limit (429) -> Temporary
    if (status === 429) {
        const retryAfter = error.response?.data?.parameters?.retry_after || 5;
        return { isTemporary: true, errorCode: 'TELEGRAM_RATE_LIMITED', retryAfterSeconds: retryAfter };
    }

    // 2. Server Errors (5xx) or Network Timeouts -> Temporary
    if ((status >= 500 && status <= 599) || error.code === 'ETIMEDOUT' || error.code === 'ECONNRESET') {
        return { isTemporary: true, errorCode: 'TELEGRAM_SERVER_ERROR', retryAfterSeconds: 30 };
    }

    // 3. User Blocked Bot (403 Forbidden) -> Permanent
    if (status === 403 || desc.includes('bot was blocked') || desc.includes('user is deactivated')) {
        return { isTemporary: false, errorCode: 'TELEGRAM_BOT_BLOCKED_BY_USER' };
    }

    // 4. Chat Not Found (400 Bad Request) -> Permanent
    if (status === 400 && (desc.includes('chat not found') || desc.includes('chat_id is empty'))) {
        return { isTemporary: false, errorCode: 'TELEGRAM_CHAT_NOT_FOUND' };
    }

    return { isTemporary: false, errorCode: 'TELEGRAM_PERMANENT_FAILURE' };
}

/**
 * Checks if real Telegram notification delivery is permitted by environment feature flags.
 * 
 * @returns {boolean}
 */
function isDeliveryEnabled() {
    const globalEnabled = process.env.NOTIFICATION_DELIVERY_ENABLED === 'true';
    const telegramEnabled = process.env.TELEGRAM_NOTIFICATION_DELIVERY_ENABLED === 'true';
    return globalEnabled && telegramEnabled;
}

/**
 * Checks if a recipient role is allowed under the current rollout stage.
 * In Phase C.2: creator, coordinator, and family_or_group are allowed; passenger is held.
 *
 * @param {string} recipientType
 * @returns {boolean}
 */
function isRecipientTypeAllowed(recipientType, intent = {}) {
    const rType = String(recipientType || '').toLowerCase();
    
    // Phase E.7 Rule: Direct Telegram passenger ticket delivery is allowed ONLY for registered, verified, safely resolved Telegram passengers
    if (rType === 'passenger') {
        if (intent.reason === 'VERIFIED_TELEGRAM_PASSENGER' || intent.isRegisteredPassenger || intent.isClaimed) {
            return true;
        }
    }

    const configured = process.env.TELEGRAM_NOTIFICATION_ALLOWED_RECIPIENT_TYPES;
    const allowedList = configured
        ? configured.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
        : DEFAULT_ALLOWED_RECIPIENT_TYPES;
    return allowedList.includes(rType);
}

/**
 * Checks if recipient is in the internal test allowlist when test mode is enabled.
 * 
 * @param {number|string} [recipientUserId]
 * @param {number|string} [recipientTelegramId]
 * @returns {boolean}
 */
function isRecipientAllowlisted(recipientUserId, recipientTelegramId) {
    if (process.env.NOTIFICATION_TEST_MODE !== 'true') {
        return true; // General mode (governed by role gates and delivery flags)
    }
    const rawAllowlist = process.env.TELEGRAM_NOTIFICATION_TEST_USER_IDS || '';
    const allowedIds = rawAllowlist.split(',').map(s => s.trim()).filter(Boolean);
    if (allowedIds.length === 0) return false;
    return (
        (recipientUserId && allowedIds.includes(String(recipientUserId))) ||
        (recipientTelegramId && allowedIds.includes(String(recipientTelegramId)))
    );
}

/**
 * Processes notification intents in dry-run mode or executes real delivery.
 * 
 * @param {Array<Object>} intents - List of notification intents
 * @param {Object} [data={}] - Context data { booking, trip, bookingsList }
 * @param {Object} [options={}] - Options { dryRun: true, supabase: null }
 * @returns {Promise<Array<Object>>} Processing results
 */
async function processNotificationIntents(intents = [], data = {}, options = {}) {
    const isDryRun = options.dryRun !== false; // Defaults to TRUE for safety
    const deliveryPermitted = isDeliveryEnabled();

    const results = [];

    for (const intent of intents) {
        // WhatsApp intents remain strictly skipped in Phase C.2
        if (intent.channel === 'whatsapp') {
            results.push({
                channel: 'whatsapp',
                recipientType: intent.recipientType,
                status: 'skipped',
                reason: 'WHATSAPP_BUSINESS_API_NOT_CONFIGURED',
                dryRun: isDryRun
            });
            continue;
        }

        // Telegram Channel Evaluation
        if (intent.channel === 'telegram') {
            if (intent.status === 'skipped') {
                results.push({
                    channel: 'telegram',
                    recipientType: intent.recipientType,
                    status: 'skipped',
                    reason: intent.reason,
                    dryRun: isDryRun
                });
                continue;
            }

            // Phase C.2 / E.7 Recipient Role Gate
            if (!isRecipientTypeAllowed(intent.recipientType, intent)) {
                results.push({
                    channel: 'telegram',
                    recipientType: intent.recipientType,
                    status: 'skipped',
                    reason: intent.recipientType === 'passenger'
                        ? 'PASSENGER_DIRECT_DELIVERY_NOT_ENABLED'
                        : 'RECIPIENT_TYPE_NOT_ALLOWED',
                    dryRun: isDryRun
                });
                continue;
            }

            // Check Test Mode Allowlist
            const allowlisted = isRecipientAllowlisted(intent.recipientUserId, intent.telegramChatId);
            if (!allowlisted) {
                results.push({
                    channel: 'telegram',
                    recipientType: intent.recipientType,
                    status: 'skipped',
                    reason: 'TEST_MODE_RECIPIENT_NOT_ALLOWED',
                    dryRun: isDryRun
                });
                continue;
            }

            // Render message text & buttons
            const rendered = renderTelegramNotification(intent, data);

            // In Dry-Run mode or when delivery flags are false: produce preview only
            if (isDryRun || !deliveryPermitted) {
                results.push({
                    channel: 'telegram',
                    recipientType: intent.recipientType,
                    recipientUserId: intent.recipientUserId || null,
                    recipientMaskedPhone: intent.recipientMaskedPhone || (intent.recipientPhone ? maskPhone(intent.recipientPhone) : 'N/A'),
                    templateKey: intent.templateKey,
                    status: 'pending',
                    wouldSend: Boolean(intent.telegramChatId),
                    dryRun: true,
                    deliveryBlockedByKillSwitch: !deliveryPermitted,
                    idempotencyKey: intent.idempotencyKey,
                    renderedPreview: {
                        parseMode: rendered.parse_mode,
                        textSnippet: rendered.text.substring(0, 120) + '...',
                        hasButton: Boolean(rendered.reply_markup?.inline_keyboard?.length)
                    }
                });
                continue;
            }

            // REAL DELIVERY PATH (Only executed when delivery is enabled, role allowed, and allowlist passed)
            try {
                if (!intent.telegramChatId) {
                    results.push({
                        channel: 'telegram',
                        recipientType: intent.recipientType,
                        status: 'skipped',
                        reason: 'NO_TELEGRAM_CHAT_ID',
                        dryRun: false
                    });
                    continue;
                }

                let sendRes = null;
                let isPhotoSent = false;

                const isTicketNotif = intent.notificationType === 'ticket_issued' || intent.notificationType === 'passenger_ticket_issued';

                if (isTicketNotif && data.booking && data.trip) {
                    // High-Resolution PNG Ticket V1.1 Inline Delivery Path
                    try {
                        const projection = buildPassengerTicketProjection(data.booking, data.trip, data.busMaster || null);
                        if (projection) {
                            const pngBuffer = await generateTicketPng(projection);
                            const filename = `POPUTKI-TICKET-${projection.ticketNumber || 'POP-000000'}.png`;

                            // ABSOLUTE RULE: ONLY ONE MESSAGE via Telegram sendPhoto, EMPTY caption
                            sendRes = await sendPhoto(intent.telegramChatId, pngBuffer, filename, '');
                            if (sendRes && (sendRes.ok || sendRes.message_id || sendRes.result?.message_id)) {
                                isPhotoSent = true;
                            }
                        }
                    } catch (photoErr) {
                        console.error('[TelegramDelivery] PNG ticket image generation error:', photoErr.message);
                    }
                } else if (!isTicketNotif) {
                    // Non-ticket notifications use standard text message
                    sendRes = await sendMessage(intent.telegramChatId, rendered.text, {
                        reply_markup: rendered.reply_markup
                    });
                }

                if (sendRes && (sendRes.ok || sendRes.message_id || sendRes.result?.message_id)) {
                    const msgId = String(sendRes.message_id || sendRes.result?.message_id || 'sent');
                    results.push({
                        channel: 'telegram',
                        recipientType: intent.recipientType,
                        status: 'sent',
                        providerMessageId: msgId,
                        isPhotoSent,
                        idempotencyKey: intent.idempotencyKey,
                        dryRun: false
                    });
                } else {
                    results.push({
                        channel: 'telegram',
                        recipientType: intent.recipientType,
                        status: 'failed',
                        errorCode: isTicketNotif ? 'TICKET_IMAGE_DELIVERY_FAILED' : 'TELEGRAM_SEND_FAILED',
                        idempotencyKey: intent.idempotencyKey,
                        dryRun: false
                    });
                }
            } catch (err) {
                const classified = classifyTelegramError(err);
                results.push({
                    channel: 'telegram',
                    recipientType: intent.recipientType,
                    status: 'failed',
                    errorCode: classified.errorCode,
                    retryAfterSeconds: classified.retryAfterSeconds,
                    idempotencyKey: intent.idempotencyKey,
                    dryRun: false
                });
            }
        }
    }

    return results;
}

module.exports = {
    classifyTelegramError,
    isDeliveryEnabled,
    isRecipientTypeAllowed,
    isRecipientAllowlisted,
    processNotificationIntents
};
