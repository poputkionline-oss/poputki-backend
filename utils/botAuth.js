/**
 * utils/botAuth.js
 *
 * Phase E.48.5: Telegram Bot Server-to-Server Authentication
 *
 * Authenticates server-to-server requests from the Telegram Bot (e.g. scraper ride creation).
 * Validates X-Bot-Service-Token header against process.env.BOT_SERVICE_TOKEN or
 * process.env.TELEGRAM_BOT_TOKEN.
 *
 * Fails closed if no secret is configured.
 */

'use strict';

function verifyBotServiceToken(req) {
    const token = req.headers['x-bot-service-token'];
    if (!token || typeof token !== 'string') {
        return false;
    }

    const trimmed = token.trim();
    const configuredToken = process.env.BOT_SERVICE_TOKEN || process.env.TELEGRAM_BOT_TOKEN;

    if (!configuredToken) {
        return false;
    }

    return trimmed === configuredToken.trim();
}

module.exports = {
    verifyBotServiceToken
};
