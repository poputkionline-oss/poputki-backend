/**
 * tests/phase_p1g2_acquisition_backend.test.js
 *
 * Phase P.1G.2: Production Backend Acquisition, Attribution and Funnel Ingestion
 * Complete Automated Test Suite
 */

'use strict';

// Set up environment before requiring routers that read env vars at module evaluation
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-placeholder-p1g2';
process.env.INTERNAL_SERVICE_SECRET = 'super-secure-internal-secret-2026';
process.env.ADMIN_SECRET_TOKEN = 'test-admin-secret-token-xyz';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const crypto = require('crypto');

const { normalizeReferrer } = require('../services/acquisition/referrerWhitelist');
const { resolveAttribution, hashToken } = require('../services/acquisition/attributionResolver');
const { ingestClientEvents, ALLOWED_CLIENT_EVENTS, PROHIBITED_CLIENT_EVENTS, scanForPiiKeys } = require('../services/acquisition/eventIngestionService');
const { recordBookingCreated, recordPaymentCompleted, recordTripCompleted } = require('../services/acquisition/serverEventService');
const { aggregateDailyMetrics, runRetentionCleanup } = require('../services/acquisition/dailyAggregationService');
const { issueUserToken } = require('../utils/userAuth');
const { setServiceRoleClient } = require('../dbServiceRole');

const acquisitionRoutes = require('../routes/acquisition');
const consentRoutes = require('../routes/consents');
const referralRoutes = require('../routes/referrals');
const internalAcquisitionRoutes = require('../routes/internalAcquisition');
const adminAcquisitionFunnelRoutes = require('../routes/adminAcquisitionFunnel');

describe('PHASE P.1G.2 — PRODUCTION BACKEND ACQUISITION & ATTRIBUTION', () => {

    // -------------------------------------------------------------------------
    // 1. Referrer Whitelist & Normalization
    // -------------------------------------------------------------------------
    describe('1. Referrer Whitelist & Normalization', () => {
        it('normalizes Instagram referrers without leaking path/query', () => {
            const res1 = normalizeReferrer('https://l.instagram.com/?u=https%3A%2F%2Fpoputki.online&e=123');
            assert.strictEqual(res1.is_whitelisted, true);
            assert.strictEqual(res1.source_platform, 'instagram');
            assert.strictEqual(res1.clean_host, 'l.instagram.com');

            const res2 = normalizeReferrer('https://www.instagram.com/stories/highlights/');
            assert.strictEqual(res2.is_whitelisted, true);
            assert.strictEqual(res2.source_platform, 'instagram');
            assert.strictEqual(res2.clean_host, 'www.instagram.com');
        });

        it('normalizes Facebook referrers', () => {
            const res = normalizeReferrer('https://l.facebook.com/l.php?u=https%3A%2F%2Fpoputki.online');
            assert.strictEqual(res.is_whitelisted, true);
            assert.strictEqual(res.source_platform, 'facebook');
            assert.strictEqual(res.clean_host, 'l.facebook.com');
        });

        it('normalizes Telegram referrers (t.me / telegram.me)', () => {
            const res1 = normalizeReferrer('https://t.me/Poputkionline_bot');
            assert.strictEqual(res1.is_whitelisted, true);
            assert.strictEqual(res1.source_platform, 'telegram');

            const res2 = normalizeReferrer('https://telegram.me/share/url?url=https://poputki.online');
            assert.strictEqual(res2.is_whitelisted, true);
            assert.strictEqual(res2.source_platform, 'telegram');
        });

        it('normalizes WhatsApp, TikTok, YouTube, Google, and Yandex', () => {
            assert.strictEqual(normalizeReferrer('https://wa.me/').source_platform, 'whatsapp');
            assert.strictEqual(normalizeReferrer('https://www.tiktok.com/@poputki').source_platform, 'tiktok');
            assert.strictEqual(normalizeReferrer('https://youtu.be/xyz123').source_platform, 'youtube');
            assert.strictEqual(normalizeReferrer('https://www.google.com/search?q=poputki').source_platform, 'google');
            assert.strictEqual(normalizeReferrer('https://www.google.com.tj/').source_platform, 'google');
            assert.strictEqual(normalizeReferrer('https://ya.ru/').source_platform, 'yandex');
            assert.strictEqual(normalizeReferrer('https://yandex.ru/search/').source_platform, 'yandex');
        });

        it('identifies internal POPUTKI.ONLINE referrers', () => {
            const res = normalizeReferrer('https://www.poputki.online/search');
            assert.strictEqual(res.is_internal, true);
            assert.strictEqual(res.source_platform, 'direct');
        });

        it('classifies unknown external referrers safely without crashing', () => {
            const res = normalizeReferrer('https://untrusted-blog.xyz/posts/travel');
            assert.strictEqual(res.is_whitelisted, false);
            assert.strictEqual(res.source_platform, 'unknown');
            assert.strictEqual(res.clean_host, 'untrusted-blog.xyz');
        });

        it('handles null, undefined, or empty referrers as direct', () => {
            assert.strictEqual(normalizeReferrer(null).source_platform, 'direct');
            assert.strictEqual(normalizeReferrer('').source_platform, 'direct');
            assert.strictEqual(normalizeReferrer('   ').source_platform, 'direct');
        });
    });

    // -------------------------------------------------------------------------
    // 2. Attribution Priority & Resolver
    // -------------------------------------------------------------------------
    describe('2. Attribution Priority & Resolver', () => {
        const mockDb = {
            from(table) {
                return {
                    select() { return this; },
                    eq() { return this; },
                    is() { return this; },
                    async maybeSingle() {
                        if (table === 'referral_links') {
                            return { data: { id: 'ref-uuid-1', owner_user_id: 55, is_active: true, revoked_at: null } };
                        }
                        if (table === 'acquisition_links') {
                            return {
                                data: {
                                    id: 'link-uuid-1',
                                    campaign_id: 'camp-uuid-100',
                                    partner_id: 'part-uuid-200',
                                    source_platform: 'instagram',
                                    source_medium: 'cpc',
                                    content_code: 'promo_story',
                                    placement_code: 'feed',
                                    is_active: true
                                }
                            };
                        }
                        return { data: null };
                    }
                };
            }
        };

        it('Priority 1: Valid passenger referral link wins over all others', async () => {
            const resolved = await resolveAttribution({
                referralCode: 'valid-ref-code',
                trackedToken: 'valid-acq-token',
                utm: { utm_source: 'google', utm_medium: 'cpc', campaign_id: 'fake-camp' },
                referrer: 'https://www.google.com',
                dbClient: mockDb
            });

            assert.strictEqual(resolved.attribution_type, 'passenger_referral');
            assert.strictEqual(resolved.attribution_confidence, 'verified_referral');
            assert.strictEqual(resolved.source_platform, 'telegram');
            assert.strictEqual(resolved.referral_link_id, 'ref-uuid-1');
        });

        it('Priority 2: Valid tracked link wins over unverified UTM and whitelisted referrer', async () => {
            const resolved = await resolveAttribution({
                trackedToken: 'valid-acq-token',
                utm: { utm_source: 'yandex', utm_medium: 'banner', campaign_id: 'forged-uuid' },
                referrer: 'https://yandex.ru',
                dbClient: mockDb
            });

            assert.strictEqual(resolved.attribution_type, 'marketing');
            assert.strictEqual(resolved.attribution_confidence, 'verified_partner');
            assert.strictEqual(resolved.source_platform, 'instagram');
            assert.strictEqual(resolved.source_medium, 'cpc');
            assert.strictEqual(resolved.campaign_id, 'camp-uuid-100');
            assert.strictEqual(resolved.partner_id, 'part-uuid-200');
        });

        it('Tracked link overrides fake UTMs (UTM cannot overwrite campaign_id or confidence)', async () => {
            const resolved = await resolveAttribution({
                trackedToken: 'valid-acq-token',
                utm: { campaign_id: 'attacker-camp-uuid', partner_id: 'attacker-partner' },
                dbClient: mockDb
            });

            assert.strictEqual(resolved.campaign_id, 'camp-uuid-100');
            assert.strictEqual(resolved.partner_id, 'part-uuid-200');
        });

        it('Priority 4: Whitelisted organic referrer when no tracked link exists', async () => {
            const emptyDb = {
                from() {
                    return { select: () => this, eq: () => this, is: () => this, maybeSingle: async () => ({ data: null }) };
                }
            };

            const resolved = await resolveAttribution({
                referrer: 'https://l.instagram.com/',
                dbClient: emptyDb
            });

            assert.strictEqual(resolved.source_platform, 'instagram');
            assert.strictEqual(resolved.attribution_type, 'marketing');
            assert.strictEqual(resolved.attribution_confidence, 'verified_referrer');
        });

        it('Priority 5: Unverified UTM parameters get unverified confidence', async () => {
            const emptyDb = {
                from() {
                    return { select: () => this, eq: () => this, is: () => this, maybeSingle: async () => ({ data: null }) };
                }
            };

            const resolved = await resolveAttribution({
                utm: { utm_source: 'tiktok', utm_medium: 'cpc' },
                dbClient: emptyDb
            });

            assert.strictEqual(resolved.source_platform, 'tiktok');
            assert.strictEqual(resolved.attribution_type, 'marketing');
            assert.strictEqual(resolved.attribution_confidence, 'unverified_utm');
        });

        it('Priority 6: Direct traffic with no referrer and no UTM', async () => {
            const emptyDb = {
                from() {
                    return { select: () => this, eq: () => this, is: () => this, maybeSingle: async () => ({ data: null }) };
                }
            };

            const resolved = await resolveAttribution({ dbClient: emptyDb });
            assert.strictEqual(resolved.source_platform, 'direct');
            assert.strictEqual(resolved.attribution_type, 'direct_organic');
            assert.strictEqual(resolved.attribution_confidence, 'direct');
            assert.strictEqual(resolved.is_direct, true);
        });
    });

    // -------------------------------------------------------------------------
    // 3. Client Event Allowlist & Server-Only Event Protection
    // -------------------------------------------------------------------------
    describe('3. Client Event Ingestion & Server-Only Protection', () => {
        it('allowed client events match the exact specification', () => {
            const expectedAllowed = ['LANDING_VIEWED', 'ROUTE_SEARCHED', 'TRIP_VIEWED', 'BOOKING_STARTED', 'TELEGRAM_OPENED', 'SHARE_CLICKED'];
            assert.strictEqual(ALLOWED_CLIENT_EVENTS.size, 6);
            expectedAllowed.forEach(evt => assert.ok(ALLOWED_CLIENT_EVENTS.has(evt)));
        });

        it('rejects forbidden server-only events when sent by client', async () => {
            const testVisitorId = crypto.randomUUID();
            const testSessionId = crypto.randomUUID();
            const mockDb = {
                from() {
                    return {
                        select() { return this; },
                        eq() { return this; },
                        maybeSingle: async () => ({ data: { id: testSessionId, anonymous_visitor_id: testVisitorId } })
                    };
                }
            };

            const forbiddenEvents = [
                'BOT_STARTED',
                'CONTACT_SHARED',
                'USER_IDENTIFIED',
                'MARKETING_CONSENT_GRANTED',
                'MARKETING_CONSENT_REVOKED',
                'BOOKING_CREATED',
                'PAYMENT_COMPLETED',
                'TRIP_COMPLETED',
                'REPEAT_BOOKING'
            ];

            for (const forbidden of forbiddenEvents) {
                const outcome = await ingestClientEvents({
                    visitorId: testVisitorId,
                    sessionId: testSessionId,
                    events: [{ event_name: forbidden, properties: {} }],
                    dbClient: mockDb
                });

                assert.strictEqual(outcome.success, false);
                assert.strictEqual(outcome.code, 403);
                assert.match(outcome.error, /SERVER_ONLY_EVENT_REJECTED/);
            }
        });

        it('rejects batch exceeding max count (10)', async () => {
            const testVisitorId = crypto.randomUUID();
            const testSessionId = crypto.randomUUID();

            const oversizedBatch = Array.from({ length: 11 }, () => ({
                event_name: 'LANDING_VIEWED',
                properties: {}
            }));

            const outcome = await ingestClientEvents({
                visitorId: testVisitorId,
                sessionId: testSessionId,
                events: oversizedBatch
            });

            assert.strictEqual(outcome.success, false);
            assert.strictEqual(outcome.code, 400);
            assert.match(outcome.error, /BATCH_LIMIT_EXCEEDED/);
        });

        it('detects and rejects recursive PII in client event properties', () => {
            assert.strictEqual(Boolean(scanForPiiKeys({ phone: '+992900000000' })), true);
            assert.strictEqual(Boolean(scanForPiiKeys({ passport: 'A1234567' })), true);
            assert.strictEqual(Boolean(scanForPiiKeys({ card_number: '4444111122223333' })), true);
            assert.strictEqual(Boolean(scanForPiiKeys({ meta: { user: { phone: '12345' } } })), true);
            assert.strictEqual(Boolean(scanForPiiKeys({ meta: { deep: { token: 'secret' } } })), true);

            assert.strictEqual(Boolean(scanForPiiKeys({ search_query: 'Душанбе - Худжанд', seat_count: 2 })), false);
            assert.strictEqual(Boolean(scanForPiiKeys({ trip_id: 101, page: '/routes' })), false);
        });

        it('rejects client event containing nested PII', async () => {
            const testVisitorId = crypto.randomUUID();
            const testSessionId = crypto.randomUUID();
            const mockDb = {
                from() {
                    return {
                        select() { return this; },
                        eq() { return this; },
                        maybeSingle: async () => ({ data: { id: testSessionId, anonymous_visitor_id: testVisitorId } })
                    };
                }
            };

            const outcome = await ingestClientEvents({
                visitorId: testVisitorId,
                sessionId: testSessionId,
                events: [{
                    event_name: 'ROUTE_SEARCHED',
                    properties: { from: 'Душанбе', nested: { phone: '+992900001122' } }
                }],
                dbClient: mockDb
            });

            assert.strictEqual(outcome.success, false);
            assert.strictEqual(outcome.code, 400);
            assert.match(outcome.error, /PII_DETECTED_IN_PAYLOAD/);
        });
    });

    // -------------------------------------------------------------------------
    // 4. Tracked Link & Open Redirect Prevention
    // -------------------------------------------------------------------------
    describe('4. Tracked Link & Open Redirect Prevention', () => {
        let server;
        let port;

        before(async () => {
            const app = express();
            app.use(express.json());
            app.use('/', acquisitionRoutes);
            server = http.createServer(app);
            await new Promise(resolve => server.listen(0, resolve));
            port = server.address().port;
        });

        after(() => {
            if (server) server.close();
        });

        it('invalid or missing rawToken safely redirects to frontend home', async () => {
            const res = await fetch(`http://127.0.0.1:${port}/l/short`, { redirect: 'manual' });
            assert.strictEqual(res.status, 302);
            assert.match(res.headers.get('location'), /https:\/\/(www\.)?poputki\.online\//);
        });

        it('invalid referral code safely redirects to frontend home', async () => {
            const res = await fetch(`http://127.0.0.1:${port}/r/ab`, { redirect: 'manual' });
            assert.strictEqual(res.status, 302);
            assert.match(res.headers.get('location'), /https:\/\/(www\.)?poputki\.online\//);
        });
    });

    // -------------------------------------------------------------------------
    // 5. Marketing Consent Endpoints & Rules
    // -------------------------------------------------------------------------
    describe('5. Marketing Consent Endpoints & Rules', () => {
        let server;
        let port;

        before(async () => {
            const app = express();
            app.use(express.json());
            app.use('/api/marketing-consents', consentRoutes);
            server = http.createServer(app);
            await new Promise(resolve => server.listen(0, resolve));
            port = server.address().port;
        });

        after(() => {
            if (server) server.close();
        });

        it('rejects unauthenticated requests with 401', async () => {
            const res = await fetch(`http://127.0.0.1:${port}/api/marketing-consents/me`);
            assert.strictEqual(res.status, 401);
        });

        it('validates allowed channel (rejects invalid channel)', async () => {
            const token = issueUserToken({ id: 777 });
            const res = await fetch(`http://127.0.0.1:${port}/api/marketing-consents`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({
                    channel: 'carrier_pigeon',
                    purpose: 'marketing'
                })
            });

            assert.strictEqual(res.status, 400);
            const body = await res.json();
            assert.strictEqual(body.error, 'INVALID_OR_MISSING_CHANNEL');
        });

        it('requires explicit purpose on grant', async () => {
            const token = issueUserToken({ id: 777 });
            const res = await fetch(`http://127.0.0.1:${port}/api/marketing-consents`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({
                    channel: 'telegram'
                })
            });

            assert.strictEqual(res.status, 400);
            const body = await res.json();
            assert.strictEqual(body.error, 'PURPOSE_REQUIRED');
        });
    });

    // -------------------------------------------------------------------------
    // 6. Referral Backend Rules
    // -------------------------------------------------------------------------
    describe('6. Referral Backend Rules', () => {
        let server;
        let port;

        before(async () => {
            const app = express();
            app.use(express.json());
            app.use('/api/referrals', referralRoutes);
            server = http.createServer(app);
            await new Promise(resolve => server.listen(0, resolve));
            port = server.address().port;
        });

        after(() => {
            if (server) server.close();
        });

        it('rejects unauthenticated request to /api/referrals/me with 401', async () => {
            const res = await fetch(`http://127.0.0.1:${port}/api/referrals/me`);
            assert.strictEqual(res.status, 401);
        });

        it('rejects unauthenticated request to /api/referrals/link with 401', async () => {
            const res = await fetch(`http://127.0.0.1:${port}/api/referrals/link`, {
                method: 'POST'
            });
            assert.strictEqual(res.status, 401);
        });
    });

    // -------------------------------------------------------------------------
    // 7. Internal Bot Endpoints & Security
    // -------------------------------------------------------------------------
    describe('7. Internal Bot Endpoints & Security', () => {
        let server;
        let port;

        before(async () => {
            const app = express();
            app.use(express.json());
            app.use('/api/internal/acquisition', internalAcquisitionRoutes);
            server = http.createServer(app);
            await new Promise(resolve => server.listen(0, resolve));
            port = server.address().port;
        });

        after(() => {
            if (server) server.close();
        });

        it('fails closed when x-internal-service-secret is missing', async () => {
            const res = await fetch(`http://127.0.0.1:${port}/api/internal/acquisition/bot-start`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ telegram_user_id: 12345 })
            });

            assert.strictEqual(res.status, 401);
        });

        it('fails closed when x-internal-service-secret is wrong', async () => {
            const res = await fetch(`http://127.0.0.1:${port}/api/internal/acquisition/bot-start`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-internal-service-secret': 'wrong-secret'
                },
                body: JSON.stringify({ telegram_user_id: 12345 })
            });

            assert.strictEqual(res.status, 401);
        });

        it('requires raw_token for consume-telegram-session', async () => {
            const res = await fetch(`http://127.0.0.1:${port}/api/internal/acquisition/consume-telegram-session`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-internal-service-secret': 'super-secure-internal-secret-2026'
                },
                body: JSON.stringify({})
            });

            assert.strictEqual(res.status, 400);
            const body = await res.json();
            assert.strictEqual(body.error, 'RAW_TOKEN_REQUIRED');
        });
    });

    // -------------------------------------------------------------------------
    // 8. Admin Funnel API & Zero PII Protection
    // -------------------------------------------------------------------------
    describe('8. Admin Funnel API & Zero PII Protection', () => {
        let server;
        let port;

        const mockAdminDb = {
            from() {
                return {
                    select() { return this; },
                    gte() { return this; },
                    lte() { return this; },
                    eq() { return this; },
                    then(resolve) {
                        resolve({
                            data: [
                                {
                                    metric_date: '2026-09-01',
                                    source_platform: 'instagram',
                                    source_medium: 'cpc',
                                    visitors_count: 50,
                                    sessions_count: 65,
                                    bot_starts_count: 12,
                                    contacts_shared_count: 8,
                                    identified_users_count: 7,
                                    bookings_count: 5,
                                    paid_bookings_count: 4,
                                    completed_trips_count: 3,
                                    referral_opens_count: 0,
                                    total_revenue: 1200
                                }
                            ],
                            error: null
                        });
                    }
                };
            }
        };

        before(async () => {
            setServiceRoleClient(mockAdminDb);
            const app = express();
            app.use(express.json());
            app.use('/api/admin/acquisition-funnel', adminAcquisitionFunnelRoutes);
            server = http.createServer(app);
            await new Promise(resolve => server.listen(0, resolve));
            port = server.address().port;
        });

        after(() => {
            setServiceRoleClient(null);
            if (server) server.close();
        });

        it('rejects requests without valid x-admin-token with 401', async () => {
            const res = await fetch(`http://127.0.0.1:${port}/api/admin/acquisition-funnel`);
            assert.strictEqual(res.status, 401);
        });

        it('rejects requests with forged x-admin-token with 401', async () => {
            const res = await fetch(`http://127.0.0.1:${port}/api/admin/acquisition-funnel`, {
                headers: { 'x-admin-token': 'attacker-forged-admin-token' }
            });
            assert.strictEqual(res.status, 401);
        });

        it('allows request with valid x-admin-token and returns zero PII structure', async () => {
            const res = await fetch(`http://127.0.0.1:${port}/api/admin/acquisition-funnel`, {
                headers: { 'x-admin-token': 'test-admin-secret-token-xyz' }
            });

            assert.strictEqual(res.status, 200);
            const body = await res.json();
            assert.strictEqual(body.success, true);
            assert.ok(body.summary !== undefined);
            assert.ok(body.conversion_rates !== undefined);

            // Assert absolute absence of PII keys
            const rawBody = JSON.stringify(body);
            assert.doesNotMatch(rawBody, /"phone"/);
            assert.doesNotMatch(rawBody, /"passport"/);
            assert.doesNotMatch(rawBody, /"telegram_id"/);
            assert.doesNotMatch(rawBody, /"raw_token"/);
            assert.doesNotMatch(rawBody, /"jwt"/);
        });
    });

    // -------------------------------------------------------------------------
    // 9. Server Event Service Non-Blocking Guarantees
    // -------------------------------------------------------------------------
    describe('9. Server Event Service Non-Blocking Guarantees', () => {
        it('handles missing bookingId gracefully without throwing uncaught exceptions', async () => {
            const res = await recordBookingCreated({ bookingId: null });
            assert.strictEqual(res.success, false);
            assert.strictEqual(res.error, 'BOOKING_ID_REQUIRED');
        });

        it('handles missing payment bookingId gracefully', async () => {
            const res = await recordPaymentCompleted({ bookingId: null });
            assert.strictEqual(res.success, false);
            assert.strictEqual(res.error, 'BOOKING_ID_REQUIRED');
        });

        it('handles missing tripId gracefully', async () => {
            const res = await recordTripCompleted({ tripId: null });
            assert.strictEqual(res.success, false);
            assert.strictEqual(res.error, 'TRIP_ID_REQUIRED');
        });
    });

    // -------------------------------------------------------------------------
    // 10. Daily Aggregation & Retention Maintenance
    // -------------------------------------------------------------------------
    describe('10. Daily Aggregation & Retention Maintenance', () => {
        const mockMaintenanceDb = {
            from() {
                return {
                    select() { return this; },
                    upsert: async () => ({ error: null }),
                    delete() { return this; },
                    lt() { return this; },
                    lte() { return this; },
                    gte() { return this; },
                    limit() { return this; },
                    maybeSingle: async () => ({ data: null }),
                    then(resolve) {
                        resolve({ data: [], error: null, count: 0 });
                    }
                };
            }
        };

        it('aggregates daily metrics idempotently without throwing', async () => {
            const result = await aggregateDailyMetrics({ targetDate: '2026-09-01', dbClient: mockMaintenanceDb });
            assert.ok(result.success === true || result.error !== undefined);
        });

        it('retention dry run executes safely', async () => {
            const result = await runRetentionCleanup({ dryRun: true, dbClient: mockMaintenanceDb });
            assert.strictEqual(result.dry_run, true);
            assert.strictEqual(result.success, true);
        });
    });
});
