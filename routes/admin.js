const express = require('express');
const router = express.Router();
const supabase = require('../db');
const { hashPassword } = require('../utils/passwordSecurity');
const { expirePendingPaymentBookings } = require('../utils/paymentExpirationHelper');
const { sweepAutoCompleteTrips } = require('../utils/tripCompletionHelper');
const { runMaintenanceTick } = require('../utils/maintenanceHelper');
const { runAcquisitionMaintenanceSweep } = require('../services/acquisition/maintenanceSweepService');
const { requireAdminToken } = require('../utils/adminTokenAuth');

const ADMIN_PASSCODE = process.env.ADMIN_PASSCODE;
const ADMIN_SECRET_TOKEN = process.env.ADMIN_SECRET_TOKEN;

// Middleware to verify admin token (Phase P.1G.3A: delegates to the shared
// constant-time helper; kept as a named local function so Express route
// introspection — router.stack.find(l => l.name === 'adminAuth') — still
// resolves it by name).
function adminAuth(req, res, next) {
    return requireAdminToken(req, res, next);
}

/**
 * @swagger
 * tags:
 *   name: Admin
 *   description: Administrative operations
 */

// Admin Login
router.post('/login', (req, res) => {
    const { passcode } = req.body;
    console.log(`[Admin Login Attempt] Passcode received: ${passcode ? '***' + passcode.slice(-2) : 'NONE'}`);

    if (String(passcode) === String(ADMIN_PASSCODE)) {
        console.log(`[Admin Login Success] Standard passcode used`);
        res.json({ token: ADMIN_SECRET_TOKEN });
    } else {
        console.warn(`[Admin Login Failure] Invalid passcode`);
        res.status(401).json({ error: 'Неверный код доступа' });
    }
});

// Protect all following routes
router.use(adminAuth);

// Phase P.1F: Admin-Only Passenger Activation Funnel Routes
const passengerFunnelRouter = require('./adminPassengerFunnel');
router.use('/passenger-funnel', passengerFunnelRouter);

// Phase P.1G.2: Admin-Only Acquisition Funnel Routes
const acquisitionFunnelRouter = require('./adminAcquisitionFunnel');
router.use('/acquisition-funnel', acquisitionFunnelRouter);

// Dashboard Stats
router.get('/stats', async (req, res) => {
    try {
        const { count: totalUsers } = await supabase.from('users').select('*', { count: 'exact', head: true });
        const { count: totalRides } = await supabase.from('rides').select('*', { count: 'exact', head: true });
        const { count: activeRides } = await supabase.from('rides').select('*', { count: 'exact', head: true }).eq('status', 'active');
        const { count: totalBusTickets } = await supabase.from('bus_tickets').select('*', { count: 'exact', head: true });
        const { count: activeBusTickets } = await supabase.from('bus_tickets').select('*', { count: 'exact', head: true }).eq('status', 'active');
        const { count: totalBusBookings } = await supabase.from('bus_ticket_bookings').select('*', { count: 'exact', head: true }).eq('status', 'confirmed');
        const { count: totalReviews } = await supabase.from('reviews').select('*', { count: 'exact', head: true });

        const { data: busBookingsRevenue } = await supabase.from('bus_ticket_bookings').select('total_price').eq('status', 'confirmed');
        const revenue = (busBookingsRevenue || []).reduce((acc, curr) => acc + (curr.total_price || 0), 0);

        // Detailed stats
        const { data: recentUsers } = await supabase
            .from('users')
            .select('id, name, created_at')
            .order('created_at', { ascending: false })
            .limit(5);

        // popularDestinations: requires grouped queries that aren't perfectly supported out of the box in PostgREST without RPC
        const { data: allRides } = await supabase.from('rides').select('to_city');
        const destinationCounts = (allRides || []).reduce((acc, curr) => {
            if (curr.to_city) {
                acc[curr.to_city] = (acc[curr.to_city] || 0) + 1;
            }
            return acc;
        }, {});
        const popularDestinations = Object.keys(destinationCounts)
            .map(city => ({ to_city: city, count: destinationCounts[city] }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 5);

        // popularBusRoutes
        const { data: allBusTickets } = await supabase.from('bus_tickets').select('from_city, to_city');
        const busRouteCounts = (allBusTickets || []).reduce((acc, curr) => {
            const route = `${curr.from_city} → ${curr.to_city}`;
            acc[route] = (acc[route] || 0) + 1;
            return acc;
        }, {});
        const popularBusRoutes = Object.keys(busRouteCounts)
            .map(route => ({ route, count: busRouteCounts[route] }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 5);

        // Stats for Charts
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
        const dateString = sevenDaysAgo.toISOString().split('T')[0];

        const { data: ridesLast7DaysRaw } = await supabase
            .from('rides')
            .select('date')
            .gte('date', dateString);

        const ridesLast7DaysMap = (ridesLast7DaysRaw || []).reduce((acc, curr) => {
            if (curr.date) {
                acc[curr.date] = (acc[curr.date] || 0) + 1;
            }
            return acc;
        }, {});
        const ridesLast7Days = Object.keys(ridesLast7DaysMap)
            .map(date => ({ date, count: ridesLast7DaysMap[date] }))
            .sort((a, b) => a.date.localeCompare(b.date));

        const { data: busTicketsLast7DaysRaw } = await supabase
            .from('bus_tickets')
            .select('departure_date')
            .gte('departure_date', dateString);

        const busTicketsLast7DaysMap = (busTicketsLast7DaysRaw || []).reduce((acc, curr) => {
            if (curr.departure_date) {
                acc[curr.departure_date] = (acc[curr.departure_date] || 0) + 1;
            }
            return acc;
        }, {});
        const busTicketsLast7Days = Object.keys(busTicketsLast7DaysMap)
            .map(date => ({ date, count: busTicketsLast7DaysMap[date] }))
            .sort((a, b) => a.date.localeCompare(b.date));

        const { data: usersLast7DaysRaw } = await supabase
            .from('users')
            .select('created_at')
            .gte('created_at', dateString);

        const usersLast7DaysMap = (usersLast7DaysRaw || []).reduce((acc, curr) => {
            if (curr.created_at) {
                const date = curr.created_at.split('T')[0];
                acc[date] = (acc[date] || 0) + 1;
            }
            return acc;
        }, {});
        const usersLast7Days = Object.keys(usersLast7DaysMap)
            .map(register_date => ({ register_date, count: usersLast7DaysMap[register_date] }))
            .sort((a, b) => a.register_date.localeCompare(b.register_date));

        // Global Booking Dynamics (Bus only, last 30 days)
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        const thirtyDateString = thirtyDaysAgo.toISOString().split('T')[0];

        const { data: busBookings } = await supabase
            .from('bus_ticket_bookings')
            .select('created_at, status, total_price')
            .gte('created_at', thirtyDateString);

        const bookingMap = {};
        let paidCount = 0;
        let manualCount = 0;
        let totalCount = 0;

        (busBookings || []).forEach(b => {
            const d = b.created_at.split('T')[0];
            bookingMap[d] = (bookingMap[d] || 0) + 1;

            if (b.status !== 'cancelled') {
                totalCount++;
                if (b.total_price === 0) {
                    manualCount++;
                } else if (b.status === 'confirmed') {
                    paidCount++;
                }
            }
        });

        const bookingDynamics = Object.keys(bookingMap)
            .map(date => ({ date, count: bookingMap[date] }))
            .sort((a, b) => a.date.localeCompare(b.date));

        const bookingStatusDistribution = {
            total: totalCount,
            paid: paidCount,
            manual: manualCount,
            other: totalCount - paidCount - manualCount
        };

        // Age Distribution
        const { data: userAges } = await supabase.from('users').select('age');
        const ageBins = { '18-25': 0, '26-35': 0, '36-45': 0, '46-60': 0, '60+': 0, 'Unknown': 0 };
        (userAges || []).forEach(u => {
            if (!u.age) ageBins['Unknown']++;
            else if (u.age <= 25) ageBins['18-25']++;
            else if (u.age <= 35) ageBins['26-35']++;
            else if (u.age <= 45) ageBins['36-45']++;
            else if (u.age <= 60) ageBins['46-60']++;
            else ageBins['60+']++;
        });
        const ageDistribution = Object.keys(ageBins).map(label => ({ label, count: ageBins[label] }));

        // Car Model Distribution
        const { data: carModels } = await supabase.from('vehicles').select('model');
        const modelCounts = (carModels || []).reduce((acc, curr) => {
            if (curr.model) {
                const model = curr.model.trim();
                acc[model] = (acc[model] || 0) + 1;
            }
            return acc;
        }, {});
        const carModelDistribution = Object.keys(modelCounts)
            .map(model => ({ model, count: modelCounts[model] }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 10);

        const stats = {
            totalUsers,
            totalRides,
            activeRides,
            totalBusTickets,
            activeBusTickets,
            totalBusBookings,
            totalReviews,
            revenue,
            recentUsers,
            popularDestinations,
            popularBusRoutes,
            ridesLast7Days,
            busTicketsLast7Days,
            usersLast7Days,
            bookingDynamics,
            bookingStatusDistribution,
            ageDistribution,
            carModelDistribution
        };

        res.json(stats);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// User Management
router.get('/users', async (req, res) => {
    try {
        const { data: users, error } = await supabase
            .from('users')
            .select('id, name, surname, phone, rating, created_at, role, age, sex, photo_url, username, is_blocked')
            .order('created_at', { ascending: false });
        if (error) throw error;
        res.json(users);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.delete('/users/:id', async (req, res) => {
    try {
        await supabase.from('users').delete().eq('id', req.params.id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.put('/users/:id', async (req, res) => {
    try {
        const { data: user, error } = await supabase
            .from('users')
            .update(req.body)
            .eq('id', req.params.id)
            .select()
            .single();
        if (error) throw error;
        res.json(user);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Bus Drivers Management
router.get('/bus-drivers', async (req, res) => {
    try {
        const { data: drivers, error } = await supabase
            .from('users')
            .select('id, name, surname, phone, created_at, service_fee_percent, is_blocked')
            .eq('role', 'bus_driver')
            .order('created_at', { ascending: false });
        if (error) throw error;
        res.json(drivers);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Update service fee percent for a specific bus driver
router.put('/bus-drivers/:id/fee', async (req, res) => {
    const { id } = req.params;
    const { service_fee_percent } = req.body;

    if (service_fee_percent === undefined || service_fee_percent === null) {
        return res.status(400).json({ error: 'service_fee_percent is required' });
    }
    const fee = parseFloat(service_fee_percent);
    if (isNaN(fee) || fee < 0 || fee > 100) {
        return res.status(400).json({ error: 'service_fee_percent must be between 0 and 100' });
    }

    try {
        const { error } = await supabase
            .from('users')
            .update({ service_fee_percent: fee })
            .eq('id', id)
            .eq('role', 'bus_driver');
        if (error) throw error;
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Block a bus driver
router.put('/bus-drivers/:id/block', async (req, res) => {
    try {
        const { error } = await supabase
            .from('users')
            .update({ is_blocked: true })
            .eq('id', req.params.id)
            .eq('role', 'bus_driver');
        if (error) throw error;
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Unblock a bus driver
router.put('/bus-drivers/:id/unblock', async (req, res) => {
    try {
        const { error } = await supabase
            .from('users')
            .update({ is_blocked: false })
            .eq('id', req.params.id)
            .eq('role', 'bus_driver');
        if (error) throw error;
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/bus-drivers', async (req, res) => {
    const { phone, name, surname, password } = req.body;
    if (!phone || !password) return res.status(400).json({ error: 'Phone and password required' });

    try {
        const { data: existing } = await supabase.from('users').select('id').eq('phone', phone).maybeSingle();
        if (existing) {
            return res.status(400).json({ error: 'Пользователь с таким номером уже существует' });
        }

        const hashedPassword = await hashPassword(password);

        const { error } = await supabase
            .from('users')
            .insert([{ phone, name, surname, password: hashedPassword, role: 'bus_driver' }]);

        if (error) throw error;
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Ride Management
router.get('/rides', async (req, res) => {
    try {
        const { data: rides, error } = await supabase
            .from('rides')
            .select('*, users:driver_id (name)')
            .order('id', { ascending: false });
        if (error) throw error;

        const formattedRides = rides.map(r => {
            const userData = r.users || {};
            delete r.users;
            return {
                ...r,
                driver_name: userData.name,
                time: r.time ? r.time.substring(0, 5) : r.time
            };
        });

        res.json(formattedRides);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.delete('/rides/:id', async (req, res) => {
    try {
        await supabase.from('rides').delete().eq('id', req.params.id);
        await supabase.from('bookings').delete().eq('ride_id', req.params.id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.put('/rides/:id', async (req, res) => {
    try {
        const { data: ride, error } = await supabase
            .from('rides')
            .update(req.body)
            .eq('id', req.params.id)
            .select()
            .single();
        if (error) throw error;
        res.json(ride);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// City Management
router.get('/cities', async (req, res) => {
    const { type } = req.query;
    try {
        let query = supabase
            .from('cities')
            .select('*')
            .order('name', { ascending: true });

        if (type) {
            query = query.eq('type', type);
        }

        const { data: cities, error } = await query;
        if (error) throw error;
        console.log(`[Admin] Fetched ${cities?.length} cities`);
        res.json(cities);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/cities', async (req, res) => {
    const { name, type } = req.body;
    try {
        const { error } = await supabase.from('cities').insert([{ name, type: type || 'ride' }]);
        if (error) throw error;
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.delete('/cities/:id', async (req, res) => {
    try {
        await supabase.from('cities').delete().eq('id', req.params.id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Bus Ticket Management
router.get('/bus-tickets', async (req, res) => {
    try {
        const { data: tickets, error } = await supabase
            .from('bus_tickets')
            .select('*')
            .order('departure_date', { ascending: false });
        if (error) throw error;
        const formatted = tickets.map(t => ({
            ...t,
            departure_time: t.departure_time ? t.departure_time.substring(0, 5) : t.departure_time,
            arrival_time: t.arrival_time ? t.arrival_time.substring(0, 5) : t.arrival_time
        }));
        res.json(formatted);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.delete('/bus-tickets/:id', async (req, res) => {
    try {
        await supabase.from('bus_tickets').delete().eq('id', req.params.id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Review Moderation
router.get('/reviews', async (req, res) => {
    try {
        const { data: reviews, error } = await supabase
            .from('reviews')
            .select('*, u1:reviewer_id(name), u2:driver_id(name)')
            .order('created_at', { ascending: false });
        if (error) throw error;

        const formattedReviews = reviews.map(r => {
            const reviewerName = r.u1 ? r.u1.name : null;
            const driverName = r.u2 ? r.u2.name : null;
            delete r.u1;
            delete r.u2;
            return {
                ...r,
                reviewer_name: reviewerName,
                driver_name: driverName
            };
        });

        res.json(formattedReviews);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.delete('/reviews/:id', async (req, res) => {
    try {
        await supabase.from('reviews').delete().eq('id', req.params.id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get all bookings for a specific bus ticket (admin drill-down)
router.get('/bus-tickets/:id/bookings', async (req, res) => {
    const { id } = req.params;
    try {
        const { data: bookings, error } = await supabase
            .from('bus_ticket_bookings')
            .select(`
                id, bus_ticket_id, passenger_id, seat_numbers, passenger_count, passengers_data, phone, status, total_price, passenger_name, pickup_city, drop_off_city, created_at,
                users:passenger_id (name, phone)
            `)
            .eq('bus_ticket_id', id)
            .neq('status', 'cancelled')
            .order('created_at', { ascending: false });

        if (error) throw error;

        const result = (bookings || []).map(b => ({
            ...b,
            passenger_name: b.passenger_name || b.users?.name,
            passenger_phone: b.users?.phone || b.phone,
            seat_numbers: typeof b.seat_numbers === 'string' ? JSON.parse(b.seat_numbers || '[]') : (b.seat_numbers || []),
            passengers_data: typeof b.passengers_data === 'string' ? JSON.parse(b.passengers_data || '[]') : (b.passengers_data || [])
        }));

        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get all bus tickets (rides) for a specific bus driver (admin drill-down)
router.get('/bus-drivers/:id/tickets', async (req, res) => {
    const { id } = req.params;
    try {
        const { data: tickets, error } = await supabase
            .from('bus_tickets')
            .select('*')
            .eq('operator_id', id)
            .order('departure_date', { ascending: false });

        if (error) throw error;

        // Fetch non-cancelled bookings to compute actual reserved seats and statistics
        const ticketIds = (tickets || []).map(t => t.id);
        const { data: allBookings } = ticketIds.length > 0
            ? await supabase
                .from('bus_ticket_bookings')
                .select('bus_ticket_id, seat_numbers, status, total_price')
                .in('bus_ticket_id', ticketIds)
                .neq('status', 'cancelled')
            : { data: [] };

        const result = (tickets || []).map(t => {
            const ticketBookings = (allBookings || []).filter(b => b.bus_ticket_id === t.id);
            const reservedSeats = [];
            let manualBooked = 0;
            let paidBooked = 0;
            let pendingBooked = 0;
            let totalBooked = 0;

            ticketBookings.forEach(b => {
                const seats = typeof b.seat_numbers === 'string' ? JSON.parse(b.seat_numbers || '[]') : (b.seat_numbers || []);
                const count = Array.isArray(seats) ? seats.length : (seats ? 1 : 0);

                // We only count confirmed as reserved for the "free seats" calculation
                if (b.status === 'confirmed') {
                    reservedSeats.push(...(Array.isArray(seats) ? seats : [seats]));
                    totalBooked += count;
                    if (b.total_price === 0) {
                        manualBooked += count;
                    } else {
                        paidBooked += count;
                    }
                } else if (b.status === 'pending_payment') {
                    pendingBooked += count;
                }
            });

            return {
                ...t,
                reserved_seats: reservedSeats,
                reserved_count: reservedSeats.length,
                total_booked: totalBooked,
                manual_booked: manualBooked,
                paid_booked: paidBooked,
                pending_booked: pendingBooked,
                free_seats: t.total_seats - reservedSeats.length,
                intermediate_stops: typeof t.intermediate_stops === 'string'
                    ? JSON.parse(t.intermediate_stops || '[]')
                    : (t.intermediate_stops || []),
                departure_time: t.departure_time ? t.departure_time.substring(0, 5) : t.departure_time,
                arrival_time: t.arrival_time ? t.arrival_time.substring(0, 5) : t.arrival_time,
            };
        });

        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get all passengers data flattened from bus_ticket_bookings (admin passenger data tab)
router.get('/passengers-data', async (req, res) => {
    try {
        const { data: bookings, error } = await supabase
            .from('bus_ticket_bookings')
            .select(`
                id, bus_ticket_id, passenger_id, seat_numbers, passenger_count, passengers_data, phone, status, total_price, passenger_name, pickup_city, drop_off_city, created_at,
                users:passenger_id (name, phone)
            `)
            .order('created_at', { ascending: false });

        if (error) throw error;

        const { data: tickets } = await supabase
            .from('bus_tickets')
            .select('id, from_city, to_city, departure_date, departure_time, transport_company');

        const ticketMap = {};
        if (tickets) {
            tickets.forEach(t => { ticketMap[t.id] = t; });
        }

        const result = [];
        (bookings || []).forEach(b => {
            const ticket = ticketMap[b.bus_ticket_id] || {};
            const pData = typeof b.passengers_data === 'string' ? JSON.parse(b.passengers_data || '[]') : (b.passengers_data || []);
            const seatNums = typeof b.seat_numbers === 'string' ? JSON.parse(b.seat_numbers || '[]') : (b.seat_numbers || []);

            if (pData.length === 0) {
                result.push({
                    booking_id: b.id,
                    bus_ticket_id: b.bus_ticket_id,
                    passenger_id: b.passenger_id,
                    lastName: b.passenger_name || '—',
                    firstName: '',
                    middleName: '',
                    gender: '—',
                    birthDate: '—',
                    docType: '—',
                    docNumber: '—',
                    citizenship: '—',
                    phone: b.users?.phone || b.phone || '—',
                    seatNumbers: (seatNums || []).join(', '),
                    pickup_city: b.pickup_city || '—',
                    drop_off_city: b.drop_off_city || '—',
                    from_city: ticket.from_city || '—',
                    to_city: ticket.to_city || '—',
                    departure_date: ticket.departure_date || '—',
                    departure_time: ticket.departure_time || '—',
                    transport_company: ticket.transport_company || '—',
                    total_price: b.total_price,
                    paymentStatus: b.status === 'pending_payment' ? 'Ожидает оплаты' : (b.total_price === 0 ? 'Ручная' : 'Оплачено'),
                    bookingStatus: b.status,
                    created_at: b.created_at
                });
            } else {
                pData.forEach((p, idx) => {
                    result.push({
                        booking_id: b.id,
                        bus_ticket_id: b.bus_ticket_id,
                        passenger_id: b.passenger_id,
                        lastName: p.lastName || '—',
                        firstName: p.firstName || '',
                        middleName: p.middleName || '',
                        gender: p.gender || '—',
                        birthDate: p.birthDate || '—',
                        docType: p.docType || '—',
                        docNumber: p.docNumber || '—',
                        citizenship: p.citizenship || '—',
                        phone: p.phone || b.users?.phone || b.phone || '—',
                        seatNumbers: (seatNums && seatNums[idx]) ? seatNums[idx].toString() : '—',
                        pickup_city: b.pickup_city || '—',
                        drop_off_city: b.drop_off_city || '—',
                        from_city: ticket.from_city || '—',
                        to_city: ticket.to_city || '—',
                        departure_date: ticket.departure_date || '—',
                        departure_time: ticket.departure_time || '—',
                        transport_company: ticket.transport_company || '—',
                        total_price: b.total_price,
                        paymentStatus: b.status === 'pending_payment' ? 'Ожидает оплаты' : (b.total_price === 0 ? 'Ручная' : 'Оплачено'),
                        bookingStatus: b.status,
                        created_at: b.created_at
                    });
                });
            }
        });

        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET active poll settings
router.get('/polls/settings', adminAuth, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('poll_settings')
            .select('*')
            .eq('id', 1)
            .maybeSingle();

        if (error) throw error;

        // Fallback seed just in case
        if (!data) {
            const defaultSettings = {
                id: 1,
                question: 'Что помешало вам завершить покупку билета?',
                option1: 'Слишком высокая итоговая цена после выбора мест и комиссии',
                option2: 'Неудобный способ оплаты или не прошла оплата',
                option3: 'Изменились планы или поездка стала неактуальной'
            };
            await supabase.from('poll_settings').insert([defaultSettings]);
            return res.json(defaultSettings);
        }

        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// UPDATE poll settings
router.put('/polls/settings', adminAuth, async (req, res) => {
    try {
        const { question, option1, option2, option3 } = req.body;
        const { data, error } = await supabase
            .from('poll_settings')
            .update({ question, option1, option2, option3 })
            .eq('id', 1)
            .select()
            .single();
        if (error) throw error;
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET customer poll answers
router.get('/polls/answers', adminAuth, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('purchase_poll_answers')
            .select(`
                id, booking_id, user_id, telegram_id, answer, created_at,
                users:user_id (name, phone),
                bus_ticket_bookings:booking_id (
                    id, total_price, passenger_count, seat_numbers,
                    bus_tickets:bus_ticket_id (from_city, to_city, departure_date, departure_time)
                )
            `)
            .order('created_at', { ascending: false });
        if (error) throw error;
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST trigger polls (for cron task)
router.post('/polls/trigger', adminAuth, async (req, res) => {
    try {
        // 1. Fetch poll settings
        let { data: settings, error: settingsErr } = await supabase
            .from('poll_settings')
            .select('*')
            .eq('id', 1)
            .maybeSingle();
        if (settingsErr) throw settingsErr;

        if (!settings) {
            settings = {
                id: 1,
                question: 'Что помешало вам завершить покупку билета?',
                option1: 'Слишком высокая итоговая цена после выбора мест и комиссии',
                option2: 'Неудобный способ оплаты или не прошла оплата',
                option3: 'Изменились планы или поездка стала неактуальной'
            };
            await supabase.from('poll_settings').insert([settings]);
        }

        // 2. Fetch only pending bookings older than 30 minutes
        const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();

        const { data: bookings, error: bookingsErr } = await supabase
            .from('bus_ticket_bookings')
            .select(`
        id, passenger_id, phone, status, total_price,
        users:passenger_id (id, name, telegram_id)
    `)
            .eq('status', 'pending_payment')
            .lte('created_at', cutoff);
        if (bookingsErr) throw bookingsErr;

        if (!bookings || bookings.length === 0) {
            return res.json({ message: 'No pending bookings found.', count: 0 });
        }

        // 3. Fetch sent polls and answers to filter out already polled/answered bookings
        const { data: sentPolls, error: sentErr } = await supabase
            .from('sent_polls')
            .select('booking_id');
        if (sentErr) throw sentErr;
        const sentBookingIds = new Set(sentPolls.map(sp => sp.booking_id));

        const { data: answers, error: answersErr } = await supabase
            .from('purchase_poll_answers')
            .select('booking_id');
        if (answersErr) throw answersErr;
        const answeredBookingIds = new Set(answers.map(a => a.booking_id));

        const eligibleBookings = bookings.filter(b => {
            const hasTg = b.users && b.users.telegram_id;
            return hasTg && !sentBookingIds.has(b.id) && !answeredBookingIds.has(b.id);
        });

        if (eligibleBookings.length === 0) {
            return res.json({ message: 'No eligible users to send polls to.', count: 0 });
        }

        // 4. Send polls
        const telegramBot = require('../utils/telegramBot');
        let successCount = 0;
        let failCount = 0;

        for (const b of eligibleBookings) {
            // Re-check booking status immediately before sending the poll
            const { data: currentBooking, error: currentBookingErr } = await supabase
                .from('bus_ticket_bookings')
                .select('id, status')
                .eq('id', b.id)
                .maybeSingle();

            if (currentBookingErr) {
                console.error(`Error re-checking booking ${b.id}: ${currentBookingErr.message}`);
                failCount++;
                continue;
            }

            // Do not send the poll if the booking is no longer awaiting payment
            if (!currentBooking || currentBooking.status !== 'pending_payment') {
                continue;
            }

            const tgId = b.users.telegram_id;

            const result = await telegramBot.sendPoll(
                tgId,
                settings.question,
                [
                    settings.option1,
                    settings.option2,
                    settings.option3,
                    'Ваш вариант (напишите, что именно мешает)'
                ]
            );

            if (result && result.ok && result.result) {
                const telegramMessage = result.result;
                const pollId = telegramMessage.poll.id;

                // Save in sent_polls
                const { error: saveErr } = await supabase
                    .from('sent_polls')
                    .insert({
                        poll_id: pollId,
                        booking_id: b.id,
                        user_id: b.passenger_id,
                        telegram_id: tgId.toString()
                    });

                if (saveErr) {
                    console.error(`Error saving sent poll: ${saveErr.message}`);
                } else {
                    successCount++;
                }
            } else {
                failCount++;
            }
        }

        res.json({
            message: 'Finished sending polls.',
            total_eligible: eligibleBookings.length,
            success: successCount,
            failed: failCount
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /api/admin/bookings/expire-pending
 *
 * Centralized cleanup endpoint to expire stale pending_payment bookings and release held seats.
 * Supports query parameter:
 * - ?dry_run=true: Preview which bookings would be cancelled without modifying state
 */
router.post('/bookings/expire-pending', adminAuth, async (req, res) => {
    try {
        const dryRun = req.query.dry_run === 'true' || req.body?.dry_run === true;
        const result = await expirePendingPaymentBookings(supabase, { dryRun });

        res.json({
            success: true,
            timestamp: new Date().toISOString(),
            ...result
        });
    } catch (err) {
        console.error('[Admin Expire Pending] Error:', err);
        res.status(500).json({ error: err.message || 'Ошибка обработки просроченных бронирований' });
    }
});

/**
 * POST /api/admin/trips/auto-complete
 *
 * Phase E.47.1 — Periodic sweep (intended cadence: every 30-60 minutes via
 * the same external Render cron mechanism already used for
 * /api/admin/bookings/expire-pending). Completes every active trip whose
 * arrival + 12h grace period has elapsed, using the canonical completeTrip()
 * service (pending_boarding -> no_show, then trip -> completed).
 *
 * Idempotent and safe under overlapping/duplicate invocations: each trip's
 * completion is independently conditional on its live DB status, so a
 * second concurrent sweep run cannot double-apply effects.
 *
 * Supports ?dry_run=true to preview eligible trips without mutating state.
 */
router.post('/trips/auto-complete', adminAuth, async (req, res) => {
    try {
        const dryRun = req.query.dry_run === 'true' || req.body?.dry_run === true;
        const result = await sweepAutoCompleteTrips({ dryRun });

        res.json({
            success: true,
            timestamp: new Date().toISOString(),
            ...result
        });
    } catch (err) {
        console.error('[Admin Auto-Complete Trips] Error:', err);
        res.status(500).json({ error: err.message || 'Ошибка автоматического завершения рейсов' });
    }
});

/**
 * POST /api/admin/maintenance/tick
 *
 * Phase E.47.7.2 — Unified maintenance entry point, intended as the single
 * endpoint an external scheduler calls going forward. Runs both periodic
 * maintenance tasks (expire-pending, auto-complete) via their existing
 * canonical helpers, with per-task failure isolation: a failure in one task
 * never prevents the other from running. The two legacy single-task
 * endpoints above are kept for backward compatibility / manual diagnostics.
 *
 * Supports ?dry_run=true (or {"dry_run": true} body) — provably
 * mutation-free for both tasks, since both underlying helpers already skip
 * their mutating branch entirely (only a read-only SELECT runs) when
 * dryRun is true.
 *
 * Phase E.47.8.1 — Authorization: this route is exempt from the global
 * x-mana-man check (index.js) because that header is not confidential (it
 * ships in the public frontend/mobile clients) and must never be treated as
 * meaningful auth. The real, server-side-only authorization boundary here
 * is adminAuth below (X-Admin-Token / ADMIN_SECRET_TOKEN).
 */
router.post('/maintenance/tick', adminAuth, async (req, res) => {
    try {
        const dryRun = req.query.dry_run === 'true' || req.body?.dry_run === true;
        const result = await runMaintenanceTick({ dryRun });
        res.json(result);
    } catch (err) {
        console.error('[Admin Maintenance Tick] Error:', err);
        res.status(500).json({ success: false, error: err.message || 'Ошибка планового обслуживания' });
    }
});

/**
 * POST /api/admin/maintenance/acquisition-sweep
 *
 * Phase P.1G.3A — Scheduled acquisition-funnel reliability sweep. The P.1G.3
 * recovery audit found that neither the outbox worker's dedicated retry
 * sweep nor the reconciliation gap-recovery pass were ever automatically
 * invoked in production (both only ran opportunistically, in-band, right
 * after a fresh event was enqueued). This endpoint runs both explicitly, is
 * intended to be called on a schedule by the same GitHub Actions workflow
 * that already reliably drives /maintenance/tick (maintenance.yml), and
 * shares that authorization model: adminAuth (X-Admin-Token /
 * ADMIN_SECRET_TOKEN) — not the HMAC-signed /api/internal/acquisition/*
 * path, which is reserved for genuine bot<->backend service calls. No new
 * secret is required for this endpoint.
 *
 * Idempotent: outbox draining is protected by fn_claim_outbox_events'
 * FOR UPDATE SKIP LOCKED leasing, and reconciliation is protected by its own
 * lease-based distributed lock (services/acquisition/reconciliationService.js)
 * — an overlapping trigger is reported as a graceful skip, never a race.
 * Task isolation: a failure in outbox_sweep never prevents reconciliation
 * from running, and vice versa. Response contains only aggregate counts —
 * zero PII.
 */
router.post('/maintenance/acquisition-sweep', adminAuth, async (req, res) => {
    try {
        const result = await runAcquisitionMaintenanceSweep();
        res.json(result);
    } catch (err) {
        console.error('[Admin Acquisition Sweep] Error:', err);
        res.status(500).json({ success: false, error: err.message || 'Ошибка планового обслуживания воронки' });
    }
});

module.exports = router;
