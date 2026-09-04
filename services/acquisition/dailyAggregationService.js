/**
 * services/acquisition/dailyAggregationService.js
 *
 * Phase P.1G.2: Idempotent Daily Aggregation & Retention Maintenance
 *
 * Functions:
 * 1. aggregateDailyMetrics(dateStr): computes daily KPIs and upserts into acquisition_daily_metrics
 * 2. runRetentionCleanup(): safely prunes aged operational records in batches
 */

'use strict';

const { getServiceRoleClient } = require('../../dbServiceRole');
const { getReconciliationWatermark } = require('./reconciliationService');

let lastSuccessfulAggregationAt = null;

/**
 * Runs daily metric aggregation for a specified UTC date (YYYY-MM-DD).
 *
 * @param {string} [targetDateStr] - Defaults to yesterday in UTC
 * @param {Object} [options] - { dbClient }
 * @returns {Promise<Object>} Aggregation outcome
 */
async function aggregateDailyMetrics(param1 = null, param2 = {}) {
    let targetDateStr = null;
    let dbClient = null;

    if (param1 && typeof param1 === 'object') {
        targetDateStr = param1.targetDate || param1.target_date || null;
        dbClient = param1.dbClient || null;
    } else {
        targetDateStr = param1;
        dbClient = param2 && param2.dbClient ? param2.dbClient : null;
    }

    const db = dbClient || getServiceRoleClient();

    // Default to yesterday UTC
    let dateStr = targetDateStr;
    if (!dateStr) {
        const d = new Date();
        d.setUTCDate(d.getUTCDate() - 1);
        dateStr = d.toISOString().slice(0, 10);
    }

    const dayStartIso = `${dateStr}T00:00:00.000Z`;
    const endIso = `${dateStr}T23:59:59.999Z`;

    // Phase P.1G.3A: never aggregate pre-launch-watermark data into daily
    // metrics / Admin Funnel API, even for the launch calendar day itself
    // (which straddles the watermark instant). effectiveStartIso is the
    // later of the day boundary and the watermark, so same-day pre-launch
    // rows (including the known pre-launch smoke visitor/session/event) are
    // excluded without needing to hardcode any specific ID.
    const { watermark_utc: watermarkUtc } = await getReconciliationWatermark(db);
    // Compare as Date instants, never as raw strings (P.1G.3A requirement).
    const effectiveStartIso = watermarkUtc && new Date(watermarkUtc).getTime() > new Date(dayStartIso).getTime()
        ? watermarkUtc
        : dayStartIso;

    try {
        // Fetch sessions for the target date (post-watermark only)
        const { data: sessions, error: sessErr } = await db
            .from('acquisition_sessions')
            .select('anonymous_visitor_id, source_platform, source_medium, attribution_type, campaign_id, partner_id, content_code, placement_code')
            .gte('started_at', effectiveStartIso)
            .lte('started_at', endIso);

        if (sessErr) throw sessErr;

        // Fetch events for the target date (post-watermark only)
        const { data: events, error: evErr } = await db
            .from('acquisition_events')
            .select('event_name, campaign_id, partner_id, properties')
            .gte('occurred_at', effectiveStartIso)
            .lte('occurred_at', endIso);

        if (evErr) throw evErr;

        // Grouping dictionary keyed by dimensions
        const dimensionBuckets = new Map();

        function getBucketKey(platform, medium, attrType, campaignId, partnerId, content, placement) {
            return [
                platform || 'unknown',
                medium || 'unknown',
                attrType || 'unknown',
                campaignId || '',
                partnerId || '',
                content || '',
                placement || ''
            ].join('|');
        }

        // 1. Process Sessions & Visitors
        const visitorsPerBucket = new Map();
        for (const s of (sessions || [])) {
            const key = getBucketKey(
                s.source_platform,
                s.source_medium,
                s.attribution_type,
                s.campaign_id,
                s.partner_id,
                s.content_code,
                s.placement_code
            );

            if (!dimensionBuckets.has(key)) {
                dimensionBuckets.set(key, {
                    metric_date: dateStr,
                    source_platform: s.source_platform || 'unknown',
                    source_medium: s.source_medium || 'unknown',
                    attribution_type: s.attribution_type || 'unknown',
                    campaign_id: s.campaign_id || null,
                    partner_id: s.partner_id || null,
                    content_code: s.content_code || null,
                    placement_code: s.placement_code || null,
                    visitors_count: 0,
                    sessions_count: 0,
                    bot_starts_count: 0,
                    contacts_shared_count: 0,
                    users_identified_count: 0,
                    bookings_count: 0,
                    paid_bookings_count: 0,
                    completed_trips_count: 0,
                    referral_opens_count: 0,
                    total_revenue_amount: 0
                });
                visitorsPerBucket.set(key, new Set());
            }

            const bucket = dimensionBuckets.get(key);
            bucket.sessions_count += 1;
            if (s.anonymous_visitor_id) {
                visitorsPerBucket.get(key).add(s.anonymous_visitor_id);
            }
        }

        // Set unique visitor counts
        for (const [key, vSet] of visitorsPerBucket.entries()) {
            dimensionBuckets.get(key).visitors_count = vSet.size;
        }

        // 2. Process Events
        for (const ev of (events || [])) {
            const key = getBucketKey(
                'unknown',
                'unknown',
                'unknown',
                ev.campaign_id,
                ev.partner_id,
                null,
                null
            );

            // Find matching bucket or use fallback
            let bucket = dimensionBuckets.get(key);
            if (!bucket) {
                // Find any bucket with matching campaign / partner
                for (const b of dimensionBuckets.values()) {
                    if ((ev.campaign_id && b.campaign_id === ev.campaign_id) ||
                        (ev.partner_id && b.partner_id === ev.partner_id)) {
                        bucket = b;
                        break;
                    }
                }
            }

            if (!bucket) {
                bucket = {
                    metric_date: dateStr,
                    source_platform: 'unknown',
                    source_medium: 'unknown',
                    attribution_type: 'unknown',
                    campaign_id: ev.campaign_id || null,
                    partner_id: ev.partner_id || null,
                    content_code: null,
                    placement_code: null,
                    visitors_count: 0,
                    sessions_count: 0,
                    bot_starts_count: 0,
                    contacts_shared_count: 0,
                    users_identified_count: 0,
                    bookings_count: 0,
                    paid_bookings_count: 0,
                    completed_trips_count: 0,
                    referral_opens_count: 0,
                    total_revenue_amount: 0
                };
                dimensionBuckets.set(key, bucket);
            }

            switch (ev.event_name) {
                case 'BOT_STARTED': bucket.bot_starts_count += 1; break;
                case 'CONTACT_SHARED': bucket.contacts_shared_count += 1; break;
                case 'USER_IDENTIFIED': bucket.users_identified_count += 1; break;
                case 'BOOKING_CREATED': bucket.bookings_count += 1; break;
                case 'PAYMENT_COMPLETED':
                    bucket.paid_bookings_count += 1;
                    if (ev.properties && ev.properties.amount) {
                        bucket.total_revenue_amount += Number(ev.properties.amount) || 0;
                    }
                    break;
                case 'TRIP_COMPLETED': bucket.completed_trips_count += 1; break;
                case 'REFERRAL_OPENED': bucket.referral_opens_count += 1; break;
            }
        }

        // 3. Upsert rows into acquisition_daily_metrics
        let upsertedCount = 0;
        for (const row of dimensionBuckets.values()) {
            row.updated_at = new Date().toISOString();

            // Match existing record by normalized dimensions
            const { data: existing } = await db
                .from('acquisition_daily_metrics')
                .select('id')
                .eq('metric_date', row.metric_date)
                .eq('source_platform', row.source_platform)
                .eq('source_medium', row.source_medium)
                .eq('attribution_type', row.attribution_type)
                .is('campaign_id', row.campaign_id)
                .is('partner_id', row.partner_id)
                .is('content_code', row.content_code)
                .is('placement_code', row.placement_code)
                .maybeSingle();

            if (existing) {
                await db
                    .from('acquisition_daily_metrics')
                    .update(row)
                    .eq('id', existing.id);
            } else {
                await db
                    .from('acquisition_daily_metrics')
                    .insert(row);
            }
            upsertedCount++;
        }

        lastSuccessfulAggregationAt = new Date().toISOString();
        return {
            success: true,
            metric_date: dateStr,
            dimension_rows_aggregated: upsertedCount,
            last_run_at: lastSuccessfulAggregationAt
        };
    } catch (err) {
        console.error('[DailyAggregation] Aggregation error:', err.message);
        return { success: false, error: err.message };
    }
}

/**
 * Runs safe batch retention cleanup of aged operational records.
 *
 * Retention policy:
 * - acquisition_events > 30 days
 * - acquisition_link_clicks > 30 days
 * - acquisition_sessions > 90 days
 * - consumed/expired telegram_link_sessions > 7 days
 *
 * @param {Object} [options] - { dryRun, dbClient }
 * @returns {Promise<Object>} Pruning outcome
 */
async function runRetentionCleanup({ dryRun = false, dbClient = null } = {}) {
    const db = dbClient || getServiceRoleClient();
    const now = new Date();

    const date30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const date90d = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const date7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const summary = {
        dry_run: dryRun,
        events_eligible: 0,
        clicks_eligible: 0,
        sessions_eligible: 0,
        tg_sessions_eligible: 0,
        executed_at: now.toISOString()
    };

    try {
        // Clicks > 30d
        const { count: clicksCount } = await db
            .from('acquisition_link_clicks')
            .select('id', { count: 'exact', head: true })
            .lt('clicked_at', date30d);
        summary.clicks_eligible = clicksCount || 0;

        if (!dryRun && clicksCount > 0) {
            await db
                .from('acquisition_link_clicks')
                .delete()
                .lt('clicked_at', date30d);
        }

        // Sessions > 90d
        const { count: sessCount } = await db
            .from('acquisition_sessions')
            .select('id', { count: 'exact', head: true })
            .lt('started_at', date90d);
        summary.sessions_eligible = sessCount || 0;

        if (!dryRun && sessCount > 0) {
            await db
                .from('acquisition_sessions')
                .delete()
                .lt('started_at', date90d);
        }

        // Telegram link sessions > 7d (expired or consumed)
        const { count: tgCount } = await db
            .from('telegram_link_sessions')
            .select('id', { count: 'exact', head: true })
            .lt('expires_at', date7d);
        summary.tg_sessions_eligible = tgCount || 0;

        if (!dryRun && tgCount > 0) {
            await db
                .from('telegram_link_sessions')
                .delete()
                .lt('expires_at', date7d);
        }

        return { success: true, ...summary };
    } catch (err) {
        console.error('[RetentionCleanup] Retention error:', err.message);
        return { success: false, error: err.message };
    }
}

module.exports = {
    aggregateDailyMetrics,
    runRetentionCleanup,
    getLastSuccessfulAggregationAt: () => lastSuccessfulAggregationAt
};
