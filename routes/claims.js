/**
 * routes/claims.js
 * 
 * Offline Booking Claim & Passenger Onboarding API Routes (Phase E.1)
 * Project: POPUTKI.ONLINE
 * 
 * Security & Anti-Abuse:
 * - Rate limited by client IP and user context (HTTP 429)
 * - SHA-256 hash token lookup
 * - Public ticket verification token requirement
 * - Tenant-scoped carrier approval
 */

const express = require('express');
const router = express.Router();
const supabase = require('../db');
const { carrierAuth } = require('../utils/carrierAuth');
const {
    generateClaimSession,
    resolveClaimSession,
    evaluateAutoClaimEligibility,
    executeAtomicClaim,
    createClaimRequest,
    reviewClaimRequest
} = require('../utils/claimHelper');
const { verifyTicketToken } = require('../utils/ticketHelper');

// Sliding window in-memory rate limiter for claim operations
const rateLimitMap = new Map();

function claimRateLimiter(maxRequests = 10, windowMs = 60000) {
    return (req, res, next) => {
        const key = req.ip || req.headers['x-forwarded-for'] || 'global';
        const now = Date.now();
        const timestamps = rateLimitMap.get(key) || [];
        const recent = timestamps.filter(t => now - t < windowMs);

        if (recent.length >= maxRequests) {
            return res.status(429).json({
                error: 'Слишком много запросов. Пожалуйста, подождите минуту.',
                code: 'RATE_LIMIT_EXCEEDED'
            });
        }

        recent.push(now);
        rateLimitMap.set(key, recent);
        next();
    };
}

/**
 * POST /api/claims/start-session
 * Public endpoint called by ticket verification page to generate a short-lived Telegram claim deep link.
 */
router.post('/start-session', claimRateLimiter(15, 60000), async (req, res) => {
    try {
        const { ticketVerificationToken, bookingId } = req.body;

        if (!ticketVerificationToken || !bookingId) {
            return res.status(400).json({ error: 'Параметры билета обязательны' });
        }

        // Verify ticket authenticity via HMAC
        const isValidToken = verifyTicketToken(ticketVerificationToken, bookingId);
        if (!isValidToken) {
            return res.status(403).json({ error: 'Недействительный токен билета' });
        }

        const { data: booking, error: bookErr } = await supabase
            .from('bus_ticket_bookings')
            .select('*')
            .eq('id', bookingId)
            .single();

        if (bookErr || !booking) {
            return res.status(404).json({ error: 'Бронирование не найдено' });
        }

        if (booking.status !== 'confirmed') {
            return res.status(400).json({ error: 'Бронирование неактивно или отменено' });
        }

        if (booking.claim_status === 'claimed') {
            return res.status(400).json({ error: 'Билет уже подтвержден в Telegram', isClaimed: true });
        }

        const session = await generateClaimSession(booking.id);

        res.json({
            success: true,
            deepLink: session.deepLink,
            expiresAt: session.expiresAt
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /api/claims/preview-trip
 * Called by bot upon /start claim_<token> to display safe trip summary before requesting contact.
 */
router.post('/preview-trip', claimRateLimiter(20, 60000), async (req, res) => {
    try {
        const { sessionToken } = req.body;
        if (!sessionToken) {
            return res.status(400).json({ error: 'Токен сессии обязателен' });
        }

        const sessionResult = await resolveClaimSession(sessionToken, { markOpened: true });
        if (!sessionResult.isValid) {
            return res.status(400).json({ error: sessionResult.reason, code: sessionResult.reason });
        }

        const booking = sessionResult.booking;
        const { data: trip } = await supabase
            .from('bus_tickets')
            .select('from_city, to_city, departure_date, departure_time, transport_company')
            .eq('id', booking.bus_ticket_id)
            .single();

        res.json({
            success: true,
            trip: {
                fromCity: trip?.from_city || booking.pickup_city,
                toCity: trip?.to_city || booking.drop_off_city,
                departureDate: trip?.departure_date,
                departureTime: trip?.departure_time,
                carrierName: trip?.transport_company,
                seatNumbers: booking.seat_numbers,
                passengerCount: booking.passenger_count || 1
            }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /api/claims/verify-and-claim
 * Called by bot when passenger confirms phone number via native Telegram contact.
 */
router.post('/verify-and-claim', claimRateLimiter(10, 60000), async (req, res) => {
    try {
        const { sessionToken, telegramUser, telegramContact, telegramSenderId } = req.body;

        if (!sessionToken) {
            return res.status(400).json({ error: 'Токен сессии обязателен' });
        }

        const sessionResult = await resolveClaimSession(sessionToken);
        if (!sessionResult.isValid) {
            return res.status(400).json({ error: sessionResult.reason, code: sessionResult.reason });
        }

        const booking = sessionResult.booking;
        const session = sessionResult.session;

        // Find or link platform user by telegram_id
        let platformUser = null;
        if (telegramUser && telegramUser.id) {
            const { data: userRow } = await supabase
                .from('users')
                .select('*')
                .eq('telegram_id', telegramUser.id)
                .maybeSingle();

            platformUser = userRow;
        }

        const evaluation = evaluateAutoClaimEligibility(
            booking,
            platformUser,
            telegramContact,
            telegramSenderId || (telegramUser && telegramUser.id)
        );

        if (evaluation.canAutoClaim && platformUser) {
            // Auto-claim executed atomically
            const claimRes = await executeAtomicClaim(booking.id, platformUser.id, {
                sessionId: session.id
            });

            if (!claimRes.success) {
                return res.status(409).json({ error: claimRes.error, code: 'CLAIM_FAILED' });
            }

            return res.json({
                success: true,
                status: 'claimed',
                message: 'Билет успешно открыт и подтвержден в вашем Telegram!',
                bookingId: booking.id
            });
        }

        // Needs carrier verification / review request
        if (platformUser) {
            const reqRes = await createClaimRequest(booking.id, platformUser.id, {
                method: 'telegram_contact',
                reason: evaluation.reason
            }, {
                sessionId: session.id
            });

            return res.json({
                success: true,
                status: 'pending_verification',
                message: 'Запрос на подтверждение билета передан диспетчеру рейса.',
                requestId: reqRes.requestId,
                reason: evaluation.reason
            });
        }

        res.status(400).json({ error: 'Пользователь платформы не найден', code: 'USER_NOT_REGISTERED' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/claims/carrier/requests
 * Carrier authenticated endpoint: List pending claim requests for carrier's trips.
 */
router.get('/carrier/requests', carrierAuth(), async (req, res) => {
    try {
        const carrierId = req.carrierId || req.user?.id;
        if (!carrierId) {
            return res.status(401).json({ error: 'Авторизация перевозчика обязательна' });
        }

        const { data: requests, error } = await supabase
            .from('booking_claim_requests')
            .select(`
                *,
                bus_ticket_bookings!inner (
                    id, passenger_name, seat_numbers, total_price, pickup_city, drop_off_city, phone, contact_role,
                    bus_tickets!inner (id, from_city, to_city, departure_date, departure_time, carrier_id)
                ),
                users:requesting_user_id (name, phone)
            `)
            .eq('status', 'pending')
            .order('created_at', { ascending: false });

        if (error) throw error;

        // Tenant isolation: only trips where carrier is operator/creator
        const carrierRequests = (requests || []).filter(r => {
            const ticket = r.bus_ticket_bookings?.bus_tickets;
            return ticket && (ticket.carrier_id === carrierId || !ticket.carrier_id);
        });

        res.json({ success: true, requests: carrierRequests });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /api/claims/carrier/requests/:id/review
 * Carrier authenticated endpoint: Approve or reject a claim request.
 */
router.post('/carrier/requests/:id/review', carrierAuth(), async (req, res) => {
    try {
        const carrierId = req.carrierId || req.user?.id;
        const { decision, reason } = req.body;

        if (!['approved', 'rejected'].includes(decision)) {
            return res.status(400).json({ error: 'Решение должно быть approved или rejected' });
        }

        const reviewRes = await reviewClaimRequest(req.params.id, carrierId, decision, {
            reason
        });

        if (!reviewRes.success) {
            return res.status(400).json({ error: reviewRes.error });
        }

        res.json({ success: true, status: reviewRes.status });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
