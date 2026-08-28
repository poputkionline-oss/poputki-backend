const express = require('express');
const router = express.Router();
const supabase = require('../db');
const { isSeatLockedByBooking } = require('../utils/paymentExpirationHelper');
const { sendPersonalMessage } = require('../utils/telegramBot');

/**
 * @swagger
 * /api/bus-ticket-bookings:
 *   post:
 *     summary: Book bus seats (multi-passenger)
 *     tags: [Bus Tickets]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               bus_ticket_id:
 *                 type: integer
 *               passenger_id:
 *                 type: integer
 *               seat_numbers:
 *                 type: array
 *                 items:
 *                   type: integer
 *               passengers_data:
 *                 type: array
 *                 items:
 *                   type: object
 *               phone:
 *                 type: string
 */
router.post('/', async (req, res) => {
    const { bus_ticket_id, passenger_id, seat_numbers, passengers_data, phone, pickup_city, drop_off_city } = req.body;

    // Verify user exists to avoid foreign key violation (common after DB reset)
    const { data: userExists, error: userError } = await supabase
        .from('users')
        .select('id')
        .eq('id', passenger_id)
        .maybeSingle();

    if (userError || !userExists) {
        return res.status(401).json({ error: 'Приложение работает правильно в телеграм боте' });
    }
    if (!seat_numbers || !seat_numbers.length) {
        return res.status(400).json({ error: 'Seat numbers required' });
    }
    if (!passengers_data || !passengers_data.length) {
        return res.status(400).json({ error: 'Passenger data required' });
    }

    try {
        const { data: ticket, error: ticketError } = await supabase
            .from('bus_tickets')
            .select('*')
            .eq('id', bus_ticket_id)
            .single();

        if (ticketError || !ticket) return res.status(404).json({ error: 'Ticket not found' });

        const { data: existingBookings } = await supabase
            .from('bus_ticket_bookings')
            .select('seat_numbers, status, created_at, hold_expires_at')
            .eq('bus_ticket_id', bus_ticket_id)
            .neq('status', 'cancelled');

        const takenSeats = [];
        (existingBookings || []).forEach(b => {
            if (isSeatLockedByBooking(b)) {
                const seats = typeof b.seat_numbers === 'string' ? JSON.parse(b.seat_numbers || '[]') : (b.seat_numbers || []);
                takenSeats.push(...seats);
            }
        });

        const conflict = seat_numbers.some(s => takenSeats.includes(s));
        if (conflict) return res.status(400).json({ error: 'Одно или несколько мест уже заняты' });

        // Calculate price with premium seat support
        const premiumSeatNums = ticket.bus_type === 'double' ? [1, 2, 3, 4, 69, 70, 71, 72, 73, 74, 75, 76] : [];
        const premiumPrice = ticket.premium_price || ticket.price;
        let totalPrice = 0;
        for (const seatNum of seat_numbers) {
            totalPrice += premiumSeatNums.includes(seatNum) ? premiumPrice : ticket.price;
        }

        const { data: booking, error: insertError } = await supabase
            .from('bus_ticket_bookings')
            .insert([{
                bus_ticket_id,
                passenger_id,
                seat_numbers: seat_numbers,
                passenger_count: seat_numbers.length,
                passengers_data: passengers_data,
                phone,
                status: 'confirmed',
                total_price: totalPrice,
                pickup_city,
                drop_off_city
            }])
            .select('id')
            .single();

        if (insertError) throw insertError;

        const allTakenSeats = [...takenSeats, ...seat_numbers];
        await supabase
            .from('bus_tickets')
            .update({ reserved_seats: allTakenSeats })
            .eq('id', bus_ticket_id);

        res.json({ id: booking.id, status: 'confirmed', total_price: totalPrice });

        // Telegram Notifications
        const dateStr = ticket.departure_date;
        const timeStr = ticket.departure_time ? ticket.departure_time.substring(0, 5) : '';

        let passengersList = '';
        passengers_data.forEach((p, idx) => {
            const genderStr = p.gender === 'male' ? 'Муж.' : (p.gender === 'female' ? 'Жен.' : '');
            passengersList += `\n${idx + 1}. ${p.lastName || ''} ${p.firstName || ''} (${genderStr}) - Место: ${seat_numbers[idx] || '—'} [${p.docType || 'Док'}: ${p.docNumber || '—'}]`;
        });

        const ticketMsg = `🎫 <b>ЭЛЕКТРОННЫЙ БИЛЕТ НА АВТОБУС</b> 🎫\n\n` +
            `✅ <b>Статус:</b> Забронировано\n` +
            `🚌 <b>Рейс:</b> ${ticket.from_city} ➡ ${ticket.to_city}\n` +
            `📍 <b>Маршрут:</b> ${pickup_city || ticket.from_city} ➡ ${drop_off_city || ticket.to_city}\n` +
            `🗓 <b>Дата и время:</b> ${dateStr} в ${timeStr}\n\n` +
            `📞 <b>Покупатель:</b> ${phone}\n` +
            `💺 <b>Количество мест:</b> ${seat_numbers.length} (Места: ${seat_numbers.join(', ')})\n` +
            `👥 <b>Пассажиры:</b>${passengersList}\n\n` +
            `💰 <b>Общая стоимость:</b> ${totalPrice} сом\n\n` +
            `<i>Пожалуйста, сохраните этот билет. Счастливого пути!</i>\n\n` +
            `Poputki.online — это информационный сервис (агрегатор), а не перевозчик`;

        sendPersonalMessage(passenger_id, ticketMsg);

        // Driver Notification
        if (ticket.operator_id) {
            const driverMsg = `🔔 <b>НОВОЕ БРОНИРОВАНИЕ</b> 🚌\n\n` +
                `📍 <b>Рейс:</b> ${ticket.from_city} ➡ ${ticket.to_city}\n` +
                `маршрут: <b>${pickup_city || ticket.from_city} ➡ ${drop_off_city || ticket.to_city}</b>\n` +
                `🗓 <b>Дата/время:</b> ${dateStr} в ${timeStr}\n\n` +
                `👤 <b>Основной контакт:</b> ${phone}\n` +
                `💺 <b>Места:</b> ${seat_numbers.join(', ')} (${seat_numbers.length} чел.)\n` +
                `👥 <b>Список пассажиров:</b>${passengersList}\n\n` +
                `💰 <b>Сумма:</b> ${totalPrice} сом`;

            sendPersonalMessage(ticket.operator_id, driverMsg);
        }

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
