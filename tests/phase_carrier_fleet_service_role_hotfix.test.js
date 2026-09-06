/**
 * tests/phase_carrier_fleet_service_role_hotfix.test.js
 *
 * Backend Hotfix Verification Test Suite:
 * Ensures all carrier_buses operations use the server service-role client,
 * enforce strict tenant isolation, fail closed on missing service-role client,
 * and maintain full backward compatibility with carrierAuth and trip editing.
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const express = require('express');
const http = require('http');

const TEST_JWT_SECRET = 'test-carrier-secret-for-hotfix-verification-32bytes';
process.env.JWT_SECRET = TEST_JWT_SECRET;
process.env.SUPABASE_URL = 'https://synthetic-test-proj.supabase.co';

let anonCarrierBusesCalls = 0;

// Install fake DB for carrierAuth user lookups BEFORE requiring routes/busAdmin
const { createFakeSupabaseClient, installFakeDbModule } = require('./helpers/fakeSupabaseClient');
const fakeAnonDb = createFakeSupabaseClient({
    users: [
        { id: 11, name: 'Владелец Перевозчика 11', phone: '+992900000011', role: 'bus_driver', is_blocked: false, service_fee_percent: 10 }
    ],
    carrier_members: []
});

// Spy on anon DB to verify carrier_buses is NEVER queried through anon
const origFrom = fakeAnonDb.from.bind(fakeAnonDb);
fakeAnonDb.from = function(tableName) {
    if (tableName === 'carrier_buses') {
        anonCarrierBusesCalls++;
        throw new Error('VIOLATION: anon client was called for carrier_buses table!');
    }
    return origFrom(tableName);
};
installFakeDbModule(fakeAnonDb);

const { setServiceRoleClient } = require('../dbServiceRole');
const { verifyBusAccess, checkDuplicatePlate } = require('../utils/busHelper');
const busAdminRouter = require('../routes/busAdmin');

function createCarrierToken(carrierId = 11, role = 'owner', userId = 11) {
    return jwt.sign(
        {
            sub: String(userId),
            carrierId,
            role,
            type: 'carrier_session'
        },
        TEST_JWT_SECRET,
        {
            algorithm: 'HS256',
            issuer: 'poputki.online',
            audience: 'poputki-carrier',
            expiresIn: '1h'
        }
    );
}

/**
 * In-memory synthetic store for carrier_buses and audit logs.
 */
function createMockDb(initialBuses = []) {
    let buses = JSON.parse(JSON.stringify(initialBuses));
    let auditLogs = [];

    const createQueryBuilder = (table) => {
        let currentTable = table;
        let filters = [];
        let updateData = null;
        let insertData = null;

        const builder = {
            select() {
                return builder;
            },
            insert(data) {
                insertData = Array.isArray(data) ? data : [data];
                return builder;
            },
            update(data) {
                updateData = data;
                return builder;
            },
            eq(field, value) {
                filters.push({ type: 'eq', field, value });
                return builder;
            },
            neq(field, value) {
                filters.push({ type: 'neq', field, value });
                return builder;
            },
            gte(field, value) {
                filters.push({ type: 'gte', field, value });
                return builder;
            },
            lte(field, value) {
                filters.push({ type: 'lte', field, value });
                return builder;
            },
            in(field, values) {
                filters.push({ type: 'in', field, values });
                return builder;
            },
            limit() {
                return builder;
            },
            order() {
                return builder;
            },
            async single() {
                const res = builder.execute();
                if (Array.isArray(res.data)) {
                    return { data: res.data[0] || null, error: res.data[0] ? null : { message: 'Row not found' } };
                }
                return res;
            },
            async maybeSingle() {
                const res = builder.execute();
                if (Array.isArray(res.data)) {
                    return { data: res.data[0] || null, error: null };
                }
                return res;
            },
            execute() {
                if (currentTable === 'carrier_buses') {
                    if (insertData) {
                        const created = insertData.map((item, idx) => ({
                            id: item.id || (1000 + buses.length + idx + 1),
                            created_at: new Date().toISOString(),
                            updated_at: new Date().toISOString(),
                            ...item
                        }));
                        buses.push(...created);
                        return { data: created[0], error: null };
                    }

                    if (updateData) {
                        let matched = buses.filter(b => {
                            return filters.every(f => {
                                if (f.type === 'eq') return String(b[f.field]) === String(f.value);
                                if (f.type === 'neq') return String(b[f.field]) !== String(f.value);
                                return true;
                            });
                        });
                        matched.forEach(b => Object.assign(b, updateData));
                        return { data: matched[0] || null, error: null };
                    }

                    // SELECT
                    let result = buses.filter(b => {
                        return filters.every(f => {
                            if (f.type === 'eq') return String(b[f.field]) === String(f.value);
                            if (f.type === 'neq') return String(b[f.field]) !== String(f.value);
                            return true;
                        });
                    });

                    return { data: result, error: null };
                }

                if (currentTable === 'carrier_audit_logs') {
                    if (insertData) {
                        auditLogs.push(...insertData);
                    }
                    return { data: insertData, error: null };
                }

                if (currentTable === 'bus_tickets') {
                    return { data: [], error: null };
                }

                if (currentTable === 'carrier_members') {
                    return { data: null, error: null };
                }

                return { data: [], error: null };
            },
            then(resolve, reject) {
                return Promise.resolve(builder.execute()).then(resolve, reject);
            }
        };

        return builder;
    };

    return {
        from: (table) => createQueryBuilder(table),
        getBuses: () => buses,
        getAuditLogs: () => auditLogs
    };
}

describe('Carrier Fleet Hotfix: Service-Role & Tenant Isolation Test Suite', () => {
    let mockDb;
    let app;
    let server;
    let baseUrl;

    const initialFleet = [
        {
            id: 101,
            carrier_id: 11,
            name: 'Mercedes Sprinter #1',
            brand: 'Mercedes-Benz',
            model: 'Sprinter',
            license_plate: '01 111 TJ 01',
            total_seats: 18,
            bus_type: 'single_deck',
            floor1_seats: null,
            floor2_seats: null,
            status: 'active',
            amenities: ['wifi', 'ac'],
            photos: []
        },
        {
            id: 102,
            carrier_id: 11,
            name: 'Setra S515 #2',
            brand: 'Setra',
            model: 'S515 HD',
            license_plate: '01 222 TJ 01',
            total_seats: 50,
            bus_type: 'single_deck',
            floor1_seats: null,
            floor2_seats: null,
            status: 'active',
            amenities: ['ac', 'usb', 'toilet'],
            photos: []
        },
        {
            id: 201,
            carrier_id: 99, // Foreign Carrier
            name: 'Foreign Neoplan',
            brand: 'Neoplan',
            model: 'Cityliner',
            license_plate: '02 999 TJ 02',
            total_seats: 55,
            bus_type: 'single_deck',
            floor1_seats: null,
            floor2_seats: null,
            status: 'active',
            amenities: ['wifi'],
            photos: []
        }
    ];

    beforeEach(async () => {
        anonCarrierBusesCalls = 0;
        mockDb = createMockDb(initialFleet);
        setServiceRoleClient(mockDb);

        app = express();
        app.use(express.json());
        app.use('/api/bus-admin', busAdminRouter);

        await new Promise((resolve) => {
            server = http.createServer(app);
            server.listen(0, '127.0.0.1', () => {
                const addr = server.address();
                baseUrl = `http://127.0.0.1:${addr.port}`;
                resolve();
            });
        });
    });

    afterEach(async () => {
        setServiceRoleClient(null);
        if (server) {
            await new Promise((resolve) => server.close(resolve));
        }
    });

    // -------------------------------------------------------------
    // SCENARIO 1: GET /api/bus-admin/buses
    // -------------------------------------------------------------
    it('1. GET /api/bus-admin/buses: valid carrier gets only their own buses with 200 OK and foreign buses excluded', async () => {
        const token = createCarrierToken(11, 'owner');
        const res = await fetch(`${baseUrl}/api/bus-admin/buses`, {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });

        assert.strictEqual(res.status, 200);
        const buses = await res.json();
        assert.ok(Array.isArray(buses), 'Response should be an array');
        assert.strictEqual(buses.length, 2, 'Carrier 11 should have exactly 2 buses');

        // Verify all buses belong to Carrier 11
        buses.forEach(b => {
            assert.strictEqual(b.carrier_id, 11);
        });

        // Ensure foreign bus (id: 201, carrier_id: 99) is strictly absent
        assert.strictEqual(buses.some(b => b.id === 201), false, 'Foreign bus must not be present');
        assert.strictEqual(anonCarrierBusesCalls, 0, 'Anon client was NEVER called for carrier_buses');
    });

    // -------------------------------------------------------------
    // SCENARIO 2: GET /api/bus-admin/buses/:id
    // -------------------------------------------------------------
    it('2. GET /buses/:id: own bus is accessible with 200; foreign bus returns 404 without leaking existence', async () => {
        const token = createCarrierToken(11, 'owner');

        // Own bus
        const resOwn = await fetch(`${baseUrl}/api/bus-admin/buses/101`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        assert.strictEqual(resOwn.status, 200);
        const ownBus = await resOwn.json();
        assert.strictEqual(ownBus.id, 101);
        assert.strictEqual(ownBus.carrier_id, 11);

        // Foreign bus (id: 201)
        const resForeign = await fetch(`${baseUrl}/api/bus-admin/buses/201`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        assert.strictEqual(resForeign.status, 404, 'Foreign bus must return 404');
        const foreignBody = await resForeign.json();
        assert.strictEqual(foreignBody.error, 'Автобус не найден или доступ запрещен');
        assert.strictEqual(foreignBody.id, undefined, 'No details leaked');
        assert.strictEqual(anonCarrierBusesCalls, 0, 'Anon client was NEVER called for carrier_buses');
    });

    // -------------------------------------------------------------
    // SCENARIO 3: POST /api/bus-admin/buses
    // -------------------------------------------------------------
    it('3. POST /buses: carrier_id in request body is ignored and cannot spoof ownership; saves authenticated carrier_id', async () => {
        const token = createCarrierToken(11, 'owner');
        const newBusPayload = {
            carrier_id: 999, // Attempt to spoof tenant
            name: 'New Yutong',
            brand: 'Yutong',
            model: 'ZK6122',
            license_plate: '01 333 TJ 01',
            total_seats: 53,
            bus_type: 'single',
            amenities: ['wifi', 'ac']
        };

        const res = await fetch(`${baseUrl}/api/bus-admin/buses`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(newBusPayload)
        });

        assert.strictEqual(res.status, 201);
        const body = await res.json();
        assert.strictEqual(body.success, true);
        assert.strictEqual(body.bus.carrier_id, 11, 'Saved carrier_id must strictly be authenticated carrier 11');
        assert.notStrictEqual(body.bus.carrier_id, 999, 'Spoofed carrier_id must be completely ignored');

        // Verify in DB
        const saved = mockDb.getBuses().find(b => b.id === body.bus.id);
        assert.ok(saved);
        assert.strictEqual(saved.carrier_id, 11);
        assert.strictEqual(anonCarrierBusesCalls, 0, 'Anon client was NEVER called for carrier_buses');
    });

    // -------------------------------------------------------------
    // SCENARIO 4: PUT & PATCH /api/bus-admin/buses/:id
    // -------------------------------------------------------------
    it('4. PUT/PATCH /buses/:id: modifies own bus, rejects foreign bus, and prevents carrier_id mutation via body', async () => {
        const token = createCarrierToken(11, 'owner');

        // Modify own bus
        const updatePayload = {
            carrier_id: 888, // Attacker tries to transfer ownership
            name: 'Renamed Sprinter #1',
            amenities: ['wifi', 'ac', 'tv']
        };

        const resPatch = await fetch(`${baseUrl}/api/bus-admin/buses/101`, {
            method: 'PATCH',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(updatePayload)
        });

        assert.strictEqual(resPatch.status, 200);
        const patchBody = await resPatch.json();
        assert.strictEqual(patchBody.bus.name, 'Renamed Sprinter #1');
        assert.strictEqual(patchBody.bus.carrier_id, 11, 'carrier_id cannot be changed via body');

        // PUT on own bus
        const resPut = await fetch(`${baseUrl}/api/bus-admin/buses/101`, {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ name: 'Renamed Via PUT' })
        });
        assert.strictEqual(resPut.status, 200);

        // Attempt to update foreign bus (id: 201)
        const resForeign = await fetch(`${baseUrl}/api/bus-admin/buses/201`, {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ name: 'Hacked Bus' })
        });
        assert.strictEqual(resForeign.status, 404, 'Updating foreign bus returns 404');

        // Verify foreign bus in DB was not modified
        const foreignBus = mockDb.getBuses().find(b => b.id === 201);
        assert.strictEqual(foreignBus.name, 'Foreign Neoplan', 'Foreign bus data remains intact');
        assert.strictEqual(anonCarrierBusesCalls, 0, 'Anon client was NEVER called for carrier_buses');
    });

    // -------------------------------------------------------------
    // SCENARIO 5: POST /api/bus-admin/buses/:id/archive
    // -------------------------------------------------------------
    it('5. DELETE/Archive: own bus is archived; foreign bus returns 404 without state mutation', async () => {
        const token = createCarrierToken(11, 'owner');

        // Attempt to archive foreign bus
        const resForeign = await fetch(`${baseUrl}/api/bus-admin/buses/201/archive`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        assert.strictEqual(resForeign.status, 404, 'Archiving foreign bus returns 404');
        const foreignBus = mockDb.getBuses().find(b => b.id === 201);
        assert.strictEqual(foreignBus.status, 'active', 'Foreign bus was not archived');

        // Archive own bus
        const resOwn = await fetch(`${baseUrl}/api/bus-admin/buses/102/archive`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        assert.strictEqual(resOwn.status, 200);
        const ownBody = await resOwn.json();
        assert.strictEqual(ownBody.success, true);
        assert.strictEqual(ownBody.bus.status, 'archived');

        const ownBus = mockDb.getBuses().find(b => b.id === 102);
        assert.strictEqual(ownBus.status, 'archived');
        assert.strictEqual(anonCarrierBusesCalls, 0, 'Anon client was NEVER called for carrier_buses');
    });

    // -------------------------------------------------------------
    // SCENARIO 6: Missing Service-Role Client (Fail-Closed 503)
    // -------------------------------------------------------------
    it('6. Service-role client missing: fail-closed with HTTP 503, no anon fallback, no secret leakage', async () => {
        // Unset service role client
        setServiceRoleClient(null);

        const token = createCarrierToken(11, 'owner');

        // Test GET /buses
        const resGet = await fetch(`${baseUrl}/api/bus-admin/buses`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        assert.strictEqual(resGet.status, 503, 'Must return HTTP 503');
        const getBody = await resGet.json();
        assert.strictEqual(getBody.error, 'Сервис временно недоступен. Повторите попытку позже.');

        // Test POST /buses
        const resPost = await fetch(`${baseUrl}/api/bus-admin/buses`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ name: 'FailClosed' })
        });
        assert.strictEqual(resPost.status, 503);

        // Test PUT /buses/:id
        const resPut = await fetch(`${baseUrl}/api/bus-admin/buses/101`, {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ name: 'FailClosed' })
        });
        assert.strictEqual(resPut.status, 503);

        // Test POST /buses/:id/archive
        const resArchive = await fetch(`${baseUrl}/api/bus-admin/buses/101/archive`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        assert.strictEqual(resArchive.status, 503);
        assert.strictEqual(anonCarrierBusesCalls, 0, 'Anon client was NEVER called for carrier_buses');
    });

    // -------------------------------------------------------------
    // SCENARIO 7: Regression - Trip editing and carrierAuth compatibility
    // -------------------------------------------------------------
    it('7. Regression: verifyBusAccess and checkDuplicatePlate correctly resolve with service client and protect isolation', async () => {
        // verifyBusAccess on own bus
        const ownBus = await verifyBusAccess({ carrier_id: 11, role: 'owner' }, 101, { client: mockDb });
        assert.ok(ownBus, 'ownBus should be resolved');
        assert.strictEqual(ownBus.id, 101);
        assert.strictEqual(ownBus.carrier_id, 11);

        // verifyBusAccess on foreign bus returns null
        const foreignBus = await verifyBusAccess({ carrier_id: 11, role: 'owner' }, 201, { client: mockDb });
        assert.strictEqual(foreignBus, null, 'verifyBusAccess must return null for foreign bus');

        // checkDuplicatePlate detects duplicate for same carrier
        const isDup = await checkDuplicatePlate(mockDb, 11, '01 111 TJ 01');
        assert.strictEqual(isDup, true);

        // checkDuplicatePlate allows same plate for different carrier
        const isDupOther = await checkDuplicatePlate(mockDb, 99, '01 111 TJ 01');
        assert.strictEqual(isDupOther, false);
        assert.strictEqual(anonCarrierBusesCalls, 0, 'Anon client was NEVER called for carrier_buses');
    });
});
