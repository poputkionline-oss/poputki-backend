const express = require('express');
const router = express.Router();
const supabase = require('../db');
const { userAuth } = require('../utils/userAuth');

/**
 * @swagger
 * /api/reviews:
 *   post:
 *     summary: Submit a review for a ride
 *     tags: [Reviews]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               ride_id:
 *                 type: integer
 *               reviewer_id:
 *                 type: integer
 *               driver_id:
 *                 type: integer
 *               rating:
 *                 type: integer
 *               comment:
 *                 type: string
 */
router.post('/', userAuth, async (req, res) => {
    const { ride_id, driver_id, rating, comment } = req.body;
    const reviewer_id = req.user.id;
    try {
        const { data: ride } = await supabase
            .from('rides')
            .select('status')
            .eq('id', ride_id)
            .single();

        if (!ride || ride.status !== 'completed') {
            return res.status(400).json({ error: 'Можно оставить отзыв только для завершенной поездки.' });
        }

        const { data: booking } = await supabase
            .from('bookings')
            .select('id')
            .eq('ride_id', ride_id)
            .eq('passenger_id', reviewer_id)
            .maybeSingle();

        if (!booking) {
            return res.status(403).json({ error: 'Вы не участвовали в этой поездке.' });
        }

        const { data: existing } = await supabase
            .from('reviews')
            .select('id')
            .eq('ride_id', ride_id)
            .eq('reviewer_id', reviewer_id)
            .maybeSingle();

        if (existing) {
            return res.status(400).json({ error: 'Вы уже оставили отзыв для этой поездки.' });
        }

        await supabase
            .from('reviews')
            .insert([{ ride_id, reviewer_id, driver_id, rating, comment }]);

        // Calculate Average
        const { data: reviews } = await supabase
            .from('reviews')
            .select('rating')
            .eq('driver_id', driver_id);

        if (reviews && reviews.length > 0) {
            const sum = reviews.reduce((acc, curr) => acc + curr.rating, 0);
            const avg = sum / reviews.length;

            await supabase
                .from('users')
                .update({ rating: parseFloat(avg.toFixed(1)) })
                .eq('id', driver_id);
        }

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
