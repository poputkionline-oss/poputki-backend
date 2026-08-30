/**
 * phase_notification_queue_audit.test.js
 * 
 * POPUTKI.ONLINE — Manual Booking Passenger Activation V1
 * Phase D Test Suite: Production Notification Queue & Audit Engine
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const {
    persistNotificationPlan,
    acquirePendingNotification,
    recoverStaleSendingNotifications,
    markNotificationSent,
    markNotificationFailed,
    enqueueAndDispatchNotifications,
    STALE_SENDING_TIMEOUT_MS
} = require('../utils/notificationQueueService');
const { buildNotificationPlan } = require('../utils/notificationRoutingEngine');

// In-memory mock Supabase client for unit testing
function createMockDb() {
    const notifications = new Map();
    const notificationBookings = new Map();

    return {
        _notifications: notifications,
        _notificationBookings: notificationBookings,
        from(table) {
            if (table === 'booking_notifications') {
                return {
                    upsert(row, { onConflict, ignoreDuplicates } = {}) {
                        return {
                            select() {
                                return {
                                    maybeSingle: async () => {
                                        let existing = null;
                                        for (const val of notifications.values()) {
                                            if (val.idempotency_key === row.idempotency_key) {
                                                existing = val;
                                                break;
                                            }
                                        }
                                        if (existing && ignoreDuplicates) {
                                            return { data: null, error: null };
                                        }
                                        const id = existing ? existing.id : 'notif-' + Math.random().toString(36).substring(2, 9);
                                        const record = { ...existing, ...row, id };
                                        notifications.set(id, record);
                                        return { data: record, error: null };
                                    }
                                };
                            }
                        };
                    },
                    select() {
                        return {
                            eq(col, val) {
                                return {
                                    single: async () => {
                                        const record = notifications.get(val);
                                        return { data: record || null, error: record ? null : { message: 'Not found' } };
                                    },
                                    maybeSingle: async () => {
                                        for (const record of notifications.values()) {
                                            if (record[col] === val) return { data: record, error: null };
                                        }
                                        return { data: null, error: null };
                                    }
                                };
                            }
                        };
                    },
                    update(updates) {
                        return {
                            eq(col1, val1) {
                                return {
                                    eq(col2, val2) {
                                        return {
                                            select() {
                                                return {
                                                    single: async () => {
                                                        const record = notifications.get(val1);
                                                        if (!record || record[col2] !== val2) {
                                                            return { data: null, error: { message: 'Condition failed' } };
                                                        }
                                                        const updated = { ...record, ...updates };
                                                        notifications.set(val1, updated);
                                                        return { data: updated, error: null };
                                                    }
                                                };
                                            }
                                        };
                                    },
                                    lt(col2, val2) {
                                        let count = 0;
                                        for (const [id, rec] of notifications.entries()) {
                                            if (rec[col1] === val1 && rec[col2] < val2) {
                                                notifications.set(id, { ...rec, ...updates });
                                                count++;
                                            }
                                        }
                                        return Promise.resolve({ data: count, error: null });
                                    },
                                    then(resolve) {
                                        const record = notifications.get(val1);
                                        if (record) {
                                            notifications.set(val1, { ...record, ...updates });
                                        }
                                        resolve({ data: record, error: null });
                                    }
                                };
                            }
                        };
                    }
                };
            }
            if (table === 'booking_notification_bookings') {
                return {
                    upsert(rows) {
                        const rowArray = Array.isArray(rows) ? rows : [rows];
                        for (const r of rowArray) {
                            const key = `${r.notification_id}:${r.booking_id}`;
                            notificationBookings.set(key, r);
                        }
                        return Promise.resolve({ data: rowArray, error: null });
                    }
                };
            }
            throw new Error('Unknown mock table: ' + table);
        }
    };
}

describe('MANUAL BOOKING PASSENGER ACTIVATION V1 — PHASE D QUEUE & AUDIT SUITE', () => {
    let mockDb;

    beforeEach(() => {
        mockDb = createMockDb();
    });

    describe('1. Plan Persistence & Group Links', () => {
        it('1. persists single creator intent and links primary booking', async () => {
            const plan = {
                intents: [{
                    channel: 'telegram',
                    recipientType: 'creator',
                    recipientUserId: 11,
                    notificationType: 'creator_handoff',
                    idempotencyKey: 'booking:100:creator:hash:telegram:creator_handoff'
                }]
            };

            const results = await persistNotificationPlan(plan, { booking: { id: 100 } }, { supabaseClient: mockDb });
            assert.equal(results.length, 1);
            assert.equal(results[0].notification.recipient_type, 'creator');
            assert.deepEqual(results[0].linkedBookingIds, [100]);
        });

        it('2. duplicate plan persistence returns existing row without creating duplicate', async () => {
            const plan = {
                intents: [{
                    channel: 'telegram',
                    recipientType: 'creator',
                    recipientUserId: 11,
                    notificationType: 'creator_handoff',
                    idempotencyKey: 'booking:100:creator:hash:telegram:creator_handoff'
                }]
            };

            const first = await persistNotificationPlan(plan, { booking: { id: 100 } }, { supabaseClient: mockDb });
            const second = await persistNotificationPlan(plan, { booking: { id: 100 } }, { supabaseClient: mockDb });

            assert.equal(mockDb._notifications.size, 1);
            assert.equal(first[0].notification.id, second[0].notification.id);
        });

        it('3. 6 family passenger bookings produce 1 notification row and 6 relational links', async () => {
            const sixBookings = [1, 2, 3, 4, 5, 6].map(i => ({ id: 500 + i, passenger_name: `Member ${i}` }));
            const plan = {
                intents: [{
                    channel: 'telegram',
                    recipientType: 'family_or_group',
                    recipientUserId: 22,
                    notificationType: 'family_group_manifest',
                    idempotencyKey: 'trip:10:family_or_group:hash:telegram:family_group_manifest'
                }]
            };

            const results = await persistNotificationPlan(plan, {
                booking: sixBookings[0],
                bookingsList: sixBookings
            }, { supabaseClient: mockDb });

            assert.equal(mockDb._notifications.size, 1);
            assert.equal(mockDb._notificationBookings.size, 6);
            assert.equal(results[0].linkedBookingIds.length, 6);
            assert.deepEqual(results[0].linkedBookingIds, [501, 502, 503, 504, 505, 506]);
        });

        it('4. 5 coordinator bookings produce 1 notification row and 5 relational links', async () => {
            const fiveBookings = [1, 2, 3, 4, 5].map(i => ({ id: 600 + i, passenger_name: `Client ${i}` }));
            const plan = {
                intents: [{
                    channel: 'telegram',
                    recipientType: 'coordinator',
                    recipientUserId: 33,
                    notificationType: 'coordinator_manifest',
                    idempotencyKey: 'trip:10:coordinator:hash:telegram:coordinator_manifest'
                }]
            };

            const results = await persistNotificationPlan(plan, {
                booking: fiveBookings[0],
                bookingsList: fiveBookings
            }, { supabaseClient: mockDb });

            assert.equal(mockDb._notifications.size, 1);
            assert.equal(mockDb._notificationBookings.size, 5);
            assert.deepEqual(results[0].linkedBookingIds, [601, 602, 603, 604, 605]);
        });
    });

    describe('2. Atomic Queue Acquisition & Concurrency', () => {
        it('5. atomically acquires pending notification transitioning to sending', async () => {
            mockDb._notifications.set('notif-1', {
                id: 'notif-1',
                status: 'pending',
                attempt_count: 0
            });

            const acquired = await acquirePendingNotification('notif-1', { supabaseClient: mockDb });
            assert.ok(acquired);
            assert.equal(acquired.status, 'sending');
            assert.equal(acquired.attempt_count, 1);
            assert.ok(acquired.sending_started_at);
        });

        it('6. second concurrent worker fails to acquire already sending notification', async () => {
            mockDb._notifications.set('notif-2', {
                id: 'notif-2',
                status: 'pending',
                attempt_count: 0
            });

            const worker1 = await acquirePendingNotification('notif-2', { supabaseClient: mockDb });
            const worker2 = await acquirePendingNotification('notif-2', { supabaseClient: mockDb });

            assert.ok(worker1);
            assert.equal(worker1.status, 'sending');
            assert.equal(worker2, null); // Blocked
        });

        it('7. stale sending recovery recovers notifications stuck in sending > 5 minutes', async () => {
            const sixMinAgo = new Date(Date.now() - 6 * 60 * 1000).toISOString();
            mockDb._notifications.set('notif-stale', {
                id: 'notif-stale',
                status: 'sending',
                sending_started_at: sixMinAgo
            });

            await recoverStaleSendingNotifications(5, { supabaseClient: mockDb });
            const recovered = mockDb._notifications.get('notif-stale');
            assert.equal(recovered.status, 'pending');
        });
    });

    describe('3. Status Finalization & Error Classification', () => {
        it('8. markNotificationSent sets status sent and providerMessageId', async () => {
            mockDb._notifications.set('notif-3', { id: 'notif-3', status: 'sending' });

            await markNotificationSent('notif-3', 'tg-msg-999', { supabaseClient: mockDb });
            const record = mockDb._notifications.get('notif-3');
            assert.equal(record.status, 'sent');
            assert.equal(record.provider_message_id, 'tg-msg-999');
            assert.ok(record.delivered_at);
        });

        it('9. markNotificationFailed with temporary error schedules retry and sets status pending', async () => {
            mockDb._notifications.set('notif-4', { id: 'notif-4', status: 'sending' });

            await markNotificationFailed('notif-4', {
                isTemporary: true,
                errorCode: 'TELEGRAM_RATE_LIMITED',
                retryAfterSeconds: 15
            }, { supabaseClient: mockDb });

            const record = mockDb._notifications.get('notif-4');
            assert.equal(record.status, 'pending');
            assert.equal(record.error_code, 'TELEGRAM_RATE_LIMITED');
            assert.ok(record.next_attempt_at);
        });

        it('10. markNotificationFailed with permanent error sets status failed without retry', async () => {
            mockDb._notifications.set('notif-5', { id: 'notif-5', status: 'sending' });

            await markNotificationFailed('notif-5', {
                isTemporary: false,
                errorCode: 'TELEGRAM_BOT_BLOCKED_BY_USER'
            }, { supabaseClient: mockDb });

            const record = mockDb._notifications.get('notif-5');
            assert.equal(record.status, 'failed');
            assert.equal(record.error_code, 'TELEGRAM_BOT_BLOCKED_BY_USER');
            assert.equal(record.next_attempt_at, null);
        });
    });

    describe('4. Non-Blocking Delivery & End-to-End Orchestration', () => {
        it('11. enqueueAndDispatchNotifications handles errors non-blockingly without throwing', async () => {
            const failingPlan = {
                intents: [{
                    channel: 'telegram',
                    recipientType: 'creator',
                    recipientUserId: 999999,
                    idempotencyKey: 'fail:key:1'
                }]
            };

            // Should complete cleanly without throwing
            await enqueueAndDispatchNotifications(failingPlan, { booking: { id: 700 } }, { supabaseClient: mockDb });
            assert.ok(true);
        });
    });
});
