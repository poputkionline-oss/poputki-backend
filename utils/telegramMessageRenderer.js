/**
 * telegramMessageRenderer.js
 * 
 * Centralized Telegram Notification Message Renderer (Phase C)
 * Project: POPUTKI.ONLINE
 * 
 * Formats clean, forwardable, HTML-structured Telegram notifications
 * for Passenger, Family/Group, Coordinator, and Creator recipients.
 * 
 * Strict Privacy: Never includes passports, payment cards, or internal user/session IDs.
 */

function escapeHtml(text) {
    if (!text) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function formatDepartureDateTime(trip) {
    if (!trip) return 'Уточняется';
    const date = trip.departure_date || '';
    const time = trip.departure_time ? String(trip.departure_time).substring(0, 5) : '';
    if (date && time) return `${date} в ${time}`;
    return date || time || 'Уточняется';
}

function formatSeatList(seats) {
    if (!seats) return '—';
    const parsed = typeof seats === 'string' ? JSON.parse(seats || '[]') : (Array.isArray(seats) ? seats : [seats]);
    if (parsed.length === 0) return '—';
    return parsed.join(', ');
}

/**
 * Renders a complete Telegram message payload with HTML formatting and inline buttons.
 * 
 * @param {Object} intent - Notification intent from notificationRoutingEngine
 * @param {Object} [data={}] - Safe projection data { booking, trip, bookingsList }
 * @returns {Object} { text, parse_mode: 'HTML', reply_markup, templateKey, recipientType }
 */
function renderTelegramNotification(intent, data = {}) {
    const booking = data.booking || {};
    const trip = data.trip || {};
    const bookingsList = data.bookingsList || (booking.id ? [booking] : []);

    const templateKey = intent.templateKey;
    const recipientType = intent.recipientType;
    const shareableUrl = intent.shareableUrl || `https://www.poputki.online/ticket/${booking.id || ''}`;

    const route = `${escapeHtml(trip.from_city || booking.pickup_city || 'Пункт отправления')} → ${escapeHtml(trip.to_city || booking.drop_off_city || 'Пункт назначения')}`;
    const departure = escapeHtml(formatDepartureDateTime(trip));
    const carrierName = escapeHtml(trip.transport_company || 'POPUTKI.ONLINE');
    const passengerName = escapeHtml(booking.passenger_name || 'Пассажир');
    const seats = formatSeatList(booking.seat_numbers);

    let text = '';
    const inlineKeyboard = [];

    switch (templateKey) {
        // =====================================================================
        // 1. PASSENGER TICKET ISSUED
        // =====================================================================
        case 'passenger_ticket_issued':
            text = [
                '🎫 <b>POPUTKI.ONLINE</b>',
                '',
                'Ваш электронный билет готов.',
                '',
                `👤 <b>Пассажир:</b> ${passengerName}`,
                `📍 <b>Маршрут:</b> ${route}`,
                `📅 <b>Отправление:</b> ${departure}`,
                `💺 <b>Место:</b> №${seats}`,
                `🏢 <b>Перевозчик:</b> ${carrierName}`,
                '',
                `🔗 <a href="${shareableUrl}">Открыть электронный билет</a>`,
                '',
                '<i>Сохраните билет. QR-код позволяет проверить подлинность брони при посадке.</i>'
            ].join('\n');

            inlineKeyboard.push([
                { text: '🎫 Открыть билет', url: shareableUrl }
            ]);
            break;

        // =====================================================================
        // 2. FAMILY / GROUP TICKETS READY
        // =====================================================================
        case 'family_group_tickets_ready':
            if (bookingsList.length > 1) {
                const summaryLines = bookingsList.map((b, idx) => {
                    const pName = escapeHtml(b.passenger_name || `Пассажир ${idx + 1}`);
                    const pSeats = formatSeatList(b.seat_numbers);
                    return `• ${pName} — место №${pSeats}`;
                }).join('\n');

                text = [
                    '🎫 <b>POPUTKI.ONLINE</b>',
                    '',
                    'На ваш контакт оформлены билеты для семьи / группы:',
                    `📍 <b>Маршрут:</b> ${route}`,
                    `📅 <b>Отправление:</b> ${departure}`,
                    `👥 <b>Пассажиров:</b> ${bookingsList.length}`,
                    '',
                    '<b>Список пассажиров:</b>',
                    summaryLines,
                    '',
                    `🔗 <a href="${shareableUrl}">Открыть билеты</a>`,
                    '',
                    '<i>Передайте ссылки на электронные билеты пассажирам для посадки.</i>'
                ].join('\n');

                inlineKeyboard.push([
                    { text: '🎫 Открыть билеты', url: shareableUrl }
                ]);
            } else {
                text = [
                    '🎫 <b>POPUTKI.ONLINE</b>',
                    '',
                    'На ваш контакт оформлен электронный билет:',
                    `👤 <b>Пассажир:</b> ${passengerName}`,
                    `📍 <b>Маршрут:</b> ${route}`,
                    `📅 <b>Отправление:</b> ${departure}`,
                    `💺 <b>Место:</b> №${seats}`,
                    `🏢 <b>Перевозчик:</b> ${carrierName}`,
                    '',
                    `🔗 <a href="${shareableUrl}">Открыть билет</a>`,
                    '',
                    '<i>Передайте билет пассажиру для проверки и посадки.</i>'
                ].join('\n');

                inlineKeyboard.push([
                    { text: '🎫 Открыть билет', url: shareableUrl }
                ]);
            }
            break;

        // =====================================================================
        // 3. COORDINATOR TICKETS READY
        // =====================================================================
        case 'coordinator_tickets_ready':
            if (bookingsList.length > 1) {
                const summaryLines = bookingsList.map((b, idx) => {
                    const pName = escapeHtml(b.passenger_name || `Пассажир ${idx + 1}`);
                    const pSeats = formatSeatList(b.seat_numbers);
                    return `• ${pName} (место №${pSeats})`;
                }).join('\n');

                text = [
                    '🎫 <b>POPUTKI.ONLINE</b>',
                    '',
                    `Вы оформили ${bookingsList.length} пассажиров на рейс:`,
                    `📍 <b>Маршрут:</b> ${route}`,
                    `📅 <b>Отправление:</b> ${departure}`,
                    '',
                    '<b>Пассажиры:</b>',
                    summaryLines,
                    '',
                    `🔗 <a href="${shareableUrl}">Открыть список билетов</a>`,
                    '',
                    '<i>Перешлите билеты пассажирам для самостоятельной проверки брони.</i>'
                ].join('\n');

                inlineKeyboard.push([
                    { text: '🎫 Открыть билеты', url: shareableUrl }
                ]);
            } else {
                text = [
                    '🎫 <b>POPUTKI.ONLINE</b>',
                    '',
                    'Вы оформили пассажира на поездку:',
                    `👤 <b>Пассажир:</b> ${passengerName}`,
                    `📍 <b>Маршрут:</b> ${route}`,
                    `📅 <b>Отправление:</b> ${departure}`,
                    `💺 <b>Место:</b> №${seats}`,
                    '',
                    'Электронный билет готов.',
                    `🔗 <a href="${shareableUrl}">Перешлите билет пассажиру</a>`
                ].join('\n');

                inlineKeyboard.push([
                    { text: '🎫 Открыть билет', url: shareableUrl }
                ]);
            }
            break;

        // =====================================================================
        // 4. CREATOR TICKETS READY FOR HANDOFF
        // =====================================================================
        case 'creator_tickets_ready_for_handoff':
        default:
            text = [
                '🎫 <b>POPUTKI.ONLINE</b>',
                '',
                'Ручная бронь успешно оформлена.',
                '',
                `👤 <b>Пассажир:</b> ${passengerName}`,
                `📍 <b>Маршрут:</b> ${route}`,
                `📅 <b>Отправление:</b> ${departure}`,
                `💺 <b>Место:</b> №${seats}`,
                '',
                'Электронный билет готов для передачи.',
                `🔗 <a href="${shareableUrl}">Передайте билет пассажиру</a>`
            ].join('\n');

            inlineKeyboard.push([
                { text: '🎫 Открыть билет', url: shareableUrl }
            ]);
            break;
    }

    return {
        text,
        parse_mode: 'HTML',
        reply_markup: inlineKeyboard.length > 0 ? { inline_keyboard: inlineKeyboard } : undefined,
        templateKey,
        recipientType
    };
}

module.exports = {
    escapeHtml,
    formatDepartureDateTime,
    formatSeatList,
    renderTelegramNotification
};
