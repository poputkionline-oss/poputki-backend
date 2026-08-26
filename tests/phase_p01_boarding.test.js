const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const http = require('node:http');

// Set dummy JWT_SECRET for test environment
process.env.JWT_SECRET = 'test-jwt-secret-poputki-secure-key-12345';
process.env.ADMIN_SECRET_TOKEN = 'test-admin-secret';

// Mock DB storage
const mockDb = {
    users: [
        { id: 101, name: 'Carrier Owner', phone: '+992900000001', role: 'bus_driver', is_blocked: false },
        { id: 102, name: 'Carrier Dispatcher', phone: '+992900000002', role: 'dispatcher', is_blocked: false },
        { id: 103, name: 'Assigned Driver', phone: '+992900000003', role: 'driver', is_blocked: false },
        { id: 104, name: 'Unassigned Driver', phone: '+992900000004', role: 'driver', is_blocked: false },
        { id: 201, name: 'Another Carrier Owner', phone: '+992900000201', role: 'bus_driver', is_blocked: false }
    ],
    carrier_members: [
        { carrier_id: 101, user_id: 102, role: 'dispatcher', assigned_ticket_ids: [], is_active: true },
        { carrier_id: 101, user_id: 103, role: 'driver', assigned_ticket_ids: [501, 502], is_active: true },
        { carrier_id: 101, user_id: 104, role: 'driver', assigned_ticket_ids: [999], is_active: true }
    ],
    bus_tickets: [
        { id: 501, operator_id: 101, from_city: 'Душанбе', to_city: 'Худжанд', departure_date: '2026-08-27' },
        { id: 601, operator_id: 201, from_city: 'Москва', to_city: 'Душанбе', departure_date: '2026-08-27' }
    ],
    bus_ticket_bookings: [
        {
            id: 1001,
            bus_ticket_id: 501,
            passenger_id: 101,
            passenger_name: 'Алиев Али',
            phone: '+992931111111',
            seat_numbers: [1],
            boarding_status: 'pending_boarding',
            boarded_at: null,
            boarded_by_user_id: null,
            status: 'confirmed'
        },
        {
            id: 2001,
            bus_ticket_id: 601,
            passenger_id: 201,
            passenger_name: 'Другой Пассажир',
            phone: '+992932222222',
            seat_numbers: [1],
            boarding_status: 'pending_boarding',
            boarded_at: null,
            boarded_by_user_id: null,
            status: 'confirmed'
        }
    ],
    booking_audit_logs: []
};

// Mock the db module
const mockSupabase = {
    from: (tableName) => {
        return {
            select: (columns, options) => {
                return {
                    eq: (col, val) => ({
                        maybeSingle: async () => {
                            const found = mockDb[tableName]?.find(item => String(item[col]) === String(val));
                            return { data: found ? JSON.parse(JSON.stringify(found)) : null, error: null };
                        },
                        single: async () => {
                            const found = mockDb[tableName]?.find(item => String(item[col]) === String(val));
                            return { data: found ? JSON.parse(JSON.stringify(found)) : null, error: found ? null : new Error('Not found') };
                        },
                        in: (col2, arr) => ({
                            eq: (col3, val3) => ({
                                order: () => ({
                                    data: mockDb[tableName]?.filter(item => arr.some(x => String(x) === String(item[col2])) && String(item[col3]) === String(val3)) || [],
                                    error: null
                                })
                            })
                        })
                    }),
                    in: (col, arr) => ({
                        eq: (col2, val2) => ({
                            order: () => ({
                                data: mockDb[tableName]?.filter(item => arr.some(x => String(x) === String(item[col])) && String(item[col2]) === String(val2)) || [],
                                error: null
                            })
                        })
                    })
                };
            },
            update: (updateFields) => ({
                eq: (col, val) => ({
                    select: () => ({
                        single: async () => {
                            const target = mockDb[tableName]?.find(item => String(item[col]) === String(val));
                            if (!target) return { data: null, error: new Error('Record not found') };
                            Object.assign(target, updateFields);
                            return { data: JSON.parse(JSON.stringify(target)), error: null };
                        }
                    })
                })
            }),
            insert: (rows) => {
                const insertedRows = (rows || []).map(r => {
                    const row = { id: (mockDb[tableName]?.length || 0) + 1, ...r };
                    mockDb[tableName].push(row);
                    return row;
                });
                const promise = Promise.resolve({ data: insertedRows, error: null });
                promise.select = () => ({
                    single: async () => ({ data: insertedRows[0], error: null })
                });
                return promise;
            }
        };
    }
};

// Override require cache for '../db'
const dbPath = require.resolve('../db');
require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: mockSupabase
};

const express = require('express');
const busAdminRouter = require('../routes/busAdmin');

function generateToken(userId, carrierId, role) {
    return jwt.sign(
        {
            sub: String(userId),
            carrierId: carrierId,
            role: role
        },
        process.env.JWT_SECRET,
        {
            algorithm: 'HS256',
            issuer: 'poputki.online',
            audience: 'poputki-carrier',
            expiresIn: '1h'
        }
    );
}

const app = express();
app.use(express.json());
app.use('/api/bus-admin', busAdminRouter);

let server;
let baseUrl;

function makeRequest(method, path, headers = {}, body = null) {
    return new Promise((resolve, reject) => {
        const url = new URL(path, baseUrl);
        const options = {
            method: method,
            hostname: url.hostname,
            port: url.port,
            path: url.pathname + url.search,
            headers: {
                'Content-Type': 'application/json',
                'Connection': 'close',
                ...headers
            }
        };

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                let parsed = null;
                try { parsed = JSON.parse(data); } catch (e) { parsed = data; }
                resolve({ status: res.statusCode, body: parsed });
            });
        });

        req.on('error', reject);
        if (body) {
            req.write(JSON.stringify(body));
        }
        req.end();
    });
}

test('CARRIER CABINET V2 — PHASE P0.1 BOARDING WORKFLOW TEST SUITE', async (t) => {
    await new Promise((resolve) => {
        server = app.listen(0, () => {
            const port = server.address().port;
            baseUrl = `http://127.0.0.1:${port}`;
            resolve();
        });
    });

    const ownerToken = generateToken(101, 101, 'owner');
    const dispatcherToken = generateToken(102, 101, 'dispatcher');
    const assignedDriverToken = generateToken(103, 101, 'driver');
    const unassignedDriverToken = generateToken(104, 101, 'driver');
    const otherCarrierToken = generateToken(201, 201, 'owner');

    const resetBooking = () => {
        mockDb.bus_ticket_bookings[0].boarding_status = 'pending_boarding';
        mockDb.bus_ticket_bookings[0].boarded_at = null;
        mockDb.bus_ticket_bookings[0].boarded_by_user_id = null;
        mockDb.booking_audit_logs = [];
    };

    await t.test('1. Owner can mark passenger as boarded (PASS)', async () => {
        resetBooking();
        const res = await makeRequest('PATCH', '/api/bus-admin/bookings/1001/boarding', {
            'Authorization': `Bearer ${ownerToken}`
        }, { boarding_status: 'boarded' });

        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.success, true);
        assert.strictEqual(res.body.booking.boarding_status, 'boarded');
        assert.ok(res.body.booking.boarded_at);
        assert.strictEqual(res.body.booking.boarded_by_user_id, 101);
    });

    await t.test('2. Dispatcher can mark passenger as boarded (PASS)', async () => {
        resetBooking();
        const res = await makeRequest('PATCH', '/api/bus-admin/bookings/1001/boarding', {
            'Authorization': `Bearer ${dispatcherToken}`
        }, { boarding_status: 'boarded' });

        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.success, true);
        assert.strictEqual(res.body.booking.boarding_status, 'boarded');
        assert.strictEqual(res.body.booking.boarded_by_user_id, 102);
    });

    await t.test('3. Assigned driver (ticket #501) can mark passenger as boarded (PASS)', async () => {
        resetBooking();
        const res = await makeRequest('PATCH', '/api/bus-admin/bookings/1001/boarding', {
            'Authorization': `Bearer ${assignedDriverToken}`
        }, { boarding_status: 'boarded' });

        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.success, true);
        assert.strictEqual(res.body.booking.boarding_status, 'boarded');
        assert.strictEqual(res.body.booking.boarded_by_user_id, 103);
    });

    await t.test('4. Unassigned driver is DENIED access with 403 (DENIED)', async () => {
        resetBooking();
        const res = await makeRequest('PATCH', '/api/bus-admin/bookings/1001/boarding', {
            'Authorization': `Bearer ${unassignedDriverToken}`
        }, { boarding_status: 'boarded' });

        assert.strictEqual(res.status, 403);
        assert.ok(res.body.error.includes('Доступ запрещен'));
    });

    await t.test('5. Another carrier cannot modify another carrier booking (403 DENIED)', async () => {
        resetBooking();
        const res = await makeRequest('PATCH', '/api/bus-admin/bookings/1001/boarding', {
            'Authorization': `Bearer ${otherCarrierToken}`
        }, { boarding_status: 'boarded' });

        assert.strictEqual(res.status, 403);
        assert.ok(res.body.error.includes('Доступ запрещен'));
    });

    await t.test('6. Invalid boarding_status is rejected with 400 Bad Request', async () => {
        resetBooking();
        const res = await makeRequest('PATCH', '/api/bus-admin/bookings/1001/boarding', {
            'Authorization': `Bearer ${ownerToken}`
        }, { boarding_status: 'invalid_status_xyz' });

        assert.strictEqual(res.status, 400);
        assert.ok(res.body.error.includes('Недопустимый статус посадки'));
    });

    await t.test('7. Marking as no_show sets status and clears boarded_at', async () => {
        resetBooking();
        // First set to boarded
        await makeRequest('PATCH', '/api/bus-admin/bookings/1001/boarding', {
            'Authorization': `Bearer ${ownerToken}`
        }, { boarding_status: 'boarded' });

        // Now set to no_show
        const res = await makeRequest('PATCH', '/api/bus-admin/bookings/1001/boarding', {
            'Authorization': `Bearer ${ownerToken}`
        }, { boarding_status: 'no_show' });

        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.booking.boarding_status, 'no_show');
        assert.strictEqual(res.body.booking.boarded_at, null);
        assert.strictEqual(res.body.booking.boarded_by_user_id, 101);
    });

    await t.test('8. Resetting to pending_boarding clears boarded_at', async () => {
        resetBooking();
        // First set to boarded
        await makeRequest('PATCH', '/api/bus-admin/bookings/1001/boarding', {
            'Authorization': `Bearer ${ownerToken}`
        }, { boarding_status: 'boarded' });

        // Now reset to pending_boarding
        const res = await makeRequest('PATCH', '/api/bus-admin/bookings/1001/boarding', {
            'Authorization': `Bearer ${ownerToken}`
        }, { boarding_status: 'pending_boarding' });

        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.booking.boarding_status, 'pending_boarding');
        assert.strictEqual(res.body.booking.boarded_at, null);
    });

    await t.test('9. Audit log entry is created on status update', async () => {
        resetBooking();
        await makeRequest('PATCH', '/api/bus-admin/bookings/1001/boarding', {
            'Authorization': `Bearer ${ownerToken}`
        }, { boarding_status: 'boarded' });

        assert.ok(mockDb.booking_audit_logs.length > 0);
        const lastLog = mockDb.booking_audit_logs[mockDb.booking_audit_logs.length - 1];
        assert.strictEqual(lastLog.booking_id, 1001);
        assert.strictEqual(lastLog.action, 'boarding_status_update');
        assert.strictEqual(lastLog.new_status, 'boarded');
        assert.strictEqual(lastLog.performed_by_user_id, 101);
    });

    await t.test('10. Request without token is rejected with 401 Unauthorized', async () => {
        const res = await makeRequest('PATCH', '/api/bus-admin/bookings/1001/boarding', {}, { boarding_status: 'boarded' });
        assert.strictEqual(res.status, 401);
    });

    await new Promise((resolve) => {
        server.close(resolve);
    });
});
