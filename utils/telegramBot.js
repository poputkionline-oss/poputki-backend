const axios = require('axios');
const supabase = require('../db');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const BROADCAST_GROUP_ID = process.env.TELEGRAM_BROADCAST_GROUP_ID; // Optional fallback
const BOT_API_URL = `https://api.telegram.org/bot${BOT_TOKEN}`;
const BOT_LINK = 'https://t.me/poputkionline_bot'; // Or t.me/poputkionline_bot, must be valid URL for inline keyboard

/**
 * Sends a message to a Telegram chat.
 * @param {string|number} chatId - The Telegram chat ID to send the message to.
 * @param {string} text - The message text (supports MarkdownV2 or HTML depending on parseMode).
 * @param {object} [options] - Optional configurations (e.g., inline keyboards).
 */
async function sendMessage(chatId, text, options = {}) {
    if (!chatId) {
        console.error('Telegram Bot: Missing chatId');
        return false;
    }

    try {
        const payload = {
            chat_id: chatId,
            text: text,
            parse_mode: 'HTML',
            ...options
        };

        const response = await axios.post(`${BOT_API_URL}/sendMessage`, payload);
        return response.data;
    } catch (error) {
        console.error(`Telegram Bot Error (chatId: ${chatId}):`, error.response?.data?.description || error.message);
        return false;
    }
}

/**
 * Broadcasts a message to all configured Telegram groups, appending standard inline buttons linking to the bot/app.
 * @param {string} text - HTML formatted message text.
 * @param {number|string} [rideId] - Optional ID of the ride to link directly to it.
 */
async function sendBroadcast(text, rideId = null, type = 'ride') {
    console.log(`[Telegram Broadcast] Starting broadcast. rideId: ${rideId}, type: ${type}`);
    
    // 1. Collect group IDs from multiple sources
    const groupIds = new Set();
    
    // Source A: Environment Variable (can be comma-separated list)
    if (process.env.TELEGRAM_BROADCAST_GROUP_ID) {
        process.env.TELEGRAM_BROADCAST_GROUP_ID.split(',').forEach(id => {
            const trimmed = id.trim();
            if (trimmed) groupIds.add(trimmed);
        });
    }

    // Source B: Database
    const { data: dbGroups, error } = await supabase
        .from('telegram_groups')
        .select('chat_id');

    if (error) {
        console.error('[Telegram Broadcast] Database error fetching groups:', error.message);
    } else if (dbGroups) {
        dbGroups.forEach(g => {
            if (g.chat_id) groupIds.add(g.chat_id.toString());
        });
    }

    const uniqueGroups = Array.from(groupIds);

    if (uniqueGroups.length === 0) {
        console.log('[Telegram Broadcast] No groups found to broadcast to (check .env and database).');
        return false;
    }

    // 2. Prepare the keyboard with safe deep links for groups
    const inlineKeyboard = [];

    // The BOT_LINK or bot username should be used for deep linking
    // Pattern: https://t.me/bot_username?start=param
    const botUsername = 'poputkionline_bot'; // From BOT_LINK 'https://t.me/poputkionline_bot'
    
    if (rideId) {
        const prefix = type === 'bus' ? 'bus' : 'ride';
        inlineKeyboard.push([
            { 
                text: '🚀 Подробнее в боте', 
                url: `https://t.me/${botUsername}?start=${prefix}_${rideId}` 
            }
        ]);
    } else {
        inlineKeyboard.push([
            { 
                text: '📱 Открыть бота', 
                url: `https://t.me/${botUsername}?start=menu` 
            }
        ]);
    }

    const options = {
        reply_markup: {
            inline_keyboard: inlineKeyboard
        }
    };

    console.log(`[Telegram Broadcast] Sending to ${uniqueGroups.length} unique groups: ${uniqueGroups.join(', ')}`);

    // 3. Send the message to all groups and collect results
    const results = await Promise.all(uniqueGroups.map(async (chatId) => {
        const result = await sendMessage(chatId, text, options);
        if (result === false) {
            console.error(`[Telegram Broadcast] FAILED for group ${chatId}`);
        } else {
            console.log(`[Telegram Broadcast] SUCCESS for group ${chatId}`);
        }
        return result;
    }));

    const successCount = results.filter(r => r !== false).length;
    console.log(`[Telegram Broadcast] Finished. Success: ${successCount}/${uniqueGroups.length}`);
    
    return successCount > 0;
}

/**
 * Sends a direct/personal message to a user based on their ID in our database.
 * Fetches the user's `telegram_id` from Supabase before sending.
 * @param {string|number} userId - The user's internal ID in the Supabase `users` table.
 * @param {string} text - HTML formatted message text.
 * @param {object} [options] - Optional configurations (e.g., inline keyboards).
 */
async function sendPersonalMessage(userId, text, options = {}) {
    if (!userId) return false;

    try {
        const { data: user, error } = await supabase
            .from('users')
            .select('telegram_id')
            .eq('id', userId)
            .single();

        if (error) {
            console.error(`Telegram Bot: Could not find user ${userId} for personal message`, error.message);
            return false;
        }

        if (!user.telegram_id) {
            console.log(`Telegram Bot: User ${userId} does not have a connected Telegram account.`);
            return false;
        }

        return await sendMessage(user.telegram_id, text, options);
    } catch (error) {
        console.error('Telegram Bot Personal Message Error:', error.message);
        return false;
    }
}

/**
 * Sends a non-anonymous poll to a Telegram chat.
 * @param {string|number} chatId - The Telegram chat ID.
 * @param {string} question - The poll question.
 * @param {string[]} optionsArray - Array of answer options.
 * @param {object} [options] - Optional configurations.
 * @returns {Promise<object|boolean>} - Returns Telegram message object on success, false on failure.
 */
async function sendPoll(chatId, question, optionsArray, options = {}) {
    if (!chatId) {
        console.error('Telegram Bot: Missing chatId');
        return false;
    }

    try {
        const payload = {
            chat_id: chatId,
            question: question,
            options: optionsArray,
            is_anonymous: false,
            ...options
        };

        const response = await axios.post(`${BOT_API_URL}/sendPoll`, payload);
        return response.data;
    } catch (error) {
        console.error(`Telegram Bot Poll Error (chatId: ${chatId}):`, error.response?.data?.description || error.message);
        return false;
    }
}

/**
 * Sends a PDF or document buffer to a Telegram chat.
 * @param {string|number} chatId - Telegram chat ID
 * @param {Buffer} documentBuffer - Document buffer
 * @param {string} filename - Filename (e.g. POPUTKI-TICKET-POP-000439.pdf)
 * @param {string} [caption] - Short caption text
 * @param {object} [options] - Additional options
 */
async function sendDocument(chatId, documentBuffer, filename, caption = '', options = {}) {
    if (!chatId || !documentBuffer) {
        console.error('Telegram Bot Document: Missing chatId or documentBuffer');
        return false;
    }

    try {
        const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
        
        const headerLines = [
            `--${boundary}`,
            'Content-Disposition: form-data; name="chat_id"',
            '',
            String(chatId)
        ];

        if (caption) {
            headerLines.push(
                `--${boundary}`,
                'Content-Disposition: form-data; name="caption"',
                '',
                String(caption),
                `--${boundary}`,
                'Content-Disposition: form-data; name="parse_mode"',
                '',
                'HTML'
            );
        }

        headerLines.push(
            `--${boundary}`,
            `Content-Disposition: form-data; name="document"; filename="${filename || 'document.pdf'}"`,
            'Content-Type: application/pdf',
            '',
            ''
        );

        const headerStr = headerLines.join('\r\n');
        const footerStr = `\r\n--${boundary}--\r\n`;

        const payload = Buffer.concat([
            Buffer.from(headerStr, 'utf-8'),
            documentBuffer,
            Buffer.from(footerStr, 'utf-8')
        ]);

        const response = await axios.post(`${BOT_API_URL}/sendDocument`, payload, {
            headers: {
                'Content-Type': `multipart/form-data; boundary=${boundary}`
            }
        });

        return response.data;
    } catch (error) {
        console.error(`Telegram Bot Document Error (chatId: ${chatId}):`, error.response?.data?.description || error.message);
        return false;
    }
}

/**
 * Sends a high-resolution PNG photo buffer to a Telegram chat.
 * @param {string|number} chatId - Telegram chat ID
 * @param {Buffer} imageBuffer - PNG Image Buffer
 * @param {string} filename - Filename (e.g. POPUTKI-TICKET-POP-000440.png)
 * @param {string} [caption] - Caption (default empty)
 * @param {object} [options]
 */
async function sendPhoto(chatId, imageBuffer, filename, caption = '', options = {}) {
    if (!chatId || !imageBuffer) {
        console.error('Telegram Bot Photo: Missing chatId or imageBuffer');
        return false;
    }

    try {
        const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
        
        const headerLines = [
            `--${boundary}`,
            'Content-Disposition: form-data; name="chat_id"',
            '',
            String(chatId)
        ];

        if (caption) {
            headerLines.push(
                `--${boundary}`,
                'Content-Disposition: form-data; name="caption"',
                '',
                String(caption),
                `--${boundary}`,
                'Content-Disposition: form-data; name="parse_mode"',
                '',
                'HTML'
            );
        }

        headerLines.push(
            `--${boundary}`,
            `Content-Disposition: form-data; name="photo"; filename="${filename || 'ticket.png'}"`,
            'Content-Type: image/png',
            '',
            ''
        );

        const headerStr = headerLines.join('\r\n');
        const footerStr = `\r\n--${boundary}--\r\n`;

        const payload = Buffer.concat([
            Buffer.from(headerStr, 'utf-8'),
            imageBuffer,
            Buffer.from(footerStr, 'utf-8')
        ]);

        const response = await axios.post(`${BOT_API_URL}/sendPhoto`, payload, {
            headers: {
                'Content-Type': `multipart/form-data; boundary=${boundary}`
            }
        });

        return response.data;
    } catch (error) {
        console.error(`Telegram Bot Photo Error (chatId: ${chatId}):`, error.response?.data?.description || error.message);
        return false;
    }
}

/**
 * Sends a personal document to a user based on internal user ID.
 * @param {string|number} userId - The user's internal ID in Supabase users table.
 * @param {Buffer} documentBuffer - Document buffer
 * @param {string} filename - Filename
 * @param {string} [caption] - Short caption
 * @param {object} [options]
 */
async function sendPersonalDocument(userId, documentBuffer, filename, caption = '', options = {}) {
    if (!userId || !documentBuffer) return false;

    try {
        const { data: user, error } = await supabase
            .from('users')
            .select('telegram_id')
            .eq('id', userId)
            .single();

        if (error || !user || !user.telegram_id) {
            console.error(`Telegram Bot: Could not resolve telegram_id for user ${userId}`);
            return false;
        }

        return await sendDocument(user.telegram_id, documentBuffer, filename, caption, options);
    } catch (error) {
        console.error('Telegram Bot Personal Document Error:', error.message);
        return false;
    }
}

/**
 * Sends a personal high-resolution PNG photo to a user based on internal user ID.
 */
async function sendPersonalPhoto(userId, imageBuffer, filename, caption = '', options = {}) {
    if (!userId || !imageBuffer) return false;

    try {
        const { data: user, error } = await supabase
            .from('users')
            .select('telegram_id')
            .eq('id', userId)
            .single();

        if (error || !user || !user.telegram_id) {
            console.error(`Telegram Bot: Could not resolve telegram_id for user ${userId}`);
            return false;
        }

        return await sendPhoto(user.telegram_id, imageBuffer, filename, caption, options);
    } catch (error) {
        console.error('Telegram Bot Personal Photo Error:', error.message);
        return false;
    }
}

module.exports = {
    sendMessage,
    sendBroadcast,
    sendPersonalMessage,
    sendPoll,
    sendDocument,
    sendPersonalDocument,
    sendPhoto,
    sendPersonalPhoto
};
