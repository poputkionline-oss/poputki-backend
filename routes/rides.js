const express = require('express');
const router = express.Router();
const supabase = require('../db');
const { sendBroadcast, sendPersonalMessage } = require('../utils/telegramBot');
const { userAuth, optionalUserAuth, verifyUserToken } = require('../utils/userAuth');
const { verifyBotServiceToken } = require('../utils/botAuth');

/**
 * @swagger
 * components:
 *   schemas:
 *     Ride:
 *       type: object
 *       properties:
 *         id:
 *           type: integer
 *         driver_id:
 *           type: integer
 *         from_city:
 *           type: string
 *         to_city:
 *           type: string
 *         date:
 *           type: string
 *         time:
 *           type: string
 *         price:
 *           type: integer
 *         seats:
 *           type: integer
 *         description:
 *           type: string
 *         is_passenger_entry:
 *           type: boolean
 *         allows_delivery:
 *           type: boolean
 *         status:
 *           type: string
 *         from_address:
 *           type: string
 *         to_address:
 *           type: string
 *         total_seats:
 *           type: integer
 */

/**
 * @swagger
 * /api/rides:
 *   get:
 *     summary: Search for rides
 *     tags: [Rides]
 *     parameters:
 *       - in: query
 *         name: from
 *         schema:
 *           type: string
 *         description: Origin city
 *       - in: query
 *         name: to
 *         schema:
 *           type: string
 *         description: Destination city
 *       - in: query
 *         name: date
 *         schema:
 *           type: string
 *         description: Date of ride
 *       - in: query
 *         name: all_status
 *         schema:
 *           type: boolean
 *         description: Include all ride statuses
 *     responses:
 *       200:
 *         description: List of rides
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Ride'
 */

router.get('/check-limit', userAuth, async (req, res) => {
    const driver_id = req.user.id;
    
    try {
        const { data: activeRides } = await supabase
            .from('rides')
            .select('date, time')
            .eq('driver_id', driver_id)
            .eq('status', 'active')
            .eq('is_passenger_entry', false);

        const futureActiveRides = (activeRides || []).filter(ride => {
            const t = ride.time ? ride.time : '00:00:00';
            const rideDateTime = new Date(`${ride.date}T${t}`);
            return new Date() < rideDateTime;
        });

        res.json({
            exceedsLimit: false,
            count: futureActiveRides.length
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/', async (req, res) => {
    const { from, to, date, all_status } = req.query;
    try {
        const now = new Date();
        const currentDate = now.toISOString().split('T')[0];
        const currentTime = now.toTimeString().split(' ')[0];

        let query = supabase
            .from('rides')
            .select(`
                *,
                users:driver_id (name, rating, phone),
                bookings:bookings(id)
            `)
            .order('id', { ascending: false });

        if (!all_status) {
            // Only active rides in the future
            query = query.or('status.eq.active,status.is.null');
            query = query.or(`date.gt.${currentDate},and(date.eq.${currentDate},time.gte.${currentTime})`);
        }

        if (from) query = query.ilike('from_city', `%${from}%`);
        if (to) query = query.ilike('to_city', `%${to}%`);
        if (date) query = query.gte('date', date);

        const { data: rides, error } = await query;
        if (error) throw error;

        // Flatten the relations
        const formattedRides = rides.map(r => {
            const userData = Array.isArray(r.users) ? r.users[0] : (r.users || {});
            delete r.users;

            let driverPhone = userData.phone;
            let driverName = userData.name;

            if (r.scraper_metadata) {
                try {
                    const meta = typeof r.scraper_metadata === 'string' ? JSON.parse(r.scraper_metadata) : r.scraper_metadata;
                    if (meta && meta.phone) {
                        driverPhone = meta.phone;
                    }
                    if (meta && meta.first_name) {
                        driverName = meta.first_name + (meta.last_name ? ' ' + meta.last_name : '');
                    }
                } catch (err) {
                    console.error('Error parsing scraper_metadata on search list endpoint:', err);
                }
            }

            return {
                ...r,
                driver_name: driverName,
                driver_rating: r.driver_id === 694 ? 5.0 : userData.rating,
                time: r.time ? r.time.substring(0, 5) : r.time,
                booked_seats: r.bookings ? r.bookings.length : 0
            };
        });

        res.json(formattedRides);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * @swagger
 * /api/rides/my:
 *   get:
 *     summary: Get user's rides (as driver or passenger)
 *     tags: [Rides]
 *     parameters:
 *       - in: query
 *         name: userId
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: List of rides
 */
router.get('/my', userAuth, async (req, res) => {
    const userId = req.user.id;

    try {
        // Query 1: Rides where user is driver
        const { data: driverRides, error: error1 } = await supabase
            .from('rides')
            .select(`
                *,
                users:driver_id (name, rating, phone),
                bookings:bookings(id, passenger_id, seat_number, status, passenger_gender)
            `)
            .eq('driver_id', userId)
            .order('id', { ascending: false });

        if (error1) throw error1;

        // Query 2: Rides where user is passenger (via bookings)
        const { data: passengerBookings, error: error2 } = await supabase
            .from('bookings')
            .select(`
                ride_id,
                rides:ride_id (
                    *,
                    users:driver_id (name, rating, phone),
                    bookings:bookings(id, passenger_id, seat_number, status, passenger_gender)
                )
            `)
            .eq('passenger_id', userId);

        if (error2) throw error2;

        const passengerRides = passengerBookings
            .map(b => b.rides)
            .filter(r => r !== null);

        // Combine and unique by ID
        const allRidesMap = new Map();
        [...driverRides, ...passengerRides].forEach(r => {
            allRidesMap.set(r.id, r);
        });
        
        const uniqueRides = Array.from(allRidesMap.values())
            .sort((a, b) => b.id - a.id);

        // Format response
        const formattedRides = uniqueRides.map(r => {
            const userData = Array.isArray(r.users) ? r.users[0] : (r.users || {});
            
            let driverPhone = userData.phone;
            let driverName = userData.name;

            if (r.scraper_metadata) {
                try {
                    const meta = typeof r.scraper_metadata === 'string' ? JSON.parse(r.scraper_metadata) : r.scraper_metadata;
                    if (meta && meta.phone) {
                        driverPhone = meta.phone;
                    }
                    if (meta && meta.first_name) {
                        driverName = meta.first_name + (meta.last_name ? ' ' + meta.last_name : '');
                    }
                } catch (err) {
                    console.error('Error parsing scraper_metadata on my rides endpoint:', err);
                }
            }

            return {
                ...r,
                driver_name: driverName,
                driver_rating: r.driver_id === 694 ? 5.0 : userData.rating,
                driver_phone: driverPhone,
                time: r.time ? r.time.substring(0, 5) : r.time,
                booked_seats: r.bookings ? r.bookings.length : 0
            };
        });

        res.json(formattedRides);
    } catch (err) {
        console.error('Fetch my rides error:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * @swagger
 * /api/rides/{id}:
 *   get:
 *     summary: Get ride details
 *     tags: [Rides]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Ride details
 *       404:
 *         description: Ride not found
 */
router.get('/:id', optionalUserAuth, async (req, res) => {
    const id = req.params.id;
    try {
        const { data: rideRaw, error: rideError } = await supabase
            .from('rides')
            .select(`
                *,
                users:driver_id (name, rating, phone, preferences)
            `)
            .eq('id', id)
            .single();

        if (rideError || !rideRaw) return res.status(404).json({ error: 'Ride not found' });

        const userData = Array.isArray(rideRaw.users) ? rideRaw.users[0] : (rideRaw.users || {});
        delete rideRaw.users;

        let driverPhone = userData.phone;
        let driverName = userData.name;

        if (rideRaw.scraper_metadata) {
            try {
                const meta = typeof rideRaw.scraper_metadata === 'string' ? JSON.parse(rideRaw.scraper_metadata) : rideRaw.scraper_metadata;
                if (meta && meta.phone) {
                    driverPhone = meta.phone;
                }
                if (meta && meta.first_name) {
                    driverName = meta.first_name + (meta.last_name ? ' ' + meta.last_name : '');
                }
            } catch (err) {
                console.error('Error parsing scraper_metadata on details endpoint:', err);
            }
        }

        const currentUserId = req.user ? req.user.id : null;
        const isDriver = currentUserId && currentUserId === rideRaw.driver_id;
        const { data: bookingsRaw, error: bookingsError } = await supabase
            .from('bookings')
            .select(`
                *,
                users:passenger_id (name, age, phone)
            `)
            .eq('ride_id', id);

        if (bookingsError) throw bookingsError;

        const hasBooked = currentUserId && (bookingsRaw || []).some(b => b.passenger_id === currentUserId);

        const ride = {
            ...rideRaw,
            driver_name: driverName,
            driver_rating: rideRaw.driver_id === 694 ? 5.0 : userData.rating,
            driver_phone: (isDriver || hasBooked) ? driverPhone : undefined,
            driver_preferences: typeof userData.preferences === 'string' ? JSON.parse(userData.preferences || '[]') : (userData.preferences || []),
            time: rideRaw.time ? rideRaw.time.substring(0, 5) : rideRaw.time
        };

        if (!ride.total_seats && !ride.is_passenger_entry) {
            const { data: v } = await supabase
                .from('vehicles')
                .select('total_seats')
                .eq('user_id', ride.driver_id)
                .maybeSingle();
            ride.total_seats = v ? v.total_seats : 5;
        } else if (!ride.total_seats) {
            ride.total_seats = 5;
        }

        ride.reserved_seats = typeof ride.reserved_seats === 'string' ? JSON.parse(ride.reserved_seats || '[]') : (ride.reserved_seats || []);
        ride.row_prices = typeof ride.row_prices === 'string' ? JSON.parse(ride.row_prices || '{}') : (ride.row_prices || {});

        let vehicle = null;
        if (!ride.is_passenger_entry) {
            const { data: vData } = await supabase
                .from('vehicles')
                .select('make, model, plate_number')
                .eq('user_id', ride.driver_id)
                .maybeSingle();
            vehicle = vData;
        }

        const bookings = (bookingsRaw || []).map(b => {
            const pData = b.users || {};
            delete b.users;
            return {
                ...b,
                passenger_name: pData.name,
                passenger_phone: isDriver ? pData.phone : undefined,
                age: pData.age
            };
        });

        res.json({ ...ride, vehicle, bookings });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * @swagger
 * /api/rides:
 *   post:
 *     summary: Create a new ride
 *     tags: [Rides]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/Ride'
 *     responses:
 *       200:
 *         description: Ride created
 *       400:
 *         description: Bad request
 */
router.post('/', async (req, res) => {
    let effectiveDriverId = null;
    let isBot = false;

    // 1. Telegram Bot Service Authentication
    if (verifyBotServiceToken(req)) {
        isBot = true;
        effectiveDriverId = parseInt(req.body.driver_id, 10) || 694;
    } else {
        // 2. Normal Driver JWT Authentication
        const authHeader = req.headers['authorization'];
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Необходима авторизация: отсутствует Bearer токен' });
        }
        try {
            const token = authHeader.substring(7).trim();
            const decoded = verifyUserToken(token);
            effectiveDriverId = parseInt(decoded.sub, 10);
        } catch (jwtErr) {
            return res.status(401).json({ error: 'Недействительный или истекший токен авторизации' });
        }
    }

    if (!effectiveDriverId || isNaN(effectiveDriverId)) {
        return res.status(401).json({ error: 'Некорректный идентификатор водителя' });
    }

    const driver_id = effectiveDriverId;
    const { from_city, to_city, date, time, price, seats, description, is_passenger_entry, reserved_seats, allows_delivery, from_address, to_address, total_seats, row_prices, scraper_metadata } = req.body;
    console.log(`[Ride Creation] Attempting to create ride for driver_id: ${driver_id} (isBot: ${isBot})`);

    try {
        // Verify user exists to avoid foreign key violation (common after DB reset)
        const { data: userExists, error: userError } = await supabase
            .from('users')
            .select('id, name')
            .eq('id', driver_id)
            .maybeSingle();

        if (userError || !userExists) {
            console.error(`[Ride Creation] Driver ${driver_id} not found in database.`);
            return res.status(401).json({ error: 'Приложение работает правильно в телеграм боте' });
        }

        const isAiScraper = userExists && (userExists.name === 'Ронанда' || userExists.name === 'AI_scraper' || userExists.id === 694);

        const { data: activeRides } = await supabase
            .from('rides')
            .select('date, time')
            .eq('driver_id', driver_id)
            .eq('status', 'active')
            .eq('is_passenger_entry', false);

        const futureActiveRides = (activeRides || []).filter(ride => {
            const t = ride.time ? ride.time : '00:00:00';
            const rideDateTime = new Date(`${ride.date}T${t}`);
            return new Date() < rideDateTime;
        });

        console.log(`[Ride Creation] driver_id: ${driver_id}, is_passenger_entry: ${is_passenger_entry}, futureActiveRides: ${futureActiveRides.length}`);

        if (!is_passenger_entry && price) {
            const isKhujandDushanbe = (from_city === 'Худжанд' && to_city === 'Душанбе') || (from_city === 'Душанбе' && to_city === 'Худжанд');
            const isKhujandOybek = (from_city === 'Худжанд' && to_city === 'Ойбек') || (from_city === 'Ойбек' && to_city === 'Худжанд');

            if (isKhujandDushanbe && price > 150) {
                return res.status(400).json({ error: `Для маршрута ${from_city} - ${to_city} максимальная цена составляет 150 с.` });
            }
            if (isKhujandOybek && price > 60) {
                return res.status(400).json({ error: `Для маршрута ${from_city} - ${to_city} максимальная цена составляет 60 с.` });
            }

            if (row_prices) {
                const maxAllowed = isKhujandDushanbe ? 150 : (isKhujandOybek ? 60 : Infinity);
                const rPrices = Object.values(row_prices).filter(p => !isNaN(p) && p !== null);
                if (rPrices.some(p => p > maxAllowed)) {
                    return res.status(400).json({ error: `Цена по одному из рядов превышает максимум (${maxAllowed} с.)` });
                }
            }
        }

        const { data: ride, error } = await supabase
            .from('rides')
            .insert([{
                driver_id,
                from_city,
                to_city,
                date,
                time,
                price,
                seats,
                description,
                is_passenger_entry: !!is_passenger_entry,
                reserved_seats: reserved_seats || [],
                allows_delivery: !!allows_delivery,
                status: 'active',
                from_address,
                to_address,
                total_seats: total_seats || 5,
                row_prices: row_prices || {},
                scraper_metadata: scraper_metadata || null
            }])
            .select('id')
            .single();

        if (error) throw error;

        res.json({ id: ride.id, ...req.body });

        // Telegram Notifications
        const dateStr = date;
        const timeStr = time ? time.substring(0, 5) : '';

        if (is_passenger_entry) {
            const broadcastMsg = `🙋 ПАССАЖИР ИЩЕТ ПОЕЗДКУ\n📍 Маршрут: ${from_city} ➡ ${to_city}\n🗓 Дата: ${dateStr}\n⏰ Время: ${timeStr}\n👥 Количество пассажиров: ${seats}`;
            console.log(`[Ride Creation] Broadcasting passenger entry: ${ride.id}`);
            await sendBroadcast(broadcastMsg, ride.id);

            const rideUrl = `${process.env.MINI_APP_URL || 'https://poputki.online'}/ride/${ride.id}`;
            const personalMsg = `✅ <b>Ваша заявка опубликована!</b>\n\n${broadcastMsg}`;
            const options = {
                reply_markup: {
                    inline_keyboard: [[{ text: 'Открыть поездку', web_app: { url: rideUrl } }]]
                }
            };
            await sendPersonalMessage(driver_id, personalMsg, options);
        } else {
            const deliveryText = allows_delivery ? '\n📦 Беру посылки' : '';
            const broadcastMsg = `🚗 ВОДИТЕЛЬ ИЩЕТ ПАССАЖИРОВ\n📍 Маршрут: ${from_city} ➡ ${to_city}\n🗓 Дата: ${dateStr}\n⏰ Время: ${timeStr}\n 💺 Свободных мест: ${seats}${deliveryText}`;
            console.log(`[Ride Creation] Broadcasting driver entry: ${ride.id}`);
            await sendBroadcast(broadcastMsg, ride.id);

            const rideUrl = `${process.env.MINI_APP_URL || 'https://poputki.online'}/ride/${ride.id}`;
            const personalMsg = `✅ <b>Ваш рейс опубликован!</b>\n\n${broadcastMsg}`;
            const options = {
                reply_markup: {
                    inline_keyboard: [[{ text: 'Открыть поездку', web_app: { url: rideUrl } }]]
                }
            };
            await sendPersonalMessage(driver_id, personalMsg, options);
        }

    } catch (err) {
        console.error('Create ride error', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * @swagger
 * /api/rides/{id}/complete:
 *   post:
 *     summary: Complete a ride
 *     tags: [Rides]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               driver_id:
 *                 type: integer
 */
router.post('/:id/complete', userAuth, async (req, res) => {
    const { id } = req.params;
    const driver_id = req.user.id;
    try {
        const { data: ride } = await supabase
            .from('rides')
            .select('driver_id, date, time')
            .eq('id', id)
            .single();

        if (!ride || ride.driver_id !== driver_id) {
            return res.status(403).json({ error: 'Permission denied' });
        }

        const time = ride.time ? ride.time : '00:00:00';
        const rideDateTime = new Date(`${ride.date}T${time}`);

        if (new Date() < rideDateTime) {
            return res.status(400).json({ error: 'Нельзя завершить поездку до её начала' });
        }

        await supabase
            .from('rides')
            .update({ status: 'completed' })
            .eq('id', id);

        res.json({ success: true });

        // Notify passengers to leave a review
        const { data: bookings } = await supabase
            .from('bookings')
            .select('passenger_id')
            .eq('ride_id', id);

        if (bookings && bookings.length > 0) {
            const reviewMsg = `🏁 <b>Поездка завершена!</b>\n\nПожалуйста, оставьте отзыв о водителе.`;
            const reviewUrl = `${process.env.MINI_APP_URL || 'https://poputki.online'}/my-rides?reviewRideId=${id}`;
            const options = {
                reply_markup: {
                    inline_keyboard: [[{ text: 'Оставить отзыв', web_app: { url: reviewUrl } }]]
                }
            };

            for (const booking of bookings) {
                try {
                    await sendPersonalMessage(booking.passenger_id, reviewMsg, options);
                } catch (notifyErr) {
                    console.error(`Failed to notify passenger ${booking.passenger_id}:`, notifyErr);
                }
            }
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * @swagger
 * /api/rides/{id}/cancel:
 *   post:
 *     summary: Cancel a ride (driver side)
 *     tags: [Rides]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 */
router.post('/:id/cancel', userAuth, async (req, res) => {
    const { id } = req.params;
    const driver_id = req.user.id;
    try {
        const { data: ride } = await supabase
            .from('rides')
            .select('driver_id, date, time, status, from_city, to_city, is_passenger_entry')
            .eq('id', id)
            .single();

        if (!ride || ride.driver_id !== driver_id) {
            return res.status(403).json({ error: 'Permission denied' });
        }

        if (ride.status === 'completed') {
            return res.status(400).json({ error: 'Cannot cancel a completed ride' });
        }

        const time = ride.time ? ride.time : '00:00:00';
        const rideDateTime = new Date(`${ride.date}T${time}`);

        if (new Date() >= rideDateTime) {
            return res.status(400).json({ error: 'Нельзя отменить поездку после её начала' });
        }

        await supabase
            .from('rides')
            .update({ status: 'cancelled' })
            .eq('id', id);

        // Fetch bookings before deleting to notify passengers
        const { data: bookings } = await supabase
            .from('bookings')
            .select('passenger_id')
            .eq('ride_id', id);

        // Also remove all bookings for this ride
        await supabase
            .from('bookings')
            .delete()
            .eq('ride_id', id);

        res.json({ success: true });

        // Telegram Notifications
        const dateStr = ride.date;
        const timeStr = ride.time ? ride.time.substring(0, 5) : '';

        if (!ride.is_passenger_entry && bookings && bookings.length > 0) {
            const cancelMsg = `🚫 <b>ПОЕЗДКА ОТМЕНЕНА</b>\n\nК сожалению, водитель отменил запланированную поездку:\n📍 <b>Маршрут:</b> ${ride.from_city} ➡ ${ride.to_city}\n🗓 <b>Дата и время:</b> ${dateStr} в ${timeStr}\n\n<i>Ваша бронь аннулирована. Пожалуйста, найдите другую поездку в приложении. Приносим извинения за неудобства.</i>`;
            bookings.forEach(b => {
                sendPersonalMessage(b.passenger_id, cancelMsg);
            });
        }

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * @swagger
 * /api/rides/{id}:
 *   put:
 *     summary: Update a ride
 *     tags: [Rides]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 */
router.put('/:id', userAuth, async (req, res) => {
    const { id } = req.params;
    const { from_city, to_city, date, time, price, seats, description, allows_delivery, from_address, to_address, total_seats, row_prices } = req.body;

    try {
        const { data: existingRide, error: findError } = await supabase
            .from('rides')
            .select('driver_id')
            .eq('id', id)
            .single();

        if (findError || !existingRide) {
            return res.status(404).json({ error: 'Поездка не найдена' });
        }

        if (existingRide.driver_id !== req.user.id) {
            return res.status(403).json({ error: 'Доступ запрещен: нельзя редактировать чужую поездку' });
        }

        const updates = {};
        if (from_city !== undefined) updates.from_city = from_city;
        if (to_city !== undefined) updates.to_city = to_city;
        if (date !== undefined) updates.date = date;
        if (time !== undefined) updates.time = time;
        if (price !== undefined) updates.price = price;
        if (seats !== undefined) updates.seats = seats;
        if (description !== undefined) updates.description = description;
        if (allows_delivery !== undefined) updates.allows_delivery = allows_delivery;
        if (from_address !== undefined) updates.from_address = from_address;
        if (to_address !== undefined) updates.to_address = to_address;
        if (total_seats !== undefined) updates.total_seats = total_seats;
        if (row_prices !== undefined) updates.row_prices = row_prices;

        const { data: ride, error } = await supabase
            .from('rides')
            .update(updates)
            .eq('id', id)
            .select()
            .single();

        if (error) throw error;
        res.json(ride);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * @swagger
 * /api/rides/{id}/share:
 *   post:
 *     summary: Share a driver's ride with a passenger
 *     tags: [Rides]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               driver_ride_id:
 *                 type: integer
 */
router.post('/:id/share', userAuth, async (req, res) => {
    const passengerReqId = req.params.id;
    const { driver_ride_id } = req.body;
    try {
        const { data: passengerReq, error: pError } = await supabase
            .from('rides')
            .select('*')
            .eq('id', passengerReqId)
            .single();

        if (pError || !passengerReq) {
            console.error('Share error (passengerReq):', pError);
            return res.status(404).json({ error: 'Заявка пассажира не найдена' });
        }

        if (!passengerReq.is_passenger_entry) {
            return res.status(400).json({ error: 'Эта поездка не является заявкой пассажира' });
        }

        const { data: driverRide, error: dError } = await supabase
            .from('rides')
            .select(`*, users:driver_id(name, phone)`)
            .eq('id', driver_ride_id)
            .single();

        if (dError || !driverRide) {
            console.error('Share error (driverRide):', dError);
            return res.status(404).json({ error: 'Поездка водителя не найдена' });
        }

        if (driverRide.driver_id !== req.user.id) {
            return res.status(403).json({ error: 'Доступ запрещен: вы можете предлагать только свою поездку' });
        }

        const dateStr = driverRide.date;
        const timeStr = driverRide.time ? driverRide.time.substring(0, 5) : '';
        
        // Safely extract from either Array or Object depending on Supabase relations
        const dsUser = Array.isArray(driverRide.users) ? driverRide.users[0] : (driverRide.users || {});
        let driverName = dsUser.name || 'Водитель';

        // Sanitize any accidental HTML characters from name to prevent Telegram API 400 errors
        driverName = driverName.replace(/</g, '').replace(/>/g, '').replace(/&/g, 'и');

        // Extract min price if row_prices exists
        let displayPrice = driverRide.price;
        if (driverRide.row_prices && Object.keys(driverRide.row_prices).length > 0) {
            const prices = Object.values(driverRide.row_prices).filter(p => !isNaN(p) && p !== null && p > 0);
            if (prices.length > 0) {
                displayPrice = Math.min(...prices, driverRide.price > 0 ? driverRide.price : Infinity);
            }
        }

        // Add to telegram queue or send right away
        const msg = `🚗 <b>ВСТРЕЧНОЕ ПРЕДЛОЖЕНИЕ ПОЕЗДКИ</b>\n\nВодитель <b>${driverName}</b> предлагает вам присоединиться к его поездке:\n📍 <b>Маршрут:</b> ${driverRide.from_city} ➡ ${driverRide.to_city}\n🗓 <b>Дата и время:</b> ${dateStr} в ${timeStr}\n💵 <b>Цена от:</b> ${displayPrice} с.\n\n<i>Откройте список поездок, найдите водителя и забронируйте место!</i>`;

        const rideUrl = `${process.env.MINI_APP_URL || 'https://poputki.online'}/ride/${driver_ride_id}`;
        const options = {
            reply_markup: {
                inline_keyboard: [[{ text: 'Открыть поездку', web_app: { url: rideUrl } }]]
            }
        };

        const personalMsgSuccess = await sendPersonalMessage(passengerReq.driver_id, msg, options);

        if (!personalMsgSuccess) {
            console.error(`Failed to send telegram msg in share endpoint for ride: ${driver_ride_id} to passenger: ${passengerReq.driver_id}`);
            return res.status(500).json({ error: 'Не удалось отправить уведомление пассажиру. Возможно, он не запустил бота.' });
        }

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * @swagger
 * /api/rides/{id}/delivery-request:
 *   post:
 *     summary: Request to send a package via the driver
 *     tags: [Rides]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               passenger_id:
 *                 type: integer
 */
router.post('/:id/delivery-request', userAuth, async (req, res) => {
    const rideId = req.params.id;
    const passenger_id = req.user.id;

    try {
        const { data: ride, error: rideError } = await supabase
            .from('rides')
            .select(`*, driver:driver_id(id)`)
            .eq('id', rideId)
            .single();

        if (rideError || !ride) {
            return res.status(404).json({ error: 'Поездка не найдена' });
        }

        const { data: passenger, error: pError } = await supabase
            .from('users')
            .select('name, phone')
            .eq('id', passenger_id)
            .single();

        if (pError || !passenger) {
            return res.status(404).json({ error: 'Пользователь не найден' });
        }

        if (!passenger.phone) {
            return res.status(400).json({ error: 'Номер телефона пассажира не указан' });
        }

        const dateStr = ride.date;
        const timeStr = ride.time ? ride.time.substring(0, 5) : '';

        const msg = `📦 <b>ЗАПРОС НА ОТПРАВКУ ПОСЫЛКИ</b>\n\nПользователь <b>${passenger.name || 'Один из пользователей'}</b> хочет передать посылку через вашу поездку:\n📍 <b>Маршрут:</b> ${ride.from_city} ➡ ${ride.to_city}\n🗓 <b>Дата и время:</b> ${dateStr} в ${timeStr}\n\n📞 <b>Свяжитесь с ним по номеру:</b> ${passenger.phone}`;

        // Send to driver
        const personalMsgSuccess = await sendPersonalMessage(ride.driver_id, msg);

        if (!personalMsgSuccess) {
            console.log('User has not started the bot yet:', ride.driver_id);
            // It might fail if driver hasn't started the bot, but typically drivers did. We'll return success anyway but log it.
        }

        res.json({ success: true, message: 'Заявка отправлена' });
    } catch (err) {
        console.error('Delivery request error:', err);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
