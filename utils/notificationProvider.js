/**
 * notificationProvider.js
 * 
 * Multi-Channel Notification Provider Abstraction
 * Project: POPUTKI.ONLINE
 */

const { sendMessage } = require('./telegramBot');

/**
 * Generates a deterministic idempotency key for notification tracking.
 * 
 * @param {number|string} bookingId
 * @param {string} recipientType - 'passenger' | 'coordinator' | 'creator'
 * @param {string|number} recipientIdentity - user_id or normalized phone fingerprint
 * @param {string} channel - 'telegram' | 'whatsapp'
 * @param {string} notificationType - 'ticket_issued' | 'coordinator_manifest' | 'trip_reminder'
 * @returns {string}
 */
function generateNotificationIdempotencyKey(bookingId, recipientType, recipientIdentity, channel, notificationType) {
    const cleanId = String(bookingId || 0);
    const cleanType = String(recipientType || 'unknown').toLowerCase();
    const cleanIdent = String(recipientIdentity || 'unknown').replace(/[^a-zA-Z0-9]/g, '');
    const cleanChan = String(channel || 'unknown').toLowerCase();
    const cleanNotif = String(notificationType || 'default').toLowerCase();
    return `booking:${cleanId}:${cleanType}:${cleanIdent}:${cleanChan}:${cleanNotif}`;
}

/**
 * Base Notification Provider Interface
 */
class BaseNotificationProvider {
    constructor(channelName) {
        this.channelName = channelName;
    }

    canSend(recipient) {
        throw new Error('canSend() must be implemented by subclass');
    }

    async send(recipient, payload, options = {}) {
        throw new Error('send() must be implemented by subclass');
    }
}

/**
 * Telegram Bot Notification Provider
 */
class TelegramProvider extends BaseNotificationProvider {
    constructor() {
        super('telegram');
        this.enabled = Boolean(process.env.TELEGRAM_BOT_TOKEN);
    }

    canSend(recipient) {
        if (!this.enabled) return false;
        return Boolean(recipient && recipient.telegramEligible && recipient.telegramChatId);
    }

    async send(recipient, payload, options = {}) {
        if (!this.canSend(recipient)) {
            return {
                success: false,
                status: 'skipped',
                reason: 'RECIPIENT_NOT_TELEGRAM_ELIGIBLE'
            };
        }

        if (options.dryRun) {
            return {
                success: true,
                status: 'dry_run_success',
                chatId: recipient.telegramChatId,
                payload
            };
        }

        const result = await sendMessage(recipient.telegramChatId, payload.text, {
            reply_markup: payload.reply_markup
        });

        if (result && result.ok) {
            return {
                success: true,
                status: 'sent',
                providerMessageId: String(result.result?.message_id || '')
            };
        }

        return {
            success: false,
            status: 'failed',
            error: 'TELEGRAM_SEND_FAILED'
        };
    }
}

/**
 * WhatsApp Business Cloud API Provider (Stub / Architecture Boundary)
 */
class WhatsAppProvider extends BaseNotificationProvider {
    constructor() {
        super('whatsapp');
        this.enabled = false; // Intentionally disabled until official Meta WABA integration
        this.status = 'NOT_CONFIGURED';
    }

    canSend(recipient) {
        // Strict boundary: Never send unofficial / web-scraped WhatsApp messages
        return false;
    }

    async send(recipient, payload, options = {}) {
        return {
            success: false,
            status: 'failed',
            reason: 'WHATSAPP_BUSINESS_API_NOT_CONFIGURED',
            message: 'Official Meta WhatsApp Business Cloud API is not configured in this phase'
        };
    }
}

module.exports = {
    generateNotificationIdempotencyKey,
    TelegramProvider,
    WhatsAppProvider
};
