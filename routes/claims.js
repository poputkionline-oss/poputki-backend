/**
 * routes/claims.js
 *
 * Offline Booking Claim & Passenger Onboarding API Routes (Phase E.3)
 * Project: POPUTKI.ONLINE
 *
 * Security & Anti-Abuse:
 * - Rate limited by client IP and user context (HTTP 429)
 * - SHA-256 hash token lookup
 * - Public ticket verification token requirement
 * - Server-only service-role access for claim persistence
 * - Dedicated shared secret for bot-only claim endpoints
 * - Tenant-scoped carrier approval, including strict legacy-trip ownership
 */

const crypto = require('crypto');
const express = require('express');
const router = express.Router();
const { getServiceRoleClient } = require('../dbServiceRole');
const { carrierAuth } = require('../utils/carrierAuth');
const {
    generateClaimSession,
    resolveClaimSession,
    evaluateAutoClaimEligibility,
    executeAtomicClaim,
    createClaimRequest,
    reviewClaimRequest,
    tripBelongsToCarrier
} = require('../utils/claimHelper');
const { cleanPhoneForStorage } = require('../utils/phoneHelper');
const { verifyTicketToken } = require('../utils/ticketHelper');

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

function safeSecretEqual(received, expected) {
    if (!received || !expected || typeof received !== 'string' || typeof expected !== 'string') {
        return false;
    }
    const a = Buffer.from(received);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireClaimBotSecret(req, res, next) {
    const configured = process.env.CLAIM_BOT_SHARED_SECRET;
    const received = req.headers['x-claim-bot-secret'];

    if (!configured) {
        console.error('[Claims] CLAIM_BOT_SHARED_SECRET is not configured');
        return res.status(503).json({ error: 'Telegram claim flow is not configured', code: 'CLAIM_BOT_NOT_CONFIGURED' });
    }

    if (!safeSecretEqual(received, configured)) {
        return res.status(401).json({ error: 'Unauthorized bot claim request', code: 'BOT_CLAIM_UNAUTHORIZED' });
    }

    next();
}

async function resolveOrCreateTelegramPassenger(claimDb, telegramUser, telegramContact) {
    const telegramId = telegramUser?.id;
    const contactUserId = telegramContact?.user_id;
    const normalizedPhone = cleanPhoneForStorage(telegramContact?.phone_number);

    if (!telegramId || !contactUserId || String(telegramId) !== String(contactUserId)) {
        return { success: false, error: 'TELEGRAM_CONTACT_USER_ID_MISMATCH' };
    }

    if (!normalizedPhone) {
        return { success: false, error: 'MISSING_CONTACT_PHONE' };
    }

    const { data: byTelegram, error: telegramLookupError } = await claimDb
        .from('users')
        .select('*')
        .eq('telegram_id', telegramId)
        .maybeSingle();

    if (telegramLookupError) {
        return { success: false, error: 'USER_LOOKUP_FAILED' };
    }

    if (byTelegram) {
        return { success: true, user: byTelegram, normalizedPhone };
    }

    const { data: byPhone, error: phoneLookupError } = await claimDb
        .from('users')
        .select('*')
        .eq('phone', normalizedPhone)
        .maybeSingle();

    if (phoneLookupError) {
        return { success: false, error: 'USER_LOOKUP_FAILED' };
    }

    if (byPhone) {
        if (byPhone.telegram_id && String(byPhone.telegram_id) !== String(telegramId)) {
            return { success: false, error: 'PHONE_ALREADY_LINKED_TO_ANOTHER_TELEGRAM' };
        }

        const updates = {
            telegram_id: telegramId,
            username: byPhone.username || telegramUser?.username || null,
            name: byPhone.name || telegramUser?.first_name || null,
            surname: byPhone.surname || telegramUser?.last_name || null
        };

        const { data: linked, error: linkError } = await claimDb
            .from('users')
            .update(updates)
            .eq('id', byPhone.id)
            .is('telegram_id', null)
            .select('*')
            .maybeSingle();

        if (linkError) {
            return { success: false, error: 'USER_LINK_FAILED' };
        }

        if (linked) {
            return { success: true, user: linked, normalizedPhone };
        }

        const { data: reloaded } = await claimDb
            .from('users')
            .select('*')
            .eq('id', byPhone.id)
            .maybeSingle();

        if (reloaded && String(reloaded.telegram_id) === String(telegramId)) {
            return { success: true, user: reloaded, normalizedPhone };
        }

        return { success: false, error: 'USER_LINK_CONFLICT' };
    }

    const { data: created, error: createError } = await claimDb
        .from('users')
        .insert([{
            phone: normalizedPhone,
            telegram_id: telegramId,
            name: telegramUser?.first_name || null,
            surname: telegramUser?.last_name || null,
            username: telegramUser?.username || null,
            role: 'passenger',
            source: 'telegram_claim'
        }])
        .select('*')
        .single();

    if (createError || !created) {
        if (createError?.code === '23505') {
            return { success: false, error: 'USER_LINK_CONFLICT' };
        }
        return { success: false, error: 'USER_CREATE_FAILED' };
    }

    return { success: true, user: created, normalizedPhone };
}

async function loadBotClaimSession(claimDb, sessionId) {
    if (!sessionId) return { success: false, error: 'SESSION_ID_REQUIRED' };

    const { data: session, error: sessionError } = await claimDb
        .from('booking_claim_sessions')
        .select('*')
        .eq('id', sessionId)
        .maybeSingle();

    if (sessionError || !session) {
        return { success: false, error: 'SESSION_NOT_FOUND' };
    }

    if (session.consumed_at) {
        return { success: false, error: 'SESSION_ALREADY_CONSUMED' };
    }

    if (new Date(session.expires_at) <= new Date()) {
        return { success: false, error: 'SESSION_EXPIRED' };
    }

    const { data: booking, error: bookingError } = await claimDb
        .from('bus_ticket_bookings')
        .select('*')
        .eq('id', session.booking_id)
        .maybeSingle();

    if (bookingError || !booking) {
        return { success: false, error: 'BOOKING_NOT_FOUND' };
    }

    if (booking.status !== 'confirmed') {
        return { success: false, error: 'BOOKING_NOT_CONFIRMED' };
    }

    if (booking.claim_status === 'claimed' || booking.claimed_by_user_id) {
        return { success: false, error: 'ALREADY_CLAIMED' };
    }

    return { success: true, session, booking };
}

router.post('/start-session', claimRateLimiter(15, 60000), async (req, res) => {
    try {
        const { ticketVerificationToken, bookingId } = req.body;

        if (!ticketVerificationToken || !bookingId) {
            return res.status(400).json({ error: 'Параметры билета обязательны' });
        }

        if (!verifyTicketToken(ticketVerificationToken, bookingId)) {
            return res.status(403).json({ error: 'Недействительный токен билета' });
        }

        const claimDb = getServiceRoleClient();
        const { data: booking, error: bookErr } = await claimDb
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

        if (booking.claim_status === 'claimed' || booking.claimed_by_user_id) {
            return res.status(400).json({ error: 'Билет уже подтвержден в Telegram', isClaimed: true });
        }

        const session = await generateClaimSession(booking.id);

        res.json({
            success: true,
            deepLink: session.deepLink,
            expiresAt: session.expiresAt
        });
    } catch (err) {
        console.error('[Claims] start-session failed:', err.message);
        res.status(500).json({ error: 'Не удалось создать сессию подтверждения билета' });
    }
});

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
        const claimDb = getServiceRoleClient();
        const { data: trip } = await claimDb
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
        console.error('[Claims] preview-trip failed:', err.message);
        res.status(500).json({ error: 'Не удалось открыть данные поездки' });
    }
});

/**
 * POST /api/claims/bot/open
 * Bot-only endpoint. Exchanges the raw deep-link token for a non-secret session id
 * plus a passenger-safe trip summary. The raw token is never persisted by the bot.
 */
router.post('/bot/open', claimRateLimiter(20, 60000), requireClaimBotSecret, async (req, res) => {
    try {
        const { sessionToken } = req.body;
        if (!sessionToken) {
            return res.status(400).json({ error: 'Токен сессии обязателен', code: 'SESSION_TOKEN_REQUIRED' });
        }

        const sessionResult = await resolveClaimSession(sessionToken, { markOpened: true });
        if (!sessionResult.isValid) {
            return res.status(400).json({ error: sessionResult.reason, code: sessionResult.reason });
        }

        const booking = sessionResult.booking;
        const claimDb = getServiceRoleClient();
        const { data: trip } = await claimDb
            .from('bus_tickets')
            .select('from_city, to_city, departure_date, departure_time, transport_company')
            .eq('id', booking.bus_ticket_id)
            .maybeSingle();

        return res.json({
            success: true,
            sessionId: sessionResult.session.id,
            expiresAt: sessionResult.session.expires_at,
            trip: {
                fromCity: trip?.from_city || booking.pickup_city,
                toCity: trip?.to_city || booking.drop_off_city,
                departureDate: trip?.departure_date || null,
                departureTime: trip?.departure_time || null,
                carrierName: trip?.transport_company || null,
                seatNumbers: booking.seat_numbers,
                passengerCount: booking.passenger_count || 1
            }
        });
    } catch (err) {
        console.error('[Claims] bot/open failed:', err.message);
        return res.status(500).json({ error: 'Не удалось открыть билет в Telegram', code: 'BOT_OPEN_FAILED' });
    }
});

/**
 * POST /api/claims/bot/verify-and-claim
 * Bot-only endpoint. Accepts only a native Telegram contact where contact.user_id
 * equals message.from.id. Resolves/creates the platform passenger server-side.
 */
router.post('/bot/verify-and-claim', claimRateLimiter(10, 60000), requireClaimBotSecret, async (req, res) => {
    try {
        const { sessionId, telegramUser, telegramContact } = req.body;
        const telegramSenderId = telegramUser?.id;

        if (!sessionId || !telegramSenderId || !telegramContact) {
            return res.status(400).json({ error: 'Недостаточно данных Telegram', code: 'TELEGRAM_DATA_REQUIRED' });
        }

        if (!telegramContact.user_id || String(telegramContact.user_id) !== String(telegramSenderId)) {
            return res.status(400).json({ error: 'Номер должен быть отправлен кнопкой Telegram', code: 'TELEGRAM_CONTACT_USER_ID_MISMATCH' });
        }

        const claimDb = getServiceRoleClient();
        const sessionResult = await loadBotClaimSession(claimDb, sessionId);
        if (!sessionResult.success) {
            return res.status(400).json({ error: sessionResult.error, code: sessionResult.error });
        }

        const identityResult = await resolveOrCreateTelegramPassenger(claimDb, telegramUser, telegramContact);
        if (!identityResult.success) {
            const status = identityResult.error === 'PHONE_ALREADY_LINKED_TO_ANOTHER_TELEGRAM' ? 409 : 400;
            return res.status(status).json({ error: identityResult.error, code: identityResult.error });
        }

        const booking = sessionResult.booking;
        const platformUser = identityResult.user;
        const evaluation = evaluateAutoClaimEligibility(
            booking,
            platformUser,
            telegramContact,
            telegramSenderId
        );

        if (evaluation.canAutoClaim) {
            const claimRes = await executeAtomicClaim(booking.id, platformUser.id, {
                sessionId: sessionResult.session.id
            });

            if (!claimRes.success) {
                return res.status(409).json({ error: claimRes.error, code: 'CLAIM_FAILED' });
            }

            return res.json({
                success: true,
                status: 'claimed',
                message: 'Билет подтвержден в вашем Telegram.',
                bookingId: booking.id
            });
        }

        const reqRes = await createClaimRequest(booking.id, platformUser.id, {
            method: 'telegram_contact',
            reason: evaluation.reason
        }, {
            sessionId: sessionResult.session.id
        });

        if (!reqRes.success) {
            return res.status(409).json({ error: reqRes.error, code: 'CLAIM_REQUEST_FAILED' });
        }

        return res.json({
            success: true,
            status: 'pending_verification',
            message: 'Запрос на подтверждение билета передан диспетчеру рейса.',
            requestId: reqRes.requestId,
            reason: evaluation.reason
        });
    } catch (err) {
        console.error('[Claims] bot/verify-and-claim failed:', err.message);
        return res.status(500).json({ error: 'Не удалось подтвердить билет', code: 'BOT_CLAIM_FAILED' });
    }
});

// Legacy endpoint retained for compatibility with existing clients. It still
// requires an already-linked platform user and is not used by the Telegram bot.
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
        const claimDb = getServiceRoleClient();

        let platformUser = null;
        if (telegramUser && telegramUser.id) {
            const { data: userRow } = await claimDb
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

        if (platformUser) {
            const reqRes = await createClaimRequest(booking.id, platformUser.id, {
                method: 'telegram_contact',
                reason: evaluation.reason
            }, {
                sessionId: session.id
            });

            if (!reqRes.success) {
                return res.status(409).json({ error: reqRes.error, code: 'CLAIM_REQUEST_FAILED' });
            }

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
        console.error('[Claims] verify-and-claim failed:', err.message);
        res.status(500).json({ error: 'Не удалось подтвердить билет' });
    }
});

router.get('/carrier/requests', carrierAuth, async (req, res) => {
    try {
        const carrierId = req.carrier?.carrier_id;
        if (!carrierId) {
            return res.status(401).json({ error: 'Авторизация перевозчика обязательна' });
        }

        const claimDb = getServiceRoleClient();
        const { data: requests, error } = await claimDb
            .from('booking_claim_requests')
            .select(`
                *,
                bus_ticket_bookings!inner (
                    id, passenger_name, seat_numbers, total_price, pickup_city, drop_off_city, phone, contact_role,
                    bus_tickets!inner (id, from_city, to_city, departure_date, departure_time, carrier_id, created_by_user_id)
                ),
                users:requesting_user_id (name, phone)
            `)
            .eq('status', 'pending')
            .order('created_at', { ascending: false });

        if (error) throw error;

        const carrierRequests = (requests || []).filter(r => {
            const ticket = r.bus_ticket_bookings?.bus_tickets;
            return tripBelongsToCarrier(ticket, carrierId);
        });

        res.json({ success: true, requests: carrierRequests });
    } catch (err) {
        console.error('[Claims] carrier requests failed:', err.message);
        res.status(500).json({ error: 'Не удалось загрузить запросы подтверждения' });
    }
});

router.post('/carrier/requests/:id/review', carrierAuth, async (req, res) => {
    try {
        const carrierId = req.carrier?.carrier_id;
        const reviewerUserId = req.carrier?.user_id;
        const { decision, reason } = req.body;

        if (!carrierId || !reviewerUserId) {
            return res.status(401).json({ error: 'Авторизация перевозчика обязательна' });
        }

        if (!['approved', 'rejected'].includes(decision)) {
            return res.status(400).json({ error: 'Решение должно быть approved или rejected' });
        }

        const reviewRes = await reviewClaimRequest(req.params.id, carrierId, decision, {
            reason,
            reviewerUserId
        });

        if (!reviewRes.success) {
            const status = reviewRes.error === 'TENANT_UNAUTHORIZED' ? 403 : 400;
            return res.status(status).json({ error: reviewRes.error });
        }

        res.json({ success: true, status: reviewRes.status });
    } catch (err) {
        console.error('[Claims] carrier review failed:', err.message);
        res.status(500).json({ error: 'Не удалось обработать запрос подтверждения' });
    }
});

module.exports = router;
