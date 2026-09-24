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
const { calculateTripFillStats, getBusinessLocalDate } = require('../utils/dashboardHelper');
const {
    MAX_QUERY_LENGTH,
    MAX_CONTENT_BYTES,
    MAX_RESULTS,
    isConfidentInternationalRoute,
    parseIntent,
    routeMatchesCities,
    formatTripLine,
    buildClarifyingQuestion,
    buildNoResultsMessage,
    truncateToByteLimit
} = require('../utils/labbayKnowledgeHelper');

const REQUEST_BUDGET_MS = 4500; // stay under Labbay's 5s timeout

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

async function handleKnowledgeQuery(req, res) {
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

    const now = new Date();
    const currentDate = now.toISOString().split('T')[0];
    const currentTime = now.toTimeString().split(' ')[0];
    const todayIso = getBusinessLocalDate();

    const { data: knownCities, error: citiesError } = await supabase
        .from('cities')
        .select('name')
        .eq('type', 'bus');
    if (citiesError) {
        console.error('[Labbay] Failed to load cities reference list:', citiesError.message);
    }

    const intent = parseIntent(query, knownCities || [], todayIso);

    if (intent.missing.length > 0) {
        return send(200, { content: buildClarifyingQuestion(intent.missing) });
    }

    // A date strictly in the past can never have an active, bookable trip.
    if (intent.date < currentDate) {
        return send(200, { content: buildNoResultsMessage(intent.cities, intent.date) });
    }

    const { data: tickets, error: ticketsError } = await supabase
        .from('bus_tickets')
        .select('id, from_city, to_city, departure_date, departure_time, price, status, total_seats')
        .eq('status', 'active')
        .eq('departure_date', intent.date);

    if (ticketsError) throw ticketsError;

    let candidates = (tickets || []).filter(t =>
        routeMatchesCities(t, intent.cities) &&
        isConfidentInternationalRoute(t.from_city, t.to_city)
    );

    // Same-day trips that have already departed are not bookable.
    if (intent.date === currentDate) {
        candidates = candidates.filter(t => !t.departure_time || t.departure_time >= currentTime);
    }

    candidates.sort((a, b) => String(a.departure_time || '').localeCompare(String(b.departure_time || '')));
    candidates = candidates.slice(0, MAX_RESULTS);

    if (candidates.length === 0) {
        return send(200, { content: buildNoResultsMessage(intent.cities, intent.date) });
    }

    const ticketIds = candidates.map(t => t.id);
    const { data: bookings, error: bookingsError } = await supabase
        .from('bus_ticket_bookings')
        .select('id, bus_ticket_id, status, seat_numbers, passengers_data, hold_expires_at, created_at, boarding_status')
        .in('bus_ticket_id', ticketIds);
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
    let settled = false;
    const timeoutTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        res.status(504).json({ error: 'Internal processing timeout' });
    }, REQUEST_BUDGET_MS);

    try {
        await handleKnowledgeQuery(req, res);
    } catch (err) {
        console.error('[Labbay] Knowledge query error:', err.message);
        if (!settled && !res.headersSent) {
            res.status(500).json({ error: 'Internal server error' });
        }
    } finally {
        settled = true;
        clearTimeout(timeoutTimer);
    }
});

module.exports = router;
