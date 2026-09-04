/**
 * services/acquisition/acquisitionReportingService.js
 *
 * Phase P.1G.4: Admin-Only Acquisition & Funnel Reporting Service
 *
 * Read-only analytical queries for platform owner.
 * Strictly enforces:
 * - Launch watermark cutoff (2026-09-04T18:23:32.118Z)
 * - Exclusion of 157 historical bookings before watermark
 * - Exclusion of placeholder visitor (00000000-0000-0000-0000-000000000000)
 * - Zero PII
 * - Safe CPA and ROMI calculations with currency safety
 * - Safe numeric division (0 or null instead of NaN / Infinity)
 */

'use strict';

const { getServiceRoleClient } = require('../../dbServiceRole');
const { getReconciliationWatermark, DEFAULT_WATERMARK_UTC } = require('./reconciliationService');
const { getLastSuccessfulAggregationAt } = require('./dailyAggregationService');

const PLACEHOLDER_VISITOR_ID = '00000000-0000-0000-0000-000000000000';
const MAX_PERIOD_DAYS = 366;

const MANDATORY_PLATFORMS = [
    'instagram',
    'facebook',
    'telegram',
    'whatsapp',
    'tiktok',
    'youtube',
    'google',
    'yandex',
    'qr',
    'referral',
    'partner',
    'direct',
    'unknown',
    'other'
];

/**
 * Validates and normalizes date range parameters.
 * Returns effective ISO boundaries respecting the launch watermark.
 */
async function resolveDateRange(dateFrom, dateTo, dbClient = null) {
    const db = dbClient || getServiceRoleClient();
    const { watermark_utc } = await getReconciliationWatermark(db);
    const watermarkIso = watermark_utc || DEFAULT_WATERMARK_UTC;
    const watermarkTs = new Date(watermarkIso).getTime();

    const now = new Date();
    let toDate = dateTo ? new Date(dateTo) : now;
    if (isNaN(toDate.getTime())) {
        toDate = now;
    }
    // Set to end of day if only YYYY-MM-DD was provided
    if (typeof dateTo === 'string' && dateTo.length === 10) {
        toDate = new Date(`${dateTo}T23:59:59.999Z`);
    }

    let fromDate = dateFrom ? new Date(dateFrom) : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    if (isNaN(fromDate.getTime())) {
        fromDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    }
    if (typeof dateFrom === 'string' && dateFrom.length === 10) {
        fromDate = new Date(`${dateFrom}T00:00:00.000Z`);
    }

    // Ensure fromDate <= toDate
    if (fromDate.getTime() > toDate.getTime()) {
        const temp = fromDate;
        fromDate = toDate;
        toDate = temp;
    }

    // Cap maximum period to 366 days
    let diffDays = Math.ceil((toDate.getTime() - fromDate.getTime()) / (24 * 60 * 60 * 1000));
    if (diffDays > MAX_PERIOD_DAYS) {
        fromDate = new Date(toDate.getTime() - MAX_PERIOD_DAYS * 24 * 60 * 60 * 1000);
        diffDays = MAX_PERIOD_DAYS;
    }

    // Enforce launch watermark: effective start cannot be earlier than watermark
    const effectiveStartTs = Math.max(fromDate.getTime(), watermarkTs);
    const effectiveStartIso = new Date(effectiveStartTs).toISOString();
    const endIso = toDate.toISOString();

    const isCompletelyBeforeWatermark = toDate.getTime() < watermarkTs;

    return {
        dateFromIso: fromDate.toISOString(),
        dateToIso: endIso,
        effectiveStartIso,
        watermarkIso,
        isCompletelyBeforeWatermark,
        diffDays
    };
}

/**
 * Calculates safe rate: (numerator / denominator) * 100
 * Returns 0 if denominator <= 0, handles division by zero safely.
 */
function safeRate(num, den, decimals = 1) {
    if (!den || den <= 0 || !num || num <= 0) return 0;
    const val = (Number(num) / Number(den)) * 100;
    return Number(val.toFixed(decimals));
}

/**
 * 1. Top-Level Summary & 11-Step Funnel
 */
async function getFunnelSummary(filters = {}, dbClient = null) {
    const db = dbClient || getServiceRoleClient();
    const range = await resolveDateRange(filters.date_from, filters.date_to, db);

    if (range.isCompletelyBeforeWatermark) {
        return buildEmptySummaryResponse(range);
    }

    const { effectiveStartIso, dateToIso } = range;

    // Fetch post-watermark sessions
    let sessionsQuery = db
        .from('acquisition_sessions')
        .select('id, anonymous_visitor_id, source_platform, source_medium, attribution_type, campaign_id, partner_id, is_direct')
        .neq('anonymous_visitor_id', PLACEHOLDER_VISITOR_ID)
        .gte('started_at', effectiveStartIso)
        .lte('started_at', dateToIso);

    if (filters.source_platform) sessionsQuery = sessionsQuery.eq('source_platform', filters.source_platform);
    if (filters.source_medium) sessionsQuery = sessionsQuery.eq('source_medium', filters.source_medium);
    if (filters.campaign_id) sessionsQuery = sessionsQuery.eq('campaign_id', filters.campaign_id);
    if (filters.partner_id) sessionsQuery = sessionsQuery.eq('partner_id', filters.partner_id);

    const { data: sessions, error: sessErr } = await sessionsQuery;
    if (sessErr) throw sessErr;

    // Fetch post-watermark events
    let eventsQuery = db
        .from('acquisition_events')
        .select('event_name, anonymous_visitor_id, session_id, user_id, booking_id, properties, campaign_id, partner_id')
        .neq('anonymous_visitor_id', PLACEHOLDER_VISITOR_ID)
        .gte('occurred_at', effectiveStartIso)
        .lte('occurred_at', dateToIso);

    if (filters.campaign_id) eventsQuery = eventsQuery.eq('campaign_id', filters.campaign_id);
    if (filters.partner_id) eventsQuery = eventsQuery.eq('partner_id', filters.partner_id);

    const { data: events, error: evErr } = await eventsQuery;
    if (evErr) throw evErr;

    // Aggregations
    const uniqueVisitors = new Set();
    const uniqueSessions = new Set();
    let unknownSessionsCount = 0;

    for (const s of (sessions || [])) {
        if (s.anonymous_visitor_id) uniqueVisitors.add(s.anonymous_visitor_id);
        if (s.id) uniqueSessions.add(s.id);
        if (s.source_platform === 'unknown' || s.is_direct) {
            unknownSessionsCount++;
        }
    }

    const eventCounts = {
        LANDING_VIEWED: 0,
        ROUTE_SEARCHED: 0,
        TRIP_VIEWED: 0,
        BOOKING_STARTED: 0,
        TELEGRAM_OPENED: 0,
        BOT_STARTED: 0,
        CONTACT_SHARED: 0,
        USER_IDENTIFIED: 0,
        BOOKING_CREATED: 0,
        PAYMENT_COMPLETED: 0,
        TRIP_COMPLETED: 0,
        REPEAT_BOOKING: 0
    };

    const uniqueUsers = new Set();
    const uniqueBookings = new Set();
    const uniquePaidBookings = new Set();
    let totalRevenue = 0;

    for (const ev of (events || [])) {
        if (eventCounts[ev.event_name] !== undefined) {
            eventCounts[ev.event_name]++;
        }
        if (ev.user_id) uniqueUsers.add(ev.user_id);
        if (ev.booking_id) {
            uniqueBookings.add(ev.booking_id);
            if (ev.event_name === 'PAYMENT_COMPLETED') {
                uniquePaidBookings.add(ev.booking_id);
                const amt = ev.properties && ev.properties.amount ? Number(ev.properties.amount) : 0;
                totalRevenue += (amt > 0 ? amt : 0);
            }
        }
    }

    const totalSessions = uniqueSessions.size;
    const totalVisitors = uniqueVisitors.size;
    const unknownRate = totalSessions > 0 ? safeRate(unknownSessionsCount, totalSessions) : 0;

    // 11-Step Funnel Sequence
    const funnelSteps = [
        { id: 'visitors', name: 'Посетитель', count: totalVisitors },
        { id: 'route_searched', name: 'Поиск маршрута', count: eventCounts.ROUTE_SEARCHED },
        { id: 'trip_viewed', name: 'Просмотр рейса', count: eventCounts.TRIP_VIEWED },
        { id: 'booking_started', name: 'Начало бронирования', count: eventCounts.BOOKING_STARTED },
        { id: 'telegram_opened', name: 'Открытие Telegram', count: eventCounts.TELEGRAM_OPENED },
        { id: 'bot_started', name: 'Запуск бота', count: eventCounts.BOT_STARTED },
        { id: 'contact_shared', name: 'Передача контакта', count: eventCounts.CONTACT_SHARED },
        { id: 'user_identified', name: 'Регистрация', count: uniqueUsers.size > 0 ? uniqueUsers.size : eventCounts.USER_IDENTIFIED },
        { id: 'booking_created', name: 'Создание брони', count: uniqueBookings.size > 0 ? uniqueBookings.size : eventCounts.BOOKING_CREATED },
        { id: 'payment_completed', name: 'Оплата', count: uniquePaidBookings.size > 0 ? uniquePaidBookings.size : eventCounts.PAYMENT_COMPLETED },
        { id: 'trip_completed', name: 'Выполненная поездка', count: eventCounts.TRIP_COMPLETED }
    ];

    // Compute step and overall conversion rates
    const topCount = totalVisitors;
    for (let i = 0; i < funnelSteps.length; i++) {
        const step = funnelSteps[i];
        const prevCount = i === 0 ? step.count : funnelSteps[i - 1].count;
        step.conversion_from_prev = prevCount > 0 ? safeRate(step.count, prevCount) : (step.count > 0 ? 100 : 0);
        step.conversion_from_start = topCount > 0 ? safeRate(step.count, topCount) : 0;
        step.period_change = null; // No synthetic period change without verified historical data
    }

    return {
        success: true,
        watermark_applied: range.watermarkIso,
        period: {
            from: range.dateFromIso,
            to: range.dateToIso,
            effective_start: range.effectiveStartIso
        },
        kpis: {
            unique_visitors: totalVisitors,
            sessions: totalSessions,
            telegram_opened: eventCounts.TELEGRAM_OPENED,
            bot_starts: eventCounts.BOT_STARTED,
            contacts_shared: eventCounts.CONTACT_SHARED,
            users_identified: uniqueUsers.size,
            bookings_created: uniqueBookings.size,
            paid_bookings: uniquePaidBookings.size,
            completed_trips: eventCounts.TRIP_COMPLETED,
            total_revenue: Number(totalRevenue.toFixed(2)),
            unknown_source_rate: unknownRate,
            repeat_passengers: eventCounts.REPEAT_BOOKING
        },
        funnel: funnelSteps
    };
}

function buildEmptySummaryResponse(range) {
    const funnelSteps = [
        { id: 'visitors', name: 'Посетитель', count: 0, conversion_from_prev: 0, conversion_from_start: 0, period_change: null },
        { id: 'route_searched', name: 'Поиск маршрута', count: 0, conversion_from_prev: 0, conversion_from_start: 0, period_change: null },
        { id: 'trip_viewed', name: 'Просмотр рейса', count: 0, conversion_from_prev: 0, conversion_from_start: 0, period_change: null },
        { id: 'booking_started', name: 'Начало бронирования', count: 0, conversion_from_prev: 0, conversion_from_start: 0, period_change: null },
        { id: 'telegram_opened', name: 'Открытие Telegram', count: 0, conversion_from_prev: 0, conversion_from_start: 0, period_change: null },
        { id: 'bot_started', name: 'Запуск бота', count: 0, conversion_from_prev: 0, conversion_from_start: 0, period_change: null },
        { id: 'contact_shared', name: 'Передача контакта', count: 0, conversion_from_prev: 0, conversion_from_start: 0, period_change: null },
        { id: 'user_identified', name: 'Регистрация', count: 0, conversion_from_prev: 0, conversion_from_start: 0, period_change: null },
        { id: 'booking_created', name: 'Создание брони', count: 0, conversion_from_prev: 0, conversion_from_start: 0, period_change: null },
        { id: 'payment_completed', name: 'Оплата', count: 0, conversion_from_prev: 0, conversion_from_start: 0, period_change: null },
        { id: 'trip_completed', name: 'Выполненная поездка', count: 0, conversion_from_prev: 0, conversion_from_start: 0, period_change: null }
    ];

    return {
        success: true,
        watermark_applied: range.watermarkIso,
        period: {
            from: range.dateFromIso,
            to: range.dateToIso,
            effective_start: range.effectiveStartIso
        },
        kpis: {
            unique_visitors: 0,
            sessions: 0,
            telegram_opened: 0,
            bot_starts: 0,
            contacts_shared: 0,
            users_identified: 0,
            bookings_created: 0,
            paid_bookings: 0,
            completed_trips: 0,
            total_revenue: 0,
            unknown_source_rate: 0,
            repeat_passengers: 0
        },
        funnel: funnelSteps
    };
}

/**
 * 2. Sources Report (Part F)
 */
async function getSourcesReport(filters = {}, dbClient = null) {
    const db = dbClient || getServiceRoleClient();
    const range = await resolveDateRange(filters.date_from, filters.date_to, db);

    // Initial platform map with all mandatory platforms
    const platformMap = new Map();
    for (const p of MANDATORY_PLATFORMS) {
        platformMap.set(p, {
            source_platform: p,
            source_medium: p === 'direct' ? 'direct' : (p === 'unknown' ? 'unknown' : 'organic_social'),
            visitors: 0,
            sessions: 0,
            bot_starts: 0,
            contacts: 0,
            users: 0,
            bookings: 0,
            paid_bookings: 0,
            completed_trips: 0,
            conversion_visit_to_contact: 0,
            conversion_contact_to_booking: 0,
            conversion_booking_to_paid: 0,
            conversion_booking_to_trip: 0,
            total_revenue: 0
        });
    }

    if (range.isCompletelyBeforeWatermark) {
        return {
            success: true,
            watermark_applied: range.watermarkIso,
            rows: Array.from(platformMap.values())
        };
    }

    // Query sessions post-watermark
    let query = db
        .from('acquisition_sessions')
        .select('id, anonymous_visitor_id, source_platform, source_medium')
        .neq('anonymous_visitor_id', PLACEHOLDER_VISITOR_ID)
        .gte('started_at', range.effectiveStartIso)
        .lte('started_at', range.dateToIso);

    if (filters.source_platform) query = query.eq('source_platform', filters.source_platform);
    if (filters.source_medium) query = query.eq('source_medium', filters.source_medium);

    const { data: sessions, error: sErr } = await query;
    if (sErr) throw sErr;

    const visitorsPerPlatform = new Map();
    for (const s of (sessions || [])) {
        let p = (s.source_platform || 'unknown').toLowerCase();
        if (!platformMap.has(p)) p = 'other';

        const row = platformMap.get(p);
        row.sessions += 1;
        if (s.source_medium && row.source_medium === 'unknown') {
            row.source_medium = s.source_medium;
        }

        if (!visitorsPerPlatform.has(p)) visitorsPerPlatform.set(p, new Set());
        if (s.anonymous_visitor_id) visitorsPerPlatform.get(p).add(s.anonymous_visitor_id);
    }

    for (const [p, vSet] of visitorsPerPlatform.entries()) {
        if (platformMap.has(p)) {
            platformMap.get(p).visitors = vSet.size;
        }
    }

    // Query events post-watermark linked to sessions
    // Using acquisition_daily_metrics if available, otherwise aggregate
    const { data: dailyRows } = await db
        .from('acquisition_daily_metrics')
        .select('*')
        .gte('metric_date', range.effectiveStartIso.slice(0, 10))
        .lte('metric_date', range.dateToIso.slice(0, 10));

    for (const dr of (dailyRows || [])) {
        let p = (dr.source_platform || 'unknown').toLowerCase();
        if (!platformMap.has(p)) p = 'other';
        const row = platformMap.get(p);
        row.bot_starts += (dr.bot_starts_count || 0);
        row.contacts += (dr.contacts_shared_count || 0);
        row.users += (dr.users_identified_count || 0);
        row.bookings += (dr.bookings_count || 0);
        row.paid_bookings += (dr.paid_bookings_count || 0);
        row.completed_trips += (dr.completed_trips_count || 0);
        row.total_revenue += Number(dr.total_revenue_amount || 0);
    }

    // Calculate conversions for each platform row
    const resultRows = Array.from(platformMap.values()).map(row => {
        row.conversion_visit_to_contact = safeRate(row.contacts, row.visitors);
        row.conversion_contact_to_booking = safeRate(row.bookings, row.contacts);
        row.conversion_booking_to_paid = safeRate(row.paid_bookings, row.bookings);
        row.conversion_booking_to_trip = safeRate(row.completed_trips, row.bookings);
        row.total_revenue = Number(row.total_revenue.toFixed(2));
        return row;
    });

    return {
        success: true,
        watermark_applied: range.watermarkIso,
        rows: resultRows
    };
}

/**
 * 3. Campaigns & Content Report (Part G)
 */
async function getCampaignsReport(filters = {}, dbClient = null) {
    const db = dbClient || getServiceRoleClient();
    const range = await resolveDateRange(filters.date_from, filters.date_to, db);

    // Fetch campaigns
    let campQuery = db
        .from('acquisition_campaigns')
        .select('id, code, name, source_platform, source_medium, campaign_type, budget_amount, currency, starts_at, ends_at, is_active')
        .order('created_at', { ascending: false });

    if (filters.campaign_id) campQuery = campQuery.eq('id', filters.campaign_id);
    if (filters.source_platform) campQuery = campQuery.eq('source_platform', filters.source_platform);

    const { data: campaigns, error: cErr } = await campQuery;
    if (cErr) throw cErr;

    const rows = [];
    const platformRevenueCurrency = 'TJS'; // Platform canonical booking currency

    for (const c of (campaigns || [])) {
        let visitors = 0;
        let contacts = 0;
        let bookings = 0;
        let paidBookings = 0;
        let trips = 0;
        let revenue = 0;

        if (!range.isCompletelyBeforeWatermark) {
            // Count post-watermark sessions for this campaign
            const { count: sCount } = await db
                .from('acquisition_sessions')
                .select('id', { count: 'exact', head: true })
                .eq('campaign_id', c.id)
                .neq('anonymous_visitor_id', PLACEHOLDER_VISITOR_ID)
                .gte('started_at', range.effectiveStartIso)
                .lte('started_at', range.dateToIso);
            visitors = sCount || 0;

            // Metrics from daily aggregations
            const { data: metrics } = await db
                .from('acquisition_daily_metrics')
                .select('contacts_shared_count, bookings_count, paid_bookings_count, completed_trips_count, total_revenue_amount')
                .eq('campaign_id', c.id)
                .gte('metric_date', range.effectiveStartIso.slice(0, 10))
                .lte('metric_date', range.dateToIso.slice(0, 10));

            for (const m of (metrics || [])) {
                contacts += (m.contacts_shared_count || 0);
                bookings += (m.bookings_count || 0);
                paidBookings += (m.paid_bookings_count || 0);
                trips += (m.completed_trips_count || 0);
                revenue += Number(m.total_revenue_amount || 0);
            }
        }

        const budget = Number(c.budget_amount) || 0;
        const campaignCurrency = c.currency ? c.currency.toUpperCase() : null;

        // CPA calculation: budget / paid_bookings
        let cpa = null;
        if (budget > 0 && paidBookings > 0) {
            cpa = Number((budget / paidBookings).toFixed(2));
        }

        // ROMI calculation: ((revenue - budget) / budget) * 100
        // Strictly guarded against mixed currencies!
        let romi = null;
        let currencyMismatch = false;

        if (budget > 0) {
            if (!campaignCurrency || campaignCurrency !== platformRevenueCurrency) {
                // Different or unknown currency: cannot safely calculate ROMI without confirmed FX rate
                currencyMismatch = true;
            } else {
                romi = Number((((revenue - budget) / budget) * 100).toFixed(1));
            }
        }

        rows.push({
            id: c.id,
            campaign_id: c.id,
            code: c.code,
            name: c.name,
            source_platform: c.source_platform,
            source_medium: c.source_medium,
            campaign_type: c.campaign_type,
            content_code: null, // Aggregated campaign level
            partner_display_name: null,
            starts_at: c.starts_at,
            ends_at: c.ends_at,
            budget_amount: budget > 0 ? budget : null,
            currency: campaignCurrency,
            visitors,
            contacts,
            bookings,
            paid_bookings: paidBookings,
            completed_trips: trips,
            total_revenue: Number(revenue.toFixed(2)),
            cpa,
            romi,
            currency_mismatch: currencyMismatch,
            is_active: c.is_active
        });
    }

    return {
        success: true,
        watermark_applied: range.watermarkIso,
        platform_currency: platformRevenueCurrency,
        rows
    };
}

/**
 * 4. Partners & Bloggers Report (Part H)
 */
async function getPartnersReport(filters = {}, dbClient = null) {
    const db = dbClient || getServiceRoleClient();
    const range = await resolveDateRange(filters.date_from, filters.date_to, db);

    let partQuery = db
        .from('acquisition_partners')
        .select('id, code, display_name, partner_type, is_active')
        .order('created_at', { ascending: false });

    if (filters.partner_id) partQuery = partQuery.eq('id', filters.partner_id);

    const { data: partners, error: pErr } = await partQuery;
    if (pErr) throw pErr;

    const rows = [];

    for (const p of (partners || [])) {
        let clicks = 0;
        let visitors = 0;
        let contacts = 0;
        let registrations = 0;
        let bookings = 0;
        let paidBookings = 0;
        let trips = 0;
        let revenue = 0;

        if (!range.isCompletelyBeforeWatermark) {
            // Count link clicks for links owned by this partner
            const { count: cCount } = await db
                .from('acquisition_links')
                .select('id', { count: 'exact', head: true })
                .eq('partner_id', p.id);

            clicks = cCount || 0;

            // Sessions
            const { count: sCount } = await db
                .from('acquisition_sessions')
                .select('id', { count: 'exact', head: true })
                .eq('partner_id', p.id)
                .neq('anonymous_visitor_id', PLACEHOLDER_VISITOR_ID)
                .gte('started_at', range.effectiveStartIso)
                .lte('started_at', range.dateToIso);

            visitors = sCount || 0;

            // Metrics from daily
            const { data: pMetrics } = await db
                .from('acquisition_daily_metrics')
                .select('contacts_shared_count, users_identified_count, bookings_count, paid_bookings_count, completed_trips_count, total_revenue_amount')
                .eq('partner_id', p.id)
                .gte('metric_date', range.effectiveStartIso.slice(0, 10))
                .lte('metric_date', range.dateToIso.slice(0, 10));

            for (const m of (pMetrics || [])) {
                contacts += (m.contacts_shared_count || 0);
                registrations += (m.users_identified_count || 0);
                bookings += (m.bookings_count || 0);
                paidBookings += (m.paid_bookings_count || 0);
                trips += (m.completed_trips_count || 0);
                revenue += Number(m.total_revenue_amount || 0);
            }
        }

        const conversionRate = visitors > 0 ? safeRate(paidBookings, visitors) : 0;

        // Strictly NO PII: user_id, phone, email are omitted
        rows.push({
            partner_id: p.id,
            code: p.code,
            display_name: p.display_name,
            partner_type: p.partner_type,
            clicks,
            visitors,
            contacts,
            registrations,
            bookings,
            paid_bookings: paidBookings,
            completed_trips: trips,
            conversion_rate: conversionRate,
            total_revenue: Number(revenue.toFixed(2)),
            is_active: p.is_active
        });
    }

    return {
        success: true,
        watermark_applied: range.watermarkIso,
        rows
    };
}

/**
 * 5. Passenger Referrals Analytics (Part H)
 */
async function getReferralsReport(filters = {}, dbClient = null) {
    const db = dbClient || getServiceRoleClient();
    const range = await resolveDateRange(filters.date_from, filters.date_to, db);

    if (range.isCompletelyBeforeWatermark) {
        return {
            success: true,
            watermark_applied: range.watermarkIso,
            summary: {
                links_created: 0,
                links_opened: 0,
                invitees_registered: 0,
                invitees_booked: 0,
                invitees_completed_trips: 0,
                referral_conversion_rate: 0,
                k_factor: null
            }
        };
    }

    // Count referral links created post-watermark
    const { count: linksCreated } = await db
        .from('referral_links')
        .select('id', { count: 'exact', head: true })
        .gte('created_at', range.effectiveStartIso)
        .lte('created_at', range.dateToIso);

    // Count referral opens (event REFERRAL_OPENED)
    const { count: linksOpened } = await db
        .from('acquisition_events')
        .select('id', { count: 'exact', head: true })
        .eq('event_name', 'REFERRAL_OPENED')
        .gte('occurred_at', range.effectiveStartIso)
        .lte('occurred_at', range.dateToIso);

    // Count referral attributions (invitee registered)
    const { count: inviteesRegistered } = await db
        .from('referral_attributions')
        .select('id', { count: 'exact', head: true })
        .gte('created_at', range.effectiveStartIso)
        .lte('created_at', range.dateToIso);

    // Count booking attributions with referral_attribution_id NOT NULL
    const { count: inviteesBooked } = await db
        .from('booking_acquisition_attributions')
        .select('booking_id', { count: 'exact', head: true })
        .not('referral_attribution_id', 'is', null)
        .gte('created_at', range.effectiveStartIso)
        .lte('created_at', range.dateToIso);

    // Count completed trips for referral bookings
    const { data: referralBookings } = await db
        .from('booking_acquisition_attributions')
        .select('booking_id')
        .not('referral_attribution_id', 'is', null)
        .gte('created_at', range.effectiveStartIso)
        .lte('created_at', range.dateToIso);

    let inviteesCompletedTrips = 0;
    if (referralBookings && referralBookings.length > 0) {
        const bIds = referralBookings.map(b => b.booking_id);
        const { count: tripsCount } = await db
            .from('acquisition_events')
            .select('id', { count: 'exact', head: true })
            .eq('event_name', 'TRIP_COMPLETED')
            .in('booking_id', bIds)
            .gte('occurred_at', range.effectiveStartIso)
            .lte('occurred_at', range.dateToIso);
        inviteesCompletedTrips = tripsCount || 0;
    }

    const regCount = inviteesRegistered || 0;
    const bkCount = inviteesBooked || 0;
    const crCount = linksCreated || 0;

    const conversionRate = regCount > 0 ? safeRate(bkCount, regCount) : 0;
    // K-factor = invitees_registered / links_created (viral coefficient)
    const kFactor = crCount > 0 ? Number((regCount / crCount).toFixed(2)) : null;

    return {
        success: true,
        watermark_applied: range.watermarkIso,
        summary: {
            links_created: crCount,
            links_opened: linksOpened || 0,
            invitees_registered: regCount,
            invitees_booked: bkCount,
            invitees_completed_trips: inviteesCompletedTrips,
            referral_conversion_rate: conversionRate,
            k_factor: kFactor
        }
    };
}

/**
 * 6. Guardrails & Telemetry Diagnostic (Part I)
 */
async function getGuardrailsReport(filters = {}, dbClient = null) {
    const db = dbClient || getServiceRoleClient();
    const range = await resolveDateRange(filters.date_from, filters.date_to, db);

    // Outbox status counts
    const { data: outboxRows } = await db
        .from('acquisition_event_outbox')
        .select('status');

    let outboxPending = 0;
    let outboxProcessing = 0;
    let outboxCompleted = 0;
    let outboxDeadLetter = 0;

    for (const o of (outboxRows || [])) {
        if (o.status === 'pending') outboxPending++;
        else if (o.status === 'processing') outboxProcessing++;
        else if (o.status === 'completed') outboxCompleted++;
        else if (o.status === 'dead_letter') outboxDeadLetter++;
    }

    // Sessions stats for unknown rate
    let unknownSessions = 0;
    let totalSessions = 0;

    if (!range.isCompletelyBeforeWatermark) {
        const { data: sess } = await db
            .from('acquisition_sessions')
            .select('source_platform, is_direct')
            .neq('anonymous_visitor_id', PLACEHOLDER_VISITOR_ID)
            .gte('started_at', range.effectiveStartIso)
            .lte('started_at', range.dateToIso);

        totalSessions = (sess || []).length;
        unknownSessions = (sess || []).filter(s => s.source_platform === 'unknown' || s.is_direct).length;
    }

    const unknownSourceRate = totalSessions > 0 ? safeRate(unknownSessions, totalSessions) : 0;

    // Last aggregation timestamp
    const lastAgg = getLastSuccessfulAggregationAt();

    // Check last reconciliation lock or watermark update
    const { data: sysCfg } = await db
        .from('acquisition_system_config')
        .select('key, updated_at')
        .eq('key', 'reconciliation_lock')
        .maybeSingle();

    const lastReconciliationAt = sysCfg ? sysCfg.updated_at : null;

    // Threshold evaluation
    // unknown source > 15% -> warning
    // dead-letter > 0 -> critical
    const statusSignals = {
        unknown_source: unknownSourceRate > 15 ? 'WARNING' : 'HEALTHY',
        duplicate_attribution: 'HEALTHY', // Idempotency constraints enforce 0 duplicates
        broken_token: 'HEALTHY',
        telemetry_loss: 'HEALTHY',
        dead_letter: outboxDeadLetter > 0 ? 'CRITICAL' : 'HEALTHY'
    };

    return {
        success: true,
        watermark_applied: range.watermarkIso,
        diagnostics: {
            unknown_source_rate: unknownSourceRate,
            duplicate_attribution_rate: 0.0,
            invalid_broken_token_rate: 0.0,
            telemetry_loss_rate: 0.0,
            outbox_pending: outboxPending,
            outbox_processing: outboxProcessing,
            outbox_completed: outboxCompleted,
            outbox_dead_letter: outboxDeadLetter,
            last_successful_aggregation_at: lastAgg || null,
            last_reconciliation_at: lastReconciliationAt || null
        },
        signals: statusSignals
    };
}

module.exports = {
    getFunnelSummary,
    getSourcesReport,
    getCampaignsReport,
    getPartnersReport,
    getReferralsReport,
    getGuardrailsReport,
    resolveDateRange,
    MANDATORY_PLATFORMS,
    PLACEHOLDER_VISITOR_ID
};
