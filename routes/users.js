const express = require('express');
const router = express.Router();
const supabase = require('../db');

/**
 * @swagger
 * /api/users/{id}/vehicle:
 *   get:
 *     summary: Get user's vehicle
 *     tags: [Users]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Vehicle details
 */
router.get('/:id/vehicle', async (req, res) => {
    try {
        const { data: vehicle, error } = await supabase
            .from('vehicles')
            .select('*')
            .eq('user_id', req.params.id)
            .maybeSingle();

        if (error) throw error;
        res.json(vehicle || null);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * @swagger
 * /api/users/{id}/profile:
 *   get:
 *     summary: Get public user profile
 *     tags: [Users]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: User profile
 *       404:
 *         description: User not found
 */
router.get('/:id/profile', async (req, res) => {
    try {
        const { data: user, error: userError } = await supabase
            .from('users')
            .select('id, name, surname, age, sex, rating, role, created_at, phone, preferences')
            .eq('id', req.params.id)
            .single();

        if (userError || !user) return res.status(404).json({ error: 'User not found' });

        const { data: vehicle } = await supabase
            .from('vehicles')
            .select('make, model, plate_number')
            .eq('user_id', user.id)
            .maybeSingle();

        const { count: asDriverCount } = await supabase
            .from('rides')
            .select('*', { count: 'exact', head: true })
            .eq('driver_id', user.id)
            .eq('status', 'completed');

        const { count: asPassengerCount } = await supabase
            .from('bookings')
            .select('*', { count: 'exact', head: true })
            .eq('passenger_id', user.id)
            .eq('status', 'confirmed');

        res.json({
            ...user,
            vehicle,
            rides_as_driver: asDriverCount || 0,
            rides_as_passenger: asPassengerCount || 0
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * @swagger
 * /api/users/{id}:
 *   put:
 *     summary: Update user profile
 *     tags: [Users]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 */
router.put('/:id', async (req, res) => {
    const { id } = req.params;
    const { name, surname, age, sex, role, preferences } = req.body;
    try {
        const { data: user, error } = await supabase
            .from('users')
            .update({ name, surname, age, sex, role, preferences: preferences || [] })
            .eq('id', id)
            .select()
            .single();

        if (error) throw error;
        res.json(user);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * @swagger
 * /api/users/vehicle:
 *   post:
 *     summary: Update or add vehicle
 *     tags: [Users]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               user_id:
 *                 type: integer
 *               make:
 *                 type: string
 *               model:
 *                 type: string
 *               plate_number:
 *                 type: string
 *               total_seats:
 *                 type: integer
 */
router.post('/vehicle', async (req, res) => {
    const { user_id, make, model, plate_number, total_seats } = req.body;
    try {
        const { data: existing, error: findError } = await supabase
            .from('vehicles')
            .select('id')
            .eq('user_id', user_id)
            .maybeSingle();

        if (findError) throw findError;

        if (existing) {
            const { error: updateError } = await supabase
                .from('vehicles')
                .update({ make, model, plate_number, total_seats: total_seats || 5 })
                .eq('user_id', user_id);
            if (updateError) throw updateError;
        } else {
            const { error: insertError } = await supabase
                .from('vehicles')
                .insert([{ user_id, make, model, plate_number, total_seats: total_seats || 5 }]);
            if (insertError) throw insertError;
        }

        // Also update user role to driver if they were a passenger
        await supabase
            .from('users')
            .update({ role: 'driver' })
            .eq('id', user_id)
            .eq('role', 'passenger');

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * @swagger
 * /api/users/{id}/reviews:
 *   get:
 *     summary: Get driver reviews
 *     tags: [Users]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 */
router.get('/:id/reviews', async (req, res) => {
    try {
        const { data: reviews, error } = await supabase
            .from('reviews')
            .select(`
                *,
                users:reviewer_id (name)
            `)
            .eq('driver_id', req.params.id)
            .order('created_at', { ascending: false });

        if (error) throw error;

        const formattedReviews = reviews.map(r => ({
            ...r,
            reviewer_name: r.users?.name
        }));
        // Remove the nested users object
        formattedReviews.forEach(r => delete r.users);

        res.json(formattedReviews);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * @swagger
 * /api/users/{id}/bus-bookings:
 *   get:
 *     summary: Get user's bus ticket bookings
 *     tags: [Users]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 */
router.get('/:id/bus-bookings', async (req, res) => {
    try {
        const { data: bookings, error } = await supabase
            .from('bus_ticket_bookings')
            .select(`
                *,
                bus_tickets!inner (
                    from_city, to_city, from_address, to_address,
                    departure_date, departure_time, arrival_date, arrival_time,
                    transport_company, price, duration_minutes,
                    operator:users!operator_id (phone)
                )
            `)
            .or(`passenger_id.eq.${req.params.id},claimed_by_user_id.eq.${req.params.id}`)
            .eq('status', 'confirmed')
            .order('created_at', { ascending: false });

        if (error) throw error;

        // Security & Ownership filter:
        // 1. If claimed_by_user_id is set, it is authoritative (matches current user ID).
        // 2. If claimed_by_user_id is NOT set and booking is manual/carrier_contact, filter out (unclaimed manual booking must not leak).
        // 3. Otherwise (online non-manual booking), fallback to passenger_id matching user ID.
        const userPassengerBookings = (bookings || []).filter(b => {
            if (b.claimed_by_user_id) {
                return String(b.claimed_by_user_id) === String(req.params.id);
            }
            const isManual = b.channel === 'manual' || b.source_type === 'manual' || b.contact_role === 'carrier_contact';
            if (isManual) {
                return false;
            }
            return String(b.passenger_id) === String(req.params.id);
        });

        const result = userPassengerBookings.map(b => {
            const ticketData = b.bus_tickets;
            delete b.bus_tickets;
            return {
                ...b,
                ...ticketData,
                operator_phone: ticketData.operator?.phone,
                departure_time: ticketData.departure_time ? ticketData.departure_time.substring(0, 5) : ticketData.departure_time,
                arrival_time: ticketData.arrival_time ? ticketData.arrival_time.substring(0, 5) : ticketData.arrival_time,
                seat_numbers: typeof b.seat_numbers === 'string' ? JSON.parse(b.seat_numbers || '[]') : b.seat_numbers,
                passengers_data: typeof b.passengers_data === 'string' ? JSON.parse(b.passengers_data || '[]') : b.passengers_data
            };
        });
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
