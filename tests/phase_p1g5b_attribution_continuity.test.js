/**
 * tests/phase_p1g5b_attribution_continuity.test.js
 *
 * Phase P.1G.5B: End-to-End Attribution Continuity & Cookie Transport Tests
 */

'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');
const crypto = require('crypto');

// Target modules
const acquisitionRoutes = require('../routes/acquisition');
const { hashToken } = require('../services/acquisition/attributionResolver');

process.env.FRONTEND_URL = 'https://www.poputki.online';

describe('Phase P.1G.5B: Attribution Continuity & Cookie Transport Suite', () => {
    let app;
    let server;
    let baseUrl;

    const mockDbState = {
        campaigns: new Map(),
        links: new Map(),
        referrals: new Map(),
        clicks: [],
        visitors: new Map(),
        sessions: new Map(),
        events: []
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
                                        }
                                    };
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
                                        }
                                    };
                                }
                            };
                        }
                    };
                }

                if (table === 'referral_links') {
                    return {
                        select(cols) {
                            return {
                                eq(col, val) {
                                    return {
                                        async maybeSingle() {
                                            for (const r of mockDbState.referrals.values()) {
                                                if (r[col] === val) return { data: { ...r }, error: null };
                                            }
                                            return { data: null, error: null };
                                        }
                                    };
                                }
                            };
                        }
                    };
                }

                if (table === 'acquisition_link_clicks') {
                    return {
                        async insert(row) {
                            mockDbState.clicks.push(row);
                            return { data: [row], error: null };
                        }
                    };
                }

                if (table === 'acquisition_visitors') {
                    return {
                        select(cols) {
                            return {
                                eq(col, val) {
                                    return {
                                        async maybeSingle() {
                                            const item = mockDbState.visitors.get(val);
                                            return { data: item ? { ...item } : null, error: null };
                                        }
                                    };
                                }
                            };
                        },
                        async insert(row) {
                            mockDbState.visitors.set(row.anonymous_visitor_id, { ...row });
                            return { data: [row], error: null };
                        },
                        update(updates) {
                            return {
                                eq(col, val) {
                                    const existing = mockDbState.visitors.get(val) || {};
                                    const updated = { ...existing, ...updates };
                                    mockDbState.visitors.set(val, updated);
                                    return Promise.resolve({ data: [updated], error: null });
                                }
                            };
                        }
                    };
                }

                if (table === 'acquisition_sessions') {
                    return {
                        select(cols) {
                            return {
                                eq(col, val) {
                                    return {
                                        order() {
                                            return {
                                                limit() {
                                                    return {
                                                        async maybeSingle() {
                                                            const matches = Array.from(mockDbState.sessions.values()).filter(s => s[col] === val);
                                                            return { data: matches[matches.length - 1] ? { ...matches[matches.length - 1] } : null, error: null };
                                                        }
                                                    };
                                                }
                                            };
                                        },
                                        async maybeSingle() {
                                            const item = mockDbState.sessions.get(val);
                                            return { data: item ? { ...item } : null, error: null };
                                        }
                                    };
                                }
                            };
                        },
                        async insert(row) {
                            mockDbState.sessions.set(row.id, { ...row });
                            return { data: [row], error: null };
                        },
                        update(updates) {
                            return {
                                eq(col, val) {
                                    const existing = mockDbState.sessions.get(val) || {};
                                    const updated = { ...existing, ...updates };
                                    mockDbState.sessions.set(val, updated);
                                    return Promise.resolve({ data: [updated], error: null });
                                }
                            };
                        }
                    };
                }

                if (table === 'acquisition_events') {
                    return {
                        insert(rows) {
                            const inserted = rows.map((r, i) => ({ id: mockDbState.events.length + i + 1, ...r }));
                            mockDbState.events.push(...inserted);
                            return {
                                select() {
                                    return Promise.resolve({ data: inserted, error: null });
                                }
                            };
                        }
                    };
                }

                return {
                    select() { return { eq() { return { maybeSingle() { return Promise.resolve({ data: null, error: null }); } }; } }; }
                };
            }
        };
    }

    const { setServiceRoleClient } = require('../dbServiceRole');

    before((t, done) => {
        setServiceRoleClient(createMockDb());

        app = express();
        app.use(express.json());
        app.use('/', acquisitionRoutes);
        app.use('/api/acquisition', acquisitionRoutes);

        server = http.createServer(app);
        server.listen(0, () => {
            baseUrl = `http://127.0.0.1:${server.address().port}`;
            done();
        });
    });

    after((t, done) => {
        setServiceRoleClient(null);
        server.close(done);
    });

    it('1. GET /l/:rawToken sets HttpOnly Secure SameSite=Lax cookie and no-store headers', async () => {
        const rawToken = 'test-token-continuity-123';
        const tokenHash = hashToken(rawToken);
        const linkId = crypto.randomUUID();
        const campaignId = crypto.randomUUID();

        mockDbState.links.set(linkId, {
            id: linkId,
            campaign_id: campaignId,
            short_token_hash: tokenHash,
            target_path: '/search?tab=bus',
            is_active: true,
            expires_at: null,
            source_platform: 'instagram',
            source_medium: 'organic_social',
            attribution_type: 'marketing'
        });

        const res = await fetch(`${baseUrl}/l/${rawToken}`, {
            headers: {
                'x-forwarded-host': 'www.poputki.online',
                'x-forwarded-proto': 'https'
            },
            redirect: 'manual'
        });

        assert.strictEqual(res.status, 302);
        assert.strictEqual(res.headers.get('cache-control'), 'no-store, no-cache, must-revalidate, proxy-revalidate');

        const setCookie = res.headers.get('set-cookie');
        assert.ok(setCookie, 'Set-Cookie header must be present');
        assert.ok(setCookie.includes('__poputki_acq_token=' + rawToken), 'Must contain cookie name and raw token');
        assert.ok(setCookie.includes('HttpOnly'), 'Must be HttpOnly');
        assert.ok(setCookie.includes('Secure'), 'Must be Secure');
        assert.ok(setCookie.includes('SameSite=Lax'), 'Must be SameSite=Lax');
        assert.ok(setCookie.includes('Domain=.poputki.online'), 'Must specify .poputki.online domain');
        assert.ok(setCookie.includes('Max-Age=1800'), 'Must have 1800s TTL (30 min)');
    });

    it('2. GET /r/:rawCode sets __poputki_ref_code HttpOnly cookie', async () => {
        const rawCode = 'REF_CODE_99';
        const codeHash = hashToken(rawCode);
        const refId = crypto.randomUUID();

        mockDbState.referrals.set(refId, {
            id: refId,
            owner_user_id: 101,
            short_code_hash: codeHash,
            is_active: true,
            expires_at: null,
            revoked_at: null
        });

        const res = await fetch(`${baseUrl}/r/${rawCode}`, {
            headers: {
                'x-forwarded-host': 'www.poputki.online',
                'x-forwarded-proto': 'https'
            },
            redirect: 'manual'
        });

        assert.strictEqual(res.status, 302);
        const setCookie = res.headers.get('set-cookie');
        assert.ok(setCookie.includes('__poputki_ref_code=' + rawCode));
        assert.ok(setCookie.includes('HttpOnly'));
        assert.ok(setCookie.includes('Domain=.poputki.online'));
    });

    it('3. POST /api/acquisition/session resolves attribution from cookie when body parameter is omitted', async () => {
        const rawToken = 'cookie-only-token-abc';
        const tokenHash = hashToken(rawToken);
        const linkId = crypto.randomUUID();
        const campaignId = crypto.randomUUID();

        mockDbState.links.set(linkId, {
            id: linkId,
            campaign_id: campaignId,
            short_token_hash: tokenHash,
            target_path: '/search?tab=bus',
            is_active: true,
            expires_at: null,
            source_platform: 'telegram',
            source_medium: 'influencer',
            attribution_type: 'marketing',
            content_code: 'content_p1g5b',
            placement_code: 'placement_p1g5b'
        });

        const visitorId = crypto.randomUUID();
        const res = await fetch(`${baseUrl}/api/acquisition/session`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Cookie': `__poputki_acq_token=${rawToken}; other_cookie=123`
            },
            body: JSON.stringify({
                anonymous_visitor_id: visitorId,
                landing_path: '/search'
                // tracked_token intentionally omitted from body
            })
        });

        assert.strictEqual(res.status, 200);
        const body = await res.json();
        assert.strictEqual(body.success, true);
        assert.strictEqual(body.data.attribution.source_platform, 'telegram');
        assert.strictEqual(body.data.attribution.source_medium, 'influencer');

        // Verify session in DB
        const sessionInDb = mockDbState.sessions.get(body.data.session_id);
        assert.ok(sessionInDb);
        assert.strictEqual(sessionInDb.campaign_id, campaignId);
        assert.strictEqual(sessionInDb.content_code, 'content_p1g5b');
        assert.strictEqual(sessionInDb.placement_code, 'placement_p1g5b');

        // Verify visitor in DB
        const visitorInDb = mockDbState.visitors.get(visitorId);
        assert.ok(visitorInDb);
        assert.strictEqual(visitorInDb.initial_campaign_id, campaignId);
        assert.strictEqual(visitorInDb.last_non_direct_campaign_id, campaignId);
    });

    it('3b. A malformed Cookie header never causes a 500 - parseCookies fails safe per-pair', async () => {
        const visitorId = crypto.randomUUID();
        const res = await fetch(`${baseUrl}/api/acquisition/session`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                // '%' with no valid escape sequence throws inside decodeURIComponent
                'Cookie': '__poputki_acq_token=%E0%A4%A; __poputki_ref_code=; ===; ;stray=value'
            },
            body: JSON.stringify({
                anonymous_visitor_id: visitorId,
                landing_path: '/search'
            })
        });

        assert.notStrictEqual(res.status, 500, 'a malformed Cookie header must never crash the endpoint');
        assert.strictEqual(res.status, 200);
        const body = await res.json();
        assert.strictEqual(body.success, true);
    });

    it('4. Event ingestion inherits verified campaign_id from session', async () => {
        const visitorId = crypto.randomUUID();
        const sessionId = crypto.randomUUID();
        const campaignId = crypto.randomUUID();

        mockDbState.visitors.set(visitorId, { anonymous_visitor_id: visitorId });
        mockDbState.sessions.set(sessionId, {
            id: sessionId,
            anonymous_visitor_id: visitorId,
            campaign_id: campaignId,
            partner_id: null,
            user_id: null
        });

        const res = await fetch(`${baseUrl}/api/acquisition/events`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-visitor-id': visitorId
            },
            body: JSON.stringify({
                anonymous_visitor_id: visitorId,
                session_id: sessionId,
                events: [
                    {
                        event_name: 'LANDING_VIEWED',
                        properties: { page_path: '/search' }
                    },
                    {
                        event_name: 'ROUTE_SEARCHED',
                        properties: { from_city: 'Dushanbe', to_city: 'Khujand' }
                    }
                ]
            })
        });

        assert.strictEqual(res.status, 200);
        const body = await res.json();
        assert.strictEqual(body.success, true);
        assert.strictEqual(body.ingested_count, 2);

        const events = mockDbState.events.filter(e => e.session_id === sessionId);
        assert.strictEqual(events.length, 2);
        assert.strictEqual(events[0].campaign_id, campaignId, 'LANDING_VIEWED must inherit campaign_id');
        assert.strictEqual(events[1].campaign_id, campaignId, 'ROUTE_SEARCHED must inherit campaign_id');
    });

    it('5. Direct revisit preserves last_non_direct_campaign_id', async () => {
        const visitorId = crypto.randomUUID();
        const campaignId = crypto.randomUUID();

        mockDbState.visitors.set(visitorId, {
            anonymous_visitor_id: visitorId,
            initial_campaign_id: campaignId,
            first_non_direct_campaign_id: campaignId,
            last_non_direct_campaign_id: campaignId,
            last_non_direct_platform: 'instagram'
        });

        const res = await fetch(`${baseUrl}/api/acquisition/session`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                anonymous_visitor_id: visitorId,
                landing_path: '/'
            })
        });

        assert.strictEqual(res.status, 200);
        const visitor = mockDbState.visitors.get(visitorId);
        assert.strictEqual(visitor.last_non_direct_campaign_id, campaignId, 'Direct revisit must not wipe last non-direct');
    });

    it('6. Unknown token does NOT set cookie and redirects to fallback', async () => {
        const res = await fetch(`${baseUrl}/l/non-existent-token-xyz`, { redirect: 'manual' });
        assert.strictEqual(res.status, 302);
        assert.strictEqual(res.headers.get('location'), 'https://www.poputki.online/');
        assert.strictEqual(res.headers.get('set-cookie'), null, 'Must not set cookie on unknown token');
    });

    it('7. Direct Render fallback returns controlled redirect to canonical frontend with acq_token', async () => {
        const rawToken = 'render-fallback-token-123';
        const tokenHash = hashToken(rawToken);
        const linkId = crypto.randomUUID();

        mockDbState.links.set(linkId, {
            id: linkId,
            short_token_hash: tokenHash,
            target_path: '/search?tab=bus',
            is_active: true
        });

        // Request with Render host (no poputki.online in host)
        const res = await fetch(`${baseUrl}/l/${rawToken}`, {
            headers: {
                'host': 'poputki-backend-9dv6.onrender.com'
            },
            redirect: 'manual'
        });

        assert.strictEqual(res.status, 302);
        const location = res.headers.get('location');
        assert.ok(location.startsWith('https://www.poputki.online/search?tab=bus'));
        assert.ok(location.includes(`acq_token=${rawToken}`));

        // Cookie is set without cross-domain reject (no domain=.poputki.online when on onrender.com host)
        const setCookie = res.headers.get('set-cookie');
        assert.ok(!setCookie.includes('Domain=.poputki.online'), 'Must not attempt cross-domain on onrender host');
    });

    it('8. A spoofed Host/X-Forwarded-Host that merely contains "poputki.online" as a substring does not trigger the production cookie domain', async () => {
        const rawToken = 'spoofed-host-token-456';
        const tokenHash = hashToken(rawToken);
        const linkId = crypto.randomUUID();

        mockDbState.links.set(linkId, {
            id: linkId,
            short_token_hash: tokenHash,
            target_path: '/search?tab=bus',
            is_active: true
        });

        const res = await fetch(`${baseUrl}/l/${rawToken}`, {
            headers: {
                'host': 'poputki.online.attacker-controlled.example',
                'x-forwarded-host': 'poputki.online.attacker-controlled.example'
            },
            redirect: 'manual'
        });

        assert.strictEqual(res.status, 302);
        const setCookie = res.headers.get('set-cookie');
        assert.ok(!setCookie.includes('Domain=.poputki.online'), 'a host that only contains the substring "poputki.online" must not match the real domain');
    });
});
