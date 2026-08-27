const express = require('express');
const router = express.Router();
const supabase = require('../db');
const { sendBroadcast } = require('../utils/telegramBot');
const { uploadToCloudinary } = require('../utils/cloudinaryUtils');

/**
 * @swagger
 * components:
 *   schemas:
 *     BusTicket:
 *       type: object
 *       properties:
 *         id:
 *           type: integer
 *         operator_id:
 *           type: integer
 *         transport_company:
 *           type: string
 *         from_city:
 *           type: string
 *         from_address:
 *           type: string
 *         to_city:
 *           type: string
 *         to_address:
 *           type: string
 *         departure_date:
 *           type: string
 *         departure_time:
 *           type: string
 *         arrival_date:
 *           type: string
 *         arrival_time:
 *           type: string
 *         duration_minutes:
 *           type: integer
 *         price:
 *           type: integer
 *         total_seats:
 *           type: integer
 *         status:
 *           type: string
 */

/**
 * @swagger
 * /api/bus-tickets:
 *   post:
 *     summary: Create a bus ticket
 *     tags: [Bus Tickets]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/BusTicket'
 */
router.post('/', async (req, res) => {
    const {
        operator_id, transport_company,
        from_city, from_address, to_city, to_address,
        departure_date, departure_time, arrival_date, arrival_time,
        duration_minutes, price, total_seats,
        bus_type, passenger_comments, intermediate_stops,
        floor1_seats, floor2_seats, premium_price, photos
    } = req.body;
    try {
        // Check if operator is blocked
        const { data: operator } = await supabase
            .from('users')
            .select('is_blocked')
            .eq('id', operator_id)
            .single();

        if (operator?.is_blocked) {
            return res.status(403).json({ error: 'Ваш аккаунт заблокирован. Вы не можете создавать новые рейсы.' });
        }

        let photoResults = [];
        if (photos && Array.isArray(photos)) {
            for (const photo of photos) {
                if (typeof photo === 'string' && photo.startsWith('data:image')) {
                    try {
                        const r = await uploadToCloudinary(photo, { folder: 'poputki/bus_photos' });
                        photoResults.push({ url: r.url, public_id: r.public_id });
                    } catch(e) { console.error('Cloudinary upload error:', e); }
                } else if (typeof photo === 'object' && photo.url && photo.public_id) {
                    // Already uploaded from frontend
                    photoResults.push(photo);
                }
            }
        }

        const { data: ticket, error } = await supabase
            .from('bus_tickets')
            .insert([{
                operator_id, transport_company,
                from_city, from_address, to_city, to_address,
                departure_date, departure_time, arrival_date, arrival_time,
                duration_minutes, price, total_seats: total_seats || 53,
                reserved_seats: [], status: 'active',
                bus_type: bus_type || 'single', passenger_comments,
                intermediate_stops: intermediate_stops || [],
                floor1_seats: floor1_seats || null,
                floor2_seats: floor2_seats || null,
                premium_price: premium_price || null,
                photos: photoResults
            }])
            .select('id')
            .single();

        if (error) throw error;

        // Audit logging (non-blocking)
        await logCarrierActivity({
            supabase,
            carrierContext: { carrier_id: operator_id, user_id: operator_id, role: 'owner' },
            action: AUDIT_ACTIONS.TICKET_CREATED,
            entityType: AUDIT_ENTITY_TYPES.TICKET,
            entityId: ticket.id,
            entityLabel: `Рейс ${from_city} → ${to_city} #${ticket.id}`,
            newData: {
                from_city,
                to_city,
                departure_date,
                departure_time,
                arrival_date,
                arrival_time,
                price,
                total_seats: total_seats || 53,
                bus_type: bus_type || 'single'
            }
        });

        res.json({ id: ticket.id, ...req.body });

        // Telegram Notifications
        const dateStr = departure_date;
        const timeStr = departure_time ? departure_time.substring(0, 5) : '';
        const stopsText = intermediate_stops && intermediate_stops.length > 0
            ? `\n🛑 Остановки: ${intermediate_stops.map(s => s.city).join(', ')}`
            : '';
        const broadcastMsg = `🚌 НОВЫЙ АВТОБУСНЫЙ РЕЙС\n📍 Маршрут: ${from_city} ➡ ${to_city}${stopsText}\n🗓 Дата: ${dateStr}\n⏰ Время: ${timeStr}\n💰 Цена: ${price} сом\n🏢 Перевозчик: ${transport_company}`;
        sendBroadcast(broadcastMsg, ticket.id, 'bus');

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * @swagger
 * /api/bus-tickets:
 *   get:
 *     summary: Search bus tickets
 *     tags: [Bus Tickets]
 *     parameters:
 *       - in: query
 *         name: from
 *         schema:
 *           type: string
 *       - in: query
 *         name: to
 *         schema:
 *           type: string
 *       - in: query
 *         name: date
 *         schema:
 *           type: string
 */
router.get('/', async (req, res) => {
    const { from, to, date } = req.query;
    try {
        const now = new Date();
        const currentDate = now.toISOString().split('T')[0];
        const currentTime = now.toTimeString().split(' ')[0];

        let query = supabase
            .from('bus_tickets')
            .select('*')
            .eq('status', 'active')
            .or(`departure_date.gt.${currentDate},and(departure_date.eq.${currentDate},departure_time.gte.${currentTime})`)
            .order('departure_date', { ascending: true })
            .order('departure_time', { ascending: true });

        if (from) query = query.ilike('from_city', `%${from}%`);
        // We will filter 'to' in-memory or via complex query to include intermediate stops
        if (date) query = query.gte('departure_date', date);

        const { data: tickets, error } = await query;
        if (error) throw error;

        let result = tickets.map(t => {
            const stops = (typeof t.intermediate_stops === 'string' ? JSON.parse(t.intermediate_stops || '[]') : (t.intermediate_stops || [])).map(s => ({
                ...s,
                time: s.time ? s.time.substring(0, 5) : s.time
            }));

            return {
                ...t,
                intermediate_stops: stops,
                reserved_seats: typeof t.reserved_seats === 'string' ? JSON.parse(t.reserved_seats || '[]') : (t.reserved_seats || []),
                departure_time: t.departure_time ? t.departure_time.substring(0, 5) : t.departure_time,
                arrival_time: t.arrival_time ? t.arrival_time.substring(0, 5) : t.arrival_time
            };
        });

        // If 'to' search is provided, filter or find matching stop
        if (to) {
            const toLower = to.toLowerCase();
            result = result.filter(t => {
                // Check final destination
                if (t.to_city.toLowerCase().includes(toLower)) return true;
                
                // Check stops
                const matchingStop = t.intermediate_stops.find(s => s.city.toLowerCase().includes(toLower));
                if (matchingStop) {
                    t.matchingStop = matchingStop; // Flag the match for frontend
                    return true;
                }
                return false;
            });
        }

        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * @swagger
 * /api/bus-tickets/{id}:
 *   get:
 *     summary: Get bus ticket details
 *     tags: [Bus Tickets]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 */
router.get('/:id', async (req, res) => {
    try {
        const { data: ticket, error: ticketError } = await supabase
            .from('bus_tickets')
            .select(`
                *,
                operator:users!operator_id (phone, service_fee_percent)
            `)
            .eq('id', req.params.id)
            .single();

        if (ticketError || !ticket) return res.status(404).json({ error: 'Ticket not found' });

        ticket.reserved_seats = typeof ticket.reserved_seats === 'string' ? JSON.parse(ticket.reserved_seats || '[]') : (ticket.reserved_seats || []);
        ticket.intermediate_stops = (typeof ticket.intermediate_stops === 'string' ? JSON.parse(ticket.intermediate_stops || '[]') : (ticket.intermediate_stops || [])).map(s => ({
            ...s,
            time: s.time ? s.time.substring(0, 5) : s.time
        }));
        ticket.departure_time = ticket.departure_time ? ticket.departure_time.substring(0, 5) : ticket.departure_time;
        ticket.arrival_time = ticket.arrival_time ? ticket.arrival_time.substring(0, 5) : ticket.arrival_time;

        const { data: bookings, error: bookingsError } = await supabase
            .from('bus_ticket_bookings')
            .select('*')
            .eq('bus_ticket_id', ticket.id)
            .eq('status', 'confirmed');

        if (bookingsError) throw bookingsError;

        const bookedSeats = [];
        const seatGenders = {};

        (bookings || []).forEach(b => {
            const seats = typeof b.seat_numbers === 'string' ? JSON.parse(b.seat_numbers || '[]') : (b.seat_numbers || []);
            const pData = typeof b.passengers_data === 'string' ? JSON.parse(b.passengers_data || '[]') : (b.passengers_data || []);

            bookedSeats.push(...seats);
            seats.forEach((seatNum, idx) => {
                if (pData[idx] && pData[idx].gender) {
                    seatGenders[seatNum] = pData[idx].gender;
                }
            });
        });

        // Calculate premium seats for double-decker
        let premiumSeats = [1, 2, 3, 4]; // Default front seats 2nd floor
        if (ticket.bus_type === 'double') {
            // Add table seats (1st floor)
            premiumSeats = [...premiumSeats, 69, 70, 71, 72, 73, 74, 75, 76];
        }

        res.json({ 
            ...ticket, 
            operator_phone: ticket.operator?.phone,
            service_fee_percent: ticket.operator?.service_fee_percent ?? 10,
            bookings, 
            bookedSeats, 
            seatGenders, 
            premiumSeats 
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
