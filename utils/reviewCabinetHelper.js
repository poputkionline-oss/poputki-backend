'use strict';
const { getServiceRoleClient } = require('../dbServiceRole');
const PAGE_SIZE = 20;

function reviewCabinetHandler(received) {
    return async (req, res) => {
        const page = Number(req.query.page ?? 1);
        if (!Number.isSafeInteger(page) || page < 1 || page > 1000000) {
            return res.status(400).json({ error: 'INVALID_PAGE' });
        }
        // Identity comes exclusively from the authentication middleware.
        const ownerId = received ? req.carrier?.carrier_id : req.user?.id;
        if (!Number.isSafeInteger(ownerId) || ownerId < 1) return res.status(401).json({ error: 'AUTH_REQUIRED' });
        try {
            const db = getServiceRoleClient();
            const person = received ? 'users:reviewer_id(name)' : 'users:driver_id(name)';
            let query = db.from('reviews').select(`id,ride_id,bus_ticket_id,rating,comment,created_at,${person},bus_tickets:bus_ticket_id(from_city,to_city,departure_date,transport_company),rides:ride_id(from_city,to_city,date)`, { count: 'exact' })
                .eq(received ? 'driver_id' : 'reviewer_id', ownerId);
            if (received) query = query.not('bus_ticket_id', 'is', null);
            const { data, count, error } = await query.order('created_at', { ascending: false }).order('id', { ascending: false }).range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);
            if (error) throw error;
            let rating = null;
            if (received) {
                const result = await db.rpc('fn_carrier_bus_review_summary', { p_carrier_id: ownerId });
                if (result.error) throw result.error;
                rating = result.data?.rating ?? null;
            }
            res.json({ page, page_size: PAGE_SIZE, count: count ?? 0, rating, reviews: (data || []).map(r => {
                const trip = r.bus_tickets || r.rides;
                return { id: r.id, rating: r.rating, comment: r.comment, created_at: r.created_at,
                    type: r.bus_ticket_id ? 'bus' : 'ride', trip_id: r.bus_ticket_id || r.ride_id,
                    from_city: trip?.from_city, to_city: trip?.to_city,
                    trip_date: trip?.departure_date || trip?.date,
                    person_name: r.users?.name || (received ? 'Пассажир' : 'Перевозчик'),
                    company: r.bus_tickets?.transport_company || null };
            }) });
        } catch (_) { res.status(500).json({ error: 'REVIEWS_UNAVAILABLE', message: 'Не удалось загрузить отзывы. Повторите позже.' }); }
    };
}
module.exports = { reviewCabinetHandler };
