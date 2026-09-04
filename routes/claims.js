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

/**
 * @swagger
 * /api/claims/track-open:
 *   post:
 *     summary: Track passenger opening the verified ticket view (LINK_OPENED journey event)
 *     tags: [Claims]
 */
router.post('/track-open', claimRateLimiter(60, 60000), async (req, res) => {
    try {
        const { ticketToken, handoffId, preview } = req.body;

        // 1. Carrier preview exclusion: never record journey event for preview
        if (preview === 'carrier' || req.query.preview === 'carrier') {
            return res.json({ success: true, ignored: 'CARRIER_PREVIEW' });
        }
        if (req.user && ['carrier', 'admin', 'dispatcher'].includes(req.user.role)) {
            return res.json({ success: true, ignored: 'CARRIER_AUTH' });
        }

        // 2. Crawler & bot exclusion (WhatsApp/Telegram/Slack/Social scrapers)
        const userAgent = String(req.headers['user-agent'] || '').toLowerCase();
        const crawlerSignatures = [
            'bot', 'crawler', 'spider', 'preview', 'facebookexternalhit',
            'facebot', 'whatsapp', 'telegrambot', 'twitterbot', 'linkedinbot',
            'vkshare', 'slackbot', 'yandexbot', 'googlebot', 'bingbot',
            'baiduspider', 'duckduckbot', 'applebot'
        ];
        if (crawlerSignatures.some(sig => userAgent.includes(sig))) {
            return res.json({ success: true, ignored: 'CRAWLER' });
        }

        if (!ticketToken) {
            return res.status(400).json({ error: 'TICKET_TOKEN_REQUIRED' });
        }

        // 3. Cryptographic ticket token validation
        const { verifyTicketToken, extractBookingIdFromToken } = require('../utils/ticketHelper');
        const derivedBookingId = extractBookingIdFromToken(ticketToken);

        if (!derivedBookingId || !verifyTicketToken(ticketToken, derivedBookingId)) {
            return res.status(403).json({ error: 'INVALID_TICKET_TOKEN' });
        }

        // If client also supplied bookingId, verify strict equality
        if (req.body.bookingId && Number(req.body.bookingId) !== Number(derivedBookingId)) {
            return res.status(403).json({ error: 'BOOKING_ID_MISMATCH' });
        }

        const claimDb = getServiceRoleClient();
        let verifiedChannel = null;

        // 4. Validate handoffId binding if present
        if (handoffId) {
            const { data: handoffRow, error: hErr } = await claimDb
                .from('booking_handoffs')
                .select('id, booking_id, channel')
                .eq('id', handoffId)
                .maybeSingle();

            if (hErr || !handoffRow || Number(handoffRow.booking_id) !== Number(derivedBookingId)) {
                return res.status(400).json({ error: 'HANDOFF_BOOKING_MISMATCH' });
            }

            verifiedChannel = handoffRow.channel;
        }

        // 5. Record LINK_OPENED journey event
        const { recordJourneyEvent, JOURNEY_EVENT_TYPES } = require('../utils/journeyHelper');
        const eventRes = await recordJourneyEvent(derivedBookingId, {
            eventType: JOURNEY_EVENT_TYPES.LINK_OPENED,
            handoffId: handoffId || null,
            channel: verifiedChannel || null,
            actorType: 'passenger',
            metadata: {} // zero PII: no IP, no raw user-agent
        }, { supabaseClient: claimDb });

        return res.json({
            success: true,
            isDuplicate: Boolean(eventRes?.isDuplicate),
            eventId: eventRes?.event?.id || null
        });
    } catch (err) {
        console.warn('[Claims] track-open failed:', err.message);
        // Failure isolation: never break client display on analytics error
        return res.json({ success: false, error: err.message });
    }
});

router.post('/start-session', claimRateLimiter(15, 60000), async (req, res) => {
    try {
        const { ticketVerificationToken, bookingId, handoffId } = req.body;

        if (!ticketVerificationToken) {
            return res.status(400).json({ error: 'Параметры билета обязательны' });
        }

        const { verifyTicketToken, extractBookingIdFromToken } = require('../utils/ticketHelper');
        const derivedBookingId = extractBookingIdFromToken(ticketVerificationToken);
        if (!derivedBookingId || !verifyTicketToken(ticketVerificationToken, derivedBookingId)) {
            return res.status(403).json({ error: 'Недействительный токен билета' });
        }

        if (bookingId && Number(bookingId) !== Number(derivedBookingId)) {
            return res.status(403).json({ error: 'Идентификатор бронирования не совпадает с токеном' });
        }

        const claimDb = getServiceRoleClient();
        const { data: booking, error: bookErr } = await claimDb
            .from('bus_ticket_bookings')
            .select('*')
            .eq('id', derivedBookingId)
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

        // Validate and correlate handoffId if provided
        let verifiedHandoffId = null;
        if (handoffId) {
            const { data: handoffRow } = await claimDb
                .from('booking_handoffs')
                .select('id, booking_id')
                .eq('id', handoffId)
                .maybeSingle();

            if (handoffRow && Number(handoffRow.booking_id) === Number(booking.id)) {
                verifiedHandoffId = handoffRow.id;
            }
        }

        const session = await generateClaimSession(booking.id, { handoffId: verifiedHandoffId });

        // Phase P.1B Journey Logging: TELEGRAM_CTA_CLICKED
        try {
            const { recordJourneyEvent, JOURNEY_EVENT_TYPES } = require('../utils/journeyHelper');
            await recordJourneyEvent(booking.id, {
                eventType: JOURNEY_EVENT_TYPES.TELEGRAM_CTA_CLICKED,
                actorType: 'passenger',
                handoffId: verifiedHandoffId || null,
                sessionId: session?.id || null
            }, { supabaseClient: claimDb });
        } catch (ctaErr) {
            console.warn('[Claims] TELEGRAM_CTA_CLICKED logging failed:', ctaErr.message);
        }

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
        const { sessionToken, telegramUser } = req.body;
        if (!sessionToken) {
            return res.status(400).json({ error: 'Токен сессии обязателен', code: 'SESSION_TOKEN_REQUIRED' });
        }

        const sessionResult = await resolveClaimSession(sessionToken, { markOpened: true });
        if (!sessionResult.isValid) {
            return res.status(400).json({ error: sessionResult.reason, code: sessionResult.reason });
        }

        const booking = sessionResult.booking;
        const claimDb = getServiceRoleClient();

        let isAlreadyOwned = false;
        let isAutoClaimed = false;

        // SAFE KNOWN-USER AUTO-CLAIM SHORTCUT:
        // If the bot passes telegramUser, check if the sender is an existing verified user whose phone matches booking.phone
        if (telegramUser?.id) {
            const telegramSenderId = telegramUser.id;
            const { data: existingUser } = await claimDb
                .from('users')
                .select('*')
                .eq('telegram_id', telegramSenderId)
                .maybeSingle();

            if (existingUser) {
                if (booking.claim_status === 'claimed' || booking.claimed_by_user_id) {
                    if (String(booking.claimed_by_user_id) === String(existingUser.id)) {
                        isAlreadyOwned = true;
                    }
                } else {
                    const evalRes = evaluateAutoClaimEligibility(booking, existingUser, {}, telegramSenderId);
                    if (evalRes.canAutoClaim) {
                        const claimRes = await executeAtomicClaim(booking.id, existingUser.id, {
                            sessionId: sessionResult.session.id
                        });
                        if (claimRes.success) {
                            isAutoClaimed = true;
                            booking.claim_status = 'claimed';
                            booking.claimed_by_user_id = existingUser.id;
                        }
                    }
                }
            }
        }

        const { data: trip } = await claimDb
            .from('bus_tickets')
            .select('from_city, to_city, departure_date, departure_time, transport_company')
            .eq('id', booking.bus_ticket_id)
            .maybeSingle();

        // Phase P.1B Journey Logging: TELEGRAM_BOT_STARTED and PHONE_SHARE_REQUESTED
        const correlatedHandoffId = sessionResult.session.handoff_id || null;
        try {
            const { recordJourneyEvent, JOURNEY_EVENT_TYPES } = require('../utils/journeyHelper');
            await recordJourneyEvent(booking.id, {
                eventType: JOURNEY_EVENT_TYPES.TELEGRAM_BOT_STARTED,
                sessionId: sessionResult.session.id,
                handoffId: correlatedHandoffId,
                actorType: 'passenger',
                actorId: telegramUser?.id ? String(telegramUser.id) : null
            }, { supabaseClient: claimDb });

            if (isAutoClaimed) {
                await recordJourneyEvent(booking.id, {
                    eventType: JOURNEY_EVENT_TYPES.PHONE_VERIFIED,
                    sessionId: sessionResult.session.id,
                    handoffId: correlatedHandoffId,
                    actorType: 'system'
                }, { supabaseClient: claimDb });
                await recordJourneyEvent(booking.id, {
                    eventType: JOURNEY_EVENT_TYPES.CLAIM_COMPLETED,
                    sessionId: sessionResult.session.id,
                    handoffId: correlatedHandoffId,
                    actorType: 'system'
                }, { supabaseClient: claimDb });
                await recordJourneyEvent(booking.id, {
                    eventType: JOURNEY_EVENT_TYPES.BOOKING_LINKED_TO_USER,
                    sessionId: sessionResult.session.id,
                    handoffId: correlatedHandoffId,
                    actorType: 'system'
                }, { supabaseClient: claimDb });
                await recordJourneyEvent(booking.id, {
                    eventType: JOURNEY_EVENT_TYPES.ACTIVATION_COMPLETED,
                    sessionId: sessionResult.session.id,
                    handoffId: correlatedHandoffId,
                    actorType: 'system'
                }, { supabaseClient: claimDb });
            } else if (!isAlreadyOwned && booking.claim_status !== 'claimed') {
                await recordJourneyEvent(booking.id, {
                    eventType: JOURNEY_EVENT_TYPES.PHONE_SHARE_REQUESTED,
                    sessionId: sessionResult.session.id,
                    handoffId: correlatedHandoffId,
                    actorType: 'bot',
                    actorId: telegramUser?.id ? String(telegramUser.id) : null
                }, { supabaseClient: claimDb });
            }
        } catch (journeyBotErr) {
            console.warn('[Claims] Bot journey logging failed:', journeyBotErr.message);
        }

        return res.json({
            success: true,
            sessionId: sessionResult.session.id,
            expiresAt: sessionResult.session.expires_at,
            status: booking.claim_status || 'unclaimed',
            isAutoClaimed,
            isAlreadyOwned,
            requiresContact: !isAlreadyOwned && !isAutoClaimed && booking.claim_status !== 'claimed',
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
 * Bot-only endpoint. Accepts native Telegram contact or known verified user identity.
 * Resolves/creates the platform passenger server-side and executes atomic claim.
 */
router.post('/bot/verify-and-claim', claimRateLimiter(10, 60000), requireClaimBotSecret, async (req, res) => {
    try {
        const { sessionId, telegramUser, telegramContact } = req.body;
        const telegramSenderId = telegramUser?.id;

        if (!sessionId || !telegramSenderId) {
            return res.status(400).json({ error: 'Недостаточно данных Telegram', code: 'TELEGRAM_DATA_REQUIRED' });
        }

        const claimDb = getServiceRoleClient();
        const sessionResult = await loadBotClaimSession(claimDb, sessionId);
        if (!sessionResult.success) {
            return res.status(400).json({ error: sessionResult.error, code: sessionResult.error });
        }

        const booking = sessionResult.booking;

        let platformUser = null;
        if (telegramUser?.id) {
            const { data: existingUser } = await claimDb
                .from('users')
                .select('*')
                .eq('telegram_id', telegramUser.id)
                .maybeSingle();

            if (existingUser) {
                platformUser = existingUser;
            }
        }

        if (!platformUser) {
            if (!telegramContact || !telegramContact.user_id || String(telegramContact.user_id) !== String(telegramSenderId)) {
                return res.status(400).json({ error: 'Номер должен быть отправлен кнопкой Telegram', code: 'TELEGRAM_CONTACT_USER_ID_MISMATCH' });
            }
            const identityResult = await resolveOrCreateTelegramPassenger(claimDb, telegramUser, telegramContact);
            if (!identityResult.success) {
                const status = identityResult.error === 'PHONE_ALREADY_LINKED_TO_ANOTHER_TELEGRAM' ? 409 : 400;
                return res.status(status).json({ error: identityResult.error, code: identityResult.error });
            }
            platformUser = identityResult.user;
        }

        // Phase P.1B Journey Logging: PHONE_SHARED
        const correlatedHandoffId = sessionResult.session.handoff_id || null;
        try {
            const { recordJourneyEvent, JOURNEY_EVENT_TYPES } = require('../utils/journeyHelper');
            await recordJourneyEvent(booking.id, {
                eventType: JOURNEY_EVENT_TYPES.PHONE_SHARED,
                sessionId: sessionResult.session.id,
                handoffId: correlatedHandoffId,
                actorType: 'passenger',
                actorId: String(telegramSenderId),
                phone: telegramContact?.phone_number || null
            }, { supabaseClient: claimDb });
        } catch (phoneLogErr) {
            console.warn('[Claims] PHONE_SHARED logging failed:', phoneLogErr.message);
        }

        const evaluation = evaluateAutoClaimEligibility(
            booking,
            platformUser,
            telegramContact || {},
            telegramSenderId
        );

        if (evaluation.canAutoClaim) {
            const claimRes = await executeAtomicClaim(booking.id, platformUser.id, {
                sessionId: sessionResult.session.id
            });

            if (!claimRes.success) {
                return res.status(409).json({ error: claimRes.error, code: 'CLAIM_FAILED' });
            }

            // Phase P.1B Journey Logging: CLAIM_COMPLETED, ACTIVATION_COMPLETED
            try {
                const { recordJourneyEvent, JOURNEY_EVENT_TYPES } = require('../utils/journeyHelper');
                await recordJourneyEvent(booking.id, {
                    eventType: JOURNEY_EVENT_TYPES.PHONE_VERIFIED,
                    sessionId: sessionResult.session.id,
                    handoffId: correlatedHandoffId,
                    actorType: 'system',
                    actorId: String(platformUser.id),
                    phone: telegramContact?.phone_number || null
                }, { supabaseClient: claimDb });
                await recordJourneyEvent(booking.id, {
                    eventType: JOURNEY_EVENT_TYPES.CLAIM_COMPLETED,
                    sessionId: sessionResult.session.id,
                    handoffId: correlatedHandoffId,
                    actorType: 'system',
                    actorId: String(platformUser.id)
                }, { supabaseClient: claimDb });
                await recordJourneyEvent(booking.id, {
                    eventType: JOURNEY_EVENT_TYPES.BOOKING_LINKED_TO_USER,
                    sessionId: sessionResult.session.id,
                    handoffId: correlatedHandoffId,
                    actorType: 'system',
                    actorId: String(platformUser.id)
                }, { supabaseClient: claimDb });
                await recordJourneyEvent(booking.id, {
                    eventType: JOURNEY_EVENT_TYPES.ACTIVATION_COMPLETED,
                    sessionId: sessionResult.session.id,
                    handoffId: correlatedHandoffId,
                    actorType: 'system',
                    actorId: String(platformUser.id)
                }, { supabaseClient: claimDb });
            } catch (claimLogErr) {
                console.warn('[Claims] Claim completion journey logging failed:', claimLogErr.message);
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

        // Phase P.1B Journey Logging: PHONE_MISMATCH & CLAIM_REQUEST_CREATED
        try {
            const { recordJourneyEvent, JOURNEY_EVENT_TYPES } = require('../utils/journeyHelper');
            await recordJourneyEvent(booking.id, {
                eventType: JOURNEY_EVENT_TYPES.PHONE_MISMATCH,
                sessionId: sessionResult.session.id,
                handoffId: correlatedHandoffId,
                actorType: 'system',
                actorId: String(platformUser.id),
                phone: telegramContact?.phone_number || null,
                metadata: { reason: evaluation.reason }
            }, { supabaseClient: claimDb });
            await recordJourneyEvent(booking.id, {
                eventType: JOURNEY_EVENT_TYPES.CLAIM_REQUEST_CREATED,
                sessionId: sessionResult.session.id,
                handoffId: correlatedHandoffId,
                actorType: 'system',
                actorId: String(platformUser.id),
                metadata: { requestId: reqRes.requestId, reason: evaluation.reason }
            }, { supabaseClient: claimDb });
        } catch (reqLogErr) {
            console.warn('[Claims] Claim request journey logging failed:', reqLogErr.message);
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

        if (decision === 'approved') {
            try {
                const { recordJourneyEvent, JOURNEY_EVENT_TYPES } = require('../utils/journeyHelper');
                const claimDb = getServiceRoleClient();
                const { data: reqRow } = await claimDb
                    .from('booking_claim_requests')
                    .select('booking_id, requesting_user_id')
                    .eq('id', req.params.id)
                    .maybeSingle();

                if (reqRow) {
                    await recordJourneyEvent(reqRow.booking_id, {
                        eventType: JOURNEY_EVENT_TYPES.CLAIM_COMPLETED,
                        actorType: 'carrier',
                        actorId: String(reviewerUserId),
                        metadata: { decision: 'approved', requestId: req.params.id }
                    }, { supabaseClient: claimDb });
                    await recordJourneyEvent(reqRow.booking_id, {
                        eventType: JOURNEY_EVENT_TYPES.BOOKING_LINKED_TO_USER,
                        actorType: 'carrier',
                        actorId: String(reqRow.requesting_user_id)
                    }, { supabaseClient: claimDb });
                    await recordJourneyEvent(reqRow.booking_id, {
                        eventType: JOURNEY_EVENT_TYPES.ACTIVATION_COMPLETED,
                        actorType: 'carrier',
                        actorId: String(reqRow.requesting_user_id)
                    }, { supabaseClient: claimDb });
                }
            } catch (revLogErr) {
                console.warn('[Claims] Review approval journey logging failed:', revLogErr.message);
            }
        }

        res.json({ success: true, status: reviewRes.status });
    } catch (err) {
        console.error('[Claims] carrier review failed:', err.message);
        res.status(500).json({ error: 'Не удалось обработать запрос подтверждения' });
    }
});

module.exports = router;
