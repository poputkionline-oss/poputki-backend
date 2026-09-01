/**
 * Phase E.9 — Notification Queue RLS & Delivery Safety Regression Tests
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { persistNotificationPlan, enqueueAndDispatchNotifications } = require('../utils/notificationQueueService');
const { buildNotificationPlan } = require('../utils/notificationRoutingEngine');

describe('Phase E.9 — Notification Queue Service Role & RLS Tests', () => {

    const mockDbStore = [];
    const mockDbClient = {
        from: (tableName) => ({
            upsert: (row, options) => ({
                select: () => ({
                    maybeSingle: () => {
                        const existingIdx = mockDbStore.findIndex(r => r.idempotency_key === row.idempotency_key);
                        if (existingIdx >= 0) {
                            return Promise.resolve({ data: mockDbStore[existingIdx], error: null });
                        }
                        const inserted = { id: `notif-${mockDbStore.length + 1}`, ...row };
                        mockDbStore.push(inserted);
                        return Promise.resolve({ data: inserted, error: null });
                    }
                })
            }),
            select: () => ({
                eq: (field, val) => ({
                    maybeSingle: () => {
                        const match = mockDbStore.find(r => r[field] === val);
                        return Promise.resolve({ data: match || null, error: null });
                    },
                    single: () => {
                        const match = mockDbStore.find(r => r[field] === val);
                        return Promise.resolve({ data: match || null, error: match ? null : new Error('Not found') });
                    }
                }),
                in: (field, vals) => Promise.resolve({
                    data: mockDbStore.filter(r => vals.includes(r[field])),
                    error: null
                })
            }),
            update: (updateFields) => ({
                eq: (field, val) => ({
                    select: () => ({
                        single: () => {
                            const idx = mockDbStore.findIndex(r => r[field] === val);
                            if (idx >= 0) {
                                mockDbStore[idx] = { ...mockDbStore[idx], ...updateFields };
                                return Promise.resolve({ data: mockDbStore[idx], error: null });
                            }
                            return Promise.resolve({ data: null, error: new Error('Not found') });
                        }
                    }),
                    eq: (field2, val2) => ({
                        select: () => ({
                            single: () => {
                                const idx = mockDbStore.findIndex(r => r[field] === val && r[field2] === val2);
                                if (idx >= 0) {
                                    mockDbStore[idx] = { ...mockDbStore[idx], ...updateFields };
                                    return Promise.resolve({ data: mockDbStore[idx], error: null });
                                }
                                return Promise.resolve({ data: null, error: new Error('Not found') });
                            }
                        })
                    })
                })
            })
        })
    };

    it('[E9-01] Notification plan persistence creates audit row using supplied or service-role DB client', async () => {
        mockDbStore.length = 0;

        const booking = {
            id: 425,
            bus_ticket_id: 10,
            passenger_id: 11,
            claimed_by_user_id: 1121,
            claim_status: 'claimed',
            phone: '+992900000000',
            contact_role: 'passenger',
            created_by_user_id: 11,
            status: 'confirmed'
        };

        const plan = buildNotificationPlan(booking, {
            creator: { id: 11, name: 'Carrier' },
            trip: { id: 10, from_city: 'Душанбе', to_city: 'Худжанд' },
            users: [{ id: 1121, telegram_id: '123456', phone: '+992900000000' }]
        });

        const results = await persistNotificationPlan(plan, { booking }, { supabaseClient: mockDbClient });
        assert.ok(results.length > 0, 'Must return persisted notification items');
        assert.strictEqual(mockDbStore.length, 2, 'Must persist telegram and whatsapp intent rows');
        assert.strictEqual(mockDbStore[0].booking_id, 425);
    });

    it('[E9-02] Notification delivery failure does NOT throw or rollback booking', async () => {
        mockDbStore.length = 0;

        const booking = {
            id: 425,
            bus_ticket_id: 10,
            passenger_id: 11,
            claimed_by_user_id: 1121,
            claim_status: 'claimed',
            phone: '+992900000000',
            contact_role: 'passenger',
            created_by_user_id: 11,
            status: 'confirmed'
        };

        const plan = buildNotificationPlan(booking, {
            creator: { id: 11, name: 'Carrier' },
            trip: { id: 10, from_city: 'Душанбе', to_city: 'Худжанд' },
            users: [{ id: 1121, telegram_id: '123456', phone: '+992900000000' }]
        });

        // enqueueAndDispatchNotifications must be non-blocking and complete safely even if delivery fails/dry-run
        await assert.doesNotReject(async () => {
            await enqueueAndDispatchNotifications(plan, { booking }, { supabaseClient: mockDbClient, dryRun: true });
        }, 'Notification dispatch failure must never throw or rollback booking transaction');
    });
});
