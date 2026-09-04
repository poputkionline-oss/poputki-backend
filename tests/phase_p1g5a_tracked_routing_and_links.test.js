/**
 * tests/phase_p1g5a_tracked_routing_and_links.test.js
 *
 * Phase P.1G.5A: Regression & Contract Tests for Tracked Link Routing and Campaign Links Loading
 */

'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');
const crypto = require('crypto');

// Target modules
const acquisitionRoutes = require('../routes/acquisition');
const adminAcquisitionRoutes = require('../routes/adminAcquisitionFunnel');
const campaignService = require('../services/acquisition/campaignManagementService');
const reportingService = require('../services/acquisition/acquisitionReportingService');
const { hashToken } = require('../services/acquisition/attributionResolver');

const ADMIN_TOKEN = 'test-admin-secret-token-p1g5a-12345';
process.env.ADMIN_SECRET_TOKEN = ADMIN_TOKEN;
process.env.FRONTEND_URL = 'https://poputki.online'; // Test apex domain normalization

describe('Phase P.1G.5A: Tracked Link Routing & Campaign Links Suite', () => {
    let app;
    let server;
    let baseUrl;

    const mockDbState = {
        campaigns: new Map(),
        links: new Map(),
        clicks: []
    };

    function createMockDb() {
        return {
            from(table) {
                if (table === 'acquisition_campaigns') {
                    return {
                        select(cols) {
                            return {
                                eq(col, val) {
                                    return {
                                        async maybeSingle() {
                                            const item = mockDbState.campaigns.get(val);
                                            return { data: item ? { ...item } : null, error: null };
                                        },
                                        order() {
                                            return Promise.resolve({ data: Array.from(mockDbState.campaigns.values()), error: null });
                                        }
                                    };
                                },
                                order() {
                                    return Promise.resolve({ data: Array.from(mockDbState.campaigns.values()), error: null });
                                }
                            };
                        }
                    };
                }

                if (table === 'acquisition_links') {
                    return {
                        select(cols) {
                            return {
                                eq(col, val) {
                                    return {
                                        async maybeSingle() {
                                            for (const l of mockDbState.links.values()) {
                                                if (l[col] === val) return { data: { ...l }, error: null };
                                            }
                                            return { data: null, error: null };
                                        },
                                        order() {
                                            const matches = Array.from(mockDbState.links.values()).filter(l => l[col] === val);
                                            return Promise.resolve({ data: matches, error: null });
                                        }
                                    };
                                }
                            };
                        },
                        insert(data) {
                            const id = crypto.randomUUID();
                            const item = { id, created_at: new Date().toISOString(), ...data };
                            mockDbState.links.set(id, item);
                            return {
                                select() {
                                    return {
                                        single() {
                                            return Promise.resolve({ data: { ...item }, error: null });
                                        }
                                    };
                                }
                            };
                        }
                    };
                }

                if (table === 'acquisition_link_clicks') {
                    return {
                        async insert(click) {
                            mockDbState.clicks.push({ id: crypto.randomUUID(), ...click });
                            return { error: null };
                        },
                        select(cols, opts) {
                            return {
                                eq(col, val) {
                                    const count = mockDbState.clicks.filter(c => c[col] === val).length;
                                    return Promise.resolve({ count, error: null });
                                }
                            };
                        }
                    };
                }

                if (table === 'acquisition_system_config') {
                    return {
                        select() {
                            return {
                                eq(col, val) {
                                    return {
                                        async maybeSingle() {
                                            return { data: { value: { watermark_utc: '2026-09-04T18:23:32.118Z' } }, error: null };
                                        }
                                    };
                                }
                            };
                        }
                    };
                }

                const chain = {
                    eq: () => chain,
                    neq: () => chain,
                    gte: () => chain,
                    lte: () => chain,
                    order: () => Promise.resolve({ data: [], error: null }),
                    then: (resolve) => resolve({ data: [], count: 0, error: null })
                };
                return {
                    select: () => chain
                };
            }
        };
    }

    before(async () => {
        const { setServiceRoleClient } = require('../dbServiceRole');
        setServiceRoleClient(createMockDb());

        app = express();
        app.use(express.json());
        app.use('/api/admin/acquisition', adminAcquisitionRoutes);
        app.use('/', acquisitionRoutes);

        await new Promise((resolve) => {
            server = http.createServer(app);
            server.listen(0, () => {
                const port = server.address().port;
                baseUrl = `http://127.0.0.1:${port}`;
                resolve();
            });
        });
    });

    after(async () => {
        if (server) await new Promise((r) => server.close(r));
    });

    // -------------------------------------------------------------------------
    // PART A: Tracked Link Redirect & Headers
    // -------------------------------------------------------------------------
    describe('Tracked Link Redirects & Anti-Caching', () => {
        let validRawToken;
        let validLinkId;
        let campaignId;

        before(async () => {
            campaignId = crypto.randomUUID();
            mockDbState.campaigns.set(campaignId, {
                id: campaignId,
                code: 'test-campaign-p1g5a',
                name: 'Test Campaign P1G5A',
                source_platform: 'direct',
                source_medium: 'direct',
                campaign_type: 'organic',
                is_active: true
            });

            validRawToken = 'SafeRandomToken123';
            validLinkId = crypto.randomUUID();
            mockDbState.links.set(validLinkId, {
                id: validLinkId,
                campaign_id: campaignId,
                short_token_hash: hashToken(validRawToken),
                target_path: '/search?tab=bus',
                is_active: true,
                expires_at: null,
                created_at: new Date().toISOString()
            });
        });

        it('redirects valid token to canonical www domain with query parameter and no-store headers', async () => {
            const res = await fetch(`${baseUrl}/l/${validRawToken}`, { redirect: 'manual' });
            assert.strictEqual(res.status, 302);

            const location = res.headers.get('location');
            assert.ok(location.startsWith('https://www.poputki.online/search?tab=bus'), `Redirect must target canonical www: ${location}`);
            assert.ok(location.includes(`acq_token=${validRawToken}`), 'Redirect must attach acq_token');

            // Verify Anti-Caching headers
            assert.strictEqual(res.headers.get('cache-control'), 'no-store, no-cache, must-revalidate, proxy-revalidate');
            assert.strictEqual(res.headers.get('pragma'), 'no-cache');
            assert.strictEqual(res.headers.get('expires'), '0');

            // Verify click recorded
            assert.strictEqual(mockDbState.clicks.length, 1);
            assert.strictEqual(mockDbState.clicks[0].link_id, validLinkId);
        });

        it('redirects unknown/invalid token safely to fallback without recording click', async () => {
            const initialClicks = mockDbState.clicks.length;
            const res = await fetch(`${baseUrl}/l/nonExistentToken999`, { redirect: 'manual' });
            assert.strictEqual(res.status, 302);
            assert.strictEqual(res.headers.get('location'), 'https://www.poputki.online/');
            assert.strictEqual(res.headers.get('cache-control'), 'no-store, no-cache, must-revalidate, proxy-revalidate');
            assert.strictEqual(mockDbState.clicks.length, initialClicks, 'No click should be recorded for unknown token');
        });

        it('redirects short malformed token (< 8 chars) immediately to fallback', async () => {
            const res = await fetch(`${baseUrl}/l/short`, { redirect: 'manual' });
            assert.strictEqual(res.status, 302);
            assert.strictEqual(res.headers.get('location'), 'https://www.poputki.online/');
        });

        it('redirects deactivated link safely to fallback without recording click', async () => {
            const deactToken = 'DeactivatedToken123';
            const deactId = crypto.randomUUID();
            mockDbState.links.set(deactId, {
                id: deactId,
                campaign_id: campaignId,
                short_token_hash: hashToken(deactToken),
                target_path: '/search?tab=bus',
                is_active: false, // Inactive
                expires_at: null,
                created_at: new Date().toISOString()
            });

            const initialClicks = mockDbState.clicks.length;
            const res = await fetch(`${baseUrl}/l/${deactToken}`, { redirect: 'manual' });
            assert.strictEqual(res.status, 302);
            assert.strictEqual(res.headers.get('location'), 'https://www.poputki.online/');
            assert.strictEqual(mockDbState.clicks.length, initialClicks, 'No click should be recorded for deactivated link');
        });

        it('redirects expired link safely to fallback without recording click', async () => {
            const expiredToken = 'ExpiredToken12345';
            const expId = crypto.randomUUID();
            mockDbState.links.set(expId, {
                id: expId,
                campaign_id: campaignId,
                short_token_hash: hashToken(expiredToken),
                target_path: '/search?tab=bus',
                is_active: true,
                expires_at: new Date(Date.now() - 60000).toISOString(), // Expired
                created_at: new Date(Date.now() - 120000).toISOString()
            });

            const initialClicks = mockDbState.clicks.length;
            const res = await fetch(`${baseUrl}/l/${expiredToken}`, { redirect: 'manual' });
            assert.strictEqual(res.status, 302);
            assert.strictEqual(res.headers.get('location'), 'https://www.poputki.online/');
            assert.strictEqual(mockDbState.clicks.length, initialClicks, 'No click should be recorded for expired link');
        });

        it('prevents open redirect even if malicious path is injected', async () => {
            const evilToken = 'EvilPathToken1234';
            const evilId = crypto.randomUUID();
            mockDbState.links.set(evilId, {
                id: evilId,
                campaign_id: campaignId,
                short_token_hash: hashToken(evilToken),
                target_path: 'https://evil.com/phishing',
                is_active: true,
                expires_at: null,
                created_at: new Date().toISOString()
            });

            const res = await fetch(`${baseUrl}/l/${evilToken}`, { redirect: 'manual' });
            assert.strictEqual(res.status, 302);
            const location = res.headers.get('location');
            assert.ok(location.startsWith('https://www.poputki.online/'), 'Must sanitize to internal root');
            assert.ok(!location.includes('evil.com'), 'Must never redirect to external domain');
        });
    });

    // -------------------------------------------------------------------------
    // PART B: Campaign Links Endpoint & ID Validation
    // -------------------------------------------------------------------------
    describe('Campaign Links Endpoint & Consistency', () => {
        let testCampaignId;

        before(() => {
            testCampaignId = crypto.randomUUID();
            mockDbState.campaigns.set(testCampaignId, {
                id: testCampaignId,
                code: 'endpoint-check-camp',
                name: 'Endpoint Check Campaign',
                source_platform: 'direct',
                source_medium: 'direct',
                campaign_type: 'organic',
                is_active: true
            });
        });

        it('returns 400 Bad Request when campaign ID is not a valid UUID (e.g. "undefined")', async () => {
            const res = await fetch(`${baseUrl}/api/admin/acquisition/campaigns/undefined/links`, {
                headers: { 'x-admin-token': ADMIN_TOKEN }
            });
            assert.strictEqual(res.status, 400);
            const body = await res.json();
            assert.strictEqual(body.error, 'INVALID_ID');
            assert.ok(body.message.includes('UUID'));
        });

        it('returns 200 with links array for valid campaign UUID', async () => {
            const res = await fetch(`${baseUrl}/api/admin/acquisition/campaigns/${testCampaignId}/links`, {
                headers: { 'x-admin-token': ADMIN_TOKEN }
            });
            assert.strictEqual(res.status, 200);
            const body = await res.json();
            assert.strictEqual(body.success, true);
            assert.ok(Array.isArray(body.links));
        });

        it('reports provide both id and campaign_id in campaignsReport rows', async () => {
            const mockDb = createMockDb();
            const report = await reportingService.getCampaignsReport({}, mockDb);
            assert.strictEqual(report.success, true);
            assert.ok(report.rows.length > 0);
            for (const row of report.rows) {
                assert.ok(row.id, 'row.id must be present');
                assert.ok(row.campaign_id, 'row.campaign_id must be present');
                assert.strictEqual(row.id, row.campaign_id, 'row.id must equal row.campaign_id');
            }
        });
    });
});
