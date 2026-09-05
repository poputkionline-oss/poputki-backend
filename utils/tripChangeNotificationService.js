/**
 * tripChangeNotificationService.js
 * 
 * Safe Trip Schedule & Vehicle Changes Notification & Outbox Dispatcher
 * Project: POPUTKI.ONLINE
 *
 * Requirements:
 * - Deterministic multilingual templates: Russian (ru), Tajik (tj), Uzbek (uz)
 * - Zero Claude / AI calls
 * - Zero leaking internal IDs, tokens, secrets or other passengers' PII
 * - Idempotent delivery protection
 * - Outbox status: pending, processing, sent, failed, unreachable
 */

const { getServiceRoleClient } = require('../dbServiceRole');
const { sendMessage } = require('./telegramBot');
const { maskPhone } = require('./phoneHelper');

/**
 * Format date in Russian, Tajik, or Uzbek format
 */
function formatHumanDateTime(dateStr, timeStr, lang = 'ru') {
    if (!dateStr) return '—';
    const timeFormatted = timeStr ? timeStr.substring(0, 5) : '';
    
    // Parse YYYY-MM-DD
    const parts = dateStr.split('-');
    if (parts.length !== 3) return `${dateStr} ${timeFormatted}`.trim();

    const year = parts[0];
    const monthIdx = parseInt(parts[1], 10) - 1;
    const day = parseInt(parts[2], 10);

    const MONTHS = {
        ru: ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'],
        tj: ['январ', 'феврал', 'март', 'апрел', 'май', 'июн', 'июл', 'август', 'сентябр', 'октябр', 'ноябр', 'декабр'],
        uz: ['yanvar', 'fevral', 'mart', 'aprel', 'may', 'iyun', 'iyul', 'avgust', 'sentabr', 'oktabr', 'noyabr', 'dekabr']
    };

    const monthName = (MONTHS[lang] || MONTHS.ru)[monthIdx] || parts[1];

    if (lang === 'uz') {
        return `${day}-${monthName} ${year}, ${timeFormatted}`.trim();
    } else if (lang === 'tj') {
        return `${day} ${monthName}и ${year}, ${timeFormatted}`.trim();
    }
    return `${day} ${monthName} ${year}, ${timeFormatted}`.trim();
}

/**
 * Render deterministic trip change message
 * 
 * @param {Object} params
 * @param {string} params.language - 'ru' | 'tj' | 'uz'
 * @param {Object} params.trip - current ticket data
 * @param {Object} params.booking - passenger booking data
 * @param {Object} params.changes - { oldValues, newValues, changedFields, seatChange: { oldSeat, newSeat } }
 * @returns {{ text: string, reply_markup: Object }}
 */
function renderTripChangeMessage({ language = 'ru', trip, booking, changes }) {
    const lang = ['ru', 'tj', 'uz'].includes(language) ? language : 'ru';
    const oldV = changes.oldValues || {};
    const newV = changes.newValues || {};
    const changedFields = changes.changedFields || [];
    const seatChange = changes.seatChange;

    const fromCity = trip.from_city || oldV.from_city || '';
    const toCity = trip.to_city || oldV.to_city || '';
    const route = `${fromCity} → ${toCity}`;

    const lines = [];

    if (lang === 'tj') {
        lines.push('⚠️ <b>Тағйирот дар сафари шумо</b>');
        lines.push('');
        lines.push(`Интиқолдиҳанда маълумоти сафарро тағйир дод: <b>${route}</b>.`);
        lines.push('');

        if (changedFields.includes('departure_date') || changedFields.includes('departure_time')) {
            const oldDep = formatHumanDateTime(oldV.departure_date || trip.departure_date, oldV.departure_time || trip.departure_time, 'tj');
            const newDep = formatHumanDateTime(newV.departure_date || trip.departure_date, newV.departure_time || trip.departure_time, 'tj');
            lines.push('📅 <b>Сана ва вақти нав:</b>');
            lines.push(`Қаблан: ${oldDep}`);
            lines.push(`Ҳоло: <b>${newDep}</b>`);
            lines.push('');
        }

        if (changedFields.includes('from_address')) {
            lines.push(`📍 <b>Суроғаи нав:</b> ${newV.from_address || trip.from_address}`);
            lines.push('');
        }

        if (seatChange) {
            lines.push(`💺 <b>Ҷойи шумо тағйир дода шуд:</b> ${seatChange.oldSeat} → <b>${seatChange.newSeat}</b>`);
            lines.push('');
        }

        if (changedFields.includes('group_leader_name') || changedFields.includes('group_leader_phone')) {
            lines.push(`👤 <b>Масъули сафар:</b> ${newV.group_leader_name || trip.group_leader_name || ''} (${maskPhone(newV.group_leader_phone || trip.group_leader_phone || '')})`);
            lines.push('');
        }

        lines.push('✅ <i>Бронкунии шумо нигоҳ дошта шуд.</i>');
    } else if (lang === 'uz') {
        lines.push('⚠️ <b>Safaringizdagi o‘zgarishlar</b>');
        lines.push('');
        lines.push(`Tashuvchi safar ma’lumotlarini o‘zgartirdi: <b>${route}</b>.`);
        lines.push('');

        if (changedFields.includes('departure_date') || changedFields.includes('departure_time')) {
            const oldDep = formatHumanDateTime(oldV.departure_date || trip.departure_date, oldV.departure_time || trip.departure_time, 'uz');
            const newDep = formatHumanDateTime(newV.departure_date || trip.departure_date, newV.departure_time || trip.departure_time, 'uz');
            lines.push('📅 <b>Sana va vaqt:</b>');
            lines.push(`Oldin: ${oldDep}`);
            lines.push(`Hozir: <b>${newDep}</b>`);
            lines.push('');
        }

        if (changedFields.includes('from_address')) {
            lines.push(`📍 <b>Jo‘nash manzili:</b> ${newV.from_address || trip.from_address}`);
            lines.push('');
        }

        if (seatChange) {
            lines.push(`💺 <b>O‘rningiz o‘zgartirildi:</b> ${seatChange.oldSeat} → <b>${seatChange.newSeat}</b>`);
            lines.push('');
        }

        if (changedFields.includes('group_leader_name') || changedFields.includes('group_leader_phone')) {
            lines.push(`👤 <b>Guruh rahbari:</b> ${newV.group_leader_name || trip.group_leader_name || ''} (${maskPhone(newV.group_leader_phone || trip.group_leader_phone || '')})`);
            lines.push('');
        }

        lines.push('✅ <i>Broningiz saqlandi.</i>');
    } else {
        // Russian
        lines.push('⚠️ <b>Изменения в вашем рейсе</b>');
        lines.push('');
        lines.push(`Перевозчик изменил данные рейса: <b>${route}</b>.`);
        lines.push('');

        if (changedFields.includes('departure_date') || changedFields.includes('departure_time')) {
            const oldDep = formatHumanDateTime(oldV.departure_date || trip.departure_date, oldV.departure_time || trip.departure_time, 'ru');
            const newDep = formatHumanDateTime(newV.departure_date || trip.departure_date, newV.departure_time || trip.departure_time, 'ru');
            lines.push('📅 <b>Дата и время:</b>');
            lines.push(`Было: ${oldDep}`);
            lines.push(`Стало: <b>${newDep}</b>`);
            lines.push('');
        }

        if (changedFields.includes('from_address')) {
            lines.push(`📍 <b>Адрес отправления:</b> ${newV.from_address || trip.from_address}`);
            lines.push('');
        }

        if (seatChange) {
            lines.push(`💺 <b>Ваше место изменено:</b> ${seatChange.oldSeat} → <b>${seatChange.newSeat}</b>`);
            lines.push('');
        }

        if (changedFields.includes('group_leader_name') || changedFields.includes('group_leader_phone')) {
            lines.push(`👤 <b>Сопровождающий:</b> ${newV.group_leader_name || trip.group_leader_name || ''} (${maskPhone(newV.group_leader_phone || trip.group_leader_phone || '')})`);
            lines.push('');
        }

        lines.push('✅ <i>Ваша бронь сохранена.</i>');
    }

    const buttonLabel = lang === 'uz' ? '🎫 Chiptani ochish' : (lang === 'tj' ? '🎫 Кушодани чипта' : '🎫 Открыть билет');
    const ticketUrl = `https://www.poputki.online/ticket/${booking.id}`;

    const reply_markup = {
        inline_keyboard: [
            [{ text: buttonLabel, url: ticketUrl }]
        ]
    };

    return {
        text: lines.join('\n'),
        reply_markup
    };
}

/**
 * Dispatch queued outbox notifications using Telegram Bot API
 * Safe dry-run mode and test mock support
 */
async function processTripChangeOutbox({ supabaseClient, eventId, dryRun = false }) {
    const client = supabaseClient || getServiceRoleClient();
    if (!client) throw new Error('SERVICE_ROLE_CLIENT_UNAVAILABLE');

    const { data: entries, error } = await client
        .from('bus_ticket_notification_outbox')
        .select('*')
        .eq('event_id', eventId)
        .eq('status', 'pending');

    if (error) throw error;
    if (!entries || entries.length === 0) return { processed: 0, sent: 0, failed: 0, unreachable: 0 };

    let sent = 0;
    let failed = 0;
    let unreachable = 0;

    for (const entry of entries) {
        if (!entry.recipient_telegram_id) {
            await client
                .from('bus_ticket_notification_outbox')
                .update({ status: 'unreachable', last_error_code: 'NO_TELEGRAM_ID' })
                .eq('id', entry.id);
            unreachable++;
            continue;
        }

        if (dryRun || process.env.NOTIFICATION_DELIVERY_ENABLED !== 'true') {
            await client
                .from('bus_ticket_notification_outbox')
                .update({
                    status: 'sent',
                    sent_at: new Date().toISOString(),
                    attempt_count: (entry.attempt_count || 0) + 1
                })
                .eq('id', entry.id);
            sent++;
            continue;
        }

        try {
            const res = await sendMessage(entry.recipient_telegram_id, entry.payload.text, {
                reply_markup: entry.payload.reply_markup
            });

            if (res) {
                await client
                    .from('bus_ticket_notification_outbox')
                    .update({
                        status: 'sent',
                        sent_at: new Date().toISOString(),
                        attempt_count: (entry.attempt_count || 0) + 1
                    })
                    .eq('id', entry.id);
                sent++;
            } else {
                await client
                    .from('bus_ticket_notification_outbox')
                    .update({
                        status: 'failed',
                        attempt_count: (entry.attempt_count || 0) + 1,
                        last_error_code: 'SEND_FAILED'
                    })
                    .eq('id', entry.id);
                failed++;
            }
        } catch (err) {
            await client
                .from('bus_ticket_notification_outbox')
                .update({
                    status: 'failed',
                    attempt_count: (entry.attempt_count || 0) + 1,
                    last_error_code: err.message
                })
                .eq('id', entry.id);
            failed++;
        }
    }

    return { processed: entries.length, sent, failed, unreachable };
}

module.exports = {
    formatHumanDateTime,
    renderTripChangeMessage,
    processTripChangeOutbox
};
