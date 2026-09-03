/**
 * utils/botAuth.js
 *
 * Phase E.48.5.1: Telegram Bot Server-to-Server Authentication (Decoupled)
 *
 * Authenticates server-to-server requests from the Telegram Bot (e.g. scraper ride creation).
 * Validates X-Bot-Service-Token header strictly and ONLY against process.env.BOT_SERVICE_TOKEN.
 *
 * Dedicated secret isolation.
 * Fails closed if BOT_SERVICE_TOKEN is not configured or header is missing/invalid.
 */

'use strict';

function verifyBotServiceToken(req) {
    const token = req.headers['x-bot-service-token'];
    if (!token || typeof token !== 'string') {
        return false;
    }

    const configuredToken = process.env.BOT_SERVICE_TOKEN;
    if (!configuredToken || typeof configuredToken !== 'string' || !configuredToken.trim()) {
        return false;
    }

    return token.trim() === configuredToken.trim();
}

module.exports = {
    verifyBotServiceToken
};
