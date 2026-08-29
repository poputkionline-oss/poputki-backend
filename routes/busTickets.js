const express = require('express');
const router = express.Router();
const supabase = require('../db');
const jwt = require('jsonwebtoken');
const { sendBroadcast } = require('../utils/telegramBot');
const { uploadToCloudinary } = require('../utils/cloudinaryUtils');
const { verifyBusAccess, checkBusScheduleConflict } = require('../utils/busHelper');
const { buildPublicBusDetails } = require('../utils/publicBusHelper');
const { logCarrierActivity, AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } = require('../utils/auditHelper');
const {
    extractBookingIdFromToken,
    verifyTicketToken,
    buildPassengerTicketProjection
} = require('../utils/ticketHelper');

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
 *         bus_id:
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
        floor1_seats, floor2_seats, premium_price, photos,
        bus_id, allow_bus_conflict
    } = req.body;
    try {
        // Authenticate verified carrier context if Bearer token present
        let verifiedCarrierId = null;
        let verifiedRole = 'owner';
        let verifiedUserId = null;
        const authHeader = req.headers['authorization'];
        if (authHeader && authHeader.startsWith('Bearer ')) {
            try {
                const token = authHeader.split(' ')[1];
                const decoded = jwt.verify(token, process.env.JWT_SECRET, {
                    issuer: 'poputki.online',
                    audience: 'poputki-carrier'
                });
                verifiedCarrierId = parseInt(decoded.carrierId || decoded.sub, 10);
                verifiedRole = decoded.role || 'owner';
                verifiedUserId = parseInt(decoded.sub, 10);
            } catch (e) {
                // Ignore token decode error for unauthenticated/legacy fallback
            }
        }

        const effectiveOperatorId = verifiedCarrierId || parseInt(operator_id, 10);
        if (!effectiveOperatorId) {
            return res.status(400).json({ error: 'Не указан идентификатор перевозчика' });
        }

        // Check if operator is blocked
        const { data: operator } = await supabase
            .from('users')
            .select('is_blocked')
            .eq('id', effectiveOperatorId)
            .single();

        if (operator?.is_blocked) {
            return res.status(403).json({ error: 'Ваш аккаунт заблокирован. Вы не можете создавать новые рейсы.' });
        }

        let effectiveBusId = null;
        let effectiveBusType = bus_type || 'single';
        let effectiveTotalSeats = total_seats || 53;
        let effectiveFloor1Seats = floor1_seats || null;
        let effectiveFloor2Seats = floor2_seats || null;
        let effectivePhotos = [];

        // FLEET MODE: When bus_id is supplied, backend master data is the ultimate source of truth
        if (bus_id) {
            const bus = await verifyBusAccess({ carrier_id: effectiveOperatorId, role: verifiedRole }, bus_id, { allowArchived: false });
            if (!bus) {
                return res.status(403).json({ error: 'BUS_NOT_FOUND', message: 'Автобус не найден или доступ запрещен' });
            }

            if (bus.status !== 'active') {
                return res.status(409).json({ error: 'BUS_NOT_AVAILABLE', message: 'Выбранный автобус недоступен для рейса (находится на ТО, неактивен или в архиве)' });
            }

            // Master capacity verification
            const masterTotal = Number(bus.total_seats);
            if (!masterTotal || masterTotal <= 0) {
                return res.status(400).json({ error: 'INVALID_BUS_CAPACITY', message: 'Некорректная вместимость автобуса в базе данных' });
            }

            if (bus.bus_type === 'double') {
                const f1 = Number(bus.floor1_seats);
                const f2 = Number(bus.floor2_seats);
                if (!f1 || !f2 || (f1 + f2 !== masterTotal)) {
                    return res.status(400).json({ error: 'INVALID_BUS_FLOORS', message: 'Некорректное распределение мест по этажам в карточке автобуса' });
                }
            }

            // Schedule conflict check (non-blocking: overrideable by authorized carrier)
            const conflicts = await checkBusScheduleConflict(
                supabase,
                effectiveOperatorId,
                bus.id,
                departure_date,
                departure_time,
                arrival_date,
                arrival_time
            );

            if (conflicts.length > 0 && !allow_bus_conflict) {
                return res.status(409).json({
                    error: 'BUS_SCHEDULE_CONFLICT',
                    message: 'Этот автобус уже назначен на другой рейс в указанный интервал времени',
                    conflicts
                });
            }

            // Snapshot values from master bus record
            effectiveBusId = bus.id;
            effectiveBusType = bus.bus_type || 'single';
            effectiveTotalSeats = masterTotal;
            effectiveFloor1Seats = effectiveBusType === 'double' ? Number(bus.floor1_seats) : null;
            effectiveFloor2Seats = effectiveBusType === 'double' ? Number(bus.floor2_seats) : null;
            effectivePhotos = Array.isArray(bus.photos) ? bus.photos : [];
        } else {
            // LEGACY / MANUAL MODE: Process uploaded or passed photos
            if (photos && Array.isArray(photos)) {
                for (const photo of photos) {
                    if (typeof photo === 'string' && photo.startsWith('data:image')) {
                        try {
                            const r = await uploadToCloudinary(photo, { folder: 'poputki/bus_photos' });
                            effectivePhotos.push({ url: r.url, public_id: r.public_id });
                        } catch(e) { console.error('Cloudinary upload error:', e); }
                    } else if (typeof photo === 'object' && photo.url && photo.public_id) {
                        effectivePhotos.push(photo);
                    }
                }
            }
        }

        const { data: ticket, error } = await supabase
            .from('bus_tickets')
            .insert([{
                operator_id: effectiveOperatorId,
                transport_company,
                from_city, from_address, to_city, to_address,
                departure_date, departure_time, arrival_date, arrival_time,
                duration_minutes, price,
                total_seats: effectiveTotalSeats,
                reserved_seats: [],
                status: 'active',
                bus_type: effectiveBusType,
                passenger_comments,
                intermediate_stops: intermediate_stops || [],
                floor1_seats: effectiveFloor1Seats,
                floor2_seats: effectiveFloor2Seats,
                premium_price: premium_price || null,
                photos: effectivePhotos,
                bus_id: effectiveBusId
            }])
            .select('id')
            .single();

        if (error) throw error;

        // Audit logging (non-blocking)
        await logCarrierActivity({
            supabase,
            carrierContext: { carrier_id: effectiveOperatorId, user_id: verifiedUserId || effectiveOperatorId, role: verifiedRole },
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
                total_seats: effectiveTotalSeats,
                bus_type: effectiveBusType,
                bus_id: effectiveBusId
            }
        });

        res.json({ id: ticket.id, bus_id: effectiveBusId, ...req.body });

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

        // Batch fetch master bus records to eliminate N+1 queries
        const busIds = Array.from(new Set((tickets || []).map(t => t.bus_id).filter(Boolean)));
        const busMap = new Map();
        if (busIds.length > 0) {
            const { data: buses, error: bErr } = await supabase
                .from('carrier_buses')
                .select('id, brand, model, license_plate, year_built, color, amenities')
                .in('id', busIds);
            if (!bErr && Array.isArray(buses)) {
                buses.forEach(b => busMap.set(b.id, b));
            }
        }

        let result = tickets.map(t => {
            const stops = (typeof t.intermediate_stops === 'string' ? JSON.parse(t.intermediate_stops || '[]') : (t.intermediate_stops || [])).map(s => ({
                ...s,
                time: s.time ? s.time.substring(0, 5) : s.time
            }));

            const busMaster = t.bus_id ? busMap.get(t.bus_id) : null;
            const busDetails = buildPublicBusDetails(t, busMaster);

            return {
                ...t,
                bus: busDetails,
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

        // Fetch passenger-safe bus projection if bus_id is present
        let busDetails = null;
        if (ticket.bus_id) {
            const { data: busMaster } = await supabase
                .from('carrier_buses')
                .select('id, brand, model, license_plate, year_built, color, amenities')
                .eq('id', ticket.bus_id)
                .maybeSingle();
            busDetails = buildPublicBusDetails(ticket, busMaster);
        }

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
            bus: busDetails,
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

/**
 * @swagger
 * /api/bus-tickets/verify/{token}:
 *   get:
 *     summary: Public verification of a passenger ticket via QR token
 *     tags: [Bus Tickets]
 */
router.get('/verify/:token', async (req, res) => {
    const { token } = req.params;

    const bookingId = extractBookingIdFromToken(token);
    if (!bookingId) {
        return res.status(404).json({ valid: false, error: 'Билет не найден или некорректный QR-код' });
    }

    try {
        const { data: booking, error: bErr } = await supabase
            .from('bus_ticket_bookings')
            .select(`
                id, bus_ticket_id, passenger_id, seat_numbers, passenger_count, passengers_data, status, total_price, passenger_name, pickup_city, drop_off_city, created_at,
                boarding_status, boarded_at,
                commission_rate, commission_amount, carrier_amount,
                users:passenger_id (name)
            `)
            .eq('id', bookingId)
            .maybeSingle();

        if (bErr || !booking) {
            return res.status(404).json({ valid: false, error: 'Билет не найден' });
        }

        const isTokenValid = verifyTicketToken(token, booking.id);
        if (!isTokenValid) {
            return res.status(403).json({ valid: false, error: 'Недействительный или поддельный токен билета' });
        }

        const { data: ticket, error: tErr } = await supabase
            .from('bus_tickets')
            .select('*')
            .eq('id', booking.bus_ticket_id)
            .maybeSingle();

        if (tErr || !ticket) {
            return res.status(404).json({ valid: false, error: 'Рейс не найден' });
        }

        let busMaster = null;
        if (ticket.bus_id) {
            const { data: bData } = await supabase
                .from('carrier_buses')
                .select('*')
                .eq('id', ticket.bus_id)
                .maybeSingle();
            busMaster = bData || null;
        }

        const projection = buildPassengerTicketProjection(booking, ticket, busMaster, { isPublic: true });

        res.json({
            valid: true,
            ticket: projection
        });
    } catch (err) {
        console.error('[Public Ticket Verify] Error:', err);
        res.status(500).json({ valid: false, error: 'Ошибка проверки билета' });
    }
});

module.exports = router;
