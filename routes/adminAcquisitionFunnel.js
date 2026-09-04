/**
 * routes/adminAcquisitionFunnel.js
 *
 * Phase P.1G.2: Admin-Only Main Platform Funnel Report API
 *
 * Exclusively available in the main platform admin panel.
 * Strictly forbidden in the carrier cabinet.
 * Fails closed without valid x-admin-token. Zero PII output.
 */

'use strict';

const express = require('express');
const router = express.Router();
const { getServiceRoleClient } = require('../dbServiceRole');
const { aggregateDailyMetrics, runRetentionCleanup, getLastSuccessfulAggregationAt } = require('../services/acquisition/dailyAggregationService');
const { requireAdminToken } = require('../utils/adminTokenAuth');

// Admin authorization gatekeeper (fails closed) — Phase P.1G.3A: shared constant-time helper.
router.use(requireAdminToken);

// -----------------------------------------------------------------------------
// GET /api/admin/acquisition-funnel
// -----------------------------------------------------------------------------
router.get('/', async (req, res) => {
    try {
        const {
            date_from,
            date_to,
            source_platform,
            source_medium,
            campaign_id,
            partner_id,
            attribution_type,
            content_code,
            placement_code
        } = req.query;

        const db = getServiceRoleClient();

        let query = db.from('acquisition_daily_metrics').select('*');

        if (date_from) {
            query = query.gte('metric_date', date_from);
        }
        if (date_to) {
            query = query.lte('metric_date', date_to);
        }
        if (source_platform) {
            query = query.eq('source_platform', source_platform);
        }
        if (source_medium) {
            query = query.eq('source_medium', source_medium);
        }
        if (campaign_id) {
            query = query.eq('campaign_id', campaign_id);
        }
        if (partner_id) {
            query = query.eq('partner_id', partner_id);
        }
        if (attribution_type) {
            query = query.eq('attribution_type', attribution_type);
        }
        if (content_code) {
            query = query.eq('content_code', content_code);
        }
        if (placement_code) {
            query = query.eq('placement_code', placement_code);
        }

        const { data: rows, error: qErr } = await query;
        if (qErr) {
            console.error('[AdminFunnel] Query error:', qErr.message);
            return res.status(500).json({ error: 'FAILED_TO_LOAD_METRICS' });
        }

        // Aggregate across filtered dimension rows
        const summary = {
            visitors: 0,
            sessions: 0,
            bot_starts: 0,
            contacts_shared: 0,
            users_identified: 0,
            bookings: 0,
            paid_bookings: 0,
            completed_trips: 0,
            referral_opens: 0,
            total_revenue: 0
        };

        const platformBreakdown = {};
        const mediumBreakdown = {};

        for (const r of (rows || [])) {
            summary.visitors += (r.visitors_count || 0);
            summary.sessions += (r.sessions_count || 0);
            summary.bot_starts += (r.bot_starts_count || 0);
            summary.contacts_shared += (r.contacts_shared_count || 0);
            summary.users_identified += (r.users_identified_count || 0);
            summary.bookings += (r.bookings_count || 0);
            summary.paid_bookings += (r.paid_bookings_count || 0);
            summary.completed_trips += (r.completed_trips_count || 0);
            summary.referral_opens += (r.referral_opens_count || 0);
            summary.total_revenue += Number(r.total_revenue_amount || 0);

            // Platform breakdown
            const p = r.source_platform || 'unknown';
            if (!platformBreakdown[p]) {
                platformBreakdown[p] = { visitors: 0, sessions: 0, bookings: 0, paid_bookings: 0, revenue: 0 };
            }
            platformBreakdown[p].visitors += (r.visitors_count || 0);
            platformBreakdown[p].sessions += (r.sessions_count || 0);
            platformBreakdown[p].bookings += (r.bookings_count || 0);
            platformBreakdown[p].paid_bookings += (r.paid_bookings_count || 0);
            platformBreakdown[p].revenue += Number(r.total_revenue_amount || 0);

            // Medium breakdown
            const m = r.source_medium || 'unknown';
            if (!mediumBreakdown[m]) {
                mediumBreakdown[m] = { visitors: 0, sessions: 0, bookings: 0, paid_bookings: 0 };
            }
            mediumBreakdown[m].visitors += (r.visitors_count || 0);
            mediumBreakdown[m].sessions += (r.sessions_count || 0);
            mediumBreakdown[m].bookings += (r.bookings_count || 0);
            mediumBreakdown[m].paid_bookings += (r.paid_bookings_count || 0);
        }

        // Conversion rates
        const conversionRates = {
            visitor_to_session_rate: summary.visitors > 0 ? Number(((summary.sessions / summary.visitors) * 100).toFixed(2)) : 0,
            session_to_booking_rate: summary.sessions > 0 ? Number(((summary.bookings / summary.sessions) * 100).toFixed(2)) : 0,
            booking_to_paid_rate: summary.bookings > 0 ? Number(((summary.paid_bookings / summary.bookings) * 100).toFixed(2)) : 0
        };

        return res.status(200).json({
            success: true,
            summary,
            conversion_rates: conversionRates,
            breakdown_by_platform: platformBreakdown,
            breakdown_by_medium: mediumBreakdown,
            data_freshness_timestamp: getLastSuccessfulAggregationAt() || new Date().toISOString()
        });
    } catch (err) {
        console.error('[AdminFunnel] Exception:', err.message);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

// -----------------------------------------------------------------------------
// POST /api/admin/acquisition-funnel/aggregate (Manual Maintenance Trigger)
// -----------------------------------------------------------------------------
router.post('/aggregate', async (req, res) => {
    try {
        const { target_date, prune_retention = false } = req.body || {};

        const aggResult = await aggregateDailyMetrics(target_date);
        let retentionResult = null;

        if (prune_retention) {
            retentionResult = await runRetentionCleanup({ dryRun: false });
        }

        return res.status(200).json({
            success: true,
            aggregation: aggResult,
            retention: retentionResult
        });
    } catch (err) {
        console.error('[AdminFunnel] Manual aggregate exception:', err.message);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
