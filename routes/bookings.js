const express = require('express');
const router = express.Router();
const supabase = require('../db');
const { sendPersonalMessage, sendMessage } = require('../utils/telegramBot');
const { userAuth } = require('../utils/userAuth');

/**
 * @swagger
 * /api/bookings:
 *   post:
 *     summary: Book a seat in a ride
 *     tags: [Bookings]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               ride_id:
 *                 type: integer
 *               passenger_id:
 *                 type: integer
 *               seat_number:
 *                 type: integer
 *               passenger_gender:
 *                 type: string
 */
router.post('/', userAuth, async (req, res) => {
    const { ride_id, seat_number, passenger_gender, seats } = req.body;
    const passenger_id = req.user.id;

    // Verify user exists to avoid foreign key violation
    const { data: userExists, error: userError } = await supabase
        .from('users')
        .select('id')
        .eq('id', passenger_id)
        .maybeSingle();

    if (userError || !userExists) {
        return res.status(401).json({ error: 'Ваша сессия устарела. Пожалуйста, выйдите из профиля и войдите снова.' });
    }

    // Prepare bookings array: either from 'seats' array or single 'seat_number'
    let bookingsToInsert = [];
    if (seats && Array.isArray(seats) && seats.length > 0) {
        bookingsToInsert = seats.map(s => ({
            ride_id,
            passenger_id,
            seat_number: s.seat_number,
            passenger_gender: s.passenger_gender
        }));
    } else if (seat_number) {
        bookingsToInsert = [{
            ride_id,
            passenger_id,
            seat_number,
            passenger_gender
        }];
    } else {
        return res.status(400).json({ error: 'Seat selection is required' });
    }

    try {
        // 1. Verify all seats are available
        const seatNumbers = bookingsToInsert.map(b => b.seat_number);
        const { data: existingBookings } = await supabase
            .from('bookings')
            .select('seat_number')
            .eq('ride_id', ride_id)
            .in('seat_number', seatNumbers);

        if (existingBookings && existingBookings.length > 0) {
            const bookedList = existingBookings.map(b => b.seat_number).join(', ');
            return res.status(400).json({ error: `Места ${bookedList} уже забронированы` });
        }

        // 2. Bulk Insert
        const { data: insertedBookings, error } = await supabase
            .from('bookings')
            .insert(bookingsToInsert)
            .select('id');

        if (error) throw error;

        res.json({ ids: insertedBookings.map(b => b.id), status: 'confirmed' });

        // Telegram Notifications
        try {
            const { data: rideData } = await supabase
                .from('rides')
                .select('driver_id, from_city, to_city, date, time, scraper_metadata')
                .eq('id', ride_id)
                .single();

            const { data: userData } = await supabase
                .from('users')
                .select('name, phone')
                .eq('id', passenger_id)
                .single();

            if (rideData && userData) {
                const dateStr = rideData.date;
                const timeStr = rideData.time ? rideData.time.substring(0, 5) : '';

                // Format seats string: "2 (М), 3 (Ж)"
                const seatsString = bookingsToInsert.map(b => {
                    const genderLabel = b.passenger_gender === 'male' ? 'М' : 'Ж';
                    return `${b.seat_number} (${genderLabel})`;
                }).join(', ');

                // Notify passenger
                const passMsg = `✅ <b>Бронирование подтверждено!</b>\n\n🚗 <b>Маршрут:</b> ${rideData.from_city} ➡ ${rideData.to_city}\n🗓 <b>Дата:</b> ${dateStr}\n⏰ <b>Время:</b> ${timeStr}\n💺 <b>Места:</b> ${seatsString}\n\n<i>Водитель уведомлен. Приятной поездки!</i>\n\nPoputki.online — это информационный сервис (агрегатор), а не перевозчик.`;
                const rideUrl = `${process.env.MINI_APP_URL || 'https://poputki.online'}/ride/${ride_id}`;
                const options = {
                    reply_markup: {
                        inline_keyboard: [[{ text: 'Открыть поездку', web_app: { url: rideUrl } }]]
                    }
                };
                sendPersonalMessage(passenger_id, passMsg, options);

                // Notify driver
                const driverMsg = `🔔 <b>Новая заявка на поездку! (Мульти-бронь)</b>\n\n🧑‍💻 <b>Пассажир:</b> ${userData.name}\n📞 <b>Телефон:</b> ${userData.phone || 'Не указан'}\n💺 <b>Выбранные места:</b> ${seatsString}\n\n📍 <b>Маршрут:</b> ${rideData.from_city} ➡ ${rideData.to_city}\n🗓 <b>Дата:</b> ${dateStr} в ${timeStr}`;
                const optionsDriver = {
                    reply_markup: {
                        inline_keyboard: [[{ text: 'Открыть поездку', web_app: { url: rideUrl } }]]
                    }
                };
                sendPersonalMessage(rideData.driver_id, driverMsg, optionsDriver);

                // Notify original Telegram Group if it's an AI-scraped ride
                if (rideData.scraper_metadata) {
                    try {
                        const meta = typeof rideData.scraper_metadata === 'string' ? JSON.parse(rideData.scraper_metadata) : rideData.scraper_metadata;
                        if (meta && meta.chat_id) {
                            let driverReference = '';
                            if (meta.username) {
                                driverReference = `@${meta.username}`;
                            } else if (meta.user_id && meta.first_name) {
                                driverReference = `<a href="tg://user?id=${meta.user_id}">${meta.first_name}</a>`;
                            } else if (meta.first_name) {
                                driverReference = meta.first_name;
                            } else {
                                driverReference = 'Ронанда';
                            }

                            const passengerPhone = userData.phone || 'номълум';
                            const groupMsg = `Ронандаи гиромӣ ${driverReference}! Хизматрасонии poputki.online барои Шумо мусофир ёфт. Лутфан, бо мусофир тавассути ин рақам тамос гиред: <b>${passengerPhone}</b>`;

                            const groupOptions = {};
                            if (meta.message_id) {
                                groupOptions.reply_to_message_id = meta.message_id;
                            }
                            groupOptions.reply_markup = {
                                inline_keyboard: [[{ text: 'Дидани сафар дар замима', web_app: { url: rideUrl } }]]
                            };

                            console.log(`[Scraper Notification] Sending booking notification to group ${meta.chat_id}, replying to msg ${meta.message_id}`);
                            await sendMessage(meta.chat_id, groupMsg, groupOptions);
                        }
                    } catch (metaErr) {
                        console.error('Error parsing scraper_metadata or sending group notification:', metaErr);
                    }
                }
            }
        } catch (e) {
            console.error('Telegram Bookings Error:', e);
        }

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * @swagger
 * /api/bus-ticket-bookings:
 *   post:
 *     summary: Book bus seats
 *     tags: [Bookings]
 */
router.post('/bus', (req, res) => {
    // Note: Mount this at /api/bus-ticket-bookings in index.js
});

/**
 * @swagger
 * /api/bookings/{id}/cancel:
 *   post:
 *     summary: Cancel a booking (passenger side)
 *     tags: [Bookings]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 */
router.post('/:id/cancel', userAuth, async (req, res) => {
    const { id } = req.params;

    try {
        const { data: booking, error } = await supabase
            .from('bookings')
            .select(`
                *,
                rides:ride_id (driver_id, from_city, to_city, date, time, status)
            `)
            .eq('id', id)
            .single();

        if (error || !booking) {
            return res.status(404).json({ error: 'Бронирование не найдено' });
        }

        const isPassenger = booking.passenger_id === req.user.id;
        const isDriver = booking.rides && booking.rides.driver_id === req.user.id;

        if (!isPassenger && !isDriver) {
            return res.status(403).json({ error: 'Доступ запрещен: нельзя отменить чужое бронирование' });
        }

        const rideData = booking.rides;

        if (rideData.status === 'completed') {
            return res.status(400).json({ error: 'Cannot cancel booking for a completed ride' });
        }

        const time = rideData.time ? rideData.time : '00:00:00';
        const rideDateTime = new Date(`${rideData.date}T${time}`);

        if (new Date() >= rideDateTime) {
            return res.status(400).json({ error: 'Нельзя отменить бронь после начала поездки' });
        }

        const { error: deleteError } = await supabase
            .from('bookings')
            .delete()
            .eq('id', id);

        if (deleteError) throw deleteError;

        // Fetch passenger details for notification
        const { data: passengerData } = await supabase
            .from('users')
            .select('name, phone')
            .eq('id', booking.passenger_id)
            .single();

        res.json({ success: true });

        // Telegram Notifications
        const dateStr = rideData.date;
        const timeStr = rideData.time ? rideData.time.substring(0, 5) : '';
        const passengerName = passengerData ? passengerData.name : 'Пассажир';
        const passengerPhone = passengerData ? (passengerData.phone ? `${passengerData.phone}` : 'Не указан') : 'Не указан';

        const rideUrl = `${process.env.MINI_APP_URL || 'https://poputki.online'}/ride/${booking.ride_id}`;
        const options = {
            reply_markup: {
                inline_keyboard: [[{ text: 'Открыть поездку', url: rideUrl }]]
            }
        };

        const cancelMsg = `⚠️ <b>ОТМЕНА БРОНИРОВАНИЯ</b>\n\n` +
            `👤 <b>Пассажир:</b> ${passengerName}\n` +
            `📞 <b>Телефон:</b> ${passengerPhone}\n` +
            `💺 <b>Место:</b> ${booking.seat_number}\n\n` +
            `📍 <b>Маршрут:</b> ${rideData.from_city} ➡ ${rideData.to_city}\n` +
            `🗓 <b>Дата:</b> ${dateStr} в ${timeStr}\n\n` +
            `<i>Место снова доступно для других попутчиков.</i>`;

        sendPersonalMessage(rideData.driver_id, cancelMsg, options);

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// I'll put bus bookings in busTickets.js or a separate file.
// Let's move bus bookings to busTickets.js as well.
// Re-writing busTickets.js to include bookings.

module.exports = router;
