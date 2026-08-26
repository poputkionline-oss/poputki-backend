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

        const ticketIds = tickets.map(t => t.id);

        // Get bookings for these tickets
        const { data: bookings, error: bErr } = await supabase
            .from('bus_ticket_bookings')
            .select(`
                id, bus_ticket_id, passenger_id, seat_numbers, passenger_count, passengers_data, phone, status, total_price, passenger_name, pickup_city, drop_off_city, created_at,
                boarding_status, boarded_at, boarded_by_user_id,
                users:passenger_id (name, phone)
            `)
            .in('bus_ticket_id', ticketIds)
            .eq('status', 'confirmed')
            .order('created_at', { ascending: false });

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

            return {
                ...b,
                passenger_name: b.passenger_name || b.users?.name || '—',
                passenger_phone: b.users?.phone || b.phone || '—',
                seat_numbers: parsedSeats,
                passengers_data: parsedPData,
                boarding_status: b.boarding_status || 'pending_boarding',
                boarded_at: b.boarded_at || null,
                boarded_by_user_id: b.boarded_by_user_id || null,
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

        // Insert booking with authenticated carrier as manager
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
                total_price: 0, // Manual booking
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

        // 2. If seats changed, check for conflicts and update ticket.reserved_seats
        if (JSON.stringify(oldBooking.seat_numbers) !== JSON.stringify(seat_numbers)) {
            const { data: ticket, error: tErr } = await supabase
                .from('bus_tickets')
                .select('reserved_seats')
                .eq('id', ticketId)
                .single();

            if (tErr) throw tErr;

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

        // 3. Update the booking record
        const { error: updateErr } = await supabase
            .from('bus_ticket_bookings')
            .update({
                seat_numbers,
                passenger_count: (seat_numbers || []).length,
                passengers_data,
                phone,
                passenger_name,
                pickup_city,
                drop_off_city
            })
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

module.exports = router;
