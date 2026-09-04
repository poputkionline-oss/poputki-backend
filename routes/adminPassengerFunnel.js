/**
 * adminPassengerFunnel.js
 * 
 * Phase P.1F: Admin-Only Passenger Activation Funnel & Journey Analytics
 * Project: POPUTKI.ONLINE
 * 
 * Access Control: Strictly restricted to platform administrators via adminAuth.
 * Carriers, managers, dispatchers, and passengers are denied access.
 * Zero PII: No unmasked phones, no passport details, no raw tokens returned.
 */

const express = require('express');
const router = express.Router();
const supabase = require('../db');
const { getServiceRoleClient } = require('../dbServiceRole');

function getDbClient() {
    try {
        return getServiceRoleClient();
    } catch (err) {
        return supabase;
    }
}

const {
    JOURNEY_EVENT_TYPES,
    JOURNEY_STATUSES,
    NEXT_ACTIONS,
    maskPhoneNumber,
    computeJourneyStatusAndNextAction
} = require('../utils/journeyHelper');

// Official tracking inception boundary for Phase P.1
const TRACKING_STARTED_AT = '2026-09-04T00:00:00.000Z';

/**
 * Helper to compute period bounds
 */
function resolvePeriodRange(period, startDate, endDate) {
    const now = new Date();
    if (period === 'today') {
        const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
        return { start, end: now.toISOString() };
    }
    if (period === 'yesterday') {
        const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
        const end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        return { start: start.toISOString(), end: end.toISOString() };
    }
    if (period === '7days') {
        const start = new Date(now.getTime() - 7 * 24 * 3600 * 1000).toISOString();
        return { start, end: now.toISOString() };
    }
    if (period === '30days') {
        const start = new Date(now.getTime() - 30 * 24 * 3600 * 1000).toISOString();
        return { start, end: now.toISOString() };
    }
    if (period === 'custom' && startDate) {
        return {
            start: new Date(startDate).toISOString(),
            end: endDate ? new Date(endDate).toISOString() : now.toISOString()
        };
    }
    // Default: all bookings from TRACKING_STARTED_AT
    return { start: TRACKING_STARTED_AT, end: now.toISOString() };
}

/**
 * Helper to format duration in human Russian string
 */
function formatDurationMinutes(minutes) {
    if (!minutes || isNaN(minutes) || minutes <= 0) return '—';
    if (minutes < 60) return `${Math.round(minutes)} мин`;
    const hours = Math.floor(minutes / 60);
    const remM = Math.round(minutes % 60);
    if (hours < 24) return remM > 0 ? `${hours} ч ${remM} мин` : `${hours} ч`;
    const days = Math.floor(hours / 24);
    return `${days} дн`;
}

/**
 * GET /api/admin/passenger-funnel/summary
 * Returns 10 top KPI metrics + period comparison
 */
router.get('/summary', async (req, res) => {
    try {
        const dbClient = getDbClient();
        const { period, startDate, endDate, carrier_id, bus_ticket_id, channel } = req.query;
        const range = resolvePeriodRange(period, startDate, endDate);

        // Fetch manual bookings within range
        let query = dbClient
            .from('bus_ticket_bookings')
            .select(`
                id, channel, source_type, created_at, status, claim_status,
                bus_tickets (id, carrier_id, operator_id, transport_company)
            `)
            .gte('created_at', range.start)
            .lte('created_at', range.end);

        if (bus_ticket_id) {
            query = query.eq('bus_ticket_id', Number(bus_ticket_id));
        }

        const { data: rawBookings, error: bErr } = await query;
        if (bErr) throw bErr;

        let bookings = (rawBookings || []).filter(b => b.channel === 'manual' || b.source_type === 'manual');
        if (carrier_id) {
            bookings = bookings.filter(b => {
                const t = b.bus_tickets;
                return t && (String(t.carrier_id) === String(carrier_id) || String(t.operator_id) === String(carrier_id));
            });
        }

        const bookingIds = bookings.map(b => b.id);
        let events = [];
        let handoffs = [];

        if (bookingIds.length > 0) {
            const { data: evData } = await dbClient
                .from('booking_journey_events')
                .select('*')
                .in('booking_id', bookingIds)
                .order('created_at', { ascending: true });
            events = evData || [];

            const { data: hData } = await dbClient
                .from('booking_handoffs')
                .select('*')
                .in('booking_id', bookingIds);
            handoffs = hData || [];
        }

        if (channel) {
            const channelBookingIds = new Set(handoffs.filter(h => h.channel === channel).map(h => h.booking_id));
            bookings = bookings.filter(b => channelBookingIds.has(b.id));
        }

        // Map events by booking
        const eventsByBooking = new Map();
        for (const ev of events) {
            if (!eventsByBooking.has(ev.booking_id)) {
                eventsByBooking.set(ev.booking_id, []);
            }
            eventsByBooking.get(ev.booking_id).push(ev);
        }

        // Compute unique stages reached
        let totalManual = bookings.length;
        let handoffInitiatedCount = 0;
        let linkOpenedCount = 0;
        let telegramCtaCount = 0;
        let botStartedCount = 0;
        let phoneSharedCount = 0;
        let phoneVerifiedCount = 0;
        let activatedCount = 0;

        const activationDurationsMinutes = [];

        for (const b of bookings) {
            const bEvents = eventsByBooking.get(b.id) || [];
            const types = new Set(bEvents.map(e => e.event_type));

            if (types.has(JOURNEY_EVENT_TYPES.SHARE_INITIATED) || types.has(JOURNEY_EVENT_TYPES.LINK_OPENED)) {
                handoffInitiatedCount++;
            }
            if (types.has(JOURNEY_EVENT_TYPES.LINK_OPENED)) {
                linkOpenedCount++;
            }
            if (types.has(JOURNEY_EVENT_TYPES.TELEGRAM_CTA_CLICKED)) {
                telegramCtaCount++;
            }
            if (types.has(JOURNEY_EVENT_TYPES.TELEGRAM_BOT_STARTED)) {
                botStartedCount++;
            }
            if (types.has(JOURNEY_EVENT_TYPES.PHONE_SHARED)) {
                phoneSharedCount++;
            }
            if (types.has(JOURNEY_EVENT_TYPES.PHONE_VERIFIED)) {
                phoneVerifiedCount++;
            }
            if (types.has(JOURNEY_EVENT_TYPES.ACTIVATION_COMPLETED) || types.has(JOURNEY_EVENT_TYPES.CLAIM_COMPLETED)) {
                activatedCount++;

                // Duration computation
                const startEv = bEvents.find(e => e.event_type === JOURNEY_EVENT_TYPES.BOOKING_CREATED);
                const endEv = bEvents.find(e => e.event_type === JOURNEY_EVENT_TYPES.ACTIVATION_COMPLETED || e.event_type === JOURNEY_EVENT_TYPES.CLAIM_COMPLETED);
                if (startEv && endEv) {
                    const diffMs = new Date(endEv.created_at).getTime() - new Date(startEv.created_at).getTime();
                    if (diffMs > 0) {
                        activationDurationsMinutes.push(diffMs / 60000);
                    }
                }
            }
        }

        // Overall conversion
        const totalConversionRate = totalManual > 0 ? Number(((activatedCount / totalManual) * 100).toFixed(1)) : 0;

        // Average and Median activation time
        let avgActivationMinutes = 0;
        let medianActivationMinutes = 0;
        if (activationDurationsMinutes.length > 0) {
            const sum = activationDurationsMinutes.reduce((a, c) => a + c, 0);
            avgActivationMinutes = Math.round(sum / activationDurationsMinutes.length);

            const sorted = [...activationDurationsMinutes].sort((a, b) => a - b);
            const mid = Math.floor(sorted.length / 2);
            medianActivationMinutes = sorted.length % 2 !== 0 ? Math.round(sorted[mid]) : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
        }

        // Count legacy bookings
        const { count: legacyCount } = await dbClient
            .from('bus_ticket_bookings')
            .select('*', { count: 'exact', head: true })
            .lt('created_at', TRACKING_STARTED_AT);

        return res.json({
            success: true,
            summary: {
                manualBookings: totalManual,
                handoffInitiated: handoffInitiatedCount,
                linkOpened: linkOpenedCount,
                telegramCta: telegramCtaCount,
                botStarted: botStartedCount,
                phoneShared: phoneSharedCount,
                phoneVerified: phoneVerifiedCount,
                activated: activatedCount,
                totalConversionRate,
                avgActivationMinutes,
                medianActivationMinutes,
                avgActivationTimeDisplay: formatDurationMinutes(avgActivationMinutes),
                medianActivationTimeDisplay: formatDurationMinutes(medianActivationMinutes),
                legacyBookingsCount: legacyCount || 0,
                trackingStartedAt: TRACKING_STARTED_AT
            }
        });
    } catch (err) {
        console.error('[AdminFunnel] Summary error:', err);
        return res.status(500).json({ error: 'INTERNAL_ERROR', message: err.message });
    }
});

/**
 * GET /api/admin/passenger-funnel/stages
 * Returns visual funnel steps with drop-offs
 */
router.get('/stages', async (req, res) => {
    try {
        const dbClient = getDbClient();
        const { period, startDate, endDate, carrier_id, bus_ticket_id, channel } = req.query;
        const range = resolvePeriodRange(period, startDate, endDate);

        let query = dbClient
            .from('bus_ticket_bookings')
            .select(`
                id, channel, source_type, created_at,
                bus_tickets (id, carrier_id, operator_id)
            `)
            .gte('created_at', range.start)
            .lte('created_at', range.end);

        if (bus_ticket_id) query = query.eq('bus_ticket_id', Number(bus_ticket_id));

        const { data: rawBookings } = await query;
        let bookings = (rawBookings || []).filter(b => b.channel === 'manual' || b.source_type === 'manual');
        if (carrier_id) {
            bookings = bookings.filter(b => {
                const t = b.bus_tickets;
                return t && (String(t.carrier_id) === String(carrier_id) || String(t.operator_id) === String(carrier_id));
            });
        }

        const bookingIds = bookings.map(b => b.id);
        let events = [];
        if (bookingIds.length > 0) {
            const { data: evData } = await dbClient
                .from('booking_journey_events')
                .select('booking_id, event_type, channel')
                .in('booking_id', bookingIds);
            events = evData || [];
        }

        if (channel) {
            const channelBookingIds = new Set(events.filter(e => e.channel === channel).map(e => e.booking_id));
            bookings = bookings.filter(b => channelBookingIds.has(b.id));
        }

        const eventsByBooking = new Map();
        for (const ev of events) {
            if (!eventsByBooking.has(ev.booking_id)) eventsByBooking.set(ev.booking_id, new Set());
            eventsByBooking.get(ev.booking_id).add(ev.event_type);
        }

        let cManual = bookings.length;
        let cHandoff = 0;
        let cOpen = 0;
        let cCta = 0;
        let cBot = 0;
        let cPhone = 0;
        let cVerified = 0;
        let cLinked = 0;
        let cActivated = 0;

        for (const b of bookings) {
            const types = eventsByBooking.get(b.id) || new Set();
            if (types.has(JOURNEY_EVENT_TYPES.SHARE_INITIATED) || types.has(JOURNEY_EVENT_TYPES.LINK_OPENED)) cHandoff++;
            if (types.has(JOURNEY_EVENT_TYPES.LINK_OPENED)) cOpen++;
            if (types.has(JOURNEY_EVENT_TYPES.TELEGRAM_CTA_CLICKED)) cCta++;
            if (types.has(JOURNEY_EVENT_TYPES.TELEGRAM_BOT_STARTED)) cBot++;
            if (types.has(JOURNEY_EVENT_TYPES.PHONE_SHARED)) cPhone++;
            if (types.has(JOURNEY_EVENT_TYPES.PHONE_VERIFIED)) cVerified++;
            if (types.has(JOURNEY_EVENT_TYPES.BOOKING_LINKED_TO_USER)) cLinked++;
            if (types.has(JOURNEY_EVENT_TYPES.ACTIVATION_COMPLETED) || types.has(JOURNEY_EVENT_TYPES.CLAIM_COMPLETED)) cActivated++;
        }

        const counts = [cManual, cHandoff, cOpen, cCta, cBot, cPhone, cVerified, cLinked, cActivated];
        const stepDefs = [
            { id: 'manual_booking', name: 'Ручная бронь' },
            { id: 'handoff_initiated', name: 'Передача инициирована' },
            { id: 'link_opened', name: 'Ссылка открыта' },
            { id: 'telegram_cta', name: 'Telegram CTA' },
            { id: 'bot_started', name: 'Бот запущен' },
            { id: 'phone_shared', name: 'Номер передан' },
            { id: 'phone_verified', name: 'Номер подтверждён' },
            { id: 'booking_linked', name: 'Бронь привязана' },
            { id: 'activated', name: 'Пассажир активирован' }
        ];

        const stages = stepDefs.map((def, idx) => {
            const count = counts[idx];
            const prevCount = idx === 0 ? count : counts[idx - 1];
            const dropOff = idx === 0 ? 0 : Math.max(0, prevCount - count);
            const dropOffRate = prevCount > 0 ? Number(((dropOff / prevCount) * 100).toFixed(1)) : 0;
            const conversion = prevCount > 0 ? Number(((count / prevCount) * 100).toFixed(1)) : 0;
            const totalConversion = cManual > 0 ? Number(((count / cManual) * 100).toFixed(1)) : 0;

            return {
                ...def,
                count,
                conversion,
                totalConversion,
                dropOff,
                dropOffRate
            };
        });

        return res.json({ success: true, stages });
    } catch (err) {
        console.error('[AdminFunnel] Stages error:', err);
        return res.status(500).json({ error: 'INTERNAL_ERROR', message: err.message });
    }
});

/**
 * GET /api/admin/passenger-funnel/passengers
 * Server-side paginated, filterable and sortable passenger journeys
 */
router.get('/passengers', async (req, res) => {
    try {
        const dbClient = getDbClient();
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(100, Math.max(5, parseInt(req.query.limit, 10) || 20));
        const { status, search, carrier_id, bus_ticket_id, channel, period, startDate, endDate, attentionOnly } = req.query;

        const sortBy = ['created_at', 'passenger_name', 'departure_date'].includes(req.query.sortBy) ? req.query.sortBy : 'created_at';
        const sortAsc = req.query.sortDir === 'asc';

        const range = resolvePeriodRange(period, startDate, endDate);

        // Fetch bookings
        let query = dbClient
            .from('bus_ticket_bookings')
            .select(`
                id, passenger_name, phone, seat_numbers, contact_role, status, claim_status, created_at,
                bus_ticket_id, pickup_city, drop_off_city,
                bus_tickets (id, from_city, to_city, departure_date, departure_time, transport_company, carrier_id, operator_id)
            `, { count: 'exact' });

        // Filter manual bookings
        query = query.or('channel.eq.manual,source_type.eq.manual');

        if (period && period !== 'all') {
            query = query.gte('created_at', range.start).lte('created_at', range.end);
        }

        if (bus_ticket_id) {
            query = query.eq('bus_ticket_id', Number(bus_ticket_id));
        }

        const { data: bookingsData, count: totalCount, error: bErr } = await query;
        if (bErr) throw bErr;

        let allBookings = bookingsData || [];

        // Carrier filter
        if (carrier_id) {
            allBookings = allBookings.filter(b => {
                const t = b.bus_tickets;
                return t && (String(t.carrier_id) === String(carrier_id) || String(t.operator_id) === String(carrier_id));
            });
        }

        // Fetch all journey events and handoffs for these bookings in one batch
        const bIds = allBookings.map(b => b.id);
        let eventsMap = new Map();
        let handoffsMap = new Map();
        let claimRequestsMap = new Map();

        if (bIds.length > 0) {
            const { data: allEvents } = await dbClient
                .from('booking_journey_events')
                .select('*')
                .in('booking_id', bIds)
                .order('created_at', { ascending: true });

            (allEvents || []).forEach(ev => {
                if (!eventsMap.has(ev.booking_id)) eventsMap.set(ev.booking_id, []);
                eventsMap.get(ev.booking_id).push(ev);
            });

            const { data: allHandoffs } = await dbClient
                .from('booking_handoffs')
                .select('*')
                .in('booking_id', bIds)
                .order('created_at', { ascending: false });

            (allHandoffs || []).forEach(h => {
                if (!handoffsMap.has(h.booking_id)) handoffsMap.set(h.booking_id, []);
                handoffsMap.get(h.booking_id).push(h);
            });

            const { data: allReqs } = await dbClient
                .from('booking_claim_requests')
                .select('id, booking_id, status')
                .in('booking_id', bIds)
                .eq('status', 'pending');

            (allReqs || []).forEach(r => claimRequestsMap.set(r.booking_id, r.id));
        }

        const nowMs = Date.now();
        const mappedList = [];

        for (const b of allBookings) {
            const bEvents = eventsMap.get(b.id) || [];
            const bHandoffs = handoffsMap.get(b.id) || [];
            const isLegacy = new Date(b.created_at).getTime() < new Date(TRACKING_STARTED_AT).getTime();

            const statusObj = computeJourneyStatusAndNextAction(bEvents, {
                booking: b,
                nowMs
            });

            const currentStatus = isLegacy && bEvents.length === 0 ? 'LEGACY' : statusObj.status;
            const lastEvent = bEvents.length > 0 ? bEvents[bEvents.length - 1] : null;
            const lastChannel = (bHandoffs[0]?.channel) || (lastEvent?.channel) || '—';

            // Calculate duration in current stage
            const lastEventTime = lastEvent ? new Date(lastEvent.created_at).getTime() : new Date(b.created_at).getTime();
            const timeInStageMs = Math.max(0, nowMs - lastEventTime);
            const timeInStageDisplay = formatDurationMinutes(timeInStageMs / 60000);

            const trip = b.bus_tickets || {};
            const seats = Array.isArray(b.seat_numbers) ? b.seat_numbers.join(', ') : (b.seat_numbers || '—');

            mappedList.push({
                bookingId: b.id,
                passengerName: b.passenger_name || 'Пассажир',
                maskedPhone: maskPhoneNumber(b.phone) || '—',
                carrierName: trip.transport_company || 'Перевозчик',
                carrierId: trip.carrier_id || trip.operator_id || null,
                busTicketId: b.bus_ticket_id,
                route: `${trip.from_city || '—'} → ${trip.to_city || '—'}`,
                departureDate: trip.departure_date || '—',
                departureTime: trip.departure_time ? String(trip.departure_time).substring(0, 5) : '—',
                seats,
                createdAt: b.created_at,
                status: currentStatus,
                statusLabel: currentStatus,
                channel: lastChannel,
                timeInStage: timeInStageDisplay,
                lastEventType: lastEvent ? lastEvent.event_type : 'BOOKING_CREATED',
                lastEventAt: lastEvent ? lastEvent.created_at : b.created_at,
                nextAction: statusObj.nextAction || NEXT_ACTIONS.SEND_TICKET,
                isLegacy,
                hasClaimRequest: claimRequestsMap.has(b.id),
                claimRequestId: claimRequestsMap.get(b.id) || null
            });
        }

        // Filter by channel if requested
        let filtered = mappedList;
        if (channel) {
            filtered = filtered.filter(p => p.channel === channel);
        }

        // Filter by status if requested
        if (status && status !== 'ALL') {
            filtered = filtered.filter(p => p.status === status);
        }

        // Attention only filter
        if (attentionOnly === 'true' || attentionOnly === true) {
            const attentionStatuses = new Set([
                JOURNEY_STATUSES.NOT_SHARED,
                JOURNEY_STATUSES.BOT_STARTED,
                JOURNEY_STATUSES.PHONE_PENDING,
                JOURNEY_STATUSES.PHONE_MISMATCH,
                JOURNEY_STATUSES.UNDER_REVIEW,
                JOURNEY_STATUSES.EXPIRED
            ]);
            filtered = filtered.filter(p => attentionStatuses.has(p.status) || p.hasClaimRequest);
        }

        // Search filter (passenger name or masked phone digits)
        if (search && search.trim()) {
            const s = search.trim().toLowerCase();
            filtered = filtered.filter(p =>
                (p.passengerName && p.passengerName.toLowerCase().includes(s)) ||
                (p.maskedPhone && p.maskedPhone.includes(s)) ||
                String(p.bookingId) === s
            );
        }

        // Sorting
        filtered.sort((a, b) => {
            let valA = a[sortBy] || '';
            let valB = b[sortBy] || '';
            if (sortBy === 'created_at' || sortBy === 'departure_date') {
                valA = new Date(valA).getTime() || 0;
                valB = new Date(valB).getTime() || 0;
            }
            if (valA < valB) return sortAsc ? -1 : 1;
            if (valA > valB) return sortAsc ? 1 : -1;
            return 0;
        });

        // Pagination
        const total = filtered.length;
        const totalPages = Math.ceil(total / limit) || 1;
        const offset = (page - 1) * limit;
        const paginated = filtered.slice(offset, offset + limit);

        return res.json({
            success: true,
            passengers: paginated,
            pagination: {
                page,
                limit,
                total,
                totalPages
            }
        });
    } catch (err) {
        console.error('[AdminFunnel] Passengers list error:', err);
        return res.status(500).json({ error: 'INTERNAL_ERROR', message: err.message });
    }
});

/**
 * GET /api/admin/passenger-funnel/bookings/:bookingId/timeline
 * Chronological timeline of events for inspection drawer/modal
 */
router.get('/bookings/:bookingId/timeline', async (req, res) => {
    const numId = Number(req.params.bookingId);
    if (!numId || isNaN(numId)) {
        return res.status(400).json({ error: 'INVALID_ID', message: 'Некорректный ID бронирования' });
    }

    try {
        const dbClient = getDbClient();
        const { data: booking, error: bErr } = await dbClient
            .from('bus_ticket_bookings')
            .select(`
                id, passenger_name, phone, seat_numbers, contact_role, status, claim_status, created_at,
                bus_tickets (id, from_city, to_city, departure_date, departure_time, transport_company)
            `)
            .eq('id', numId)
            .single();

        if (bErr || !booking) {
            return res.status(404).json({ error: 'NOT_FOUND', message: 'Бронирование не найдено' });
        }

        // Fetch events
        const { data: rawEvents } = await dbClient
            .from('booking_journey_events')
            .select('*')
            .eq('booking_id', numId)
            .order('created_at', { ascending: true });

        // Fetch handoffs
        const { data: rawHandoffs } = await dbClient
            .from('booking_handoffs')
            .select('*')
            .eq('booking_id', numId)
            .order('created_at', { ascending: true });

        const safeEvents = (rawEvents || []).map(ev => ({
            id: ev.id,
            eventType: ev.event_type,
            channel: ev.channel || null,
            actorType: ev.actor_type || 'system',
            actorId: ev.actor_id || null,
            recipientPhoneMasked: ev.recipient_phone_masked || null,
            createdAt: ev.created_at,
            metadata: ev.metadata || {}
        }));

        const safeHandoffs = (rawHandoffs || []).map(h => ({
            id: h.id,
            channel: h.channel,
            recipientPhoneMasked: h.recipient_phone_masked,
            createdAt: h.created_at,
            openedAt: h.opened_at || null
        }));

        const trip = booking.bus_tickets || {};

        return res.json({
            success: true,
            booking: {
                bookingId: booking.id,
                passengerName: booking.passenger_name || 'Пассажир',
                maskedPhone: maskPhoneNumber(booking.phone),
                route: `${trip.from_city || '—'} → ${trip.to_city || '—'}`,
                departureDate: trip.departure_date,
                departureTime: trip.departure_time,
                seats: Array.isArray(booking.seat_numbers) ? booking.seat_numbers.join(', ') : booking.seat_numbers,
                createdAt: booking.created_at
            },
            timeline: safeEvents,
            handoffs: safeHandoffs
        });
    } catch (err) {
        console.error('[AdminFunnel] Timeline error:', err);
        return res.status(500).json({ error: 'INTERNAL_ERROR', message: err.message });
    }
});

/**
 * GET /api/admin/passenger-funnel/channels
 * Channel comparison analytics table
 */
router.get('/channels', async (req, res) => {
    try {
        const dbClient = getDbClient();
        const { period, startDate, endDate } = req.query;
        const range = resolvePeriodRange(period, startDate, endDate);

        // Fetch handoffs and events in range
        const { data: rawHandoffs } = await dbClient
            .from('booking_handoffs')
            .select('*')
            .gte('created_at', range.start)
            .lte('created_at', range.end);

        const handoffs = rawHandoffs || [];
        const bookingIds = Array.from(new Set(handoffs.map(h => h.booking_id)));

        let events = [];
        if (bookingIds.length > 0) {
            const { data: evData } = await dbClient
                .from('booking_journey_events')
                .select('*')
                .in('booking_id', bookingIds);
            events = evData || [];
        }

        const channelDefs = [
            { id: 'whatsapp', name: 'WhatsApp' },
            { id: 'sms', name: 'SMS' },
            { id: 'telegram', name: 'Telegram Share' },
            { id: 'copy_link', name: 'Copy Link' }
        ];

        const channelStats = channelDefs.map(ch => {
            const chHandoffs = handoffs.filter(h => h.channel === ch.id);
            const chBookingIds = new Set(chHandoffs.map(h => h.booking_id));
            const chEvents = events.filter(e => e.channel === ch.id || chBookingIds.has(e.booking_id));

            const uniqueBookings = chBookingIds.size;
            const handoffsCount = chHandoffs.length;

            const openedBookings = new Set(
                chEvents.filter(e => e.event_type === JOURNEY_EVENT_TYPES.LINK_OPENED).map(e => e.booking_id)
            );
            const ctaBookings = new Set(
                chEvents.filter(e => e.event_type === JOURNEY_EVENT_TYPES.TELEGRAM_CTA_CLICKED).map(e => e.booking_id)
            );
            const botBookings = new Set(
                chEvents.filter(e => e.event_type === JOURNEY_EVENT_TYPES.TELEGRAM_BOT_STARTED).map(e => e.booking_id)
            );
            const phoneBookings = new Set(
                chEvents.filter(e => e.event_type === JOURNEY_EVENT_TYPES.PHONE_SHARED).map(e => e.booking_id)
            );
            const activatedBookings = new Set(
                chEvents.filter(e => e.event_type === JOURNEY_EVENT_TYPES.ACTIVATION_COMPLETED || e.event_type === JOURNEY_EVENT_TYPES.CLAIM_COMPLETED).map(e => e.booking_id)
            );

            const conversionRate = uniqueBookings > 0 ? Number(((activatedBookings.size / uniqueBookings) * 100).toFixed(1)) : 0;

            // Median activation time for this channel
            const durations = [];
            for (const bId of activatedBookings) {
                const bEvents = chEvents.filter(e => e.booking_id === bId);
                const startEv = bEvents.find(e => e.event_type === JOURNEY_EVENT_TYPES.SHARE_INITIATED) || bEvents.find(e => e.event_type === JOURNEY_EVENT_TYPES.BOOKING_CREATED);
                const endEv = bEvents.find(e => e.event_type === JOURNEY_EVENT_TYPES.ACTIVATION_COMPLETED || e.event_type === JOURNEY_EVENT_TYPES.CLAIM_COMPLETED);
                if (startEv && endEv) {
                    const diff = (new Date(endEv.created_at).getTime() - new Date(startEv.created_at).getTime()) / 60000;
                    if (diff > 0) durations.push(diff);
                }
            }

            let medianMinutes = 0;
            if (durations.length > 0) {
                durations.sort((a, b) => a - b);
                const m = Math.floor(durations.length / 2);
                medianMinutes = durations.length % 2 !== 0 ? Math.round(durations[m]) : Math.round((durations[m - 1] + durations[m]) / 2);
            }

            return {
                channel: ch.id,
                channelName: ch.name,
                handoffsCount,
                uniqueBookings,
                opensCount: openedBookings.size,
                ctaCount: ctaBookings.size,
                botStartsCount: botBookings.size,
                phoneSharedCount: phoneBookings.size,
                activatedCount: activatedBookings.size,
                conversionRate,
                medianActivationMinutes: medianMinutes,
                medianActivationDisplay: formatDurationMinutes(medianMinutes)
            };
        });

        return res.json({ success: true, channels: channelStats });
    } catch (err) {
        console.error('[AdminFunnel] Channels error:', err);
        return res.status(500).json({ error: 'INTERNAL_ERROR', message: err.message });
    }
});

/**
 * GET /api/admin/passenger-funnel/carriers
 * Carrier ranking and speed metrics (Admin-Only)
 */
router.get('/carriers', async (req, res) => {
    try {
        const dbClient = getDbClient();
        const { period, startDate, endDate } = req.query;
        const range = resolvePeriodRange(period, startDate, endDate);

        // Fetch bookings joined with bus_tickets
        const { data: rawBookings } = await dbClient
            .from('bus_ticket_bookings')
            .select(`
                id, channel, source_type, created_at,
                bus_tickets (id, carrier_id, operator_id, transport_company)
            `)
            .gte('created_at', range.start)
            .lte('created_at', range.end);

        const bookings = (rawBookings || []).filter(b => b.channel === 'manual' || b.source_type === 'manual');
        const bookingIds = bookings.map(b => b.id);

        let events = [];
        if (bookingIds.length > 0) {
            const { data: evData } = await dbClient
                .from('booking_journey_events')
                .select('*')
                .in('booking_id', bookingIds);
            events = evData || [];
        }

        const eventsByBooking = new Map();
        for (const ev of events) {
            if (!eventsByBooking.has(ev.booking_id)) eventsByBooking.set(ev.booking_id, []);
            eventsByBooking.get(ev.booking_id).push(ev);
        }

        // Group by carrier
        const carriersMap = new Map();
        for (const b of bookings) {
            const t = b.bus_tickets || {};
            const carrierId = t.carrier_id || t.operator_id || 'unknown';
            const carrierName = t.transport_company || `Перевозчик #${carrierId}`;

            if (!carriersMap.has(carrierId)) {
                carriersMap.set(carrierId, {
                    carrierId,
                    carrierName,
                    manualBookings: 0,
                    handoffs: 0,
                    opens: 0,
                    activated: 0,
                    timeToHandoffMinList: [],
                    timeToActivateMinList: []
                });
            }

            const cData = carriersMap.get(carrierId);
            cData.manualBookings++;

            const bEvents = eventsByBooking.get(b.id) || [];
            const types = new Set(bEvents.map(e => e.event_type));

            const hasHandoff = types.has(JOURNEY_EVENT_TYPES.SHARE_INITIATED) || types.has(JOURNEY_EVENT_TYPES.LINK_OPENED);
            if (hasHandoff) cData.handoffs++;

            if (types.has(JOURNEY_EVENT_TYPES.LINK_OPENED)) cData.opens++;

            const isActivated = types.has(JOURNEY_EVENT_TYPES.ACTIVATION_COMPLETED) || types.has(JOURNEY_EVENT_TYPES.CLAIM_COMPLETED);
            if (isActivated) {
                cData.activated++;

                const startEv = bEvents.find(e => e.event_type === JOURNEY_EVENT_TYPES.BOOKING_CREATED);
                const handoffEv = bEvents.find(e => e.event_type === JOURNEY_EVENT_TYPES.SHARE_INITIATED);
                const endEv = bEvents.find(e => e.event_type === JOURNEY_EVENT_TYPES.ACTIVATION_COMPLETED || e.event_type === JOURNEY_EVENT_TYPES.CLAIM_COMPLETED);

                if (startEv && handoffEv) {
                    const diffH = (new Date(handoffEv.created_at).getTime() - new Date(startEv.created_at).getTime()) / 60000;
                    if (diffH > 0) cData.timeToHandoffMinList.push(diffH);
                }
                if (startEv && endEv) {
                    const diffA = (new Date(endEv.created_at).getTime() - new Date(startEv.created_at).getTime()) / 60000;
                    if (diffA > 0) cData.timeToActivateMinList.push(diffA);
                }
            }
        }

        const carriersList = Array.from(carriersMap.values()).map(c => {
            const activationRate = c.manualBookings > 0 ? Number(((c.activated / c.manualBookings) * 100).toFixed(1)) : 0;

            let avgTimeToHandoff = 0;
            if (c.timeToHandoffMinList.length > 0) {
                avgTimeToHandoff = Math.round(c.timeToHandoffMinList.reduce((a, v) => a + v, 0) / c.timeToHandoffMinList.length);
            }

            let avgTimeToActivate = 0;
            if (c.timeToActivateMinList.length > 0) {
                avgTimeToActivate = Math.round(c.timeToActivateMinList.reduce((a, v) => a + v, 0) / c.timeToActivateMinList.length);
            }

            return {
                carrierId: c.carrierId,
                carrierName: c.carrierName,
                manualBookings: c.manualBookings,
                handoffsCount: c.handoffs,
                opensCount: c.opens,
                activatedCount: c.activated,
                activationRate,
                avgTimeToHandoffMin: avgTimeToHandoff,
                avgTimeToHandoffDisplay: formatDurationMinutes(avgTimeToHandoff),
                avgTimeToActivateMin: avgTimeToActivate,
                avgTimeToActivateDisplay: formatDurationMinutes(avgTimeToActivate)
            };
        });

        // Sort by manualBookings desc
        carriersList.sort((a, b) => b.manualBookings - a.manualBookings);

        return res.json({ success: true, carriers: carriersList });
    } catch (err) {
        console.error('[AdminFunnel] Carriers error:', err);
        return res.status(500).json({ error: 'INTERNAL_ERROR', message: err.message });
    }
});

/**
 * GET /api/admin/passenger-funnel/attention
 * Work queue of journeys needing intervention
 */
router.get('/attention', async (req, res) => {
    try {
        const dbClient = getDbClient();
        const nowMs = Date.now();

        // 1. Fetch pending claim requests (PHONE_MISMATCH / UNDER_REVIEW)
        const { data: pendingRequests } = await dbClient
            .from('booking_claim_requests')
            .select(`
                id, booking_id, requesting_user_id, failure_reason_code, created_at,
                bus_ticket_bookings (
                    id, passenger_name, phone, created_at,
                    bus_tickets (from_city, to_city, transport_company)
                )
            `)
            .eq('status', 'pending')
            .order('created_at', { ascending: false });

        const queue = [];

        for (const reqRow of (pendingRequests || [])) {
            const b = reqRow.bus_ticket_bookings;
            if (!b) continue;
            const trip = b.bus_tickets || {};
            queue.push({
                bookingId: b.id,
                claimRequestId: reqRow.id,
                issueType: 'PHONE_MISMATCH',
                priority: 'HIGH',
                issueTitle: 'Несовпадение номера / Ожидает подтверждения',
                passengerName: b.passenger_name || 'Пассажир',
                maskedPhone: maskPhoneNumber(b.phone),
                route: `${trip.from_city || '—'} → ${trip.to_city || '—'}`,
                carrierName: trip.transport_company || '—',
                createdAt: reqRow.created_at,
                recommendedAction: 'Проверить заявку подтверждения',
                actionType: 'REVIEW_REQUEST'
            });
        }

        // 2. Fetch recent non-activated bookings from TRACKING_STARTED_AT
        const { data: recentBookings } = await dbClient
            .from('bus_ticket_bookings')
            .select(`
                id, passenger_name, phone, created_at, status, claim_status,
                bus_tickets (from_city, to_city, transport_company)
            `)
            .or('channel.eq.manual,source_type.eq.manual')
            .neq('claim_status', 'claimed')
            .gte('created_at', TRACKING_STARTED_AT)
            .order('created_at', { ascending: false })
            .limit(100);

        if (recentBookings && recentBookings.length > 0) {
            const bIds = recentBookings.map(b => b.id);
            const { data: evData } = await dbClient
                .from('booking_journey_events')
                .select('*')
                .in('booking_id', bIds)
                .order('created_at', { ascending: true });

            const eventsByBooking = new Map();
            (evData || []).forEach(ev => {
                if (!eventsByBooking.has(ev.booking_id)) eventsByBooking.set(ev.booking_id, []);
                eventsByBooking.get(ev.booking_id).push(ev);
            });

            for (const b of recentBookings) {
                // Skip if already in queue from claim requests
                if (queue.some(q => q.bookingId === b.id)) continue;

                const bEvents = eventsByBooking.get(b.id) || [];
                const statusObj = computeJourneyStatusAndNextAction(bEvents, {
                    booking: b,
                    nowMs
                });

                if (statusObj.status === JOURNEY_STATUSES.ACTIVATED) continue;

                const trip = b.bus_tickets || {};

                if (statusObj.isBotAbandoned) {
                    queue.push({
                        bookingId: b.id,
                        claimRequestId: null,
                        issueType: 'BOT_ABANDONED',
                        priority: 'MEDIUM',
                        issueTitle: 'Бот запущен, но номер не передан (> 2 ч)',
                        passengerName: b.passenger_name || 'Пассажир',
                        maskedPhone: maskPhoneNumber(b.phone),
                        route: `${trip.from_city || '—'} → ${trip.to_city || '—'}`,
                        carrierName: trip.transport_company || '—',
                        createdAt: b.created_at,
                        recommendedAction: 'Связаться с пассажиром',
                        actionType: 'CONTACT_PASSENGER'
                    });
                } else if (statusObj.status === JOURNEY_STATUSES.NOT_SHARED) {
                    const elapsedMin = (nowMs - new Date(b.created_at).getTime()) / 60000;
                    if (elapsedMin > 120) {
                        queue.push({
                            bookingId: b.id,
                            claimRequestId: null,
                            issueType: 'NOT_SHARED',
                            priority: 'LOW',
                            issueTitle: 'Билет ещё не передан пассажиру',
                            passengerName: b.passenger_name || 'Пассажир',
                            maskedPhone: maskPhoneNumber(b.phone),
                            route: `${trip.from_city || '—'} → ${trip.to_city || '—'}`,
                            carrierName: trip.transport_company || '—',
                            createdAt: b.created_at,
                            recommendedAction: 'Напомнить перевозчику передать билет',
                            actionType: 'NOTIFY_CARRIER'
                        });
                    }
                } else if (statusObj.isExpired) {
                    queue.push({
                        bookingId: b.id,
                        claimRequestId: null,
                        issueType: 'EXPIRED',
                        priority: 'LOW',
                        issueTitle: 'Срок действия claim-сессии истек',
                        passengerName: b.passenger_name || 'Пассажир',
                        maskedPhone: maskPhoneNumber(b.phone),
                        route: `${trip.from_city || '—'} → ${trip.to_city || '—'}`,
                        carrierName: trip.transport_company || '—',
                        createdAt: b.created_at,
                        recommendedAction: 'Сгенерировать новую ссылку',
                        actionType: 'RENEW_LINK'
                    });
                }
            }
        }

        return res.json({ success: true, count: queue.length, items: queue });
    } catch (err) {
        console.error('[AdminFunnel] Attention error:', err);
        return res.status(500).json({ error: 'INTERNAL_ERROR', message: err.message });
    }
});

/**
 * POST /api/admin/passenger-funnel/claim-requests/:requestId/review
 * Administrative review (approved / rejected) for phone mismatches
 */
router.post('/claim-requests/:requestId/review', async (req, res) => {
    try {
        const { requestId } = req.params;
        const { decision, reason } = req.body;

        if (!['approved', 'rejected'].includes(decision)) {
            return res.status(400).json({ error: 'INVALID_DECISION', message: 'Решение должно быть approved или rejected' });
        }

        const { reviewClaimRequest } = require('../utils/claimHelper');
        const adminUserId = 1; // Platform administrator user ID

        const result = await reviewClaimRequest(requestId, adminUserId, decision, {
            enforceTenant: false, // Platform admin override
            reviewerUserId: adminUserId,
            reason
        });

        if (!result.success) {
            return res.status(400).json({ error: result.error, message: 'Не удалось обработать заявку подтверждения' });
        }

        // On approval: log journey events
        if (decision === 'approved') {
            try {
                const claimDb = getDbClient();
                const { data: reqRow } = await claimDb
                    .from('booking_claim_requests')
                    .select('booking_id, requesting_user_id')
                    .eq('id', requestId)
                    .maybeSingle();

                if (reqRow) {
                    const { recordJourneyEvent, JOURNEY_EVENT_TYPES } = require('../utils/journeyHelper');
                    await recordJourneyEvent(reqRow.booking_id, {
                        eventType: JOURNEY_EVENT_TYPES.CLAIM_COMPLETED,
                        actorType: 'system',
                        actorId: String(adminUserId),
                        metadata: { decision: 'approved', requestId }
                    }, { supabaseClient: claimDb });

                    await recordJourneyEvent(reqRow.booking_id, {
                        eventType: JOURNEY_EVENT_TYPES.BOOKING_LINKED_TO_USER,
                        actorType: 'system',
                        actorId: String(reqRow.requesting_user_id)
                    }, { supabaseClient: claimDb });

                    await recordJourneyEvent(reqRow.booking_id, {
                        eventType: JOURNEY_EVENT_TYPES.ACTIVATION_COMPLETED,
                        actorType: 'system',
                        actorId: String(reqRow.requesting_user_id)
                    }, { supabaseClient: claimDb });
                }
            } catch (evErr) {
                console.warn('[AdminFunnel] Post-approval journey logging failed:', evErr.message);
            }
        }

        return res.json({ success: true, status: result.status });
    } catch (err) {
        console.error('[AdminFunnel] Review error:', err);
        return res.status(500).json({ error: 'INTERNAL_ERROR', message: err.message });
    }
});

module.exports = router;
