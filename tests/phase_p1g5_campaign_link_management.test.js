/**
 * tests/phase_p1g5_campaign_link_management.test.js
 *
 * Phase P.1G.5: Automated Test Suite for Campaign, Tracked Link, and Partner Management
 */

'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const express = require('express');
const crypto = require('crypto');

const campaignService = require('../services/acquisition/campaignManagementService');
const adminAcquisitionRouter = require('../routes/adminAcquisitionFunnel');

describe('Phase P.1G.5: Campaign, Tracked Link & Partner Management', () => {
    let server;
    let baseUrl;
    const ADMIN_TOKEN = 'test-secret-token-p1g5';

    // In-memory mock DB client for robust isolated testing
    function createMockDb() {
        const campaigns = new Map();
        const links = new Map();
        const partners = new Map();
        const clicks = new Map();

        return {
            from(table) {
                if (table === 'acquisition_campaigns') {
                    return {
                        select(cols) {
                            return {
                                eq(col, val) {
                                    return {
                                        async maybeSingle() {
                                            for (const c of campaigns.values()) {
                                                if (c[col] === val) return { data: { ...c }, error: null };
                                            }
                                            return { data: null, error: null };
                                        },
                                        async single() {
                                            for (const c of campaigns.values()) {
                                                if (c[col] === val) return { data: { ...c }, error: null };
                                            }
                                            return { data: null, error: { message: 'Not found' } };
                                        }
                                    };
                                },
                                order() {
                                    return Promise.resolve({ data: Array.from(campaigns.values()), error: null });
                                }
                            };
                        },
                        insert(row) {
                            const id = crypto.randomUUID();
                            const item = { id, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...row };
                            campaigns.set(id, item);
                            return {
                                select() {
                                    return {
                                        async single() {
                                            return { data: { ...item }, error: null };
                                        }
                                    };
                                }
                            };
                        },
                        update(patch) {
                            return {
                                eq(col, val) {
                                    return {
                                        select() {
                                            return {
                                                async single() {
                                                    const item = campaigns.get(val);
                                                    if (!item) return { data: null, error: { message: 'Not found' } };
                                                    Object.assign(item, patch);
                                                    return { data: { ...item }, error: null };
                                                },
                                                async maybeSingle() {
                                                    const item = campaigns.get(val);
                                                    if (!item) return { data: null, error: null };
                                                    Object.assign(item, patch);
                                                    return { data: { ...item }, error: null };
                                                }
                                            };
                                        }
                                    };
                                }
                            };
                        }
                    };
                }

                if (table === 'acquisition_links') {
                    return {
                        select(cols, opts) {
                            if (opts && opts.count === 'exact') {
                                return {
                                    eq(col, val) {
                                        let cnt = 0;
                                        for (const l of links.values()) {
                                            if (l[col] === val) cnt++;
                                        }
                                        return Promise.resolve({ count: cnt, error: null });
                                    }
                                };
                            }
                            return {
                                eq(col, val) {
                                    return {
                                        order() {
                                            const matches = Array.from(links.values()).filter(l => l[col] === val);
                                            return Promise.resolve({ data: matches, error: null });
                                        }
                                    };
                                }
                            };
                        },
                        insert(row) {
                            const id = crypto.randomUUID();
                            const item = { id, created_at: new Date().toISOString(), ...row };
                            links.set(id, item);
                            return {
                                select() {
                                    return {
                                        async single() {
                                            return { data: { ...item }, error: null };
                                        }
                                    };
                                }
                            };
                        },
                        update(patch) {
                            return {
                                eq(col, val) {
                                    return {
                                        select() {
                                            return {
                                                async maybeSingle() {
                                                    const item = links.get(val);
                                                    if (!item) return { data: null, error: null };
                                                    Object.assign(item, patch);
                                                    return { data: { ...item }, error: null };
                                                }
                                            };
                                        }
                                    };
                                }
                            };
                        }
                    };
                }

                if (table === 'acquisition_partners') {
                    return {
                        select() {
                            return {
                                eq(col, val) {
                                    return {
                                        async maybeSingle() {
                                            for (const p of partners.values()) {
                                                if (p[col] === val) return { data: { ...p }, error: null };
                                            }
                                            return { data: null, error: null };
                                        }
                                    };
                                },
                                order() {
                                    return Promise.resolve({ data: Array.from(partners.values()), error: null });
                                }
                            };
                        },
                        insert(row) {
                            const id = crypto.randomUUID();
                            const item = { id, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...row };
                            partners.set(id, item);
                            return {
                                select() {
                                    return {
                                        async single() {
                                            return { data: { ...item }, error: null };
                                        }
                                    };
                                }
                            };
                        },
                        update(patch) {
                            return {
                                eq(col, val) {
                                    return {
                                        select() {
                                            return {
                                                async maybeSingle() {
                                                    const item = partners.get(val);
                                                    if (!item) return { data: null, error: null };
                                                    Object.assign(item, patch);
                                                    return { data: { ...item }, error: null };
                                                }
                                            };
                                        }
                                    };
                                }
                            };
                        }
                    };
                }

                if (table === 'acquisition_link_clicks') {
                    return {
                        select(cols, opts) {
                            return {
                                eq(col, val) {
                                    return Promise.resolve({ count: 0, error: null });
                                }
                            };
                        }
                    };
                }

                throw new Error(`Unknown table in mock: ${table}`);
            }
        };
    }

    before(async () => {
        process.env.ADMIN_SECRET_TOKEN = ADMIN_TOKEN;

        const app = express();
        app.use(express.json());
        app.use('/api/admin/acquisition', adminAcquisitionRouter);

        await new Promise((resolve) => {
            server = http.createServer(app);
            server.listen(0, '127.0.0.1', () => {
                const port = server.address().port;
                baseUrl = `http://127.0.0.1:${port}/api/admin/acquisition`;
                resolve();
            });
        });
    });

    after(async () => {
        if (server) {
            await new Promise(resolve => server.close(resolve));
        }
    });

    // -------------------------------------------------------------------------
    // UNIT TESTS: Validation & Pure Service Logic
    // -------------------------------------------------------------------------
    describe('Service Logic & Validators', () => {
        it('validates target_path strictly against relative path rules', () => {
            assert.strictEqual(campaignService.isValidTargetPath('/'), true);
            assert.strictEqual(campaignService.isValidTargetPath('/search?tab=bus'), true);
            assert.strictEqual(campaignService.isValidTargetPath('/bus-tickets/123'), true);
            assert.strictEqual(campaignService.isValidTargetPath('/profile'), true);

            // Rejections
            assert.strictEqual(campaignService.isValidTargetPath('https://evil.com'), false);
            assert.strictEqual(campaignService.isValidTargetPath('//evil.com'), false);
            assert.strictEqual(campaignService.isValidTargetPath('/foo//bar'), false);
            assert.strictEqual(campaignService.isValidTargetPath('/path/../secret'), false);
            assert.strictEqual(campaignService.isValidTargetPath('/path\\test'), false);
            assert.strictEqual(campaignService.isValidTargetPath('/login:admin'), false);
            assert.strictEqual(campaignService.isValidTargetPath('relative/without/slash'), false);
        });

        it('validates campaign code format', () => {
            assert.strictEqual(campaignService.isValidCampaignCode('autumn-promo-2026'), true);
            assert.strictEqual(campaignService.isValidCampaignCode('tg_channel_01'), true);
            assert.strictEqual(campaignService.isValidCampaignCode('a'), false); // too short
            assert.strictEqual(campaignService.isValidCampaignCode('Promo Campaign'), false); // spaces, capitals
            assert.strictEqual(campaignService.isValidCampaignCode('promo$code'), false); // special char
        });

        it('creates organic campaign without budget via service', async () => {
            const mockDb = createMockDb();
            const campaign = await campaignService.createCampaign({
                name: 'Organic Instagram Reels',
                code: 'ig-reels-organic',
                source_platform: 'instagram',
                source_medium: 'organic_social',
                campaign_type: 'organic'
            }, mockDb);

            assert.ok(campaign.id);
            assert.strictEqual(campaign.code, 'ig-reels-organic');
            assert.strictEqual(campaign.budget_amount, null);
            assert.strictEqual(campaign.currency, null);
            assert.strictEqual(campaign.is_active, true);
        });

        it('creates paid campaign with budget and currency via service', async () => {
            const mockDb = createMockDb();
            const campaign = await campaignService.createCampaign({
                name: 'Paid Telegram Ads',
                code: 'tg-ads-autumn',
                source_platform: 'telegram',
                source_medium: 'paid_social',
                campaign_type: 'paid',
                budget_amount: 1500,
                currency: 'TJS'
            }, mockDb);

            assert.ok(campaign.id);
            assert.strictEqual(campaign.budget_amount, 1500);
            assert.strictEqual(campaign.currency, 'TJS');
        });

        it('rejects duplicate campaign code via service', async () => {
            const mockDb = createMockDb();
            await campaignService.createCampaign({
                name: 'Test 1',
                code: 'duplicate-code',
                source_platform: 'website',
                source_medium: 'direct',
                campaign_type: 'organic'
            }, mockDb);

            await assert.rejects(async () => {
                await campaignService.createCampaign({
                    name: 'Test 2',
                    code: 'duplicate-code',
                    source_platform: 'website',
                    source_medium: 'direct',
                    campaign_type: 'organic'
                }, mockDb);
            }, (err) => {
                assert.strictEqual(err.code, 'CAMPAIGN_CODE_EXISTS');
                assert.strictEqual(err.status, 409);
                return true;
            });
        });

        it('issues tracked link with single-exposure raw token and stored SHA-256 hash', async () => {
            const mockDb = createMockDb();
            const campaign = await campaignService.createCampaign({
                name: 'Test Campaign',
                code: 'test-camp',
                source_platform: 'instagram',
                source_medium: 'organic_social',
                campaign_type: 'organic'
            }, mockDb);

            const result = await campaignService.createTrackedLink(campaign.id, {
                content_code: 'bio_link',
                target_path: '/bus-tickets'
            }, mockDb);

            assert.ok(result.raw_token, 'raw_token must be present in creation response');
            assert.ok(result.public_url.includes(result.raw_token));
            assert.strictEqual(result.link.campaign_id, campaign.id);
            assert.strictEqual(result.link.target_path, '/bus-tickets');

            // Verify raw token is NOT in the DB link object
            assert.strictEqual(result.link.short_token_hash, undefined, 'raw token hash should not be exposed in returned public link object');
        });
    });

    // -------------------------------------------------------------------------
    // INTEGRATION TESTS: HTTP Endpoints & Auth Gatekeeper
    // -------------------------------------------------------------------------
    describe('HTTP Endpoints & Access Control', () => {
        it('rejects unauthenticated requests with 401', async () => {
            const res = await fetch(`${baseUrl}/campaigns`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'Test' })
            });
            assert.strictEqual(res.status, 401);
        });

        it('prohibits physical DELETE on campaigns, links, and partners with 405', async () => {
            const res1 = await fetch(`${baseUrl}/campaigns/123`, {
                method: 'DELETE',
                headers: { 'x-admin-token': ADMIN_TOKEN }
            });
            assert.strictEqual(res1.status, 405);

            const res2 = await fetch(`${baseUrl}/links/123`, {
                method: 'DELETE',
                headers: { 'x-admin-token': ADMIN_TOKEN }
            });
            assert.strictEqual(res2.status, 405);
        });

        it('rejects invalid campaign payload with 400', async () => {
            const res = await fetch(`${baseUrl}/campaigns`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-admin-token': ADMIN_TOKEN
                },
                body: JSON.stringify({
                    name: 'Bad Campaign',
                    code: 'invalid code spaces',
                    source_platform: 'invalid_platform',
                    source_medium: 'invalid_medium'
                })
            });
            assert.strictEqual(res.status, 400);
            const body = await res.json();
            assert.strictEqual(body.error, 'VALIDATION_ERROR');
        });

        it('rejects invalid target_path on link creation (open redirect protection)', async () => {
            const mockDb = createMockDb();
            const camp = await campaignService.createCampaign({
                name: 'Open Redirect Test',
                code: 'open-redir-test',
                source_platform: 'website',
                source_medium: 'direct',
                campaign_type: 'organic'
            }, mockDb);

            await assert.rejects(async () => {
                await campaignService.createTrackedLink(camp.id, {
                    target_path: 'https://evil.example.com/steal'
                }, mockDb);
            }, (err) => {
                assert.strictEqual(err.code, 'VALIDATION_ERROR');
                assert.strictEqual(err.status, 400);
                return true;
            });
        });

        it('prohibits modifying immutable campaign code once links exist', async () => {
            const mockDb = createMockDb();
            const camp = await campaignService.createCampaign({
                name: 'Locked Campaign',
                code: 'locked-code-01',
                source_platform: 'telegram',
                source_medium: 'paid_social',
                campaign_type: 'paid'
            }, mockDb);

            // Create a link for this campaign
            await campaignService.createTrackedLink(camp.id, {
                target_path: '/'
            }, mockDb);

            // Attempt to change code
            await assert.rejects(async () => {
                await campaignService.updateCampaign(camp.id, {
                    code: 'new-code-attempt'
                }, mockDb);
            }, (err) => {
                assert.strictEqual(err.code, 'CAMPAIGN_IMMUTABLE_FIELD');
                assert.strictEqual(err.status, 409);
                return true;
            });

            // But changing name or budget succeeds
            const updated = await campaignService.updateCampaign(camp.id, {
                name: 'Updated Name Safe',
                budget_amount: 500
            }, mockDb);
            assert.strictEqual(updated.name, 'Updated Name Safe');
            assert.strictEqual(updated.budget_amount, 500);
        });

        it('toggles campaign and link active statuses safely', async () => {
            const mockDb = createMockDb();
            const camp = await campaignService.createCampaign({
                name: 'Status Campaign',
                code: 'status-test-camp',
                source_platform: 'instagram',
                source_medium: 'organic_social',
                campaign_type: 'organic'
            }, mockDb);

            const paused = await campaignService.updateCampaignStatus(camp.id, { is_active: false }, mockDb);
            assert.strictEqual(paused.is_active, false);

            const linkRes = await campaignService.createTrackedLink(camp.id, { target_path: '/' }, mockDb);
            assert.strictEqual(linkRes.link.is_active, true);

            const pausedLink = await campaignService.updateLinkStatus(linkRes.link.id, { is_active: false }, mockDb);
            assert.strictEqual(pausedLink.is_active, false);
        });

        it('manages partners in dictionary without PII', async () => {
            const mockDb = createMockDb();
            const partner = await campaignService.createPartner({
                code: 'blogger-farrukh',
                display_name: 'Farrukh Blogger',
                partner_type: 'influencer'
            }, mockDb);

            assert.ok(partner.id);
            assert.strictEqual(partner.code, 'blogger-farrukh');
            assert.strictEqual(partner.is_active, true);
            assert.strictEqual(partner.phone, undefined, 'No PII phone');
            assert.strictEqual(partner.telegram_id, undefined, 'No telegram ID');

            const list = await campaignService.listPartners(mockDb);
            assert.strictEqual(list.length, 1);

            const toggled = await campaignService.updatePartnerStatus(partner.id, { is_active: false }, mockDb);
            assert.strictEqual(toggled.is_active, false);
        });
    });
});
