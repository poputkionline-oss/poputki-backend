const express = require('express');
const router = express.Router();
const supabase = require('../db');
const { uploadToCloudinary, deleteFromCloudinary } = require('../utils/cloudinaryUtils');
const { carrierAuth, verifyTicketAccess } = require('../utils/carrierAuth');

/**
 * @swagger
 * tags:
 *   name: Bus Admin
 *   description: Operations for Bus Drivers Panel
 */

// Protect ALL carrier panel routes with carrierAuth
router.use(carrierAuth);

/**
 * @swagger
 * /api/bus-admin/stats:
 *   get:
 *     summary: Get dashboard stats for the authenticated carrier
 *     tags: [Bus Admin]
 */
router.get('/stats', async (req, res) => {
    // Trusted carrier ID extracted directly from verified JWT
    const operatorId = req.carrier.carrier_id;

    try {
        // 1. Basic counts
        const { count: totalRides } = await supabase.from('bus_tickets').select('*', { count: 'exact', head: true }).eq('operator_id', operatorId);
        const { count: activeRides } = await supabase.from('bus_tickets').select('*', { count: 'exact', head: true }).eq('operator_id', operatorId).eq('status', 'active');
        
        // 2. Bookings and Revenue
        const { data: tickets } = await supabase.from('bus_tickets').select('id, total_seats').eq('operator_id', operatorId);
        const ticketIds = (tickets || []).map(t => t.id);

        if (ticketIds.length === 0) {
            return res.json({
                totalRides: 0,
                activeRides: 0,
                totalBookings: 0,
                totalRevenue: 0,
                avgFillRate: 0,
                dailyBookings: [],
                popularRoutes: []
            });
        }

        const { data: bookings } = await supabase
            .from('bus_ticket_bookings')
            .select('id, total_price, passenger_count, created_at, bus_ticket_id')
            .in('bus_ticket_id', ticketIds)
            .eq('status', 'confirmed');

        const totalBookings = (bookings || []).length;
        const totalRevenue = (bookings || []).reduce((acc, curr) => acc + (curr.total_price || 0), 0);

        // 3. Average Fill Rate
        // For each ticket, calculate filled seats / total seats
        const { data: allReserved } = await supabase
            .from('bus_ticket_bookings')
            .select('bus_ticket_id, passenger_count')
            .in('bus_ticket_id', ticketIds)
            .eq('status', 'confirmed');

        const fillRates = tickets.map(t => {
            const reserved = (allReserved || []).filter(b => b.bus_ticket_id === t.id).reduce((acc, curr) => acc + curr.passenger_count, 0);
            return (reserved / t.total_seats) * 100;
        });
        const avgFillRate = fillRates.length > 0 ? (fillRates.reduce((a, b) => a + b, 0) / fillRates.length).toFixed(1) : 0;

        // 4. Daily Bookings (Last 30 days)
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        const dateString = thirtyDaysAgo.toISOString().split('T')[0];

        const dailyMap = (bookings || []).filter(b => b.created_at >= dateString).reduce((acc, curr) => {
            const date = curr.created_at.split('T')[0];
            acc[date] = (acc[date] || 0) + 1;
            return acc;
        }, {});

        const dailyBookings = Object.keys(dailyMap)
            .map(date => ({ date, count: dailyMap[date] }))
            .sort((a, b) => a.date.localeCompare(b.date));

        // 5. Popular Routes
        const { data: routeInfo } = await supabase.from('bus_tickets').select('from_city, to_city').eq('operator_id', operatorId);
        const routeCounts = (routeInfo || []).reduce((acc, curr) => {
            const route = `${curr.from_city} → ${curr.to_city}`;
            acc[route] = (acc[route] || 0) + 1;
            return acc;
        }, {});
        const popularRoutes = Object.keys(routeCounts)
            .map(route => ({ route, count: routeCounts[route] }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 5);

        res.json({
            totalRides,
            activeRides,
            totalBookings,
            totalRevenue,
            avgFillRate,
            dailyBookings,
            popularRoutes
        });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * @swagger
 * /api/bus-admin/tickets:
 *   get:
 *     summary: Get tickets created by the authenticated carrier
 *     tags: [Bus Admin]
 */
router.get('/tickets', async (req, res) => {
    // Trusted carrier ID extracted directly from verified JWT
    const operatorId = req.carrier.carrier_id;

    try {
        console.log(`[BusAdmin] Fetching tickets for carrier: ${operatorId} (user: ${req.carrier.user_id})`);
        const { data: tickets, error } = await supabase
            .from('bus_tickets')
            .select('*')
            .eq('operator_id', operatorId)
            .order('departure_date', { ascending: false });

        if (error) {
            console.error('[BusAdmin] Supabase error fetching tickets:', error);
            throw error;
        }

        if (!tickets || tickets.length === 0) {
            console.log(`[BusAdmin] No tickets found for carrier: ${operatorId}`);
            return res.json([]);
        }

        // Fetch all relevant bookings to calculate accurate reserved seats (including pending_payment)
        const ticketIds = tickets.map(t => t.id);
        const { data: allBookings, error: bErr } = await supabase
            .from('bus_ticket_bookings')
            .select('bus_ticket_id, seat_numbers, status')
            .in('bus_ticket_id', ticketIds)
            .neq('status', 'cancelled');

        if (bErr) {
            console.error('[BusAdmin] Error fetching bookings for tickets:', bErr);
        }

        const result = tickets.map(t => {
            // We count both 'confirmed' and 'pending_payment' as reserved to prevent double booking
            const ticketBookings = (allBookings || []).filter(b => b.bus_ticket_id === t.id);
            const actuallyReserved = [];
            
            ticketBookings.forEach(b => {
                try {
                    const seats = typeof b.seat_numbers === 'string' ? JSON.parse(b.seat_numbers || '[]') : (b.seat_numbers || []);
                    if (Array.isArray(seats)) {
                        actuallyReserved.push(...seats);
                    } else if (seats) {
                        actuallyReserved.push(seats);
                    }
                } catch (e) {
                    console.error(`[BusAdmin] Error parsing seat_numbers for booking ${b.id}:`, e);
                }
            });

            // Clean formatting for frontend
            return {
                ...t,
                reserved_seats: [...new Set(actuallyReserved)], // Unique seats
                intermediate_stops: (typeof t.intermediate_stops === 'string' ? JSON.parse(t.intermediate_stops || '[]') : (t.intermediate_stops || [])).map(s => ({
                    ...s,
                    time: s.time ? s.time.substring(0, 5) : s.time
                })),
                departure_time: t.departure_time ? t.departure_time.substring(0, 5) : t.departure_time,
                arrival_time: t.arrival_time ? t.arrival_time.substring(0, 5) : t.arrival_time
            };
        });

        console.log(`[BusAdmin] Successfully returning ${result.length} tickets for carrier ${operatorId}`);
        res.json(result);
    } catch (err) {
        console.error('[BusAdmin] Critical error in /tickets:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * @swagger
 * /api/bus-admin/bookings:
 *   get:
 *     summary: Get bookings on tickets owned by authenticated carrier
 *     tags: [Bus Admin]
 */
router.get('/bookings', async (req, res) => {
    // Trusted carrier ID extracted directly from verified JWT
    const operatorId = req.carrier.carrier_id;

    try {
        console.log(`[BusAdmin] Fetching bookings for carrier: ${operatorId}`);
        // Find tickets for this carrier
        const { data: tickets, error: tErr } = await supabase
            .from('bus_tickets')
            .select('id, from_city, to_city, departure_date, departure_time')
            .eq('operator_id', operatorId);

        if (tErr) {
            console.error('[BusAdmin] Error fetching operator tickets for bookings:', tErr);
            throw tErr;
        }
        
        if (!tickets || tickets.length === 0) {
            console.log(`[BusAdmin] No tickets found, so no bookings to return for carrier ${operatorId}`);
            return res.json([]);
        }

        const ticketIds = req.query.ticket_id 
            ? [parseInt(req.query.ticket_id, 10)]
            : tickets.map(t => t.id);

        // Get bookings for these tickets
        let query = supabase
            .from('bus_ticket_bookings')
            .select(`
                id, bus_ticket_id, passenger_id, seat_numbers, passenger_count, passengers_data, phone, status, total_price, passenger_name, pickup_city, drop_off_city, created_at,
                boarding_status, boarded_at, boarded_by_user_id,
                channel, source_type, source_id, created_by_user_id,
                commission_rate, commission_amount, carrier_amount,
                users:passenger_id (name, phone)
            `)
            .in('bus_ticket_id', ticketIds);

        if (req.query.status) {
            query = query.eq('status', req.query.status);
        } else {
            // Default: exclude cancelled, return confirmed and pending
            query = query.neq('status', 'cancelled');
        }

        const { data: bookings, error: bErr } = await query.order('created_at', { ascending: false });

        if (bErr) {
            console.error('[BusAdmin] Error fetching bookings:', bErr);
            throw bErr;
        }

        const result = (bookings || []).map(b => {
            const ticket = tickets.find(t => t.id === b.bus_ticket_id);
            let parsedSeats = [];
            let parsedPData = [];

            try {
                parsedSeats = typeof b.seat_numbers === 'string' ? JSON.parse(b.seat_numbers || '[]') : (b.seat_numbers || []);
                if (!Array.isArray(parsedSeats)) parsedSeats = parsedSeats ? [parsedSeats] : [];
            } catch (e) { console.error(`Error parsing seat_numbers for booking ${b.id}`, e); }

            try {
                parsedPData = typeof b.passengers_data === 'string' ? JSON.parse(b.passengers_data || '[]') : (b.passengers_data || []);
            } catch (e) { console.error(`Error parsing passengers_data for booking ${b.id}`, e); }

            const isDriver = req.carrier.role === 'driver';
            const channel = b.channel || 'web';
            const sourceType = b.source_type || (channel === 'manual' ? 'manual' : 'platform');
            const isManual = channel === 'manual' || sourceType === 'manual' || sourceType === 'carrier';
            const totalPrice = Number(b.total_price || 0);
            const commRate = Number(b.commission_rate ?? (isManual ? 0 : 10));
            const commAmount = Number(b.commission_amount ?? (isManual ? 0 : Math.round(totalPrice * (commRate / 100))));
            const carrierAmount = Number(b.carrier_amount ?? Math.max(0, totalPrice - commAmount));

            return {
                ...b,
                passenger_name: b.passenger_name || b.users?.name || '—',
                passenger_phone: b.users?.phone || b.phone || '—',
                seat_numbers: parsedSeats,
                passengers_data: parsedPData,
                boarding_status: b.boarding_status || 'pending_boarding',
                boarded_at: b.boarded_at || null,
                boarded_by_user_id: b.boarded_by_user_id || null,
                channel: channel,
                source_type: sourceType,
                source_id: b.source_id || null,
                // Security Projection: Drivers do NOT see financial data
                commission_rate: isDriver ? null : commRate,
                commission_amount: isDriver ? null : commAmount,
                carrier_amount: isDriver ? null : carrierAmount,
                total_price: isDriver ? null : totalPrice,
                ticket_context: ticket ? `${ticket.from_city} -> ${ticket.to_city} (${ticket.departure_date})` : 'Unknown'
            };
        });

        console.log(`[BusAdmin] Successfully returning ${result.length} bookings for carrier ${operatorId}`);
        res.json(result);
    } catch (err) {
        console.error('[BusAdmin] Critical error in /bookings:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * @swagger
 * /api/bus-admin/tickets/{id}:
 *   put:
 *     summary: Update a bus ticket with ownership verification
 *     tags: [Bus Admin]
 */
router.put('/tickets/:id', async (req, res) => {
    const { id } = req.params;
    const updateData = req.body;
    
    // Strict ownership verification
    const hasAccess = await verifyTicketAccess(req.carrier, id);
    if (!hasAccess) {
        return res.status(403).json({ error: 'Доступ запрещен: рейс не принадлежит вашему аккаунту перевозчика' });
    }

    // Remove metadata and ownership fields from updateData
    delete updateData.id;
    delete updateData.created_at;
    delete updateData.operator_id; // prevent changing owner
    const incomingPhotos = updateData.photos;
    delete updateData.photos; // process and attach safely

    try {
        // Fetch existing ticket to compare photos
        const { data: oldTicket } = await supabase.from('bus_tickets').select('photos').eq('id', id).single();
        const oldPhotos = oldTicket?.photos || [];

        if (incomingPhotos !== undefined) {
            let newPhotoResults = [];
            if (incomingPhotos && Array.isArray(incomingPhotos)) {
                for (const photo of incomingPhotos) {
                    if (typeof photo === 'string' && photo.startsWith('data:image')) {
                        try {
                            const r = await uploadToCloudinary(photo, { folder: 'poputki/bus_photos' });
                            newPhotoResults.push({ url: r.url, public_id: r.public_id });
                        } catch(e) { console.error('Cloudinary upload error in PUT:', e); }
                    } else if (typeof photo === 'object' && photo.url && photo.public_id) {
                        // Keep existing photo
                        newPhotoResults.push(photo);
                    }
                }
            }

            const oldPublicIds = oldPhotos.map(p => p.public_id).filter(id => id);
            const newPublicIds = newPhotoResults.map(p => p.public_id).filter(id => id);

            const idsToDelete = oldPublicIds.filter(id => !newPublicIds.includes(id));
            for (const pid of idsToDelete) {
                await deleteFromCloudinary(pid);
            }

            updateData.photos = newPhotoResults;
        }

        const { error } = await supabase
            .from('bus_tickets')
            .update(updateData)
            .eq('id', id);

        if (error) throw error;
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * @swagger
 * /api/bus-admin/tickets/{id}:
 *   delete:
 *     summary: Delete a bus ticket with ownership verification
 *     tags: [Bus Admin]
 */
router.delete('/tickets/:id', async (req, res) => {
    const { id } = req.params;

    // Strict ownership verification
    const hasAccess = await verifyTicketAccess(req.carrier, id);
    if (!hasAccess) {
        return res.status(403).json({ error: 'Доступ запрещен: рейс не принадлежит вашему аккаунту перевозчика' });
    }

    try {
        // Fetch to get photos before deleting
        const { data: ticket } = await supabase.from('bus_tickets').select('photos').eq('id', id).single();
        const photos = ticket?.photos || [];

        const { error } = await supabase
            .from('bus_tickets')
            .delete()
            .eq('id', id);

        if (error) throw error;

        // Cleanup cloudinary
        for (const photo of photos) {
            if (photo && photo.public_id) {
                await deleteFromCloudinary(photo.public_id);
            }
        }

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * @swagger
 * /api/bus-admin/bookings/manual:
 *   post:
 *     summary: Create a manual booking (by authenticated carrier)
 *     tags: [Bus Admin]
 */
router.post('/bookings/manual', async (req, res) => {
    const { bus_ticket_id, seat_numbers, passengers_data, phone, passenger_name, pickup_city, drop_off_city } = req.body;

    if (!bus_ticket_id) {
        return res.status(400).json({ error: 'Необходимо указать bus_ticket_id' });
    }

    // Strict ownership verification
    const hasAccess = await verifyTicketAccess(req.carrier, bus_ticket_id);
    if (!hasAccess) {
        return res.status(403).json({ error: 'Доступ запрещен: рейс не принадлежит вашему аккаунту перевозчика' });
    }

    try {
        const { data: ticket, error: tErr } = await supabase
            .from('bus_tickets')
            .select('*')
            .eq('id', bus_ticket_id)
            .single();

        if (tErr || !ticket) return res.status(404).json({ error: 'Рейс не найден' });

        // Check if seats are already taken
        const reserved = typeof ticket.reserved_seats === 'string' ? JSON.parse(ticket.reserved_seats || '[]') : (ticket.reserved_seats || []);
        const conflict = (seat_numbers || []).some(s => reserved.includes(s));
        if (conflict) return res.status(400).json({ error: 'Одно или несколько мест уже заняты' });

        // Calculate full fare matching online booking pricing logic (including premium seats)
        const premiumSeatNums = ticket.bus_type === 'double' ? [1, 2, 3, 4, 69, 70, 71, 72, 73, 74, 75, 76] : [];
        const premiumPrice = Number(ticket.premium_price || ticket.price || 0);
        const standardPrice = Number(ticket.price || 0);

        let manualTotalPrice = 0;
        for (const seatNum of (seat_numbers || [])) {
            manualTotalPrice += premiumSeatNums.includes(Number(seatNum)) ? premiumPrice : standardPrice;
        }

        const commissionRate = 0;
        const commissionAmount = 0;
        const carrierAmount = manualTotalPrice;

        // Insert booking with authenticated carrier as manager and complete financial snapshot
        const { data: booking, error: bErr } = await supabase
            .from('bus_ticket_bookings')
            .insert([{
                bus_ticket_id,
                passenger_id: req.carrier.user_id, // Authenticated carrier manager
                seat_numbers,
                passenger_count: (seat_numbers || []).length,
                passengers_data,
                phone,
                status: 'confirmed',
                total_price: manualTotalPrice,
                commission_rate: commissionRate,
                commission_amount: commissionAmount,
                carrier_amount: carrierAmount,
                passenger_name: passenger_name,
                pickup_city,
                drop_off_city,
                channel: 'manual',
                source_type: 'manual',
                source_id: String(req.carrier.carrier_id || req.carrier.id),
                created_by_user_id: req.carrier.user_id
            }])
            .select('id')
            .single();

        if (bErr) throw bErr;

        // Update ticket reserved seats
        const newReserved = [...reserved, ...(seat_numbers || [])];
        await supabase
            .from('bus_tickets')
            .update({ reserved_seats: newReserved })
            .eq('id', bus_ticket_id);

        res.json({ success: true, id: booking.id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * @swagger
 * /api/bus-admin/bookings/{id}:
 *   put:
 *     summary: Update an existing booking with ownership verification
 *     tags: [Bus Admin]
 */
router.put('/bookings/:id', async (req, res) => {
    const { id } = req.params;
    const { seat_numbers, passengers_data, phone, passenger_name, pickup_city, drop_off_city } = req.body;

    try {
        // 1. Get the current booking to know old seats and ticket_id
        const { data: oldBooking, error: obErr } = await supabase
            .from('bus_ticket_bookings')
            .select('*')
            .eq('id', id)
            .single();

        if (obErr || !oldBooking) return res.status(404).json({ error: 'Бронирование не найдено' });

        const ticketId = oldBooking.bus_ticket_id;

        // Strict ownership verification: verify the booking's ticket belongs to current carrier
        const hasAccess = await verifyTicketAccess(req.carrier, ticketId);
        if (!hasAccess) {
            return res.status(403).json({ error: 'Доступ запрещен: бронирование принадлежит рейсу другого перевозчика' });
        }

        const { data: ticket, error: tErr } = await supabase
            .from('bus_tickets')
            .select('*')
            .eq('id', ticketId)
            .single();

        if (tErr) throw tErr;

        const seatsChanged = JSON.stringify(oldBooking.seat_numbers) !== JSON.stringify(seat_numbers);

        // 2. If seats changed, check for conflicts and update ticket.reserved_seats
        if (seatsChanged) {
            const reserved = typeof ticket.reserved_seats === 'string' ? JSON.parse(ticket.reserved_seats || '[]') : (ticket.reserved_seats || []);
            
            // Remove old seats from the reserved list
            const withoutOld = reserved.filter(s => !(oldBooking.seat_numbers || []).includes(s));
            
            // Check for conflicts with new seats (excluding the seats we just "released")
            const conflict = (seat_numbers || []).some(s => withoutOld.includes(s));
            if (conflict) return res.status(400).json({ error: 'Одно или несколько выбранных мест уже заняты' });

            const newReserved = [...withoutOld, ...(seat_numbers || [])];

            // Update ticket
            await supabase
                .from('bus_tickets')
                .update({ reserved_seats: newReserved })
                .eq('id', ticketId);
        }

        const updatePayload = {
            seat_numbers,
            passenger_count: (seat_numbers || []).length,
            passengers_data,
            phone,
            passenger_name,
            pickup_city,
            drop_off_city
        };

        // Snapshot Safety Guard:
        // Only recalculate financial snapshot if seat_numbers actually changed on a manual booking with existing non-zero snapshot
        const isManual = oldBooking.channel === 'manual' || oldBooking.source_type === 'manual' || oldBooking.source_type === 'carrier';
        if (seatsChanged && isManual && oldBooking.total_price > 0 && ticket) {
            const premiumSeatNums = ticket.bus_type === 'double' ? [1, 2, 3, 4, 69, 70, 71, 72, 73, 74, 75, 76] : [];
            const premiumPrice = Number(ticket.premium_price || ticket.price || 0);
            const standardPrice = Number(ticket.price || 0);

            let newTotalPrice = 0;
            for (const seatNum of (seat_numbers || [])) {
                newTotalPrice += premiumSeatNums.includes(Number(seatNum)) ? premiumPrice : standardPrice;
            }
            updatePayload.total_price = newTotalPrice;
            updatePayload.commission_rate = 0;
            updatePayload.commission_amount = 0;
            updatePayload.carrier_amount = newTotalPrice;
        }

        // 3. Update the booking record
        const { error: updateErr } = await supabase
            .from('bus_ticket_bookings')
            .update(updatePayload)
            .eq('id', id);

        if (updateErr) throw updateErr;

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * @swagger
 * /api/bus-admin/bookings/{id}:
 *   delete:
 *     summary: Delete a bus booking and release seats with ownership verification
 *     tags: [Bus Admin]
 */
router.delete('/bookings/:id', async (req, res) => {
    const { id } = req.params;

    try {
        // 1. Get the booking to know which seats to release and which ticket it belongs to
        const { data: booking, error: bErr } = await supabase
            .from('bus_ticket_bookings')
            .select('bus_ticket_id, seat_numbers')
            .eq('id', id)
            .single();

        if (bErr || !booking) return res.status(404).json({ error: 'Бронирование не найдено' });

        const ticketId = booking.bus_ticket_id;

        // Strict ownership verification: verify the booking's ticket belongs to current carrier
        const hasAccess = await verifyTicketAccess(req.carrier, ticketId);
        if (!hasAccess) {
            return res.status(403).json({ error: 'Доступ запрещен: бронирование принадлежит рейсу другого перевозчика' });
        }

        const seatsToRelease = typeof booking.seat_numbers === 'string' ? JSON.parse(booking.seat_numbers || '[]') : (booking.seat_numbers || []);

        // 2. Delete the booking
        const { error: delErr } = await supabase
            .from('bus_ticket_bookings')
            .delete()
            .eq('id', id);

        if (delErr) throw delErr;

        // 3. Release the seats in the bus_tickets table
        const { data: ticket, error: tErr } = await supabase
            .from('bus_tickets')
            .select('reserved_seats')
            .eq('id', ticketId)
            .single();

        if (!tErr && ticket) {
            const reserved = typeof ticket.reserved_seats === 'string' ? JSON.parse(ticket.reserved_seats || '[]') : (ticket.reserved_seats || []);
            const newReserved = reserved.filter(s => !seatsToRelease.includes(s));

            await supabase
                .from('bus_tickets')
                .update({ reserved_seats: newReserved })
                .eq('id', ticketId);
        }

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * @swagger
 * /api/bus-admin/bookings/{id}/boarding:
 *   patch:
 *     summary: Update passenger boarding status (pending_boarding, boarded, no_show)
 *     tags: [Bus Admin]
 */
router.patch('/bookings/:id/boarding', async (req, res) => {
    const { id } = req.params;
    const { boarding_status } = req.body;

    const allowedStatuses = ['pending_boarding', 'boarded', 'no_show'];
    if (!boarding_status || !allowedStatuses.includes(boarding_status)) {
        return res.status(400).json({ 
            error: 'Недопустимый статус посадки. Допустимы: pending_boarding, boarded, no_show' 
        });
    }

    try {
        // 1. Fetch booking to verify ticket ownership and access
        const { data: booking, error: bErr } = await supabase
            .from('bus_ticket_bookings')
            .select('id, bus_ticket_id, boarding_status, status')
            .eq('id', id)
            .maybeSingle();

        if (bErr || !booking) {
            return res.status(404).json({ error: 'Бронирование не найдено' });
        }

        const ticketId = booking.bus_ticket_id;

        // 2. Strict tenant isolation & role access verification (handles owners, dispatchers, and assigned drivers)
        const hasAccess = await verifyTicketAccess(req.carrier, ticketId);
        if (!hasAccess) {
            return res.status(403).json({ 
                error: 'Доступ запрещен: рейс не принадлежит вашему аккаунту перевозчика или не назначен вам' 
            });
        }

        const oldStatus = booking.boarding_status || 'pending_boarding';
        const authenticatedUserId = req.carrier.user_id;
        const now = new Date().toISOString();

        // 3. Prepare payload according to status model
        const updatePayload = {
            boarding_status: boarding_status,
            boarded_at: boarding_status === 'boarded' ? now : null,
            boarded_by_user_id: authenticatedUserId
        };

        const { data: updatedBooking, error: uErr } = await supabase
            .from('bus_ticket_bookings')
            .update(updatePayload)
            .eq('id', id)
            .select('id, bus_ticket_id, boarding_status, boarded_at, boarded_by_user_id')
            .single();

        if (uErr) {
            console.error('[BusAdmin Boarding] Update error:', uErr);
            throw uErr;
        }

        // 4. Log change in booking_audit_logs table
        try {
            await supabase
                .from('booking_audit_logs')
                .insert([{
                    booking_id: booking.id,
                    action: 'boarding_status_update',
                    old_status: oldStatus,
                    new_status: boarding_status,
                    performed_by_user_id: authenticatedUserId,
                    details: {
                        previous_boarding_status: oldStatus,
                        new_boarding_status: boarding_status,
                        boarded_at: updatePayload.boarded_at,
                        carrier_id: req.carrier.carrier_id,
                        carrier_role: req.carrier.role
                    }
                }]);
        } catch (auditErr) {
            console.error('[BusAdmin Boarding] Audit log insertion error (non-fatal):', auditErr);
        }

        res.json({
            success: true,
            booking: updatedBooking
        });
    } catch (err) {
        console.error('[BusAdmin Boarding] Fatal error:', err);
        res.status(500).json({ error: err.message || 'Ошибка обновления статуса посадки' });
    }
});

/**
 * @swagger
 * /api/bus-admin/tickets/{ticketId}/summary:
 *   get:
 *     summary: Get trip financial and operational summary for a specific bus ticket
 *     tags: [Bus Admin]
 */
router.get('/tickets/:ticketId/summary', async (req, res) => {
    const { ticketId } = req.params;

    // Security Gate: Drivers MUST NOT access financial summary
    if (req.carrier.role === 'driver') {
        return res.status(403).json({ 
            error: 'Доступ к финансовым данным рейса запрещен для роли водителя' 
        });
    }

    try {
        // 1. Fetch ticket and verify carrier ownership / dispatcher access
        const { data: ticket, error: tErr } = await supabase
            .from('bus_tickets')
            .select('*')
            .eq('id', ticketId)
            .maybeSingle();

        if (tErr || !ticket) {
            return res.status(404).json({ error: 'Рейс не найден' });
        }

        const hasAccess = await verifyTicketAccess(req.carrier, ticketId);
        if (!hasAccess) {
            return res.status(403).json({ 
                error: 'Доступ запрещен: рейс не принадлежит вашему аккаунту перевозчика' 
            });
        }

        // 2. Fetch all bookings on this ticket
        const { data: bookings, error: bErr } = await supabase
            .from('bus_ticket_bookings')
            .select(`
                id, bus_ticket_id, passenger_id, seat_numbers, passenger_count, passengers_data, phone, status, total_price, passenger_name, pickup_city, drop_off_city, created_at,
                boarding_status, boarded_at, boarded_by_user_id,
                channel, source_type, source_id, created_by_user_id,
                commission_rate, commission_amount, carrier_amount
            `)
            .eq('bus_ticket_id', ticketId);

        if (bErr) {
            console.error('[BusAdmin Ticket Summary] Error fetching bookings:', bErr);
            throw bErr;
        }

        const capacity = ticket.total_seats || 53;
        const allBookings = bookings || [];

        // Count unique booked seats from non-cancelled bookings
        const activeBookings = allBookings.filter(b => b.status !== 'cancelled');
        const uniqueReservedSeats = new Set();

        activeBookings.forEach(b => {
            let seats = [];
            try {
                seats = typeof b.seat_numbers === 'string' ? JSON.parse(b.seat_numbers || '[]') : (b.seat_numbers || []);
                if (!Array.isArray(seats)) seats = seats ? [seats] : [];
            } catch(e) { }
            seats.forEach(s => uniqueReservedSeats.add(s));
        });

        const bookedSeatsCount = uniqueReservedSeats.size;
        const freeSeatsCount = Math.max(0, capacity - bookedSeatsCount);
        const fillRate = capacity > 0 ? parseFloat(((bookedSeatsCount / capacity) * 100).toFixed(1)) : 0;

        // Categorize bookings
        const confirmedBookings = allBookings.filter(b => b.status === 'confirmed');
        const pendingBookings = allBookings.filter(b => b.status === 'pending_payment');
        const cancelledBookings = allBookings.filter(b => b.status === 'cancelled');

        const onlineBookings = confirmedBookings.filter(b => b.channel !== 'manual' && b.source_type !== 'manual');
        const manualBookings = confirmedBookings.filter(b => b.channel === 'manual' || b.source_type === 'manual' || b.source_type === 'carrier');

        // Financial aggregations based on historical snapshots
        let paidAmount = 0;
        let serviceCommission = 0;
        let carrierAmount = 0;
        let unpaidAmount = 0;

        // 1. Confirmed bookings (actual completed payments / confirmed manual)
        confirmedBookings.forEach(b => {
            const totalPrice = Number(b.total_price || 0);
            const isManual = b.channel === 'manual' || b.source_type === 'manual' || b.source_type === 'carrier';
            
            paidAmount += totalPrice;

            if (isManual) {
                // 0% platform fee for carrier's manual bookings
                carrierAmount += totalPrice;
            } else {
                // Online booking: use snapshot commission_amount or calculate from snapshot commission_rate
                const commRate = Number(b.commission_rate ?? 10);
                const comm = Number(b.commission_amount > 0 ? b.commission_amount : Math.round(totalPrice * (commRate / 100)));
                serviceCommission += comm;
                carrierAmount += Math.max(0, totalPrice - comm);
            }
        });

        // 2. Pending payment bookings (money awaiting payment)
        pendingBookings.forEach(b => {
            unpaidAmount += Number(b.total_price || 0);
        });

        // 3. Gross amount represents confirmed sales (or total expected)
        const grossAmount = paidAmount;

        // Boarding counters across confirmed passengers
        let boardingPending = 0;
        let boardingBoarded = 0;
        let boardingNoShow = 0;

        confirmedBookings.forEach(b => {
            const count = b.passenger_count || (Array.isArray(b.passengers_data) ? b.passengers_data.length : 1) || 1;
            const bStatus = b.boarding_status || 'pending_boarding';
            if (bStatus === 'boarded') {
                boardingBoarded += count;
            } else if (bStatus === 'no_show') {
                boardingNoShow += count;
            } else {
                boardingPending += count;
            }
        });

        const totalPassengers = boardingPending + boardingBoarded + boardingNoShow;

        res.json({
            ticket_id: ticket.id,
            from_city: ticket.from_city,
            to_city: ticket.to_city,
            departure_date: ticket.departure_date,
            departure_time: ticket.departure_time,
            price: ticket.price,
            currency: 'сомони',

            capacity: capacity,
            booked_seats: bookedSeatsCount,
            free_seats: freeSeatsCount,
            fill_rate: fillRate,

            bookings_total: allBookings.length,
            confirmed_bookings: confirmedBookings.length,
            pending_bookings: pendingBookings.length,
            cancelled_bookings: cancelledBookings.length,

            online_bookings: onlineBookings.length,
            manual_bookings: manualBookings.length,

            gross_amount: grossAmount,
            paid_amount: paidAmount,
            unpaid_amount: unpaidAmount,

            service_commission: serviceCommission,
            carrier_amount: carrierAmount,

            boarding: {
                total_passengers: totalPassengers,
                pending: boardingPending,
                boarded: boardingBoarded,
                no_show: boardingNoShow
            }
        });
    } catch (err) {
        console.error('[BusAdmin Ticket Summary] Fatal error:', err);
        res.status(500).json({ error: err.message || 'Ошибка получения финансовой сводки рейса' });
    }
});

/**
 * @swagger
 * /api/bus-admin/finance:
 *   get:
 *     summary: Get carrier financial report, settlements and trip breakdown by period
 *     tags: [Bus Admin]
 */
router.get('/finance', async (req, res) => {
    // Security Gate 1: Drivers MUST NOT access financial reports
    if (req.carrier.role === 'driver') {
        return res.status(403).json({ 
            error: 'Доступ к финансовому разделу запрещен для роли водителя' 
        });
    }

    const operatorId = req.carrier.carrier_id;

    try {
        // Parse date range (default to current month if omitted)
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const defaultFrom = `${year}-${month}-01`;
        const lastDay = new Date(year, now.getMonth() + 1, 0).getDate();
        const defaultTo = `${year}-${month}-${String(lastDay).padStart(2, '0')}`;

        const fromDate = req.query.from || defaultFrom;
        const toDate = req.query.to || defaultTo;

        // 1. Fetch carrier tickets for the period
        let tQuery = supabase
            .from('bus_tickets')
            .select('id, operator_id, from_city, to_city, departure_date, departure_time, price, total_seats, status')
            .eq('operator_id', operatorId)
            .gte('departure_date', fromDate)
            .lte('departure_date', toDate);

        if (req.query.ticket_id) {
            tQuery = tQuery.eq('id', req.query.ticket_id);
        }

        const { data: tickets, error: tErr } = await tQuery.order('departure_date', { ascending: false });

        if (tErr) {
            console.error('[BusAdmin Finance] Error fetching tickets:', tErr);
            throw tErr;
        }

        const periodTickets = tickets || [];
        const ticketIds = periodTickets.map(t => t.id);

        if (ticketIds.length === 0) {
            return res.json({
                period: { from: fromDate, to: toDate },
                totals: {
                    confirmed_gross: 0,
                    pending_amount: 0,
                    service_commission: 0,
                    carrier_amount: 0,
                    online_amount: 0,
                    manual_amount: 0,
                    online_bookings: 0,
                    manual_bookings: 0,
                    refunds_amount: 0,
                    refund_needed_amount: 0
                },
                booking_counts: {
                    confirmed: 0,
                    pending_payment: 0,
                    cancelled: 0,
                    refund_needed: 0
                },
                boarding: {
                    total: 0,
                    boarded: 0,
                    pending: 0,
                    no_show: 0
                },
                source_breakdown: [],
                trips: []
            });
        }

        // 2. Fetch all bookings for these tickets
        const { data: bookings, error: bErr } = await supabase
            .from('bus_ticket_bookings')
            .select(`
                id, bus_ticket_id, passenger_id, seat_numbers, passenger_count, passengers_data, phone, status, total_price, passenger_name, pickup_city, drop_off_city, created_at,
                boarding_status, boarded_at, boarded_by_user_id,
                channel, source_type, source_id, created_by_user_id,
                commission_rate, commission_amount, carrier_amount
            `)
            .in('bus_ticket_id', ticketIds);

        if (bErr) {
            console.error('[BusAdmin Finance] Error fetching bookings:', bErr);
            throw bErr;
        }

        const allBookings = bookings || [];

        // Source classification buckets
        const sourceMap = {
            web: { key: 'web', label: 'Платформа (Web)', count: 0, gross: 0, commission: 0, carrier_amount: 0 },
            telegram: { key: 'telegram', label: 'Telegram Bot', count: 0, gross: 0, commission: 0, carrier_amount: 0 },
            carrier_link: { key: 'carrier_link', label: 'Ссылка перевозчика', count: 0, gross: 0, commission: 0, carrier_amount: 0 },
            partner_link: { key: 'partner_link', label: 'Партнерская ссылка', count: 0, gross: 0, commission: 0, carrier_amount: 0 },
            manual: { key: 'manual', label: 'Ручная бронь', count: 0, gross: 0, commission: 0, carrier_amount: 0 },
            legacy_unknown: { key: 'legacy_unknown', label: 'Legacy / Неизвестно', count: 0, gross: 0, commission: 0, carrier_amount: 0 }
        };

        let totalConfirmedGross = 0;
        let totalPendingAmount = 0;
        let totalServiceCommission = 0;
        let totalCarrierAmount = 0;
        let totalOnlineAmount = 0;
        let totalManualAmount = 0;
        let totalOnlineBookings = 0;
        let totalManualBookings = 0;

        let countConfirmed = 0;
        let countPending = 0;
        let countCancelled = 0;

        let boardingTotal = 0;
        let boardingBoarded = 0;
        let boardingPending = 0;
        let boardingNoShow = 0;

        // Process trip breakdowns
        const trips = periodTickets.map(ticket => {
            const tripBookings = allBookings.filter(b => b.bus_ticket_id === ticket.id);
            const capacity = ticket.total_seats || 53;

            const confirmedBookings = tripBookings.filter(b => b.status === 'confirmed');
            const pendingBookings = tripBookings.filter(b => b.status === 'pending_payment');
            const cancelledBookings = tripBookings.filter(b => b.status === 'cancelled');

            // Unique occupied seats for non-cancelled
            const activeBookings = tripBookings.filter(b => b.status !== 'cancelled');
            const uniqueSeats = new Set();
            activeBookings.forEach(b => {
                let seats = [];
                try {
                    seats = typeof b.seat_numbers === 'string' ? JSON.parse(b.seat_numbers || '[]') : (b.seat_numbers || []);
                    if (!Array.isArray(seats)) seats = seats ? [seats] : [];
                } catch(e) {}
                seats.forEach(s => uniqueSeats.add(s));
            });

            const bookedSeatsCount = uniqueSeats.size;
            const freeSeatsCount = Math.max(0, capacity - bookedSeatsCount);
            const fillRate = capacity > 0 ? parseFloat(((bookedSeatsCount / capacity) * 100).toFixed(1)) : 0;

            let tripConfirmedGross = 0;
            let tripPendingAmount = 0;
            let tripServiceCommission = 0;
            let tripCarrierAmount = 0;
            let tripOnlineBookings = 0;
            let tripManualBookings = 0;

            let tripBoarded = 0;
            let tripPending = 0;
            let tripNoShow = 0;

            // Aggregate confirmed bookings for this trip
            confirmedBookings.forEach(b => {
                const totalPrice = Number(b.total_price || 0);
                const isManual = b.channel === 'manual' || b.source_type === 'manual' || b.source_type === 'carrier';
                const commRate = Number(b.commission_rate ?? (isManual ? 0 : 10));
                const commAmount = Number(b.commission_amount > 0 ? b.commission_amount : (isManual ? 0 : Math.round(totalPrice * (commRate / 100))));
                const carrierAmount = Number(b.carrier_amount > 0 ? b.carrier_amount : Math.max(0, totalPrice - commAmount));

                tripConfirmedGross += totalPrice;
                tripServiceCommission += commAmount;
                tripCarrierAmount += carrierAmount;

                if (isManual) {
                    tripManualBookings += 1;
                    totalManualAmount += totalPrice;
                    totalManualBookings += 1;
                } else {
                    tripOnlineBookings += 1;
                    totalOnlineAmount += totalPrice;
                    totalOnlineBookings += 1;
                }

                // Source breakdown attribution
                let sKey = 'legacy_unknown';
                if (isManual) sKey = 'manual';
                else if (b.source_type === 'carrier_link') sKey = 'carrier_link';
                else if (b.source_type === 'partner_link') sKey = 'partner_link';
                else if (b.channel === 'telegram') sKey = 'telegram';
                else if (b.channel === 'web' || b.source_type === 'platform') sKey = 'web';

                sourceMap[sKey].count += 1;
                sourceMap[sKey].gross += totalPrice;
                sourceMap[sKey].commission += commAmount;
                sourceMap[sKey].carrier_amount += carrierAmount;

                // Boarding count
                const pCount = b.passenger_count || (Array.isArray(b.passengers_data) ? b.passengers_data.length : 1) || 1;
                const bStatus = b.boarding_status || 'pending_boarding';
                if (bStatus === 'boarded') {
                    tripBoarded += pCount;
                } else if (bStatus === 'no_show') {
                    tripNoShow += pCount;
                } else {
                    tripPending += pCount;
                }
            });

            // Pending bookings
            pendingBookings.forEach(b => {
                tripPendingAmount += Number(b.total_price || 0);
            });

            // Accumulate to overall totals
            totalConfirmedGross += tripConfirmedGross;
            totalPendingAmount += tripPendingAmount;
            totalServiceCommission += tripServiceCommission;
            totalCarrierAmount += tripCarrierAmount;

            countConfirmed += confirmedBookings.length;
            countPending += pendingBookings.length;
            countCancelled += cancelledBookings.length;

            boardingBoarded += tripBoarded;
            boardingPending += tripPending;
            boardingNoShow += tripNoShow;
            boardingTotal += (tripBoarded + tripPending + tripNoShow);

            return {
                ticket_id: ticket.id,
                from_city: ticket.from_city,
                to_city: ticket.to_city,
                departure_date: ticket.departure_date,
                departure_time: ticket.departure_time,
                price: ticket.price,
                capacity: capacity,
                booked_seats: bookedSeatsCount,
                free_seats: freeSeatsCount,
                fill_rate: fillRate,

                confirmed_gross: tripConfirmedGross,
                service_commission: tripServiceCommission,
                carrier_amount: tripCarrierAmount,
                pending_amount: tripPendingAmount,

                bookings_total: tripBookings.length,
                confirmed_bookings: confirmedBookings.length,
                pending_bookings: pendingBookings.length,
                cancelled_bookings: cancelledBookings.length,

                online_bookings: tripOnlineBookings,
                manual_bookings: tripManualBookings,

                boarding: {
                    total: tripBoarded + tripPending + tripNoShow,
                    boarded: tripBoarded,
                    pending: tripPending,
                    no_show: tripNoShow
                }
            };
        });

        const sourceBreakdownList = Object.values(sourceMap).filter(s => s.count > 0);

        res.json({
            period: {
                from: fromDate,
                to: toDate
            },
            totals: {
                confirmed_gross: totalConfirmedGross,
                pending_amount: totalPendingAmount,
                service_commission: totalServiceCommission,
                carrier_amount: totalCarrierAmount,
                online_amount: totalOnlineAmount,
                manual_amount: totalManualAmount,
                online_bookings: totalOnlineBookings,
                manual_bookings: totalManualBookings,
                refunds_amount: 0,
                refund_needed_amount: 0
            },
            booking_counts: {
                confirmed: countConfirmed,
                pending_payment: countPending,
                cancelled: countCancelled,
                refund_needed: 0
            },
            boarding: {
                total: boardingTotal,
                boarded: boardingBoarded,
                pending: boardingPending,
                no_show: boardingNoShow
            },
            source_breakdown: sourceBreakdownList,
            trips: trips
        });

    } catch (err) {
        console.error('[BusAdmin Finance] Fatal error in /finance:', err);
        res.status(500).json({ error: err.message || 'Ошибка формирования финансового отчета' });
    }
});

module.exports = router;
