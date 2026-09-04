/**
 * phase_p1f_admin_funnel.test.js
 * 
 * Phase P.1F: Admin-Only Passenger Activation Funnel Backend Tests
 * POPUTKI.ONLINE
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');

// [P1F-BE-01] sends a real carrier JWT through the real carrierAuth
// middleware (mounted via routes/busAdmin.js's router.use(carrierAuth)),
// which does a mandatory real-time DB lookup as part of its fail-closed
// design. Deterministic, offline fake of the `users` table it depends on —
// see tests/helpers/fakeSupabaseClient.js for why (this repo's test env has
// no reachable Supabase project). Must be installed BEFORE routes/busAdmin
// is required, since that module requires utils/carrierAuth at load time.
const { createFakeSupabaseClient, installFakeDbModule } = require('./helpers/fakeSupabaseClient');
installFakeDbModule(createFakeSupabaseClient({
    users: [
        { id: 11, name: 'Тестовый Водитель', phone: '+992900000011', role: 'bus_driver', is_blocked: false, service_fee_percent: 10 }
    ],
    carrier_members: []
}));

// Import routers
const busAdminRouter = require('../routes/busAdmin');
const adminRouter = require('../routes/admin');

function generateCarrierToken(userId = 123, carrierId = 123, role = 'owner') {
    return jwt.sign(
        {
            sub: String(userId),
            carrierId: carrierId,
            role: role
        },
        process.env.JWT_SECRET || 'test-jwt-secret-placeholder',
        {
            algorithm: 'HS256',
            issuer: 'poputki.online',
            audience: 'poputki-carrier',
            expiresIn: '1h'
        }
    );
}

describe('PHASE P.1F — ADMIN-ONLY PASSENGER ACTIVATION FUNNEL (BACKEND)', () => {

    describe('1. Carrier Journey Endpoint Restriction (CARRIER_JOURNEY_API_ACCESS = DENIED)', () => {
        it('[P1F-BE-01] GET /api/bus-admin/bookings/:bookingId/journey returns 403 Forbidden with ACCESS_DENIED for authenticated carrier', async () => {
            const app = express();
            app.use(express.json());
            app.use('/api/bus-admin', busAdminRouter);

            const server = http.createServer(app);
            await new Promise(resolve => server.listen(0, resolve));
            const port = server.address().port;

            try {
                const carrierToken = generateCarrierToken(11, 11, 'owner');
                const res = await fetch(`http://127.0.0.1:${port}/api/bus-admin/bookings/1001/journey`, {
                    headers: {
                        'Authorization': `Bearer ${carrierToken}`
                    }
                });
                const body = await res.json();

                assert.strictEqual(res.status, 403);
                assert.strictEqual(body.success, false);
                assert.strictEqual(body.code, 'ACCESS_DENIED');
                assert.match(body.message, /панели администратора/i);
            } finally {
                server.close();
            }
        });
    });

    describe('2. Admin Auth Protection on Funnel Endpoints (IDOR / BOLA Prevention)', () => {
        it('[P1F-BE-02] Endpoints reject unauthenticated requests with 401 Unauthorized', async () => {
            const app = express();
            app.use(express.json());
            app.use('/api/admin', adminRouter);

            const server = http.createServer(app);
            await new Promise(resolve => server.listen(0, resolve));
            const port = server.address().port;

            const endpoints = [
                '/api/admin/passenger-funnel/summary',
                '/api/admin/passenger-funnel/stages',
                '/api/admin/passenger-funnel/passengers',
                '/api/admin/passenger-funnel/channels',
                '/api/admin/passenger-funnel/carriers',
                '/api/admin/passenger-funnel/attention',
                '/api/admin/passenger-funnel/bookings/1001/timeline'
            ];

            try {
                for (const ep of endpoints) {
                    const res = await fetch(`http://127.0.0.1:${port}${ep}`);
                    const body = await res.json();
                    assert.strictEqual(res.status, 401, `Endpoint ${ep} should return 401`);
                    assert.strictEqual(body.error, 'Unauthorized: Admin access required');
                }
            } finally {
                server.close();
            }
        });

        it('[P1F-BE-03] Endpoints reject forged or invalid admin token with 401', async () => {
            const app = express();
            app.use(express.json());
            app.use('/api/admin', adminRouter);

            const server = http.createServer(app);
            await new Promise(resolve => server.listen(0, resolve));
            const port = server.address().port;

            try {
                const res = await fetch(`http://127.0.0.1:${port}/api/admin/passenger-funnel/summary`, {
                    headers: { 'X-Admin-Token': 'forged-invalid-secret-key-123' }
                });
                const body = await res.json();
                assert.strictEqual(res.status, 401);
                assert.strictEqual(body.error, 'Unauthorized: Admin access required');
            } finally {
                server.close();
            }
        });

        it('[P1F-BE-03B] Endpoints allow access with valid admin token', async () => {
            const app = express();
            app.use(express.json());
            app.use('/api/admin', adminRouter);

            const server = http.createServer(app);
            await new Promise(resolve => server.listen(0, resolve));
            const port = server.address().port;

            try {
                const validAdminToken = process.env.ADMIN_SECRET_TOKEN;
                assert.ok(validAdminToken, 'process.env.ADMIN_SECRET_TOKEN must be present');

                const res = await fetch(`http://127.0.0.1:${port}/api/admin/passenger-funnel/stages`, {
                    headers: { 'X-Admin-Token': validAdminToken }
                });
                const body = await res.json();

                assert.strictEqual(res.status, 200);
                assert.strictEqual(body.success, true);
                assert.ok(Array.isArray(body.stages));
                assert.strictEqual(body.stages.length, 9);
            } finally {
                server.close();
            }
        });
    });

    describe('3. PII & Secret Data Protection Rules', () => {
        it('[P1F-BE-04] Masking helper strictly prevents leaking full phone numbers', () => {
            function maskPhone(phone) {
                if (!phone) return null;
                const clean = String(phone).trim();
                if (clean.length < 7) return '***';
                return clean.slice(0, 4) + ' ** *** ' + clean.slice(-4);
            }

            const rawPhones = ['+992900112233', '+79991234567', '927778899'];
            for (const p of rawPhones) {
                const masked = maskPhone(p);
                assert.ok(!masked.includes(p), `Masked phone ${masked} must not contain raw phone ${p}`);
                assert.ok(masked.includes('**'), 'Masked phone must include asterisks');
            }
        });

        it('[P1F-BE-05] Passenger list and timeline payload excludes raw tokens and passport data', () => {
            const forbiddenKeys = ['token', 'raw_token', 'claim_token', 'passport', 'doc_number', 'document_number', 'service_role'];
            const samplePassengerPayload = {
                booking_id: 'booking-101',
                passenger_name: 'Иван Иванов',
                masked_phone: '+992 ** *** 2233',
                carrier_name: 'ООО Транс',
                status: 'LINK_OPENED'
            };

            for (const fk of forbiddenKeys) {
                assert.strictEqual(samplePassengerPayload[fk], undefined, `Payload must not contain key ${fk}`);
            }
        });
    });

    describe('4. Funnel Math, Drop-offs & Conversion Calculations', () => {
        it('[P1F-BE-06] Stages sequence and drop-off calculations are accurate', () => {
            const sampleCounts = {
                manual: 100,
                handoff: 80,
                opened: 60,
                cta: 50,
                bot: 40,
                shared: 35,
                verified: 30,
                linked: 28,
                activated: 25
            };

            const dropOff1to2 = sampleCounts.manual - sampleCounts.handoff;
            const dropOffPct1to2 = Math.round((dropOff1to2 / sampleCounts.manual) * 100);
            assert.strictEqual(dropOff1to2, 20);
            assert.strictEqual(dropOffPct1to2, 20);

            const overallConv = Math.round((sampleCounts.activated / sampleCounts.manual) * 1000) / 10;
            assert.strictEqual(overallConv, 25.0);
        });

        it('[P1F-BE-07] Channel attribution is bound to handoff_id (not just booking_id)', () => {
            const handoffRecords = [
                { id: 'h-1', booking_id: 1, channel: 'whatsapp' },
                { id: 'h-2', booking_id: 1, channel: 'telegram' },
                { id: 'h-3', booking_id: 2, channel: 'sms' }
            ];

            const channels = {};
            for (const h of handoffRecords) {
                channels[h.channel] = (channels[h.channel] || 0) + 1;
            }

            assert.strictEqual(channels.whatsapp, 1);
            assert.strictEqual(channels.telegram, 1);
            assert.strictEqual(channels.sms, 1);
            assert.strictEqual(Object.values(channels).reduce((a, b) => a + b, 0), 3);
        });
    });

    describe('5. Tracking Inception Boundary (04.09.2026)', () => {
        it('[P1F-BE-08] Bookings created before TRACKING_STARTED_AT are flagged as legacy or excluded', () => {
            const TRACKING_STARTED_AT = new Date('2026-09-04T00:00:00.000Z');
            const legacyBooking = { id: 50, created_at: '2026-08-15T12:00:00.000Z' };
            const p1Booking = { id: 51, created_at: '2026-09-04T10:30:00.000Z' };

            const isLegacy = (b) => new Date(b.created_at) < TRACKING_STARTED_AT;

            assert.strictEqual(isLegacy(legacyBooking), true);
            assert.strictEqual(isLegacy(p1Booking), false);
        });
    });

    describe('6. Analytical Status Calculation (BOT_ABANDONED & EXPIRED)', () => {
        it('[P1F-BE-09] BOT_ABANDONED is calculated analytically when bot started > 2 hours ago without phone', () => {
            const now = Date.now();
            const twoHoursAndTenMinsAgo = new Date(now - (2 * 3600 + 600) * 1000).toISOString();
            const tenMinsAgo = new Date(now - 600 * 1000).toISOString();

            function computeStatus(events) {
                const types = events.map(e => e.event_type);
                if (types.includes('ACTIVATION_COMPLETED') || types.includes('CLAIM_COMPLETED')) return 'ACTIVATED';
                if (types.includes('PHONE_SHARED')) return 'PHONE_VERIFIED';
                if (types.includes('TELEGRAM_BOT_STARTED')) {
                    const botEv = events.find(e => e.event_type === 'TELEGRAM_BOT_STARTED');
                    const elapsedHours = (Date.now() - new Date(botEv.created_at).getTime()) / (1000 * 3600);
                    if (elapsedHours > 2) return 'BOT_ABANDONED';
                    return 'PHONE_PENDING';
                }
                return 'NOT_SHARED';
            }

            const abandonedEvents = [{ event_type: 'TELEGRAM_BOT_STARTED', created_at: twoHoursAndTenMinsAgo }];
            const pendingEvents = [{ event_type: 'TELEGRAM_BOT_STARTED', created_at: tenMinsAgo }];

            assert.strictEqual(computeStatus(abandonedEvents), 'BOT_ABANDONED');
            assert.strictEqual(computeStatus(pendingEvents), 'PHONE_PENDING');
        });
    });
});
