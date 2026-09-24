/**
 * routes/labbay.js
 *
 * Labbay Dynamic Knowledge Base integration.
 *
 * Scope: answers customer questions about published, currently available
 * INTERNATIONAL bus trips only. Never touches carpool (`rides`) search and
 * never creates/modifies bookings — read-only.
 *
 * Contract (Labbay Dynamic Knowledge Base API):
 *   POST /api/labbay/knowledge
 *   Headers: Content-Type: application/json, X-Api-Key: <LABBAY_API_KEY>
 *   Body:    { "query": "<customer question>" }
 *   Success: HTTP 200 { "content": "<answer text>" }
 *   Labbay's own request timeout is 5s and it caches identical answers for
 *   5 minutes, so seat availability here is only accurate "at check time" —
 *   the response text says so; the booking flow itself re-confirms the seat.
 */

'use strict';

const express = require('express');
const router = express.Router();
const supabase = require('../db');
const { constantTimeEqual } = require('../utils/adminTokenAuth');
const { calculateTripFillStats, getBusinessLocalDate, getBusinessLocalTime } = require('../utils/dashboardHelper');
const {
    MAX_QUERY_LENGTH,
    MAX_CONTENT_BYTES,
    MAX_RESULTS,
    isConfidentInternationalRoute,
    parseIntent,
    routeMatchesIntent,
    hasTicketAlreadyDeparted,
    formatTripLine,
    buildClarifyingQuestion,
    buildNoResultsMessage,
    truncateToByteLimit
} = require('../utils/labbayKnowledgeHelper');

const DEFAULT_REQUEST_BUDGET_MS = 4500; // stay under Labbay's 5s timeout

// Read fresh per-request (not a module-level constant) so tests can exercise
// the abort path deterministically via LABBAY_REQUEST_BUDGET_MS without a
// multi-second real sleep; production always gets the 4500ms default.
function getRequestBudgetMs() {
    const override = Number(process.env.LABBAY_REQUEST_BUDGET_MS);
    return Number.isFinite(override) && override > 0 ? override : DEFAULT_REQUEST_BUDGET_MS;
}

function requireLabbayApiKey(req, res, next) {
    const configured = process.env.LABBAY_API_KEY;
    if (!configured) {
        console.error('[Labbay] LABBAY_API_KEY is not configured in environment!');
        return res.status(500).json({ error: 'Internal server security configuration error' });
    }

    const provided = req.headers['x-api-key'];
    if (!constantTimeEqual(provided, configured)) {
        return res.status(401).json({ error: 'Unauthorized: invalid or missing X-Api-Key' });
    }

    return next();
}

async function handleKnowledgeQuery(req, res, signal) {
    // Guards every response write against the sibling timeout handler in the
    // route below already having sent a response first.
    const send = (status, body) => {
        if (res.headersSent) return;
        res.status(status).json(body);
    };

    const { query } = req.body || {};

    if (typeof query !== 'string' || query.trim().length === 0) {
        return send(400, { error: 'Field "query" (non-empty string) is required' });
    }
    if (query.length > MAX_QUERY_LENGTH) {
        return send(400, { error: `Field "query" must be at most ${MAX_QUERY_LENGTH} characters` });
    }

    // "Today" and "already departed" are always measured in the single
    // Asia/Dushanbe business-local clock (utils/dashboardHelper.js), never
    // a UTC calendar date or the server process's own local timezone. Using
    // two different notions of "now" in the same handler was exactly the
    // bug: Asia/Dushanbe is UTC+5, so it is already "tomorrow" there for
    // roughly 5 hours (UTC ~19:00-23:59) before a UTC-based check agrees —
    // a window in which trips could wrongly show as bookable after they'd
    // actually departed, or a same-day trip could be silently skipped from
    // "already departed" filtering entirely.
    const now = new Date();
    const todayIso = getBusinessLocalDate();
    const nowLocalTime = getBusinessLocalTime();

    const { data: knownCities, error: citiesError } = await supabase
        .from('cities')
        .select('name')
        .eq('type', 'bus')
        .abortSignal(signal);
    if (citiesError) {
        console.error('[Labbay] Failed to load cities reference list:', citiesError.message);
    }

    const intent = parseIntent(query, knownCities || [], todayIso);

    if (intent.missing.length > 0) {
        return send(200, { content: buildClarifyingQuestion(intent.missing) });
    }

    // A date strictly in the past (business-local) can never have an
    // active, bookable trip.
    if (intent.date < todayIso) {
        return send(200, { content: buildNoResultsMessage(intent.cities, intent.date) });
    }

    const { data: tickets, error: ticketsError } = await supabase
        .from('bus_tickets')
        .select('id, from_city, to_city, departure_date, departure_time, price, status, total_seats')
        .eq('status', 'active')
        .eq('departure_date', intent.date)
        .abortSignal(signal);

    if (ticketsError) throw ticketsError;

    let candidates = (tickets || []).filter(t =>
        routeMatchesIntent(t, intent) &&
        isConfidentInternationalRoute(t.from_city, t.to_city) &&
        !hasTicketAlreadyDeparted(t, todayIso, nowLocalTime)
    );

    candidates.sort((a, b) => String(a.departure_time || '').localeCompare(String(b.departure_time || '')));
    candidates = candidates.slice(0, MAX_RESULTS);

    if (candidates.length === 0) {
        return send(200, { content: buildNoResultsMessage(intent.cities, intent.date) });
    }

    // passengers_data (names, gender, document numbers — see
    // routes/busBookings.js insert) is deliberately NOT selected here.
    // calculateTripFillStats()'s free_seats — the only stat this endpoint
    // reads — comes entirely from seat_numbers/status/hold_expires_at/
    // created_at; passengers_data only ever feeds its passenger-count
    // aggregates (getBookingPassengerCount(), which itself prefers
    // booking.passenger_count first, always set at insert), none of which
    // this endpoint surfaces. Selecting it would pull passenger PII into
    // memory for zero benefit.
    const ticketIds = candidates.map(t => t.id);
    const { data: bookings, error: bookingsError } = await supabase
        .from('bus_ticket_bookings')
        .select('id, bus_ticket_id, status, seat_numbers, hold_expires_at, created_at, boarding_status')
        .in('bus_ticket_id', ticketIds)
        .abortSignal(signal);
    if (bookingsError) throw bookingsError;

    const bookingsByTicket = new Map();
    for (const b of bookings || []) {
        const key = b.bus_ticket_id;
        if (!bookingsByTicket.has(key)) bookingsByTicket.set(key, []);
        bookingsByTicket.get(key).push(b);
    }

    const bookingBaseUrl = process.env.MINI_APP_URL || 'https://poputki.online';

    const lines = candidates.map(ticket => {
        const ticketBookings = bookingsByTicket.get(ticket.id) || [];
        const stats = calculateTripFillStats(ticket, ticketBookings, now);
        return formatTripLine(ticket, stats.free_seats, bookingBaseUrl);
    });

    const content = truncateToByteLimit(lines.join('\n'), MAX_CONTENT_BYTES);
    return send(200, { content });
}

/**
 * @swagger
 * /api/labbay/knowledge:
 *   post:
 *     summary: Labbay Dynamic Knowledge Base endpoint — international bus trips only
 *     tags: [Labbay]
 *     parameters:
 *       - in: header
 *         name: X-Api-Key
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               query:
 *                 type: string
 *     responses:
 *       200:
 *         description: Answer for Labbay's AI bot
 */
router.post('/knowledge', requireLabbayApiKey, async (req, res) => {
    // A plain setTimeout that only sends a 504 does NOT stop the Supabase
    // query still in flight underneath it — the outbound HTTP request to
    // PostgREST (and the Node-side work of waiting on it) keeps running
    // after Labbay has already given up. The AbortController below is
    // threaded into every query via .abortSignal(), so timing out here
    // aborts that in-flight HTTP request at the Node/fetch level instead of
    // merely abandoning an unawaited promise. This does NOT, by itself,
    // prove the underlying SQL statement is killed inside Postgres — that
    // depends on PostgREST/Postgres propagating the client disconnect to a
    // server-side query cancellation (standard Postgres behavior on
    // connection abort, but outside what this process controls or a unit
    // test can observe).
    const controller = new AbortController();
    let settled = false;

    const timeoutTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        controller.abort();
        res.status(504).json({ error: 'Internal processing timeout' });
    }, getRequestBudgetMs());

    try {
        await handleKnowledgeQuery(req, res, controller.signal);
    } catch (err) {
        if (err.name === 'AbortError' || controller.signal.aborted) {
            // Expected: the timeout above already aborted the query and
            // responded 504. Nothing left to do.
        } else {
            console.error('[Labbay] Knowledge query error:', err.message);
            if (!settled && !res.headersSent) {
                res.status(500).json({ error: 'Internal server error' });
            }
        }
    } finally {
        settled = true;
        clearTimeout(timeoutTimer);
    }
});

module.exports = router;
