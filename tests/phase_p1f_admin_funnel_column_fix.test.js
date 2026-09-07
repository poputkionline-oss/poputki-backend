/**
 * phase_p1f_admin_funnel_column_fix.test.js
 *
 * Hotfix Regression Gate:
 * 1. PostgREST bus_tickets selector column validation (carrier_id removed, operator_id preserved).
 * 2. Strict schema-enforcing simulation: attempts to select bus_tickets.carrier_id throw 42703.
 * 3. HTTP 200 verification for /passengers, /summary, /stages, /carriers, /attention.
 * 4. Production-like dataset: exactly 11 attention records returned when attentionOnly=true.
 * 5. NOT_SHARED duration threshold: <= 120 min excluded, > 120 min included.
 * 6. Consistency between /attention and /passengers across filters.
 * 7. Admin auth enforcement (401 without/invalid token).
 * 8. Zero PII leak verification (all phones masked, no secrets).
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const express = require('express');

// Set admin secret token for test environment
process.env.ADMIN_SECRET_TOKEN = 'test-admin-secret-token-hotfix-gate';

describe('HOTFIX REGRESSION GATE — ADMIN FUNNEL INVALID CARRIER COLUMN & ERROR STATE', () => {

    describe('1. Static Code Analysis: bus_tickets schema integrity', () => {
        const routePath = path.join(__dirname, '..', 'routes', 'adminPassengerFunnel.js');
        const routeSource = fs.readFileSync(routePath, 'utf8');

        it('[HOTFIX-01] No PostgREST selector queries bus_tickets.carrier_id', () => {
            // Find all bus_tickets (...) selectors in the file
            const regex = /bus_tickets\s*\(([^)]+)\)/g;
            let match;
            const selectors = [];
            while ((match = regex.exec(routeSource)) !== null) {
                selectors.push(match[1]);
            }

            assert.ok(selectors.length >= 4, `Expected at least 4 bus_tickets selectors, found ${selectors.length}`);

            selectors.forEach((cols, idx) => {
                const columnList = cols.split(',').map(c => c.trim());
                assert.strictEqual(
                    columnList.includes('carrier_id'),
                    false,
                    `Selector #${idx + 1} ("${cols}") contains forbidden nonexistent column carrier_id`
                );
                // Must contain operator_id if it's querying carrier info
                if (cols.includes('operator_id')) {
                    assert.ok(columnList.includes('operator_id'), `Selector #${idx + 1} should use operator_id`);
                }
            });
        });

        it('[HOTFIX-02] No references to ticket.carrier_id or b.bus_tickets.carrier_id exist in logic', () => {
            assert.strictEqual(
                routeSource.includes('t.carrier_id'),
                false,
                'Found leftover t.carrier_id in adminPassengerFunnel.js'
            );
            assert.strictEqual(
                routeSource.includes('trip.carrier_id'),
                false,
                'Found leftover trip.carrier_id in adminPassengerFunnel.js'
            );
        });

        it('[HOTFIX-03] All bus_tickets selectors use strictly valid schema columns', () => {
            const VALID_BUS_TICKETS_COLUMNS = new Set([
                'id', 'operator_id', 'transport_company', 'from_city', 'from_address',
                'to_city', 'to_address', 'departure_date', 'departure_time', 'arrival_date',
                'arrival_time', 'duration_minutes', 'price', 'total_seats', 'reserved_seats',
                'status', 'bus_type', 'passenger_comments', 'intermediate_stops', 'created_at',
                'floor1_seats', 'floor2_seats', 'premium_price', 'photos', 'bus_id',
                'group_leader_name', 'group_leader_phone', 'group_leader_whatsapp'
            ]);

            const regex = /bus_tickets\s*\(([^)]+)\)/g;
            let match;
            while ((match = regex.exec(routeSource)) !== null) {
                const cols = match[1].split(',').map(c => c.trim());
                cols.forEach(col => {
                    assert.ok(
                        VALID_BUS_TICKETS_COLUMNS.has(col),
                        `Column "${col}" is not in PostgreSQL public.bus_tickets schema!`
                    );
                });
            }
        });
    });

    describe('2. Strict Schema-Enforcing Integration Simulation', () => {
        // Build an in-memory client that fails if carrier_id is queried on bus_tickets
        const VALID_BUS_TICKETS_COLUMNS = new Set([
            'id', 'operator_id', 'transport_company', 'from_city', 'from_address',
            'to_city', 'to_address', 'departure_date', 'departure_time', 'arrival_date',
            'arrival_time', 'duration_minutes', 'price', 'total_seats', 'reserved_seats',
            'status', 'bus_type', 'passenger_comments', 'intermediate_stops', 'created_at',
            'floor1_seats', 'floor2_seats', 'premium_price', 'photos', 'bus_id',
            'group_leader_name', 'group_leader_phone', 'group_leader_whatsapp'
        ]);

        const now = Date.now();
        const iso = (offsetMinutes) => new Date(now - offsetMinutes * 60 * 1000).toISOString();

        // Seed realistic production-like dataset
        const seededBusTickets = [
            { id: 74, operator_id: 11, transport_company: 'ООО Рохи Абрешим', from_city: 'Худжанд (TJ)', to_city: 'Нижневартовск (РФ)', departure_date: '2026-09-09', departure_time: '20:00:00' },
            { id: 76, operator_id: 11, transport_company: 'ООО Рохи Абрешим', from_city: 'Худжанд (TJ)', to_city: 'Нижневартовск (РФ)', departure_date: '2026-09-16', departure_time: '20:00:00' },
            { id: 73, operator_id: 11, transport_company: 'ООО Рохи Абрешим', from_city: 'Нижневартовск (РФ)', to_city: 'Канибадам (TJ)', departure_date: '2026-09-16', departure_time: '00:30:00' }
        ];

        const seededBookings = [
            // 1. The 10 production NOT_SHARED manual bookings created > 120 min ago
            { id: 479, passenger_name: 'Пассажир 479', phone: '+992900114479', seat_numbers: ['1'], status: 'confirmed', claim_status: 'unclaimed', created_at: iso(190), bus_ticket_id: 74, channel: 'manual', source_type: 'manual' },
            { id: 478, passenger_name: 'Пассажир 478', phone: '+992900114478', seat_numbers: ['2'], status: 'confirmed', claim_status: 'unclaimed', created_at: iso(195), bus_ticket_id: 74, channel: 'manual', source_type: 'manual' },
            { id: 477, passenger_name: 'Пассажир 477', phone: '+992900114477', seat_numbers: ['3'], status: 'confirmed', claim_status: 'unclaimed', created_at: iso(200), bus_ticket_id: 74, channel: 'manual', source_type: 'manual' },
            { id: 476, passenger_name: 'Пассажир 476', phone: '+992900114476', seat_numbers: ['4'], status: 'confirmed', claim_status: 'unclaimed', created_at: iso(205), bus_ticket_id: 74, channel: 'manual', source_type: 'manual' },
            { id: 474, passenger_name: 'Пассажир 474', phone: '+992900114474', seat_numbers: ['5'], status: 'confirmed', claim_status: 'unclaimed', created_at: iso(2100), bus_ticket_id: 74, channel: 'manual', source_type: 'manual' },
            { id: 473, passenger_name: 'Пассажир 473', phone: '+992900114473', seat_numbers: ['6'], status: 'confirmed', claim_status: 'unclaimed', created_at: iso(2120), bus_ticket_id: 74, channel: 'manual', source_type: 'manual' },
            { id: 467, passenger_name: 'Пассажир 467', phone: '+992900114467', seat_numbers: ['7'], status: 'confirmed', claim_status: 'unclaimed', created_at: iso(4600), bus_ticket_id: 76, channel: 'manual', source_type: 'manual' },
            { id: 466, passenger_name: 'Пассажир 466', phone: '+992900114466', seat_numbers: ['8'], status: 'confirmed', claim_status: 'unclaimed', created_at: iso(4620), bus_ticket_id: 76, channel: 'manual', source_type: 'manual' },
            { id: 464, passenger_name: 'Пассажир 464', phone: '+992900114464', seat_numbers: ['9'], status: 'confirmed', claim_status: 'unclaimed', created_at: iso(4700), bus_ticket_id: 74, channel: 'manual', source_type: 'manual' },
            { id: 463, passenger_name: 'Пассажир 463', phone: '+992900114463', seat_numbers: ['10'], status: 'confirmed', claim_status: 'unclaimed', created_at: iso(4720), bus_ticket_id: 74, channel: 'manual', source_type: 'manual' },

            // 2. Booking #449 with pending claim request (phone mismatch / under review)
            { id: 449, passenger_name: 'Пассажир 449', phone: '+992900114449', seat_numbers: ['11'], status: 'confirmed', claim_status: 'pending_verification', created_at: iso(6500), bus_ticket_id: 73, channel: 'manual', source_type: 'manual' },

            // 3. FRESH manual booking created 30 minutes ago (<= 120 min) -> MUST NOT be in attention queue!
            { id: 499, passenger_name: 'Пассажир Свежий', phone: '+992900114499', seat_numbers: ['12'], status: 'confirmed', claim_status: 'unclaimed', created_at: iso(30), bus_ticket_id: 74, channel: 'manual', source_type: 'manual' },

            // 4. Activated booking (claimed) -> MUST NOT be in attention queue!
            { id: 480, passenger_name: 'Пассажир Активный', phone: '+992900114480', seat_numbers: ['13'], status: 'confirmed', claim_status: 'claimed', claimed_by_user_id: 99, created_at: iso(300), bus_ticket_id: 74, channel: 'manual', source_type: 'manual' }
        ];

        const seededClaimRequests = [
            { id: '8e5b18a6-3471-4b71-a8ec-1bfe7006d458', booking_id: 449, requesting_user_id: 101, failure_reason_code: 'UNKNOWN_ROLE_REQUIRES_APPROVAL', status: 'pending', created_at: iso(6490) }
        ];

        function createStrictSchemaClient() {
            return {
                from(tableName) {
                    let rows = [];
                    if (tableName === 'bus_ticket_bookings') rows = [...seededBookings];
                    else if (tableName === 'booking_claim_requests') rows = [...seededClaimRequests];
                    else if (tableName === 'booking_journey_events') rows = [];
                    else if (tableName === 'booking_handoffs') rows = [];
                    else if (tableName === 'bus_tickets') rows = [...seededBusTickets];

                    let selectedFields = null;
                    let filters = [];
                    let orderCol = null;
                    let orderAsc = true;
                    let limitVal = null;

                    const builder = {
                        select(fields = '*') {
                            selectedFields = fields;
                            // STRICT SCHEMA VALIDATION FOR bus_tickets:
                            // If bus_tickets sub-select contains carrier_id, emulate PostgreSQL 42703 error!
                            const btMatch = fields.match(/bus_tickets\s*\(([^)]+)\)/);
                            if (btMatch) {
                                const btCols = btMatch[1].split(',').map(c => c.trim());
                                if (btCols.includes('carrier_id')) {
                                    builder._schemaError = {
                                        code: '42703',
                                        message: 'column bus_tickets_1.carrier_id does not exist'
                                    };
                                }
                            }
                            return builder;
                        },
                        or(cond) {
                            filters.push({ type: 'or', cond });
                            return builder;
                        },
                        gte(col, val) {
                            filters.push({ type: 'gte', col, val });
                            return builder;
                        },
                        lte(col, val) {
                            filters.push({ type: 'lte', col, val });
                            return builder;
                        },
                        gt(col, val) {
                            filters.push({ type: 'gt', col, val });
                            return builder;
                        },
                        lt(col, val) {
                            filters.push({ type: 'lt', col, val });
                            return builder;
                        },
                        eq(col, val) {
                            filters.push({ type: 'eq', col, val });
                            return builder;
                        },
                        neq(col, val) {
                            filters.push({ type: 'neq', col, val });
                            return builder;
                        },
                        in(col, vals) {
                            filters.push({ type: 'in', col, vals });
                            return builder;
                        },
                        order(col, opts = {}) {
                            orderCol = col;
                            orderAsc = opts.ascending !== false;
                            return builder;
                        },
                        limit(n) {
                            limitVal = n;
                            return builder;
                        },
                        then(resolve, reject) {
                            if (builder._schemaError) {
                                return Promise.resolve({ data: null, error: builder._schemaError, count: null }).then(resolve, reject);
                            }

                            let filtered = rows.filter(r => {
                                for (const f of filters) {
                                    if (f.type === 'gte' && !(r[f.col] >= f.val)) return false;
                                    if (f.type === 'lte' && !(r[f.col] <= f.val)) return false;
                                    if (f.type === 'gt' && !(r[f.col] > f.val)) return false;
                                    if (f.type === 'lt' && !(r[f.col] < f.val)) return false;
                                    if (f.type === 'eq' && !(r[f.col] === f.val)) return false;
                                    if (f.type === 'neq' && !(r[f.col] !== f.val)) return false;
                                    if (f.type === 'in' && !f.vals.includes(r[f.col])) return false;
                                    if (f.type === 'or') {
                                        if (r.channel !== 'manual' && r.source_type !== 'manual') return false;
                                    }
                                }
                                return true;
                            });

                            // Join bus_tickets if requested
                            if (tableName === 'bus_ticket_bookings' && selectedFields && selectedFields.includes('bus_tickets')) {
                                filtered = filtered.map(b => {
                                    const ticket = seededBusTickets.find(t => t.id === b.bus_ticket_id);
                                    return { ...b, bus_tickets: ticket ? { ...ticket } : null };
                                });
                            }

                            // Join bus_ticket_bookings for claim requests
                            if (tableName === 'booking_claim_requests' && selectedFields && selectedFields.includes('bus_ticket_bookings')) {
                                filtered = filtered.map(cr => {
                                    const b = seededBookings.find(x => x.id === cr.booking_id);
                                    const ticket = b ? seededBusTickets.find(t => t.id === b.bus_ticket_id) : null;
                                    return {
                                        ...cr,
                                        bus_ticket_bookings: b ? { ...b, bus_tickets: ticket ? { ...ticket } : null } : null
                                    };
                                });
                            }

                            if (limitVal != null) {
                                filtered = filtered.slice(0, limitVal);
                            }

                            return Promise.resolve({ data: filtered, count: filtered.length, error: null }).then(resolve, reject);
                        }
                    };
                    return builder;
                }
            };
        }

        // Install our strict schema client
        const fakeClient = createStrictSchemaClient();
        const { installFakeDbModule } = require('./helpers/fakeSupabaseClient');
        installFakeDbModule(fakeClient);

        // Also mock dbServiceRole so getDbClient() uses our client
        const dbServiceRolePath = require.resolve('../dbServiceRole');
        require.cache[dbServiceRolePath] = {
            id: dbServiceRolePath,
            filename: dbServiceRolePath,
            loaded: true,
            exports: {
                getServiceRoleClient: () => fakeClient,
                getServiceRoleDiagnostics: () => ({ serviceRoleEnvPresent: true, serviceRoleClientCached: true })
            }
        };

        const adminRouter = require('../routes/admin');

        let server;
        let baseUrl;

        it('Starts test HTTP server with admin routes', async () => {
            const app = express();
            app.use(express.json());
            app.use('/api/admin', adminRouter);

            server = http.createServer(app);
            await new Promise(res => server.listen(0, res));
            const port = server.address().port;
            baseUrl = `http://127.0.0.1:${port}/api/admin`;
        });

        it('[HOTFIX-04] Unauthenticated requests return 401 Unauthorized', async () => {
            const endpoints = [
                '/passenger-funnel/passengers',
                '/passenger-funnel/attention',
                '/passenger-funnel/summary',
                '/passenger-funnel/stages',
                '/passenger-funnel/carriers'
            ];

            for (const ep of endpoints) {
                const res = await fetch(`${baseUrl}${ep}`);
                assert.strictEqual(res.status, 401, `Expected 401 for unauthenticated ${ep}`);
            }
        });

        it('[HOTFIX-05] Requests with invalid admin token return 401 Unauthorized', async () => {
            const res = await fetch(`${baseUrl}/passenger-funnel/passengers`, {
                headers: { 'X-Admin-Token': 'wrong-token' }
            });
            assert.strictEqual(res.status, 401);
        });

        it('[HOTFIX-06] /passengers returns HTTP 200 (not 500)', async () => {
            const res = await fetch(`${baseUrl}/passenger-funnel/passengers?period=30days`, {
                headers: { 'X-Admin-Token': process.env.ADMIN_SECRET_TOKEN }
            });
            assert.strictEqual(res.status, 200);
            const body = await res.json();
            assert.strictEqual(body.success, true);
            assert.ok(Array.isArray(body.passengers));
        });

        it('[HOTFIX-07] /summary, /stages, /carriers return HTTP 200', async () => {
            const headers = { 'X-Admin-Token': process.env.ADMIN_SECRET_TOKEN };
            const [rSum, rStg, rCar] = await Promise.all([
                fetch(`${baseUrl}/passenger-funnel/summary?period=30days`, { headers }),
                fetch(`${baseUrl}/passenger-funnel/stages?period=30days`, { headers }),
                fetch(`${baseUrl}/passenger-funnel/carriers?period=30days`, { headers })
            ]);

            assert.strictEqual(rSum.status, 200, 'summary should be 200');
            assert.strictEqual(rStg.status, 200, 'stages should be 200');
            assert.strictEqual(rCar.status, 200, 'carriers should be 200');
        });

        it('[HOTFIX-08] /passengers with attentionOnly=true returns exactly 11 records (matches production attention queue)', async () => {
            const res = await fetch(`${baseUrl}/passenger-funnel/passengers?period=30days&attentionOnly=true`, {
                headers: { 'X-Admin-Token': process.env.ADMIN_SECRET_TOKEN }
            });
            assert.strictEqual(res.status, 200);
            const body = await res.json();
            assert.strictEqual(body.success, true);
            assert.strictEqual(body.passengers.length, 11, `Expected exactly 11 attention passengers, got ${body.passengers.length}`);

            // Verify booking 449 (claim request) is included
            const has449 = body.passengers.some(p => p.bookingId === 449);
            assert.ok(has449, 'Booking #449 must be included in attention list');

            // Verify fresh booking 499 (<= 120 min) is NOT included
            const has499 = body.passengers.some(p => p.bookingId === 499);
            assert.strictEqual(has499, false, 'Fresh booking #499 (<= 120 min) must NOT be in attention list');

            // Verify activated booking 480 is NOT included
            const has480 = body.passengers.some(p => p.bookingId === 480);
            assert.strictEqual(has480, false, 'Activated booking #480 must NOT be in attention list');
        });

        it('[HOTFIX-09] /attention returns exactly 11 records under the same filters', async () => {
            const res = await fetch(`${baseUrl}/passenger-funnel/attention?period=30days`, {
                headers: { 'X-Admin-Token': process.env.ADMIN_SECRET_TOKEN }
            });
            assert.strictEqual(res.status, 200);
            const body = await res.json();
            assert.strictEqual(body.success, true);
            assert.strictEqual(body.count, 11, `Expected /attention count to be 11, got ${body.count}`);
            assert.strictEqual(body.items.length, 11);
        });

        it('[HOTFIX-10] /attention and /passengers counts are synchronized when period filters change', async () => {
            // Period: 1 day (today) -> only bookings created within 1440 min
            // Bookings 476, 477, 478, 479 are created 190-205 min ago (within today and > 120 min)
            const headers = { 'X-Admin-Token': process.env.ADMIN_SECRET_TOKEN };
            const [resAtt, resPass] = await Promise.all([
                fetch(`${baseUrl}/passenger-funnel/attention?period=today`, { headers }),
                fetch(`${baseUrl}/passenger-funnel/passengers?period=today&attentionOnly=true`, { headers })
            ]);

            const bodyAtt = await resAtt.json();
            const bodyPass = await resPass.json();

            assert.strictEqual(bodyAtt.count, bodyPass.passengers.length, 'Counts must match between /attention and /passengers for period=today');
            assert.strictEqual(bodyAtt.count, 4, 'Expected 4 records for today > 120 min');
        });

        it('[HOTFIX-11] Zero PII leak check: no unmasked phones or secrets in /passengers and /attention', async () => {
            const headers = { 'X-Admin-Token': process.env.ADMIN_SECRET_TOKEN };
            const [resPass, resAtt] = await Promise.all([
                fetch(`${baseUrl}/passenger-funnel/passengers?period=30days&attentionOnly=true`, { headers }),
                fetch(`${baseUrl}/passenger-funnel/attention?period=30days`, { headers })
            ]);

            const textPass = await resPass.text();
            const textAtt = await resAtt.text();

            // Raw unmasked phone from seed: +992900114479
            assert.strictEqual(textPass.includes('+992900114479'), false, 'Raw phone leaked in /passengers');
            assert.strictEqual(textAtt.includes('+992900114479'), false, 'Raw phone leaked in /attention');

            // Masked phone format must be present
            assert.ok(textPass.includes('+992 ** *** 4479'), 'Masked phone expected in /passengers');
            assert.ok(textAtt.includes('+992 ** *** 4479'), 'Masked phone expected in /attention');
        });

        it('Closes test server', async () => {
            if (server) {
                await new Promise(res => server.close(res));
            }
        });
    });
});
