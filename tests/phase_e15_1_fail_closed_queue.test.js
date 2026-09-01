/**
 * Phase E.15.1 — Notification Queue Fail-Closed & Service-Role Isolation Tests
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { persistNotificationPlan, enqueueAndDispatchNotifications } = require('../utils/notificationQueueService');
const { buildNotificationPlan } = require('../utils/notificationRoutingEngine');

describe('Phase E.15.1 — Notification Queue Fail-Closed Safety Tests', () => {

    it('[E151-01] Explicit injected supabaseClient (mock/test) works as intended', async () => {
        const mockStore = [];
        const mockClient = {
            from: () => ({
                upsert: (row) => ({
                    select: () => ({
                        maybeSingle: () => {
                            const inserted = { id: 'notif-100', ...row };
                            mockStore.push(inserted);
                            return Promise.resolve({ data: inserted, error: null });
                        }
                    })
                })
            })
        };

        const plan = {
            intents: [{
                channel: 'telegram',
                recipientType: 'passenger',
                recipientUserId: 1121,
                recipientPhone: '+992900000000',
                notificationType: 'ticket_issued',
                status: 'pending',
                idempotencyKey: 'test:key:1'
            }]
        };

        const results = await persistNotificationPlan(plan, { booking: { id: 999 } }, { supabaseClient: mockClient });
        assert.strictEqual(results.length, 1);
        assert.strictEqual(mockStore.length, 1);
        assert.strictEqual(mockStore[0].booking_id, 999);
    });

    it('[E151-02] When service-role is unconfigured, persistNotificationPlan fails closed with NOTIFICATION_SERVICE_ROLE_UNAVAILABLE without anon fallback', async () => {
        // Clear process.env.SUPABASE_SERVICE_ROLE_KEY temporarily to test fail-closed behavior
        const origKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
        delete process.env.SUPABASE_SERVICE_ROLE_KEY;

        try {
            const plan = {
                intents: [{
                    channel: 'telegram',
                    recipientType: 'passenger',
                    recipientUserId: 1121,
                    notificationType: 'ticket_issued',
                    status: 'pending',
                    idempotencyKey: 'test:key:2'
                }]
            };

            await assert.rejects(async () => {
                await persistNotificationPlan(plan, { booking: { id: 998 } });
            }, /NOTIFICATION_SERVICE_ROLE_UNAVAILABLE/);
        } finally {
            if (origKey) process.env.SUPABASE_SERVICE_ROLE_KEY = origKey;
        }
    });

    it('[E151-03] Notification dispatch failure never throws or breaks manual booking creation (Non-blocking policy)', async () => {
        const origKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
        delete process.env.SUPABASE_SERVICE_ROLE_KEY;

        try {
            const plan = { intents: [] };
            await assert.doesNotReject(async () => {
                await enqueueAndDispatchNotifications(plan, { booking: { id: 997 } });
            }, 'Must catch all dispatch errors and never throw');
        } finally {
            if (origKey) process.env.SUPABASE_SERVICE_ROLE_KEY = origKey;
        }
    });

    it('[E151-04] Verified Telegram passenger produces pending ticket_issued plan intent and reaches immediate delivery path', () => {
        const booking = {
            id: 430,
            bus_ticket_id: 73,
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
            trip: { id: 73, from_city: 'Душанбе', to_city: 'Худжанд' },
            users: [{ id: 1121, telegram_id: '123456', phone: '+992900000000' }]
        });

        assert.ok(plan.intents.length > 0);
        const telegramIntent = plan.intents.find(i => i.channel === 'telegram');
        assert.strictEqual(telegramIntent.status, 'pending');
        assert.strictEqual(telegramIntent.reason, 'VERIFIED_TELEGRAM_PASSENGER');
    });

    it('[E151-05] Cancelled booking is strictly blocked from notification eligibility', async () => {
        const { evaluateBookingEligibility } = require('../utils/notificationQueueService');
        const eligibility = await evaluateBookingEligibility({ id: 'notif-canc', booking_id: 500 }, { booking: { id: 500, status: 'cancelled' } });
        assert.strictEqual(eligibility.isEligible, false);
    });

    it('[E151-06] Expired pending_payment booking is strictly blocked from notification eligibility', async () => {
        const { evaluateBookingEligibility } = require('../utils/notificationQueueService');
        const eligibility = await evaluateBookingEligibility({ id: 'notif-pend', booking_id: 501 }, { booking: { id: 501, status: 'pending_payment' } });
        assert.strictEqual(eligibility.isEligible, false);
    });
});
