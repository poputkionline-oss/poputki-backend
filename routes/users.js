const express = require('express');
const router = express.Router();
const supabase = require('../db');
const { userAuth, optionalUserAuth } = require('../utils/userAuth');

/**
 * Phase E.48.4: User PII & Ownership Protection
 *
 * Rules:
 * - GET /:id/vehicle: Safe public projection (make, model, plate, color, seats).
 * - GET /:id/profile: Owner gets full profile (including phone & preferences).
 *                     Public/guest gets safe public projection (NO phone, NO preferences, NO internal IDs).
 * - PUT /:id: Requires userAuth. Owner only (req.user.id === :id). Strict allow-list of fields.
 *             Role, carrier_id, id, is_admin, phone, telegram_id, rating cannot be escalated.
 * - POST /vehicle: Requires userAuth. Vehicle upsert strictly pinned to req.user.id.
 * - GET /:id/reviews: Public reputation projection. Reviewer contact info / PII scrubbed.
 * - GET /:id/bus-bookings: Requires userAuth. Owner only (req.user.id === :id). Cross-user access returns 403.
 */

/**
 * @swagger
 * /api/users/{id}/vehicle:
 *   get:
 *     summary: Get user's vehicle (safe public projection)
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
            .select('id, user_id, make, model, plate_number, total_seats, color')
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
 *     summary: Get user profile (full owner projection if authenticated, safe public projection otherwise)
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
router.get('/:id/profile', optionalUserAuth, async (req, res) => {
    try {
        const requestedId = parseInt(req.params.id, 10);
        if (!requestedId || isNaN(requestedId)) {
            return res.status(400).json({ error: 'Некорректный ID пользователя' });
        }

        const isOwner = req.user && req.user.id === requestedId;

        const { data: user, error: userError } = await supabase
            .from('users')
            .select('id, name, surname, age, sex, rating, role, created_at, phone, preferences')
            .eq('id', requestedId)
            .single();

        if (userError || !user) return res.status(404).json({ error: 'User not found' });

        const { data: vehicle } = await supabase
            .from('vehicles')
            .select('make, model, plate_number, color')
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

        // Base public-safe profile projection
        const profileResponse = {
            id: user.id,
            name: user.name,
            surname: user.surname,
            age: user.age,
            sex: user.sex,
            rating: user.rating,
            role: user.role,
            created_at: user.created_at,
            vehicle,
            rides_as_driver: asDriverCount || 0,
            rides_as_passenger: asPassengerCount || 0
        };

        // Owner-only private fields
        if (isOwner) {
            profileResponse.phone = user.phone;
            profileResponse.preferences = user.preferences;
        }

        res.json(profileResponse);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * @swagger
 * /api/users/{id}:
 *   put:
 *     summary: Update user profile (owner only)
 *     tags: [Users]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 */
router.put('/:id', userAuth, async (req, res) => {
    const requestedId = parseInt(req.params.id, 10);
    if (!requestedId || isNaN(requestedId)) {
        return res.status(400).json({ error: 'Некорректный ID пользователя' });
    }

    if (req.user.id !== requestedId) {
        return res.status(403).json({ error: 'Доступ запрещен: нельзя редактировать чужой профиль' });
    }

    try {
        // Explicit allow-list of user-editable fields
        // Strictly prevent tampering with id, role, carrier_id, is_admin, phone, telegram_id, password, rating
        const { name, surname, age, sex, preferences } = req.body;
        const updateData = {};

        if (name !== undefined) updateData.name = typeof name === 'string' ? name.trim() : null;
        if (surname !== undefined) updateData.surname = typeof surname === 'string' ? surname.trim() : null;
        if (age !== undefined) updateData.age = parseInt(age, 10) || null;
        if (sex !== undefined) updateData.sex = ['male', 'female'].includes(sex) ? sex : null;
        if (preferences !== undefined) updateData.preferences = Array.isArray(preferences) ? preferences : [];

        const { data: updatedUser, error } = await supabase
            .from('users')
            .update(updateData)
            .eq('id', requestedId)
            .select()
            .single();

        if (error) throw error;

        const sanitized = { ...updatedUser };
        delete sanitized.password;
        res.json(sanitized);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * @swagger
 * /api/users/vehicle:
 *   post:
 *     summary: Update or add vehicle (authenticated owner only)
 *     tags: [Users]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               make:
 *                 type: string
 *               model:
 *                 type: string
 *               plate_number:
 *                 type: string
 *               total_seats:
 *                 type: integer
 */
router.post('/vehicle', userAuth, async (req, res) => {
    const { make, model, plate_number, total_seats, color } = req.body;
    const userId = req.user.id;

    // If client sends body user_id, ensure no cross-user spoofing attempt
    if (req.body.user_id && parseInt(req.body.user_id, 10) !== userId) {
        return res.status(403).json({ error: 'Доступ запрещен: нельзя изменять автомобиль другого пользователя' });
    }

    try {
        const { data: existing, error: findError } = await supabase
            .from('vehicles')
            .select('id')
            .eq('user_id', userId)
            .maybeSingle();

        if (findError) throw findError;

        if (existing) {
            const { error: updateError } = await supabase
                .from('vehicles')
                .update({
                    make,
                    model,
                    plate_number,
                    color: color || null,
                    total_seats: total_seats || 5
                })
                .eq('user_id', userId);
            if (updateError) throw updateError;
        } else {
            const { error: insertError } = await supabase
                .from('vehicles')
                .insert([{
                    user_id: userId,
                    make,
                    model,
                    plate_number,
                    color: color || null,
                    total_seats: total_seats || 5
                }]);
            if (insertError) throw insertError;
        }

        // Update user role to driver if they were a passenger
        await supabase
            .from('users')
            .update({ role: 'driver' })
            .eq('id', userId)
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
 *     summary: Get driver reviews (public reputation, PII-safe)
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
                id, driver_id, reviewer_id, rating, comment, created_at,
                users:reviewer_id (name)
            `)
            .eq('driver_id', req.params.id)
            .order('created_at', { ascending: false });

        if (error) throw error;

        const formattedReviews = (reviews || []).map(r => ({
            id: r.id,
            driver_id: r.driver_id,
            reviewer_id: r.reviewer_id,
            rating: r.rating,
            comment: r.comment,
            created_at: r.created_at,
            reviewer_name: r.users?.name || 'Пользователь'
        }));

        res.json(formattedReviews);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * @swagger
 * /api/users/{id}/bus-bookings:
 *   get:
 *     summary: Get user's bus ticket bookings (authenticated owner only)
 *     tags: [Users]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 */
router.get('/:id/bus-bookings', userAuth, async (req, res) => {
    const requestedId = parseInt(req.params.id, 10);
    if (!requestedId || isNaN(requestedId)) {
        return res.status(400).json({ error: 'Некорректный ID пользователя' });
    }

    if (req.user.id !== requestedId) {
        return res.status(403).json({ error: 'Доступ запрещен: нельзя просматривать билеты другого пользователя' });
    }

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
            .or(`passenger_id.eq.${requestedId},claimed_by_user_id.eq.${requestedId}`)
            .eq('status', 'confirmed')
            .order('created_at', { ascending: false });

        if (error) throw error;

        // Security & Ownership filter:
        // 1. If claimed_by_user_id is set, it is authoritative (matches current user ID).
        // 2. If claimed_by_user_id is NOT set and booking is manual/carrier_contact, filter out (unclaimed manual booking must not leak).
        // 3. Otherwise (online non-manual booking), fallback to passenger_id matching user ID.
        const userPassengerBookings = (bookings || []).filter(b => {
            if (b.claimed_by_user_id) {
                return String(b.claimed_by_user_id) === String(requestedId);
            }
            const isManual = b.channel === 'manual' || b.source_type === 'manual' || b.contact_role === 'carrier_contact';
            if (isManual) {
                return false;
            }
            return String(b.passenger_id) === String(requestedId);
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
