/**
 * tests/phase_p1g4_acquisition_reporting.test.js
 *
 * Behavioral tests for Phase P.1G.4 Acquisition Reporting & Admin APIs.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const reportingService = require('../services/acquisition/acquisitionReportingService');

// Mock db client helper
function createMockDbClient({
    watermark = '2026-09-04T18:23:32.118Z',
    sessions = [],
    events = [],
    campaigns = [],
    partners = [],
    referralLinks = [],
    referralAttributions = [],
    bookingAttributions = [],
    dailyMetrics = [],
    outbox = [],
    sysConfig = []
} = {}) {
    return {
        from(tableName) {
            let filterConditions = [];
            let isCountHead = false;

            const builder = {
                select(fields, opts) {
                    if (opts && opts.count === 'exact' && opts.head) {
                        isCountHead = true;
                    }
                    return builder;
                },
                eq(field, val) {
                    filterConditions.push(r => r[field] === val);
                    return builder;
                },
                neq(field, val) {
                    filterConditions.push(r => r[field] !== val);
                    return builder;
                },
                gte(field, val) {
                    filterConditions.push(r => String(r[field] || '') >= String(val));
                    return builder;
                },
                lte(field, val) {
                    filterConditions.push(r => String(r[field] || '') <= String(val));
                    return builder;
                },
                not(field, op, val) {
                    if (op === 'is' && val === null) {
                        filterConditions.push(r => r[field] !== null && r[field] !== undefined);
                    }
                    return builder;
                },
                in(field, arr) {
                    filterConditions.push(r => arr.includes(r[field]));
                    return builder;
                },
                order() {
                    return builder;
                },
                maybeSingle() {
                    return {
                        then(resolve) {
                            let rows = getTableRows(tableName);
                            rows = applyFilters(rows, filterConditions);
                            resolve({ data: rows[0] || null, error: null });
                        }
                    };
                },
                then(resolve) {
                    let rows = getTableRows(tableName);
                    rows = applyFilters(rows, filterConditions);
                    if (isCountHead) {
                        resolve({ count: rows.length, error: null });
                    } else {
                        resolve({ data: rows, error: null });
                    }
                }
            };

            function getTableRows(t) {
                switch (t) {
                    case 'acquisition_system_config':
                        return sysConfig.length ? sysConfig : [
                            { key: 'reconciliation_launch_watermark', value: { watermark_utc: watermark } },
                            { key: 'reconciliation_lock', updated_at: '2026-09-04T18:30:00.000Z' }
                        ];
                    case 'acquisition_sessions': return [...sessions];
                    case 'acquisition_events': return [...events];
                    case 'acquisition_campaigns': return [...campaigns];
                    case 'acquisition_partners': return [...partners];
                    case 'referral_links': return [...referralLinks];
                    case 'referral_attributions': return [...referralAttributions];
                    case 'booking_acquisition_attributions': return [...bookingAttributions];
                    case 'acquisition_daily_metrics': return [...dailyMetrics];
                    case 'acquisition_event_outbox': return [...outbox];
                    default: return [];
                }
            }

            function applyFilters(rows, conds) {
                let res = rows;
                for (const c of conds) {
                    res = res.filter(c);
                }
                return res;
            }

            return builder;
        }
    };
}

test('PHASE P.1G.4 — Acquisition Reporting Service Tests', async (t) => {

    await t.test('1. resolveDateRange enforces launch watermark and caps max period to 366 days', async () => {
        const watermark = '2026-09-04T18:23:32.118Z';
        const db = createMockDbClient({ watermark });

        // Request earlier than watermark: effective start must clamp to watermark
        const range1 = await reportingService.resolveDateRange('2026-08-01', '2026-09-10', db);
        assert.equal(range1.effectiveStartIso, watermark);
        assert.equal(range1.isCompletelyBeforeWatermark, false);

        // Request completely before watermark: isCompletelyBeforeWatermark is true
        const range2 = await reportingService.resolveDateRange('2026-08-01', '2026-09-01', db);
        assert.equal(range2.isCompletelyBeforeWatermark, true);

        // Exceed 366 days cap: diffDays <= 366
        const range3 = await reportingService.resolveDateRange('2024-01-01', '2026-09-05', db);
        assert.ok(range3.diffDays <= 366, 'Period exceeding 366 days is capped');
    });

    await t.test('2. getFunnelSummary excludes placeholder visitor and pre-watermark data', async () => {
        const watermark = '2026-09-04T18:23:32.118Z';
        const sessions = [
            // Pre-watermark session: should be excluded by effectiveStart
            { id: 's-pre', anonymous_visitor_id: 'vis-pre', started_at: '2026-09-04T17:00:00.000Z', source_platform: 'instagram' },
            // Placeholder visitor post-watermark: must be excluded
            { id: 's-placeholder', anonymous_visitor_id: reportingService.PLACEHOLDER_VISITOR_ID, started_at: '2026-09-04T19:00:00.000Z', source_platform: 'direct' },
            // Real post-watermark session
            { id: 's-real-1', anonymous_visitor_id: 'vis-real-1', started_at: '2026-09-04T19:30:00.000Z', source_platform: 'telegram' },
            // Another session from same visitor: should count 1 unique visitor, 2 sessions
            { id: 's-real-2', anonymous_visitor_id: 'vis-real-1', started_at: '2026-09-04T20:00:00.000Z', source_platform: 'telegram' }
        ];

        const events = [
            { event_name: 'BOT_STARTED', occurred_at: '2026-09-04T19:35:00.000Z', anonymous_visitor_id: 'vis-real-1' },
            { event_name: 'CONTACT_SHARED', occurred_at: '2026-09-04T19:36:00.000Z', anonymous_visitor_id: 'vis-real-1' },
            { event_name: 'USER_IDENTIFIED', occurred_at: '2026-09-04T19:37:00.000Z', user_id: 42, anonymous_visitor_id: 'vis-real-1' },
            { event_name: 'BOOKING_CREATED', occurred_at: '2026-09-04T19:38:00.000Z', booking_id: 201, anonymous_visitor_id: 'vis-real-1' },
            { event_name: 'PAYMENT_COMPLETED', occurred_at: '2026-09-04T19:40:00.000Z', booking_id: 201, anonymous_visitor_id: 'vis-real-1', properties: { amount: 150 } },
            { event_name: 'TRIP_COMPLETED', occurred_at: '2026-09-04T22:00:00.000Z', booking_id: 201, anonymous_visitor_id: 'vis-real-1' }
        ];

        const db = createMockDbClient({ watermark, sessions, events });
        const res = await reportingService.getFunnelSummary({ date_from: '2026-09-04', date_to: '2026-09-05' }, db);

        assert.equal(res.success, true);
        assert.equal(res.kpis.unique_visitors, 1, 'Only 1 unique visitor counted');
        assert.equal(res.kpis.sessions, 2, '2 post-watermark sessions counted');
        assert.equal(res.kpis.bot_starts, 1);
        assert.equal(res.kpis.contacts_shared, 1);
        assert.equal(res.kpis.users_identified, 1);
        assert.equal(res.kpis.bookings_created, 1);
        assert.equal(res.kpis.paid_bookings, 1);
        assert.equal(res.kpis.completed_trips, 1);
        assert.equal(res.kpis.total_revenue, 150);

        // Funnel steps
        assert.equal(res.funnel.length, 11);
        assert.equal(res.funnel[0].id, 'visitors');
        assert.equal(res.funnel[0].count, 1);
        assert.equal(res.funnel[10].id, 'trip_completed');
        assert.equal(res.funnel[10].count, 1);
    });

    await t.test('3. getSourcesReport includes all mandatory platforms and handles unknown safely', async () => {
        const watermark = '2026-09-04T18:23:32.118Z';
        const sessions = [
            { id: 's1', anonymous_visitor_id: 'v1', started_at: '2026-09-04T19:00:00.000Z', source_platform: 'unknown', source_medium: 'unknown' },
            { id: 's2', anonymous_visitor_id: 'v2', started_at: '2026-09-04T19:30:00.000Z', source_platform: 'instagram', source_medium: 'paid_social' }
        ];

        const db = createMockDbClient({ watermark, sessions });
        const res = await reportingService.getSourcesReport({ date_from: '2026-09-04', date_to: '2026-09-05' }, db);

        assert.equal(res.success, true);
        const platforms = res.rows.map(r => r.source_platform);
        for (const p of reportingService.MANDATORY_PLATFORMS) {
            assert.ok(platforms.includes(p), `Mandatory platform ${p} must be present`);
        }

        const unknownRow = res.rows.find(r => r.source_platform === 'unknown');
        assert.ok(unknownRow, 'Unknown platform row exists');
        assert.equal(unknownRow.sessions, 1);
        assert.equal(unknownRow.visitors, 1);

        const instaRow = res.rows.find(r => r.source_platform === 'instagram');
        assert.equal(instaRow.sessions, 1);
        assert.equal(instaRow.visitors, 1);
    });

    await t.test('4. getCampaignsReport calculates CPA and protects ROMI against mixed currencies', async () => {
        const watermark = '2026-09-04T18:23:32.118Z';
        const campaigns = [
            {
                id: 'c-tjs',
                code: 'CAMP_TJS',
                name: 'Local Campaign TJS',
                source_platform: 'telegram',
                source_medium: 'paid_social',
                campaign_type: 'paid',
                budget_amount: 500,
                currency: 'TJS',
                is_active: true
            },
            {
                id: 'c-rub',
                code: 'CAMP_RUB',
                name: 'Cross-Border Campaign RUB',
                source_platform: 'yandex',
                source_medium: 'search_paid',
                campaign_type: 'paid',
                budget_amount: 5000,
                currency: 'RUB', // Different currency from platform TJS!
                is_active: true
            }
        ];

        const dailyMetrics = [
            {
                campaign_id: 'c-tjs',
                metric_date: '2026-09-05',
                bookings_count: 10,
                paid_bookings_count: 5,
                completed_trips_count: 4,
                total_revenue_amount: 1500
            },
            {
                campaign_id: 'c-rub',
                metric_date: '2026-09-05',
                bookings_count: 20,
                paid_bookings_count: 10,
                completed_trips_count: 8,
                total_revenue_amount: 3000 // In TJS!
            }
        ];

        const db = createMockDbClient({ watermark, campaigns, dailyMetrics });
        const res = await reportingService.getCampaignsReport({ date_from: '2026-09-04', date_to: '2026-09-06' }, db);

        assert.equal(res.success, true);
        assert.equal(res.rows.length, 2);

        // Campaign 1: Same currency (TJS)
        const tjsCamp = res.rows.find(r => r.code === 'CAMP_TJS');
        assert.equal(tjsCamp.cpa, 100); // 500 budget / 5 paid bookings = 100
        assert.equal(tjsCamp.romi, 200); // ((1500 - 500) / 500) * 100 = 200%
        assert.equal(tjsCamp.currency_mismatch, false);

        // Campaign 2: Mixed currency (RUB budget vs TJS revenue)
        const rubCamp = res.rows.find(r => r.code === 'CAMP_RUB');
        assert.equal(rubCamp.cpa, 500); // 5000 budget / 10 paid bookings
        assert.equal(rubCamp.romi, null, 'ROMI is null for mixed currencies');
        assert.equal(rubCamp.currency_mismatch, true, 'Flag currency_mismatch is true');
    });

    await t.test('5. getPartnersReport exposes ZERO PII and aggregates correctly', async () => {
        const watermark = '2026-09-04T18:23:32.118Z';
        const partners = [
            {
                id: 'p-1',
                code: 'BLOGGER_ALEX',
                display_name: 'Alex Travel',
                partner_type: 'influencer',
                is_active: true
            }
        ];

        const db = createMockDbClient({ watermark, partners });
        const res = await reportingService.getPartnersReport({ date_from: '2026-09-04', date_to: '2026-09-06' }, db);

        assert.equal(res.success, true);
        assert.equal(res.rows.length, 1);
        const p = res.rows[0];
        assert.equal(p.code, 'BLOGGER_ALEX');
        assert.equal(p.display_name, 'Alex Travel');
        assert.equal(p.phone, undefined, 'No phone exposed');
        assert.equal(p.email, undefined, 'No email exposed');
        assert.equal(p.user_id, undefined, 'No user_id exposed');
    });

    await t.test('6. getReferralsReport calculates conversion rate and k-factor without PII', async () => {
        const watermark = '2026-09-04T18:23:32.118Z';
        const referralLinks = [
            { id: 'ref-link-1', created_at: '2026-09-04T19:00:00.000Z' },
            { id: 'ref-link-2', created_at: '2026-09-04T20:00:00.000Z' }
        ];

        const referralAttributions = [
            { id: 1, created_at: '2026-09-04T19:30:00.000Z' },
            { id: 2, created_at: '2026-09-04T20:30:00.000Z' },
            { id: 3, created_at: '2026-09-04T21:30:00.000Z' },
            { id: 4, created_at: '2026-09-04T22:00:00.000Z' }
        ];

        const bookingAttributions = [
            { booking_id: 101, referral_attribution_id: 1, created_at: '2026-09-04T19:45:00.000Z' },
            { booking_id: 102, referral_attribution_id: 2, created_at: '2026-09-04T20:45:00.000Z' }
        ];

        const db = createMockDbClient({ watermark, referralLinks, referralAttributions, bookingAttributions });
        const res = await reportingService.getReferralsReport({ date_from: '2026-09-04', date_to: '2026-09-06' }, db);

        assert.equal(res.success, true);
        assert.equal(res.summary.links_created, 2);
        assert.equal(res.summary.invitees_registered, 4);
        assert.equal(res.summary.invitees_booked, 2);
        assert.equal(res.summary.referral_conversion_rate, 50); // 2 booked / 4 registered * 100 = 50%
        assert.equal(res.summary.k_factor, 2); // 4 registered / 2 links = 2.0
    });

    await t.test('7. getGuardrailsReport triggers warning on unknown rate > 15% and critical on dead-letter', async () => {
        const watermark = '2026-09-04T18:23:32.118Z';
        const sessions = [
            { id: 's1', anonymous_visitor_id: 'v1', started_at: '2026-09-04T19:00:00.000Z', source_platform: 'unknown' },
            { id: 's2', anonymous_visitor_id: 'v2', started_at: '2026-09-04T19:10:00.000Z', source_platform: 'telegram' },
            { id: 's3', anonymous_visitor_id: 'v3', started_at: '2026-09-04T19:20:00.000Z', source_platform: 'instagram' },
            { id: 's4', anonymous_visitor_id: 'v4', started_at: '2026-09-04T19:30:00.000Z', source_platform: 'direct', is_direct: true }
        ]; // 2 out of 4 are unknown/direct = 50% > 15%

        const outbox = [
            { status: 'pending' },
            { status: 'dead_letter' }
        ];

        const db = createMockDbClient({ watermark, sessions, outbox });
        const res = await reportingService.getGuardrailsReport({ date_from: '2026-09-04', date_to: '2026-09-06' }, db);

        assert.equal(res.success, true);
        assert.equal(res.diagnostics.outbox_pending, 1);
        assert.equal(res.diagnostics.outbox_dead_letter, 1);
        assert.equal(res.signals.unknown_source, 'WARNING');
        assert.equal(res.signals.dead_letter, 'CRITICAL');
    });

    await t.test('8. HTTP endpoints reject unauthorized requests with 401 and allow valid admin token', async () => {
        const express = require('express');
        const http = require('http');
        const adminRouter = require('../routes/adminAcquisitionFunnel');

        const app = express();
        app.use(express.json());
        app.use('/api/admin/acquisition', adminRouter);

        const server = http.createServer(app);
        await new Promise(resolve => server.listen(0, resolve));
        const port = server.address().port;

        try {
            // Anonymous request: must fail with 401
            const anonRes = await fetch(`http://127.0.0.1:${port}/api/admin/acquisition/summary`);
            assert.equal(anonRes.status, 401, 'Anonymous request rejected with 401');

            // Carrier / invalid token request: must fail with 401
            const badTokenRes = await fetch(`http://127.0.0.1:${port}/api/admin/acquisition/sources`, {
                headers: { 'x-admin-token': 'carrier-or-invalid-token' }
            });
            assert.equal(badTokenRes.status, 401, 'Invalid token rejected with 401');

            // Valid admin token: succeeds (or returns JSON, not 401/403)
            const adminToken = process.env.ADMIN_SECRET_TOKEN || 'test-admin-secret-token-which-is-at-least-32-chars';
            process.env.ADMIN_SECRET_TOKEN = adminToken;

            const adminRes = await fetch(`http://127.0.0.1:${port}/api/admin/acquisition/guardrails`, {
                headers: { 'x-admin-token': adminToken }
            });
            assert.notEqual(adminRes.status, 401, 'Valid admin token passes auth gate');
            assert.notEqual(adminRes.status, 403, 'Valid admin token passes auth gate');
        } finally {
            server.close();
        }
    });

});
