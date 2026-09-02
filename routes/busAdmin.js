const express = require('express');
const router = express.Router();
const supabase = require('../db');
const { uploadToCloudinary, deleteFromCloudinary } = require('../utils/cloudinaryUtils');
const { carrierAuth, verifyTicketAccess } = require('../utils/carrierAuth');
const { aggregateCarrierCustomers, getCustomerDetails } = require('../utils/crmHelper');
const { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES, logCarrierActivity } = require('../utils/auditHelper');
const {
    getBusinessLocalDate,
    getBusinessLocalTime,
    buildTodaySummary,
    detectAttentionItems,
    buildUpcomingTripsList
} = require('../utils/dashboardHelper');
const {
    isSeatLockedByBooking,
    isPendingHoldActive,
    expirePendingPaymentBookings
} = require('../utils/paymentExpirationHelper');
const {
    validateBusPayload,
    checkDuplicatePlate,
    verifyBusAccess,
    getBusActiveTickets,
    validateBusReplacement
} = require('../utils/busHelper');
const {
    buildPassengerTicketProjection,
    buildTripPrintManifest,
    verifyTicketToken,
    extractBookingIdFromToken
} = require('../utils/ticketHelper');
const { isValidPhone, cleanPhoneForStorage } = require('../utils/phoneHelper');
const { completeTrip } = require('../utils/tripCompletionHelper');



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

        // Filter tickets if role is driver
        let filteredTickets = tickets;
        if (req.carrier.role === 'driver') {
            const assigned = Array.isArray(req.carrier.assignedTicketIds) ? req.carrier.assignedTicketIds : [];
            filteredTickets = tickets.filter(t => assigned.includes(t.id));
        }

        if (filteredTickets.length === 0) {
            return res.json([]);
        }

        // Fetch all relevant bookings to calculate accurate reserved seats and seat gender metadata (including active pending_payment)
        const ticketIds = filteredTickets.map(t => t.id);
        const { data: allBookings, error: bErr } = await supabase
            .from('bus_ticket_bookings')
            .select('id, bus_ticket_id, seat_numbers, status, created_at, hold_expires_at, passengers_data')
            .in('bus_ticket_id', ticketIds)
            .neq('status', 'cancelled');

        if (bErr) {
            console.error('[BusAdmin] Error fetching bookings for tickets:', bErr);
        }

        const result = tickets.map(t => {
            // We count 'confirmed' and active 'pending_payment' as reserved to prevent double booking
            const ticketBookings = (allBookings || []).filter(b => b.bus_ticket_id === t.id);
            const actuallyReserved = [];
            const seatGenders = {};
            
            ticketBookings.forEach(b => {
                if (isSeatLockedByBooking(b)) {
                    try {
                        const seats = typeof b.seat_numbers === 'string' ? JSON.parse(b.seat_numbers || '[]') : (b.seat_numbers || []);
                        const pData = typeof b.passengers_data === 'string' ? JSON.parse(b.passengers_data || '[]') : (b.passengers_data || []);
                        if (Array.isArray(seats)) {
                            actuallyReserved.push(...seats);
                            seats.forEach((seatNum, idx) => {
                                const num = Number(seatNum);
                                const g = pData[idx]?.gender;
                                if (!isNaN(num) && (g === 'male' || g === 'female')) {
                                    seatGenders[num] = g;
                                }
                            });
                        } else if (seats) {
                            actuallyReserved.push(seats);
                            const num = Number(seats);
                            const g = pData[0]?.gender;
                            if (!isNaN(num) && (g === 'male' || g === 'female')) {
                                seatGenders[num] = g;
                            }
                        }
                    } catch (e) {
                        console.error(`[BusAdmin] Error parsing seat_numbers for booking ${b.id}:`, e);
                    }
                }
            });


            // Clean formatting for frontend
            return {
                ...t,
                reserved_seats: [...new Set(actuallyReserved)], // Unique seats
                seat_genders: seatGenders,
                seatGenders: seatGenders,
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
                claim_status, claimed_by_user_id, contact_role,
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
                claim_status: b.claim_status || 'unclaimed',
                claimed_by_user_id: b.claimed_by_user_id || null,
                contact_role: b.contact_role || 'passenger',
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
    // Security Gate: Drivers and Accountants cannot edit tickets
    if (req.carrier.role === 'driver' || req.carrier.role === 'accountant') {
        return res.status(403).json({ error: 'Недостаточно прав для изменения рейсов' });
    }

    const { id } = req.params;
    const updateData = { ...req.body };
    const allowBusConflict = Boolean(updateData.allow_bus_conflict);
    delete updateData.allow_bus_conflict;
    
    // Strict ownership verification
    const hasAccess = await verifyTicketAccess(req.carrier, id);
    if (!hasAccess) {
        return res.status(403).json({ error: 'Доступ запрещен: рейс не принадлежит вашему аккаунту перевозчика' });
    }

    // Remove metadata and ownership fields from updateData
    delete updateData.id;
    delete updateData.created_at;
    delete updateData.operator_id; // prevent changing owner

    try {
        // Fetch existing ticket to compare photos and audit diff
        const { data: oldTicket, error: otErr } = await supabase.from('bus_tickets').select('*').eq('id', id).single();
        if (otErr || !oldTicket) {
            return res.status(404).json({ error: 'Рейс не найден' });
        }
        const oldPhotos = oldTicket?.photos || [];

        // Check if bus replacement / assignment is requested
        // Check if bus replacement / assignment is requested
        let busReplaced = false;
        let newBusMaster = null;
        if (updateData.bus_id !== undefined) {
            const replacement = await validateBusReplacement(
                supabase,
                req.carrier,
                id,
                updateData.bus_id,
                { allowConflict: allowBusConflict }
            );

            if (!replacement.valid) {
                return res.status(replacement.status || 400).json({
                    error: replacement.error,
                    message: replacement.message,
                    conflicts: replacement.conflicts,
                    activeBookingCount: replacement.activeBookingCount
                });
            }

            if (!replacement.noOp && replacement.snapshot) {
                busReplaced = true;
                newBusMaster = replacement.newBus;
                // Apply authoritative vehicle snapshot from carrier_buses master
                updateData.bus_id = replacement.snapshot.bus_id;
                updateData.bus_type = replacement.snapshot.bus_type;
                updateData.total_seats = replacement.snapshot.total_seats;
                updateData.floor1_seats = replacement.snapshot.floor1_seats;
                updateData.floor2_seats = replacement.snapshot.floor2_seats;
                updateData.photos = replacement.snapshot.photos;
            }
        }

        const incomingPhotos = updateData.photos;
        if (incomingPhotos !== undefined && !busReplaced) {
            delete updateData.photos; // process and attach safely
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

        // If bus was replaced via RPC, snapshot was already written atomically by RPC.
        // Update any remaining ticket fields (route, dates, price, etc.)
        const { error } = await supabase
            .from('bus_tickets')
            .update(updateData)
            .eq('id', id);

        if (error) throw error;

        // Audit log ticket update
        await logCarrierActivity({
            supabase,
            carrierContext: req.carrier,
            action: busReplaced ? AUDIT_ACTIONS.TRIP_BUS_REPLACED : AUDIT_ACTIONS.TICKET_UPDATED,
            entityType: AUDIT_ENTITY_TYPES.TICKET,
            entityId: id,
            entityLabel: `Рейс ${oldTicket?.from_city || ''} → ${oldTicket?.to_city || ''} #${id}`,
            oldData: oldTicket,
            newData: { ...oldTicket, ...updateData },
            metadata: busReplaced ? {
                old_bus_id: oldTicket.bus_id,
                new_bus_id: updateData.bus_id,
                old_capacity: oldTicket.total_seats,
                new_capacity: updateData.total_seats,
                conflict_override: allowBusConflict
            } : undefined
        });

        res.json({ success: true, bus_replaced: busReplaced });
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
    // Security Gate: Drivers and Accountants cannot delete tickets
    if (req.carrier.role === 'driver' || req.carrier.role === 'accountant') {
        return res.status(403).json({ error: 'Недостаточно прав для удаления рейсов' });
    }

    const { id } = req.params;

    // Strict ownership verification
    const hasAccess = await verifyTicketAccess(req.carrier, id);
    if (!hasAccess) {
        return res.status(403).json({ error: 'Доступ запрещен: рейс не принадлежит вашему аккаунту перевозчика' });
    }

    try {
        // Fetch to get photos and route info before deleting
        const { data: ticket } = await supabase.from('bus_tickets').select('*').eq('id', id).single();
        const photos = ticket?.photos || [];

        const { error } = await supabase
            .from('bus_tickets')
            .delete()
            .eq('id', id);

        if (error) throw error;

        // Audit log ticket deletion
        await logCarrierActivity({
            supabase,
            carrierContext: req.carrier,
            action: AUDIT_ACTIONS.TICKET_DELETED,
            entityType: AUDIT_ENTITY_TYPES.TICKET,
            entityId: id,
            entityLabel: `Рейс ${ticket?.from_city || ''} → ${ticket?.to_city || ''} #${id}`,
            oldData: ticket,
            newData: { status: 'deleted' }
        });

        // Cleanup Cloudinary only if no other ticket is referencing this photo public_id (FAIL-CLOSED)
        for (const photo of photos) {
            if (photo && photo.public_id) {
                try {
                    const { data: otherTickets, error: checkErr } = await supabase
                        .from('bus_tickets')
                        .select('id')
                        .neq('id', id)
                        .contains('photos', [{ public_id: photo.public_id }])
                        .limit(1);

                    // Fail-closed: only delete from Cloudinary if check succeeded and definitively returned 0 records
                    if (!checkErr && Array.isArray(otherTickets) && otherTickets.length === 0) {
                        await deleteFromCloudinary(photo.public_id).catch(e => console.error('[Cloudinary] Destroy error:', e));
                    }
                } catch (e) {
                    console.error('[Cloudinary Photo Cleanup] Reference check failed (fail-closed, asset preserved):', e);
                }
            }
        }

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * @swagger
 * /api/bus-admin/tickets/{id}/duplicate:
 *   post:
 *     summary: Quick duplicate or reverse a bus ticket on a new date
 *     tags: [Bus Admin]
 */
router.post('/tickets/:id/duplicate', async (req, res) => {
    // Security Gate: Drivers and Accountants cannot create/duplicate tickets
    if (req.carrier.role === 'driver' || req.carrier.role === 'accountant') {
        return res.status(403).json({ error: 'Недостаточно прав для создания и дублирования рейсов' });
    }

    const { id } = req.params;
    const { 
        departure_date, 
        departure_time, 
        arrival_date, 
        arrival_time, 
        price, 
        premium_price,
        is_reverse 
    } = req.body;

    if (!departure_date) {
        return res.status(400).json({ error: 'Укажите дату отправления нового рейса' });
    }

    // Ownership verification
    const hasAccess = await verifyTicketAccess(req.carrier, id);
    if (!hasAccess) {
        return res.status(403).json({ error: 'Доступ запрещен: исходный рейс не принадлежит вашему аккаунту' });
    }

    try {
        const { data: sourceTicket, error: sErr } = await supabase
            .from('bus_tickets')
            .select('*')
            .eq('id', id)
            .single();

        if (sErr || !sourceTicket) {
            return res.status(404).json({ error: 'Исходный рейс не найден' });
        }

        let fromCity = sourceTicket.from_city;
        let fromAddress = sourceTicket.from_address;
        let toCity = sourceTicket.to_city;
        let toAddress = sourceTicket.to_address;
        
        // Deep clone intermediate stops to guarantee source immutability
        let rawStops = sourceTicket.intermediate_stops || [];
        if (typeof rawStops === 'string') {
            try { rawStops = JSON.parse(rawStops); } catch(e) { rawStops = []; }
        }
        let stops = JSON.parse(JSON.stringify(rawStops));

        // Deep clone photos to guarantee source immutability
        let rawPhotos = sourceTicket.photos || [];
        if (typeof rawPhotos === 'string') {
            try { rawPhotos = JSON.parse(rawPhotos); } catch(e) { rawPhotos = []; }
        }
        const clonedPhotos = JSON.parse(JSON.stringify(rawPhotos));

        // If reverse trip requested, swap origin/destination and reverse stops
        if (is_reverse) {
            fromCity = sourceTicket.to_city;
            fromAddress = sourceTicket.to_address;
            toCity = sourceTicket.from_city;
            toAddress = sourceTicket.from_address;
            stops = stops.reverse().map(s => ({
                city: s.city,
                address: s.address || '',
                time: '' // Direction-dependent time is strictly cleared for safety
            }));
        }

        const newTicketData = {
            operator_id: req.carrier.carrier_id, // Trusted from JWT
            transport_company: sourceTicket.transport_company,
            from_city: fromCity,
            from_address: fromAddress,
            to_city: toCity,
            to_address: toAddress,
            departure_date: departure_date,
            departure_time: departure_time || sourceTicket.departure_time,
            arrival_date: arrival_date || null,
            arrival_time: arrival_time || null,
            duration_minutes: sourceTicket.duration_minutes || null,
            price: price !== undefined && price !== null ? Number(price) : sourceTicket.price,
            premium_price: premium_price !== undefined ? (premium_price ? Number(premium_price) : null) : sourceTicket.premium_price,
            total_seats: sourceTicket.total_seats || 53,
            floor1_seats: sourceTicket.floor1_seats || null,
            floor2_seats: sourceTicket.floor2_seats || null,
            reserved_seats: [], // STRICT SAFETY: Always reset reserved seats
            status: 'active',
            bus_type: sourceTicket.bus_type || 'single',
            passenger_comments: sourceTicket.passenger_comments || '',
            intermediate_stops: stops,
            photos: clonedPhotos,
            group_leader_name: sourceTicket.group_leader_name || null,
            group_leader_phone: sourceTicket.group_leader_phone || null,
            group_leader_whatsapp: sourceTicket.group_leader_whatsapp || null
        };

        const { data: newTicket, error: insertErr } = await supabase
            .from('bus_tickets')
            .insert([newTicketData])
            .select('id')
            .single();

        if (insertErr) throw insertErr;

        // Audit log duplication / reverse (exactly ONE logical event)
        await logCarrierActivity({
            supabase,
            carrierContext: req.carrier,
            action: is_reverse ? AUDIT_ACTIONS.TICKET_REVERSED : AUDIT_ACTIONS.TICKET_DUPLICATED,
            entityType: AUDIT_ENTITY_TYPES.TICKET,
            entityId: newTicket.id,
            entityLabel: `Рейс ${fromCity} → ${toCity} #${newTicket.id} (${is_reverse ? 'Обратный от #' + id : 'Копия #' + id})`,
            newData: newTicketData
        });

        res.status(201).json({
            success: true,
            id: newTicket.id,
            message: is_reverse ? 'Обратный рейс успешно создан' : 'Рейс успешно продублирован',
            ticket: { ...newTicketData, id: newTicket.id }
        });

    } catch (err) {
        console.error('[BusAdmin Duplicate Ticket] Error:', err);
        res.status(500).json({ error: err.message || 'Ошибка создания копии рейса' });
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
    // Security Gate: Drivers and Accountants cannot create manual bookings
    if (req.carrier.role === 'driver' || req.carrier.role === 'accountant') {
        return res.status(403).json({ error: 'Недостаточно прав для ручного бронирования' });
    }

    const { bus_ticket_id, seat_numbers, passengers_data, phone, passenger_name, pickup_city, drop_off_city, contact_role } = req.body;

    if (!bus_ticket_id) {
        return res.status(400).json({ error: 'Необходимо указать bus_ticket_id' });
    }

    // Phone format validation (reject text typos, allow empty / valid international numbers)
    if (!isValidPhone(phone, true)) {
        return res.status(400).json({
            error: 'INVALID_PHONE_FORMAT',
            message: 'Некорректный номер телефона. Введите номер в международном формате (+992..., +7...) или оставьте поле пустым'
        });
    }
    const cleanPhone = cleanPhoneForStorage(phone);
    const validContactRole = ['passenger', 'family_or_group', 'coordinator', 'unknown'].includes(contact_role) ? contact_role : 'unknown';

    const { resolveRegisteredPassenger, executeAtomicClaim } = require('../utils/claimHelper');

    // Phase E.38.1 Hardening: Only explicit 'passenger' role enters automatic registered passenger resolution.
    // For 'unknown', 'family_or_group', and 'coordinator', never auto-promote role and never auto-claim.
    let registeredPassenger = null;
    let effectiveContactRole = validContactRole;

    if (validContactRole === 'passenger') {
        registeredPassenger = await resolveRegisteredPassenger(cleanPhone);
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
                passenger_id: req.carrier.user_id, // Authenticated carrier manager (legacy surrogate)
                seat_numbers,
                passenger_count: (seat_numbers || []).length,
                passengers_data,
                phone: cleanPhone,
                contact_role: effectiveContactRole,
                claim_status: 'unclaimed',
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

        // Phase E.7 Atomic Auto-Claim for Resolved Registered Passenger
        let isAutoClaimed = false;
        if (registeredPassenger) {
            try {
                const claimRes = await executeAtomicClaim(booking.id, registeredPassenger.id);
                if (claimRes.success) {
                    isAutoClaimed = true;
                }
            } catch (claimErr) {
                console.error('[ManualBooking] Registered passenger auto-claim error:', claimErr.message);
            }
        }

        // Update ticket reserved seats
        const newReserved = [...reserved, ...(seat_numbers || [])];
        await supabase
            .from('bus_tickets')
            .update({ reserved_seats: newReserved })
            .eq('id', bus_ticket_id);

        // Audit log manual booking creation
        await logCarrierActivity({
            supabase,
            carrierContext: req.carrier,
            action: AUDIT_ACTIONS.BOOKING_CREATED_MANUAL,
            entityType: AUDIT_ENTITY_TYPES.BOOKING,
            entityId: booking.id,
            entityLabel: `Бронь #${booking.id} (${ticket.from_city || ''} → ${ticket.to_city || ''})`,
            newData: {
                seat_numbers,
                passenger_count: (seat_numbers || []).length,
                total_price: manualTotalPrice,
                status: 'confirmed',
                boarding_status: 'pending_boarding',
                pickup_city,
                drop_off_city
            }
        });

        // Phase D / E.7 Notification Planning & Server-Side Queue Hook (Non-blocking)
        if (process.env.NOTIFICATION_ROUTING_ENABLED === 'true') {
            try {
                const { buildNotificationPlan } = require('../utils/notificationRoutingEngine');
                const { enqueueAndDispatchNotifications } = require('../utils/notificationQueueService');
                const fullBooking = {
                    id: booking.id,
                    bus_ticket_id,
                    passenger_id: req.carrier.user_id,
                    seat_numbers,
                    passenger_count: (seat_numbers || []).length,
                    passengers_data,
                    total_price: manualTotalPrice,
                    commission_rate: commissionRate,
                    commission_amount: commissionAmount,
                    carrier_amount: carrierAmount,
                    claimed_by_user_id: isAutoClaimed ? registeredPassenger.id : null,
                    claim_status: isAutoClaimed ? 'claimed' : 'unclaimed',
                    passenger_name,
                    phone: cleanPhone,
                    contact_role: effectiveContactRole,
                    channel: 'manual',
                    source_type: 'manual',
                    pickup_city,
                    drop_off_city,
                    created_by_user_id: req.carrier.user_id,
                    status: 'confirmed'
                };
                const plan = buildNotificationPlan(fullBooking, {
                    creator: req.carrier,
                    trip: ticket,
                    users: registeredPassenger ? [registeredPassenger] : []
                });
                enqueueAndDispatchNotifications(plan, { booking: fullBooking, trip: ticket, creator: req.carrier }).catch(err => {
                    console.error('[NotificationQueue] Async dispatch error:', err.message);
                });
            } catch (planErr) {
                console.error('[NotificationPlan] Error generating plan:', planErr.message);
            }
        }

        // Phase E.38.2 Manual Booking Handoff for Unregistered Contacts
        let handoff = { required: false };
        if (!isAutoClaimed) {
            let session = null;
            try {
                const { generateClaimSession } = require('../utils/claimHelper');
                session = await generateClaimSession(booking.id);
            } catch (handoffErr) {
                console.error('[ManualBooking] Error generating claim session handoff:', handoffErr.message);
            }

            const { generateTicketVerificationToken } = require('../utils/ticketHelper');
            const verificationToken = generateTicketVerificationToken(booking.id);
            const ticketUrl = `https://www.poputki.online/ticket-verify/${verificationToken}`;

            handoff = {
                required: true,
                contact_role: effectiveContactRole,
                booking_id: booking.id,
                claim_url: session?.deepLink || null,
                ticket_url: ticketUrl,
                expires_at: session?.expiresAt || null
            };
        }

        res.json({
            success: true,
            id: booking.id,
            booking_id: booking.id,
            is_auto_claimed: isAutoClaimed,
            handoff
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * @swagger
 * /api/bus-admin/bookings/{bookingId}/claim-link:
 *   post:
 *     summary: Generate or regenerate a claim link for an unconfirmed/unclaimed booking (carrier tenant-scoped)
 *     tags: [Bus Admin]
 */
router.post('/bookings/:bookingId/claim-link', async (req, res) => {
    const { bookingId } = req.params;
    const numId = Number(bookingId);
    if (!numId || isNaN(numId)) {
        return res.status(400).json({ error: 'INVALID_BOOKING_ID', message: 'Некорректный ID бронирования' });
    }

    try {
        // 1. Fetch booking
        const { data: booking, error: bErr } = await supabase
            .from('bus_ticket_bookings')
            .select('id, bus_ticket_id, status, claim_status, claimed_by_user_id, contact_role, phone')
            .eq('id', numId)
            .single();

        if (bErr || !booking) {
            return res.status(404).json({ error: 'BOOKING_NOT_FOUND', message: 'Бронирование не найдено' });
        }

        // 2. Strict tenant verification: verify the booking's trip belongs to current carrier
        const hasAccess = await verifyTicketAccess(req.carrier, booking.bus_ticket_id);
        if (!hasAccess) {
            return res.status(403).json({ error: 'FORBIDDEN', message: 'Доступ запрещен: рейс не принадлежит вашему аккаунту перевозчика' });
        }

        // 3. Cancelled booking check
        if (booking.status === 'cancelled') {
            return res.status(400).json({ error: 'BOOKING_CANCELLED', message: 'Нельзя создать ссылку для отмененного бронирования' });
        }

        // 4. Already claimed check
        if (booking.claim_status === 'claimed' || booking.claimed_by_user_id) {
            return res.status(409).json({ error: 'BOOKING_ALREADY_CLAIMED', message: 'Поездка уже подтверждена пассажиром' });
        }

        // 5. Generate fresh claim session
        const { generateClaimSession } = require('../utils/claimHelper');
        const { generateTicketVerificationToken } = require('../utils/ticketHelper');

        const session = await generateClaimSession(booking.id);
        const verificationToken = generateTicketVerificationToken(booking.id);
        const ticketUrl = `https://www.poputki.online/ticket-verify/${verificationToken}`;

        return res.json({
            success: true,
            booking_id: booking.id,
            claim_url: session.deepLink,
            ticket_url: ticketUrl,
            expires_at: session.expiresAt
        });
    } catch (err) {
        console.error('[ClaimLink Regeneration] Error:', err);
        return res.status(500).json({ error: 'INTERNAL_ERROR', message: err.message });
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
    // Security Gate: Drivers and Accountants cannot edit bookings
    if (req.carrier.role === 'driver' || req.carrier.role === 'accountant') {
        return res.status(403).json({ error: 'Недостаточно прав для изменения бронирования' });
    }

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

        // Audit log booking update
        await logCarrierActivity({
            supabase,
            carrierContext: req.carrier,
            action: AUDIT_ACTIONS.BOOKING_UPDATED,
            entityType: AUDIT_ENTITY_TYPES.BOOKING,
            entityId: id,
            entityLabel: `Бронь #${id} (${ticket.from_city || ''} → ${ticket.to_city || ''})`,
            oldData: {
                seat_numbers: oldBooking.seat_numbers,
                pickup_city: oldBooking.pickup_city,
                drop_off_city: oldBooking.drop_off_city,
                status: oldBooking.status,
                total_price: oldBooking.total_price
            },
            newData: {
                seat_numbers: updatePayload.seat_numbers,
                pickup_city: updatePayload.pickup_city,
                drop_off_city: updatePayload.drop_off_city,
                status: oldBooking.status,
                total_price: updatePayload.total_price !== undefined ? updatePayload.total_price : oldBooking.total_price
            }
        });

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
    // Security Gate: Drivers and Accountants cannot delete bookings
    if (req.carrier.role === 'driver' || req.carrier.role === 'accountant') {
        return res.status(403).json({ error: 'Недостаточно прав для удаления бронирования' });
    }

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

        // 3. Release the seats canonically by deriving from remaining active bookings
        const { data: remainingBookings } = await supabase
            .from('bus_ticket_bookings')
            .select('seat_numbers, status, hold_expires_at, created_at')
            .eq('bus_ticket_id', ticketId)
            .neq('status', 'cancelled');

        const remainingSeats = [];
        (remainingBookings || []).forEach(b => {
            if (isSeatLockedByBooking(b)) {
                const sList = typeof b.seat_numbers === 'string' ? JSON.parse(b.seat_numbers || '[]') : (b.seat_numbers || []);
                if (Array.isArray(sList)) {
                    sList.forEach(s => {
                        const num = Number(s);
                        if (!isNaN(num)) remainingSeats.push(num);
                    });
                } else if (sList != null) {
                    const num = Number(sList);
                    if (!isNaN(num)) remainingSeats.push(num);
                }
            }
        });

        const canonicalReserved = [...new Set(remainingSeats)];

        await supabase
            .from('bus_tickets')
            .update({ reserved_seats: canonicalReserved })
            .eq('id', ticketId);

        // Audit log booking cancellation
        await logCarrierActivity({
            supabase,
            carrierContext: req.carrier,
            action: AUDIT_ACTIONS.BOOKING_CANCELLED,
            entityType: AUDIT_ENTITY_TYPES.BOOKING,
            entityId: id,
            entityLabel: `Бронь #${id}`,
            oldData: {
                seat_numbers: seatsToRelease,
                status: 'confirmed'
            },
            newData: {
                status: 'cancelled'
            }
        });

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
    // Security Gate: Accountants cannot mutate boarding
    if (req.carrier.role === 'accountant') {
        return res.status(403).json({ error: 'Недостаточно прав для отметки посадки' });
    }

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

        // Security Gate: Boarding operations are strictly allowed ONLY for confirmed bookings
        if (booking.status !== 'confirmed') {
            return res.status(400).json({ 
                error: 'Посадка доступна только для подтвержденной брони' 
            });
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

        // 4. Log change in legacy booking_audit_logs and carrier_activity_logs (Dual-write)
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
            console.error('[BusAdmin Boarding] Legacy audit log insertion error (non-fatal):', auditErr);
        }

        await logCarrierActivity({
            supabase,
            carrierContext: req.carrier,
            action: AUDIT_ACTIONS.BOARDING_STATUS_CHANGED,
            entityType: AUDIT_ENTITY_TYPES.BOOKING,
            entityId: id,
            entityLabel: `Бронь #${id} (Места: ${(booking.seat_numbers || []).join(', ')})`,
            oldData: { boarding_status: oldStatus },
            newData: { boarding_status: boarding_status }
        });

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
 * Builds a minimal, PII-safe display projection of a boarded passenger for
 * the QR scanner response (seat + name only — no phone, no documents, no
 * Telegram IDs).
 */
function buildScanDisplayName(booking) {
    if (booking.passenger_name && String(booking.passenger_name).trim()) {
        return String(booking.passenger_name).trim();
    }
    try {
        const pData = typeof booking.passengers_data === 'string'
            ? JSON.parse(booking.passengers_data || '[]')
            : (booking.passengers_data || []);
        if (Array.isArray(pData) && pData[0]) {
            const p0 = pData[0];
            const name = [p0.lastName, p0.firstName, p0.middleName].filter(Boolean).join(' ').trim();
            if (name) return name;
        }
    } catch (e) { /* fall through to default */ }
    return 'Пассажир';
}

function buildScanSeats(booking) {
    try {
        const seats = typeof booking.seat_numbers === 'string'
            ? JSON.parse(booking.seat_numbers || '[]')
            : (booking.seat_numbers || []);
        return Array.isArray(seats) ? seats : (seats ? [seats] : []);
    } catch (e) {
        return [];
    }
}

/**
 * @swagger
 * /api/bus-admin/bookings/scan-boarding:
 *   post:
 *     summary: Board a passenger by scanning their existing Ticket V1.1 QR code
 *     tags: [Bus Admin]
 */
router.post('/bookings/scan-boarding', async (req, res) => {
    // Security Gate: Accountants cannot mutate boarding
    if (req.carrier.role === 'accountant') {
        return res.status(403).json({ error: 'Недостаточно прав для отметки посадки', code: 'FORBIDDEN' });
    }

    const { ticketToken, tripId } = req.body || {};

    if (!ticketToken || typeof ticketToken !== 'string') {
        return res.status(400).json({ error: 'Отсутствует QR-токен билета', code: 'INVALID_TICKET' });
    }
    const numericTripId = parseInt(tripId, 10);
    if (!numericTripId) {
        return res.status(400).json({ error: 'Не выбран рейс для посадки', code: 'INVALID_TRIP' });
    }

    try {
        // 1. Extract booking id from the token's structural shape (no trust yet)
        const bookingId = extractBookingIdFromToken(ticketToken);
        if (!bookingId) {
            return res.status(404).json({ error: 'Недействительный билет', code: 'INVALID_TICKET' });
        }

        // 2. Fetch booking (safe columns only)
        const { data: booking, error: bErr } = await supabase
            .from('bus_ticket_bookings')
            .select('id, bus_ticket_id, status, boarding_status, boarded_at, passenger_name, passengers_data, seat_numbers')
            .eq('id', bookingId)
            .maybeSingle();

        if (bErr || !booking) {
            return res.status(404).json({ error: 'Недействительный билет', code: 'INVALID_TICKET' });
        }

        // 3. Server-side HMAC verification — the SOLE source of cryptographic truth.
        //    Frontend never re-implements or trusts a client-supplied booking id.
        if (!verifyTicketToken(ticketToken, booking.id)) {
            return res.status(404).json({ error: 'Недействительный билет', code: 'INVALID_TICKET' });
        }

        // 4. Resolve the trip the booking actually belongs to, and enforce
        //    tenant isolation (cross-carrier tickets are BLOCKED without
        //    revealing that the booking exists at all).
        const { data: trip, error: tErr } = await supabase
            .from('bus_tickets')
            .select('id, operator_id, status, from_city, to_city')
            .eq('id', booking.bus_ticket_id)
            .maybeSingle();

        if (tErr || !trip) {
            return res.status(404).json({ error: 'Недействительный билет', code: 'INVALID_TICKET' });
        }

        if (trip.operator_id !== req.carrier.carrier_id) {
            return res.status(404).json({ error: 'Недействительный билет', code: 'INVALID_TICKET' });
        }

        // Driver role: must be specifically assigned to this trip (same rule
        // as every other operational boarding action).
        if (req.carrier.role === 'driver') {
            const assigned = Array.isArray(req.carrier.assignedTicketIds) ? req.carrier.assignedTicketIds : [];
            const isAssigned = assigned.some(id => String(id) === String(trip.id));
            if (!isAssigned) {
                return res.status(404).json({ error: 'Недействительный билет', code: 'INVALID_TICKET' });
            }
        }

        // 5. Same carrier, but scanning the WRONG trip: the booking is real
        //    and belongs to this carrier, just not to the trip currently
        //    selected in the scanner. Explicitly surfaced (not silently
        //    treated as invalid) so the carrier can find the right trip.
        if (trip.id !== numericTripId) {
            return res.status(409).json({ error: 'Билет относится к другому рейсу', code: 'WRONG_TRIP' });
        }

        // 6. Trip must still be open for boarding.
        if (trip.status === 'completed') {
            return res.status(400).json({ error: 'Рейс уже завершён, посадка недоступна', code: 'TRIP_COMPLETED' });
        }
        if (trip.status !== 'active') {
            return res.status(400).json({ error: 'Рейс недоступен для посадки', code: 'TRIP_NOT_ACTIVE' });
        }

        // 7. Booking / payment safety.
        if (booking.status === 'pending_payment') {
            return res.status(400).json({ error: 'Бронирование ожидает оплаты, посадка недоступна', code: 'PENDING_PAYMENT' });
        }
        if (booking.status !== 'confirmed') {
            return res.status(400).json({ error: 'Бронирование недействительно для посадки', code: 'BOOKING_INVALID' });
        }

        const seats = buildScanSeats(booking);
        const displayName = buildScanDisplayName(booking);

        // 8. Idempotent duplicate-scan handling: already boarded -> no mutation.
        if (booking.boarding_status === 'boarded') {
            return res.json({
                success: true,
                already_boarded: true,
                trip_id: trip.id,
                booking_id: booking.id,
                boarding_status: 'boarded',
                boarded_at: booking.boarded_at,
                passenger: { seats, displayName }
            });
        }

        // 9. Conditional atomic update: only flips a still-confirmed,
        //    not-yet-boarded booking. A concurrent duplicate scan (same QR
        //    visible across several camera frames, or two devices at once)
        //    that loses the race affects 0 rows and is treated as idempotent
        //    below instead of double-mutating or erroring.
        const now = new Date().toISOString();
        const { data: updatedRows, error: uErr } = await supabase
            .from('bus_ticket_bookings')
            .update({
                boarding_status: 'boarded',
                boarded_at: now,
                boarded_by_user_id: req.carrier.user_id
            })
            .eq('id', booking.id)
            .eq('status', 'confirmed')
            .neq('boarding_status', 'boarded')
            .select('id, boarding_status, boarded_at')
            .single();

        if (uErr || !updatedRows) {
            // Lost the race to a concurrent scan/mutation: converge to idempotent response.
            const { data: refetched } = await supabase
                .from('bus_ticket_bookings')
                .select('boarding_status, boarded_at')
                .eq('id', booking.id)
                .maybeSingle();

            return res.json({
                success: true,
                already_boarded: true,
                trip_id: trip.id,
                booking_id: booking.id,
                boarding_status: refetched?.boarding_status || 'boarded',
                boarded_at: refetched?.boarded_at || now,
                passenger: { seats, displayName }
            });
        }

        // 10. Audit trail (same dual-write pattern as manual boarding update).
        try {
            await supabase
                .from('booking_audit_logs')
                .insert([{
                    booking_id: booking.id,
                    action: 'boarding_status_update',
                    old_status: booking.boarding_status || 'pending_boarding',
                    new_status: 'boarded',
                    performed_by_user_id: req.carrier.user_id,
                    details: {
                        previous_boarding_status: booking.boarding_status || 'pending_boarding',
                        new_boarding_status: 'boarded',
                        boarded_at: now,
                        carrier_id: req.carrier.carrier_id,
                        carrier_role: req.carrier.role,
                        method: 'qr_scan'
                    }
                }]);
        } catch (auditErr) {
            console.error('[BusAdmin ScanBoarding] Legacy audit log insertion error (non-fatal):', auditErr);
        }

        await logCarrierActivity({
            supabase,
            carrierContext: req.carrier,
            action: AUDIT_ACTIONS.BOARDING_STATUS_CHANGED,
            entityType: AUDIT_ENTITY_TYPES.BOOKING,
            entityId: booking.id,
            entityLabel: `Бронь #${booking.id} (Места: ${seats.join(', ')})`,
            oldData: { boarding_status: booking.boarding_status || 'pending_boarding' },
            newData: { boarding_status: 'boarded' },
            metadata: { reason: 'qr_scan' }
        });

        return res.json({
            success: true,
            already_boarded: false,
            trip_id: trip.id,
            booking_id: booking.id,
            boarding_status: updatedRows.boarding_status,
            boarded_at: updatedRows.boarded_at,
            passenger: { seats, displayName }
        });
    } catch (err) {
        console.error('[BusAdmin ScanBoarding] Fatal error:', err);
        res.status(500).json({ error: err.message || 'Ошибка обработки QR-сканирования' });
    }
});

/**
 * @swagger
 * /api/bus-admin/tickets/{id}/complete:
 *   post:
 *     summary: Complete a trip via the canonical completion service (pending -> no_show, then status -> completed)
 *     tags: [Bus Admin]
 */
router.post('/tickets/:id/complete', async (req, res) => {
    // Security Gate: same role gate as other ticket-level mutations (edit/delete)
    if (req.carrier.role === 'driver' || req.carrier.role === 'accountant') {
        return res.status(403).json({ error: 'Недостаточно прав для завершения рейса' });
    }

    const { id } = req.params;

    const hasAccess = await verifyTicketAccess(req.carrier, id);
    if (!hasAccess) {
        return res.status(403).json({ error: 'Доступ запрещен: рейс не принадлежит вашему аккаунту перевозчика' });
    }

    try {
        const result = await completeTrip({ tripId: id, actorContext: req.carrier });

        if (!result.success) {
            const statusByError = {
                TRIP_NOT_FOUND: 404,
                TRIP_OWNERSHIP_MISMATCH: 403,
                RPC_FAILED: 500
            };
            const status = statusByError[result.error] || 400;
            return res.status(status).json({ error: result.error, details: result.details });
        }

        res.json(result);
    } catch (err) {
        console.error('[BusAdmin CompleteTrip] Fatal error:', err);
        res.status(500).json({ error: err.message || 'Ошибка завершения рейса' });
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
        const confirmedSeats = new Set();
        const heldSeats = new Set();

        // Categorize bookings
        const confirmedBookings = allBookings.filter(b => b.status === 'confirmed');
        const pendingBookings = allBookings.filter(b => b.status === 'pending_payment' && isPendingHoldActive(b));
        const cancelledBookings = allBookings.filter(b => b.status === 'cancelled' || (b.status === 'pending_payment' && !isPendingHoldActive(b)));

        confirmedBookings.forEach(b => {
            let seats = [];
            try {
                seats = typeof b.seat_numbers === 'string' ? JSON.parse(b.seat_numbers || '[]') : (b.seat_numbers || []);
                if (!Array.isArray(seats)) seats = seats ? [seats] : [];
            } catch(e) { }
            seats.forEach(s => {
                uniqueReservedSeats.add(s);
                confirmedSeats.add(s);
            });
        });

        pendingBookings.forEach(b => {
            let seats = [];
            try {
                seats = typeof b.seat_numbers === 'string' ? JSON.parse(b.seat_numbers || '[]') : (b.seat_numbers || []);
                if (!Array.isArray(seats)) seats = seats ? [seats] : [];
            } catch(e) { }
            seats.forEach(s => {
                uniqueReservedSeats.add(s);
                heldSeats.add(s);
            });
        });


        let pendingPassengersCount = 0;
        pendingBookings.forEach(b => {
            const count = b.passenger_count || (Array.isArray(b.passengers_data) ? b.passengers_data.length : 1) || 1;
            pendingPassengersCount += count;
        });

        const bookedSeatsCount = uniqueReservedSeats.size;
        const confirmedSeatsCount = confirmedSeats.size;
        const heldSeatsCount = heldSeats.size;
        const freeSeatsCount = Math.max(0, capacity - bookedSeatsCount);
        const fillRate = capacity > 0 ? parseFloat(((bookedSeatsCount / capacity) * 100).toFixed(1)) : 0;

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

        // Boarding counters across confirmed passengers ONLY
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
            occupied_or_held_seats: bookedSeatsCount,
            confirmed_seats: confirmedSeatsCount,
            held_seats: heldSeatsCount,
            free_seats: freeSeatsCount,
            fill_rate: fillRate,


            bookings_total: allBookings.length,
            confirmed_bookings: confirmedBookings.length,
            pending_bookings: pendingBookings.length,
            cancelled_bookings: cancelledBookings.length,

            pending_payment_passengers: pendingPassengersCount,
            online_bookings: onlineBookings.length,
            manual_bookings: manualBookings.length,

            gross_amount: grossAmount,
            paid_amount: paidAmount,
            unpaid_amount: unpaidAmount,
            pending_payment_amount: unpaidAmount,

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
 * /api/bus-admin/tickets/{ticketId}/print-manifest:
 *   get:
 *     summary: Get bulk printable tickets manifest for a trip sorted by seat number
 *     tags: [Bus Admin]
 */
router.get('/tickets/:ticketId/print-manifest', async (req, res) => {
    const { ticketId } = req.params;

    try {
        const hasAccess = await verifyTicketAccess(req.carrier, ticketId);
        if (!hasAccess) {
            return res.status(403).json({ error: 'Доступ запрещен: рейс не принадлежит вашему аккаунту перевозчика' });
        }

        const { data: ticket, error: tErr } = await supabase
            .from('bus_tickets')
            .select(`
                *,
                operator:users!operator_id (id, name, phone)
            `)
            .eq('id', ticketId)
            .maybeSingle();

        if (tErr || !ticket) {
            return res.status(404).json({ error: 'Рейс не найден' });
        }

        // Fetch master bus vehicle if bus_id is present
        let busMaster = null;
        if (ticket.bus_id) {
            const { data: bData } = await supabase
                .from('carrier_buses')
                .select('*')
                .eq('id', ticket.bus_id)
                .maybeSingle();
            busMaster = bData || null;
        }

        // Fetch all bookings for this ticket
        const { data: bookings, error: bErr } = await supabase
            .from('bus_ticket_bookings')
            .select(`
                id, bus_ticket_id, passenger_id, seat_numbers, passenger_count, passengers_data, phone, status, total_price, passenger_name, pickup_city, drop_off_city, created_at,
                boarding_status, boarded_at, boarded_by_user_id,
                channel, source_type, source_id, created_by_user_id,
                commission_rate, commission_amount, carrier_amount,
                users:passenger_id (name, phone)
            `)
            .eq('bus_ticket_id', ticketId)
            .eq('status', 'confirmed');

        if (bErr) throw bErr;

        const tickets = buildTripPrintManifest(ticket, bookings || [], busMaster);

        res.json({
            tripId: Number(ticketId),
            fromCity: ticket.from_city,
            toCity: ticket.to_city,
            departureDate: ticket.departure_date,
            departureTime: ticket.departure_time ? ticket.departure_time.substring(0, 5) : '',
            bus: busMaster ? {
                brand: busMaster.brand,
                model: busMaster.model,
                licensePlate: busMaster.license_plate,
                busType: ticket.bus_type || 'single'
            } : null,
            totalConfirmedTickets: tickets.length,
            tickets
        });
    } catch (err) {
        console.error('[BusAdmin Print Manifest] Error:', err);
        res.status(500).json({ error: err.message || 'Ошибка генерации списка билетов' });
    }
});

/**
 * @swagger
 * /api/bus-admin/bookings/{bookingId}/ticket:
 *   get:
 *     summary: Get single electronic/printable passenger ticket projection
 *     tags: [Bus Admin]
 */
router.get('/bookings/:bookingId/ticket', async (req, res) => {
    const { bookingId } = req.params;

    try {
        const { data: booking, error: bErr } = await supabase
            .from('bus_ticket_bookings')
            .select(`
                id, bus_ticket_id, passenger_id, seat_numbers, passenger_count, passengers_data, phone, status, total_price, passenger_name, pickup_city, drop_off_city, created_at,
                boarding_status, boarded_at, boarded_by_user_id,
                channel, source_type, source_id, created_by_user_id,
                commission_rate, commission_amount, carrier_amount,
                users:passenger_id (name, phone)
            `)
            .eq('id', bookingId)
            .maybeSingle();

        if (bErr || !booking) {
            return res.status(404).json({ error: 'Бронирование не найдено' });
        }

        const hasAccess = await verifyTicketAccess(req.carrier, booking.bus_ticket_id);
        if (!hasAccess) {
            return res.status(403).json({ error: 'Доступ запрещен: рейс не принадлежит вашему аккаунту перевозчика' });
        }

        const { data: ticket, error: tErr } = await supabase
            .from('bus_tickets')
            .select(`
                *,
                operator:users!operator_id (id, name, phone)
            `)
            .eq('id', booking.bus_ticket_id)
            .maybeSingle();

        if (tErr || !ticket) {
            return res.status(404).json({ error: 'Рейс не найден' });
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

        const ticketProjection = buildPassengerTicketProjection(booking, ticket, busMaster, { includeCarrierPhone: true });

        res.json(ticketProjection);
    } catch (err) {
        console.error('[BusAdmin Single Ticket] Error:', err);
        res.status(500).json({ error: err.message || 'Ошибка формирования билета' });
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

/**
 * =========================================================================
 * PHASE P1.1: TEAM MANAGEMENT & ROLE ASSIGNMENTS
 * =========================================================================
 */

/**
 * @swagger
 * /api/bus-admin/members:
 *   get:
 *     summary: List team members for the authenticated carrier (Owner only)
 *     tags: [Bus Admin Team]
 */
router.get('/members', async (req, res) => {
    // Only owner can view and manage team members
    if (req.carrier.role !== 'owner') {
        return res.status(403).json({ error: 'Только владелец компании имеет доступ к списку сотрудников' });
    }

    const carrierId = req.carrier.carrier_id;

    try {
        const { data: members, error } = await supabase
            .from('carrier_members')
            .select(`
                id,
                carrier_id,
                user_id,
                role,
                assigned_ticket_ids,
                is_active,
                created_at,
                users (
                    id,
                    name,
                    phone
                )
            `)
            .eq('carrier_id', carrierId)
            .order('created_at', { ascending: true });

        if (error) throw error;

        const formattedMembers = (members || []).map(m => ({
            id: m.id,
            carrier_id: m.carrier_id,
            user_id: m.user_id,
            role: m.role,
            assigned_ticket_ids: m.assigned_ticket_ids || [],
            is_active: m.is_active,
            created_at: m.created_at,
            name: m.users?.name || 'Сотрудник',
            phone: m.users?.phone || ''
        }));

        res.json({
            owner: {
                user_id: req.carrier.user_id,
                name: req.carrier.name,
                phone: req.carrier.phone,
                role: 'owner'
            },
            members: formattedMembers
        });
    } catch (err) {
        console.error('[BusAdmin Team] Error fetching members:', err);
        res.status(500).json({ error: err.message || 'Ошибка загрузки списка сотрудников' });
    }
});

/**
 * Validate and sanitize driver assigned ticket IDs (Strict Carrier Tenant Isolation)
 */
async function sanitizeAssignedTickets(carrierId, ticketIds) {
    if (!Array.isArray(ticketIds) || ticketIds.length === 0) return [];
    const numericIds = [...new Set(ticketIds.map(id => parseInt(id, 10)).filter(id => !isNaN(id) && id > 0))];
    if (numericIds.length === 0) return [];

    const { data: validTickets, error } = await supabase
        .from('bus_tickets')
        .select('id')
        .eq('operator_id', carrierId)
        .in('id', numericIds);

    if (error || !validTickets) return [];
    return validTickets.map(t => t.id);
}

/**
 * @swagger
 * /api/bus-admin/members:
 *   post:
 *     summary: Add a new member to the carrier team (Owner only)
 *     tags: [Bus Admin Team]
 */
router.post('/members', async (req, res) => {
    if (req.carrier.role !== 'owner') {
        return res.status(403).json({ error: 'Только владелец компании может добавлять сотрудников' });
    }

    const carrierId = req.carrier.carrier_id;
    const { phone, role, assigned_ticket_ids } = req.body;

    if (!phone || !phone.trim()) {
        return res.status(400).json({ error: 'Укажите номер телефона сотрудника' });
    }

    const validRoles = ['dispatcher', 'driver', 'accountant'];
    if (!validRoles.includes(role)) {
        return res.status(400).json({ error: 'Недопустимая роль. Допустимы: dispatcher, driver, accountant' });
    }

    const normalizedPhone = phone.trim().replace(/\s+/g, '');

    try {
        // 1. Find existing user by phone
        let { data: user, error: uErr } = await supabase
            .from('users')
            .select('id, name, phone, role, is_blocked')
            .eq('phone', normalizedPhone)
            .maybeSingle();

        if (uErr) throw uErr;

        // Security Gate: NEVER auto-create accounts with default/predictable passwords.
        if (!user) {
            return res.status(404).json({
                code: 'USER_NOT_REGISTERED',
                error: 'Пользователь с таким номером еще не зарегистрирован в POPUTKI.ONLINE. Попросите сотрудника сначала пройти регистрацию на сайте или в Telegram-боте, после чего добавьте его в команду.'
            });
        }

        // Prevent adding owner to their own team as a sub-member
        if (user.id === req.carrier.user_id) {
            return res.status(400).json({ error: 'Владелец компании уже обладает полным доступом и не может быть добавлен как сотрудник' });
        }

        // 2. Check if already a member of this carrier
        const { data: existingMember } = await supabase
            .from('carrier_members')
            .select('id, role, is_active')
            .eq('carrier_id', carrierId)
            .eq('user_id', user.id)
            .maybeSingle();

        if (existingMember) {
            return res.status(409).json({ error: 'Пользователь с этим номером уже добавлен в команду перевозчика' });
        }

        // 3. Sanitize driver ticket assignments against current carrier trips
        const validAssignedTickets = role === 'driver' 
            ? await sanitizeAssignedTickets(carrierId, assigned_ticket_ids) 
            : [];

        // 4. Insert carrier_member (DO NOT mutate user profile or password)
        const memberPayload = {
            carrier_id: carrierId,
            user_id: user.id,
            role: role,
            assigned_ticket_ids: validAssignedTickets,
            is_active: true
        };

        const { data: newMember, error: mErr } = await supabase
            .from('carrier_members')
            .insert([memberPayload])
            .select('id, carrier_id, user_id, role, assigned_ticket_ids, is_active, created_at')
            .single();

        if (mErr) throw mErr;

        // Audit log member addition (Strict Privacy: No phone/name in entityLabel)
        await logCarrierActivity({
            supabase,
            carrierContext: req.carrier,
            action: AUDIT_ACTIONS.MEMBER_ADDED,
            entityType: AUDIT_ENTITY_TYPES.MEMBER,
            entityId: newMember.id,
            entityLabel: `Сотрудник #${newMember.id} (${role})`,
            newData: {
                role: role,
                is_active: true,
                assigned_ticket_ids: validAssignedTickets
            }
        });

        res.status(201).json({
            success: true,
            member: {
                ...newMember,
                name: user.name,
                phone: user.phone
            }
        });
    } catch (err) {
        console.error('[BusAdmin Team] Error adding member:', err);
        res.status(500).json({ error: err.message || 'Ошибка при добавлении сотрудника' });
    }
});

/**
 * @swagger
 * /api/bus-admin/members/{id}:
 *   patch:
 *     summary: Update member role, status, or driver ticket assignments (Owner only)
 *     tags: [Bus Admin Team]
 */
router.patch('/members/:id', async (req, res) => {
    if (req.carrier.role !== 'owner') {
        return res.status(403).json({ error: 'Только владелец компании может редактировать сотрудников' });
    }

    const { id } = req.params;
    const carrierId = req.carrier.carrier_id;
    const { role, assigned_ticket_ids, is_active } = req.body;

    try {
        // Ownership verification
        const { data: member, error: mErr } = await supabase
            .from('carrier_members')
            .select('*')
            .eq('id', id)
            .eq('carrier_id', carrierId)
            .single();

        if (mErr || !member) {
            return res.status(404).json({ error: 'Сотрудник не найден в вашей компании' });
        }

        // Owner protection: cannot edit owner's own record via employee API
        if (member.user_id === req.carrier.user_id || member.role === 'owner') {
            return res.status(400).json({ error: 'Нельзя изменять статус или роль владельца компании' });
        }

        const updateData = {};
        const effectiveRole = role !== undefined ? role : member.role;

        if (role !== undefined) {
            const validRoles = ['dispatcher', 'driver', 'accountant'];
            if (!validRoles.includes(role)) {
                return res.status(400).json({ error: 'Недопустимая роль. Допустимы: dispatcher, driver, accountant' });
            }
            updateData.role = role;
            if (role !== 'driver') {
                updateData.assigned_ticket_ids = [];
            }
        }

        if (assigned_ticket_ids !== undefined) {
            if (effectiveRole === 'driver') {
                updateData.assigned_ticket_ids = await sanitizeAssignedTickets(carrierId, assigned_ticket_ids);
            } else {
                updateData.assigned_ticket_ids = [];
            }
        }

        if (is_active !== undefined) {
            updateData.is_active = Boolean(is_active);
        }

        const { data: updatedMember, error: uErr } = await supabase
            .from('carrier_members')
            .update(updateData)
            .eq('id', id)
            .select('*')
            .single();

        if (uErr) throw uErr;

        // Determine specific audit action
        let memberAuditAction = AUDIT_ACTIONS.MEMBER_ROLE_CHANGED;
        if (role !== undefined && role !== member.role) {
            memberAuditAction = AUDIT_ACTIONS.MEMBER_ROLE_CHANGED;
        } else if (assigned_ticket_ids !== undefined) {
            memberAuditAction = AUDIT_ACTIONS.DRIVER_ASSIGNMENT_CHANGED;
        } else if (is_active !== undefined) {
            memberAuditAction = is_active ? AUDIT_ACTIONS.MEMBER_REACTIVATED : AUDIT_ACTIONS.MEMBER_DEACTIVATED;
        }

        await logCarrierActivity({
            supabase,
            carrierContext: req.carrier,
            action: memberAuditAction,
            entityType: AUDIT_ENTITY_TYPES.MEMBER,
            entityId: id,
            entityLabel: `Сотрудник #${id}`,
            oldData: {
                role: member.role,
                is_active: member.is_active,
                assigned_ticket_ids: member.assigned_ticket_ids
            },
            newData: {
                role: updatedMember.role,
                is_active: updatedMember.is_active,
                assigned_ticket_ids: updatedMember.assigned_ticket_ids
            }
        });

        res.json({ success: true, member: updatedMember });
    } catch (err) {
        console.error('[BusAdmin Team] Error updating member:', err);
        res.status(500).json({ error: err.message || 'Ошибка обновления данных сотрудника' });
    }
});

/**
 * @swagger
 * /api/bus-admin/members/{id}/status:
 *   patch:
 *     summary: Quick toggle active status for a team member (Owner only)
 *     tags: [Bus Admin Team]
 */
router.patch('/members/:id/status', async (req, res) => {
    if (req.carrier.role !== 'owner') {
        return res.status(403).json({ error: 'Только владелец компании может активировать или отключать сотрудников' });
    }

    const { id } = req.params;
    const carrierId = req.carrier.carrier_id;
    const { is_active } = req.body;

    try {
        const { data: member, error: mErr } = await supabase
            .from('carrier_members')
            .select('id, user_id, carrier_id, role')
            .eq('id', id)
            .eq('carrier_id', carrierId)
            .single();

        if (mErr || !member) {
            return res.status(404).json({ error: 'Сотрудник не найден в вашей компании' });
        }

        // Owner protection
        if (member.user_id === req.carrier.user_id || member.role === 'owner') {
            return res.status(400).json({ error: 'Нельзя отключить доступ владельцу компании' });
        }

        const { error: uErr } = await supabase
            .from('carrier_members')
            .update({ is_active: Boolean(is_active) })
            .eq('id', id);

        if (uErr) throw uErr;

        res.json({ success: true, is_active: Boolean(is_active) });
    } catch (err) {
        console.error('[BusAdmin Team] Error toggling status:', err);
        res.status(500).json({ error: err.message || 'Ошибка изменения статуса сотрудника' });
    }
});

/**
 * @swagger
 * /api/bus-admin/members/{id}:
 *   delete:
 *     summary: Soft-deactivate a team member (Owner only, preserves history)
 *     tags: [Bus Admin Team]
 */
router.delete('/members/:id', async (req, res) => {
    if (req.carrier.role !== 'owner') {
        return res.status(403).json({ error: 'Только владелец компании может отключать сотрудников' });
    }

    const { id } = req.params;
    const carrierId = req.carrier.carrier_id;

    try {
        const { data: member, error: mErr } = await supabase
            .from('carrier_members')
            .select('id, user_id, role')
            .eq('id', id)
            .eq('carrier_id', carrierId)
            .single();

        if (mErr || !member) {
            return res.status(404).json({ error: 'Сотрудник не найден в вашей компании' });
        }

        // Owner protection
        if (member.user_id === req.carrier.user_id || member.role === 'owner') {
            return res.status(400).json({ error: 'Нельзя удалить владельца компании из системы' });
        }


        // Soft-deactivate to preserve historical integrity (referential safety)
        const { error: uErr } = await supabase
            .from('carrier_members')
            .update({ is_active: false })
            .eq('id', id);

        if (uErr) throw uErr;

        // Audit log member deactivation
        await logCarrierActivity({
            supabase,
            carrierContext: req.carrier,
            action: AUDIT_ACTIONS.MEMBER_DEACTIVATED,
            entityType: AUDIT_ENTITY_TYPES.MEMBER,
            entityId: id,
            entityLabel: `Сотрудник #${id}`,
            oldData: { is_active: true },
            newData: { is_active: false }
        });

        res.json({ success: true, message: 'Доступ сотрудника отключен' });
    } catch (err) {
        console.error('[BusAdmin Team] Error deactivating member:', err);
        res.status(500).json({ error: err.message || 'Ошибка при отключении сотрудника' });
    }
});

/**
 * @swagger
 * /api/bus-admin/customers:
 *   get:
 *     summary: Get aggregated customer list and CRM analytics for carrier
 *     tags: [Bus Admin CRM]
 */
router.get('/customers', async (req, res) => {
    // Role guards: only owner and dispatcher allowed
    if (req.carrier.role === 'driver') {
        return res.status(403).json({ error: 'Водителям запрещен доступ к CRM-базе пассажиров' });
    }
    if (req.carrier.role === 'accountant') {
        return res.status(403).json({ error: 'Доступ бухгалтера к CRM пассажиров ограничен' });
    }

    const carrierId = req.carrier.carrier_id;

    try {
        // 1. Fetch carrier tickets to isolate tenant
        const { data: tickets, error: tErr } = await supabase
            .from('bus_tickets')
            .select('id, operator_id, from_city, to_city, from_address, to_address, departure_date, departure_time, price, status')
            .eq('operator_id', carrierId);

        if (tErr) throw tErr;

        const ticketIds = (tickets || []).map(t => t.id);
        if (ticketIds.length === 0) {
            return res.json({
                customers: [],
                pagination: { page: 1, limit: 50, total: 0, totalPages: 1 },
                summary: { total_customers: 0, repeat_customers: 0, total_no_shows: 0, total_revenue: 0 }
            });
        }

        // 2. Fetch all bookings for carrier's tickets
        const { data: bookings, error: bErr } = await supabase
            .from('bus_ticket_bookings')
            .select('id, bus_ticket_id, passenger_id, phone, passenger_name, passengers_data, seat_numbers, passenger_count, pickup_city, drop_off_city, status, boarding_status, channel, source_type, total_price, created_at')
            .in('bus_ticket_id', ticketIds);

        if (bErr) throw bErr;

        const result = aggregateCarrierCustomers(bookings || [], tickets || [], {
            carrierId,
            search: req.query.search,
            from: req.query.from,
            to: req.query.to,
            source: req.query.source,
            loyalty: req.query.loyalty,
            sort: req.query.sort,
            page: req.query.page,
            limit: req.query.limit
        });

        res.json(result);
    } catch (err) {
        console.error('[BusAdmin CRM] Error fetching customers (carrierId: %s):', carrierId, err.message);
        res.status(500).json({ error: 'Ошибка загрузки базы клиентов' });
    }
});

/**
 * @swagger
 * /api/bus-admin/customers/{customerKey}:
 *   get:
 *     summary: Get single customer profile, statistics, and booking history
 *     tags: [Bus Admin CRM]
 */
router.get('/customers/:customerKey', async (req, res) => {
    // Role guards
    if (req.carrier.role === 'driver') {
        return res.status(403).json({ error: 'Водителям запрещен доступ к карточке клиента' });
    }
    if (req.carrier.role === 'accountant') {
        return res.status(403).json({ error: 'Доступ бухгалтера к CRM пассажиров ограничен' });
    }

    const carrierId = req.carrier.carrier_id;
    const { customerKey } = req.params;

    try {
        const { data: tickets, error: tErr } = await supabase
            .from('bus_tickets')
            .select('id, operator_id, from_city, to_city, from_address, to_address, departure_date, departure_time, price, status')
            .eq('operator_id', carrierId);

        if (tErr) throw tErr;

        const ticketIds = (tickets || []).map(t => t.id);
        if (ticketIds.length === 0) {
            return res.status(404).json({ error: 'Клиент не найден в вашей базе' });
        }

        const { data: bookings, error: bErr } = await supabase
            .from('bus_ticket_bookings')
            .select('id, bus_ticket_id, passenger_id, phone, passenger_name, passengers_data, seat_numbers, passenger_count, pickup_city, drop_off_city, status, boarding_status, channel, source_type, total_price, created_at')
            .in('bus_ticket_id', ticketIds);

        if (bErr) throw bErr;

        const details = getCustomerDetails(bookings || [], tickets || [], customerKey, carrierId);
        if (!details) {
            return res.status(404).json({ error: 'Клиент с указанным идентификатором не найден' });
        }

        res.json(details);
    } catch (err) {
        console.error('[BusAdmin CRM] Error fetching customer details (carrierId: %s):', carrierId, err.message);
        res.status(500).json({ error: 'Ошибка загрузки карточки клиента' });
    }
});



/**
 * @swagger
 * /api/bus-admin/activity:
 *   get:
 *     summary: Query append-only carrier activity audit history (Owner only)
 *     tags: [Bus Admin Audit]
 */
router.get('/activity', async (req, res) => {
    // Role guard: Only owner has access to carrier audit logs
    if (req.carrier.role !== 'owner') {
        return res.status(403).json({ error: 'Только владелец компании имеет доступ к журналу аудита' });
    }

    const carrierId = req.carrier.carrier_id;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const { from, to, actor_user_id, action, entity_type, entity_id } = req.query;

    try {
        let query = supabase
            .from('carrier_activity_logs')
            .select('*', { count: 'exact' })
            .eq('carrier_id', carrierId)
            .order('created_at', { ascending: false });

        if (action) query = query.eq('action', action);
        if (entity_type) query = query.eq('entity_type', entity_type);
        if (actor_user_id) query = query.eq('actor_user_id', parseInt(actor_user_id, 10));
        if (entity_id) query = query.eq('entity_id', String(entity_id));
        if (from) query = query.gte('created_at', from);
        if (to) {
            const toStr = to.includes('T') ? to : `${to}T23:59:59.999Z`;
            query = query.lte('created_at', toStr);
        }

        const offset = (page - 1) * limit;
        query = query.range(offset, offset + limit - 1);

        const { data: logs, count, error } = await query;

        if (error) {
            console.error('[BusAdmin Activity] Error querying activity logs:', error);
            const isTableMissing = error.code === '42P01' || 
                (typeof error.message === 'string' && (error.message.includes('carrier_activity_logs') || error.message.includes('schema cache')));

            if (isTableMissing) {
                // Controlled pre-migration grace path: return clean empty structure
                return res.json({
                    activity: [],
                    pagination: {
                        page,
                        limit,
                        total: 0,
                        totalPages: 1
                    }
                });
            }

            // Real DB/connection/auth error: fail with 500
            return res.status(500).json({ error: 'Ошибка загрузки журнала активности' });
        }


        res.json({
            activity: logs || [],
            pagination: {
                page,
                limit,
                total: count !== null ? count : (logs || []).length,
                totalPages: Math.ceil((count || 0) / limit) || 1
            }
        });
    } catch (err) {
        console.error('[BusAdmin Activity] Exception:', err);
        res.status(500).json({ error: 'Ошибка загрузки журнала активности' });
    }
});


/**
 * @swagger
 * /api/bus-admin/dashboard:
 *   get:
 *     summary: Aggregated Owner Dashboard data (Today KPI, Finances, Upcoming trips, Attention items, Recent team activity)
 *     tags: [Bus Admin Dashboard]
 */
router.get('/dashboard', async (req, res) => {
    // Role guard: Owner only
    if (req.carrier.role !== 'owner') {
        return res.status(403).json({ error: 'Только владелец компании имеет доступ к управленческому дашборду' });
    }

    const carrierId = req.carrier.carrier_id;
    const businessToday = getBusinessLocalDate();
    const businessLocalTime = getBusinessLocalTime();

    try {
        // 1. Fetch carrier's active / non-deleted tickets
        const { data: tickets, error: tErr } = await supabase
            .from('bus_tickets')
            .select('*')
            .eq('operator_id', carrierId)
            .neq('status', 'deleted');

        if (tErr) throw tErr;

        const allTickets = tickets || [];

        // Partition tickets into today and strictly upcoming (date > today OR (date == today AND time >= now))
        const todayTickets = allTickets.filter(t => t.departure_date === businessToday);
        const todayTicketIds = new Set(todayTickets.map(t => t.id));

        const upcomingTickets = allTickets
            .filter(t => {
                if (t.status !== 'active') return false;
                if (t.departure_date > businessToday) return true;
                if (t.departure_date === businessToday) {
                    const depTime = (t.departure_time || '23:59').slice(0, 5);
                    return depTime >= businessLocalTime;
                }
                return false;
            })
            .sort((a, b) => {
                const dateCmp = (a.departure_date || '').localeCompare(b.departure_date || '');
                if (dateCmp !== 0) return dateCmp;
                return (a.departure_time || '').localeCompare(b.departure_time || '');
            });

        // 2. Fetch scoped bookings ONLY for relevant operational trips (today + upcoming)
        const relevantTicketIds = Array.from(new Set([...todayTickets, ...upcomingTickets].map(t => t.id)));

        // 3 parallel queries for zero N+1 latency
        const [bookingsRes, driversRes, activityRes] = await Promise.all([
            relevantTicketIds.length > 0 
                ? supabase.from('bus_ticket_bookings').select('*').in('bus_ticket_id', relevantTicketIds)
                : Promise.resolve({ data: [] }),
            supabase.from('carrier_members').select('id, role, is_active, assigned_ticket_ids').eq('carrier_id', carrierId).eq('role', 'driver').eq('is_active', true),
            supabase.from('carrier_activity_logs').select('id, created_at, actor_role, actor_name, action, entity_type, entity_id, entity_label').eq('carrier_id', carrierId).order('created_at', { ascending: false }).limit(5)
        ]);

        if (bookingsRes.error) throw bookingsRes.error;

        const allRelevantBookings = bookingsRes.data || [];
        const activeDrivers = driversRes.data || [];
        const recentActivity = activityRes.data || [];

        const todayBookings = allRelevantBookings.filter(b => todayTicketIds.has(b.bus_ticket_id));

        // 3. Compute structured sections
        const todaySummary = buildTodaySummary(todayTickets, todayBookings);
        const attentionItems = detectAttentionItems(todayTickets, upcomingTickets, allRelevantBookings, activeDrivers);
        const upcomingTrips = buildUpcomingTripsList(upcomingTickets, allRelevantBookings, activeDrivers);

        res.json({
            business_date: businessToday,
            timezone: 'Asia/Dushanbe',
            today: todaySummary,
            money: {
                confirmed_gross: todaySummary.gross_amount,
                service_commission: todaySummary.service_commission,
                carrier_receivable: todaySummary.carrier_amount,
                pending_payment_amount: todaySummary.pending_payment_amount
            },
            upcoming_trips: upcomingTrips,
            attention: attentionItems,
            recent_activity: recentActivity
        });

    } catch (err) {
        console.error('[BusAdmin Dashboard] Exception:', err);
        res.status(500).json({ error: 'Ошибка загрузки дашборда перевозчика' });
    }
});

// ============================================================================
// CARRIER FLEET / МОЙ АВТОПАРК (PHASE A+B)
// ============================================================================

/**
 * @swagger
 * /api/bus-admin/buses:
 *   get:
 *     summary: List buses belonging to authenticated carrier
 *     tags: [Bus Admin Fleet]
 */
router.get('/buses', async (req, res) => {
    // Security Gate: Drivers do not have fleet management access
    if (req.carrier.role === 'driver') {
        return res.status(403).json({ error: 'Водители не имеют доступа к автопарку' });
    }

    const carrierId = req.carrier.carrier_id;

    try {
        let query = supabase
            .from('carrier_buses')
            .select('*')
            .eq('carrier_id', carrierId);

        if (req.query.include_archived !== 'true') {
            query = query.neq('status', 'archived');
        }

        const { data: buses, error } = await query.order('created_at', { ascending: false });

        if (error) throw error;

        res.json(buses || []);
    } catch (err) {
        console.error('[BusAdmin Fleet] Error fetching buses:', err);
        res.status(500).json({ error: 'Ошибка загрузки списка автобусов' });
    }
});

/**
 * @swagger
 * /api/bus-admin/buses/{id}:
 *   get:
 *     summary: Get single bus details with ownership verification
 *     tags: [Bus Admin Fleet]
 */
router.get('/buses/:id', async (req, res) => {
    if (req.carrier.role === 'driver') {
        return res.status(403).json({ error: 'Водители не имеют доступа к автопарку' });
    }

    const busId = req.params.id;

    try {
        const bus = await verifyBusAccess(req.carrier, busId, { allowArchived: true });
        if (!bus) {
            return res.status(404).json({ error: 'Автобус не найден или доступ запрещен' });
        }

        // Fetch active tickets count for operational awareness
        const activeTickets = await getBusActiveTickets(supabase, req.carrier.carrier_id, bus.id);

        res.json({
            ...bus,
            active_tickets: activeTickets,
            active_tickets_count: activeTickets.length
        });
    } catch (err) {
        console.error('[BusAdmin Fleet] Error fetching bus details:', err);
        res.status(500).json({ error: 'Ошибка получения данных автобуса' });
    }
});

/**
 * @swagger
 * /api/bus-admin/buses:
 *   post:
 *     summary: Add a new bus to the carrier fleet
 *     tags: [Bus Admin Fleet]
 */
router.post('/buses', async (req, res) => {
    // Security Gate: Drivers and Accountants cannot add buses
    if (req.carrier.role === 'driver') {
        return res.status(403).json({ error: 'Водители не имеют доступа к автопарку' });
    }
    if (req.carrier.role === 'accountant') {
        return res.status(403).json({ error: 'Бухгалтеры имеют доступ только для чтения' });
    }

    // Input Validation
    const validation = validateBusPayload(req.body, { isUpdate: false });
    if (!validation.valid) {
        return res.status(400).json({ error: validation.error });
    }

    // Tenant Isolation: carrier_id taken exclusively from verified JWT
    const carrierId = req.carrier.carrier_id;

    try {
        // Uniqueness check for active plate
        const isDuplicate = await checkDuplicatePlate(supabase, carrierId, validation.sanitizedData.license_plate);
        if (isDuplicate) {
            return res.status(400).json({ error: 'Автобус с таким госномером уже зарегистрирован в вашем автопарке' });
        }

        const newBusData = {
            ...validation.sanitizedData,
            carrier_id: carrierId,
            status: validation.sanitizedData.status || 'active'
        };

        const { data: newBus, error } = await supabase
            .from('carrier_buses')
            .insert([newBusData])
            .select()
            .single();

        if (error) throw error;

        // Activity Audit Logging (safe diff with zero secrets / PII)
        await logCarrierActivity({
            supabase,
            carrierContext: req.carrier,
            action: AUDIT_ACTIONS.BUS_CREATED,
            entityType: AUDIT_ENTITY_TYPES.BUS,
            entityId: newBus.id,
            entityLabel: `Автобус ${newBus.brand} ${newBus.model} (${newBus.name})`,
            newData: newBus
        });

        res.status(201).json({
            success: true,
            bus: newBus
        });
    } catch (err) {
        console.error('[BusAdmin Fleet] Error creating bus:', err);
        res.status(500).json({ error: err.message || 'Ошибка добавления автобуса' });
    }
});

/**
 * @swagger
 * /api/bus-admin/buses/{id}:
 *   patch:
 *     summary: Update bus attributes with ownership verification
 *     tags: [Bus Admin Fleet]
 */
router.patch('/buses/:id', async (req, res) => {
    // Security Gate: Drivers and Accountants cannot edit buses
    if (req.carrier.role === 'driver') {
        return res.status(403).json({ error: 'Водители не имеют доступа к автопарку' });
    }
    if (req.carrier.role === 'accountant') {
        return res.status(403).json({ error: 'Бухгалтеры имеют доступ только для чтения' });
    }

    const busId = req.params.id;

    try {
        const oldBus = await verifyBusAccess(req.carrier, busId, { allowArchived: false });
        if (!oldBus) {
            return res.status(404).json({ error: 'Автобус не найден, заархивирован или доступ запрещен' });
        }

        const validation = validateBusPayload(req.body, { isUpdate: true });
        if (!validation.valid) {
            return res.status(400).json({ error: validation.error });
        }

        // Check duplicate plate if license_plate was modified
        if (validation.sanitizedData.license_plate && validation.sanitizedData.license_plate !== oldBus.license_plate) {
            const isDuplicate = await checkDuplicatePlate(supabase, req.carrier.carrier_id, validation.sanitizedData.license_plate, oldBus.id);
            if (isDuplicate) {
                return res.status(400).json({ error: 'Автобус с таким госномером уже зарегистрирован в вашем автопарке' });
            }
        }

        const updatePayload = {
            ...validation.sanitizedData,
            updated_at: new Date().toISOString()
        };

        const { data: updatedBus, error } = await supabase
            .from('carrier_buses')
            .update(updatePayload)
            .eq('id', busId)
            .select()
            .single();

        if (error) throw error;

        // Activity Audit Logging
        await logCarrierActivity({
            supabase,
            carrierContext: req.carrier,
            action: AUDIT_ACTIONS.BUS_UPDATED,
            entityType: AUDIT_ENTITY_TYPES.BUS,
            entityId: busId,
            entityLabel: `Автобус ${updatedBus.brand} ${updatedBus.model} (${updatedBus.name})`,
            oldData: oldBus,
            newData: updatedBus
        });

        res.json({
            success: true,
            bus: updatedBus
        });
    } catch (err) {
        console.error('[BusAdmin Fleet] Error updating bus:', err);
        res.status(500).json({ error: err.message || 'Ошибка обновления данных автобуса' });
    }
});

/**
 * @swagger
 * /api/bus-admin/buses/{id}/archive:
 *   post:
 *     summary: Archive a bus (Owner only, non-destructive soft archive)
 *     tags: [Bus Admin Fleet]
 */
router.post('/buses/:id/archive', async (req, res) => {
    // Security Gate: Only Owner can archive buses
    if (req.carrier.role !== 'owner') {
        return res.status(403).json({ error: 'Только владелец компании может архивировать автобус' });
    }

    const busId = req.params.id;

    try {
        const oldBus = await verifyBusAccess(req.carrier, busId, { allowArchived: true });
        if (!oldBus) {
            return res.status(404).json({ error: 'Автобус не найден или доступ запрещен' });
        }

        if (oldBus.status === 'archived') {
            return res.json({ success: true, message: 'Автобус уже находится в архиве', bus: oldBus });
        }

        // Check active / future tickets (Strict Policy: Cannot archive bus with active future trips)
        const activeTickets = await getBusActiveTickets(supabase, req.carrier.carrier_id, busId);
        if (activeTickets.length > 0) {
            return res.status(409).json({
                error: 'BUS_HAS_ACTIVE_TRIPS',
                message: `Невозможно архивировать автобус: назначено активных рейсов — ${activeTickets.length}`,
                active_tickets_count: activeTickets.length
            });
        }

        const { data: archivedBus, error } = await supabase
            .from('carrier_buses')
            .update({
                status: 'archived',
                updated_at: new Date().toISOString()
            })
            .eq('id', busId)
            .select()
            .single();

        if (error) throw error;

        // Activity Audit Logging (only emitted if archive succeeded)
        await logCarrierActivity({
            supabase,
            carrierContext: req.carrier,
            action: AUDIT_ACTIONS.BUS_ARCHIVED,
            entityType: AUDIT_ENTITY_TYPES.BUS,
            entityId: busId,
            entityLabel: `Автобус ${oldBus.brand} ${oldBus.model} (${oldBus.name}) [Архив]`,
            oldData: oldBus,
            newData: archivedBus
        });

        res.json({
            success: true,
            message: 'Автобус успешно заархивирован',
            active_tickets_count: 0,
            bus: archivedBus
        });
    } catch (err) {
        console.error('[BusAdmin Fleet] Error archiving bus:', err);
        res.status(500).json({ error: err.message || 'Ошибка архивации автобуса' });
    }
});

/**
 * Physical DELETE is disabled to prevent data corruption and foreign key integrity errors
 */
router.delete('/buses/:id', (req, res) => {
    res.status(405).json({
        error: 'Физическое удаление автобуса запрещено. Используйте архивацию POST /api/bus-admin/buses/:id/archive'
    });
});

module.exports = router;
