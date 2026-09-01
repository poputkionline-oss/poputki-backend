/**
 * Phase E.12.1 — Manual Booking Delivery Status & Eligibility Regression Tests
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { buildNotificationPlan } = require('../utils/notificationRoutingEngine');
const { evaluateBookingEligibility } = require('../utils/notificationQueueService');

describe('Phase E.12.1 — Manual Booking Notification Eligibility Tests', () => {

    it('[E12-01] Newly created manual booking with status: confirmed passes evaluateBookingEligibility', async () => {
        const fullBooking = {
            id: 429,
            bus_ticket_id: 73,
            passenger_id: 11,
            claimed_by_user_id: 1121,
            claim_status: 'claimed',
            passenger_name: 'Test Passenger',
            phone: '+992900000000',
            contact_role: 'passenger',
            created_by_user_id: 11,
            status: 'confirmed'
        };

        const plan = buildNotificationPlan(fullBooking, {
            creator: { id: 11, name: 'Carrier' },
            trip: { id: 73, from_city: 'Душанбе', to_city: 'Худжанд' },
            users: [{ id: 1121, telegram_id: '123456', phone: '+992900000000' }]
        });

        assert.strictEqual(plan.intents.length, 2, 'Should generate telegram and whatsapp intents');
        const telegramIntent = plan.intents.find(i => i.channel === 'telegram');
        assert.strictEqual(telegramIntent.status, 'pending');
        assert.strictEqual(telegramIntent.reason, 'VERIFIED_TELEGRAM_PASSENGER');

        const mockDbClient = {
            from: () => ({
                select: () => ({
                    eq: () => Promise.resolve({ data: [fullBooking], error: null })
                })
            })
        };

        const eligibility = await evaluateBookingEligibility({ id: 'notif-1', booking_id: 429 }, { booking: fullBooking }, { supabaseClient: mockDbClient });
        assert.strictEqual(eligibility.isEligible, true);
        assert.strictEqual(eligibility.eligibleBookings.length, 1);
        assert.strictEqual(eligibility.eligibleBookings[0].status, 'confirmed');
    });

    it('[E12-02] Cancelled booking is strictly blocked by evaluateBookingEligibility', async () => {
        const cancelledBooking = {
            id: 430,
            bus_ticket_id: 73,
            status: 'cancelled'
        };

        const eligibility = await evaluateBookingEligibility({ id: 'notif-2', booking_id: 430 }, { booking: cancelledBooking });
        assert.strictEqual(eligibility.isEligible, false);
        assert.strictEqual(eligibility.reason, 'BOOKING_NO_LONGER_ELIGIBLE');
    });

    it('[E12-03] Expired pending_payment booking is strictly blocked by evaluateBookingEligibility', async () => {
        const pendingBooking = {
            id: 431,
            bus_ticket_id: 73,
            status: 'pending_payment'
        };

        const eligibility = await evaluateBookingEligibility({ id: 'notif-3', booking_id: 431 }, { booking: pendingBooking });
        assert.strictEqual(eligibility.isEligible, false);
        assert.strictEqual(eligibility.reason, 'BOOKING_NO_LONGER_ELIGIBLE');
    });

    it('[E12-04] Family or group contact role safety is preserved', () => {
        const familyBooking = {
            id: 432,
            bus_ticket_id: 73,
            phone: '+992900000000',
            contact_role: 'family_or_group',
            status: 'confirmed'
        };

        const plan = buildNotificationPlan(familyBooking, {
            creator: { id: 11, name: 'Carrier' },
            users: [{ id: 1121, telegram_id: '123456', phone: '+992900000000' }]
        });

        assert.ok(plan.intents.length > 0);
        const familyIntent = plan.intents.find(i => i.recipientType === 'family_or_group');
        assert.ok(familyIntent, 'Must create family_or_group intent');
    });

    it('[E12-05] Coordinator contact role safety is preserved', () => {
        const coordBooking = {
            id: 433,
            bus_ticket_id: 73,
            phone: '+992900000000',
            contact_role: 'coordinator',
            status: 'confirmed'
        };

        const plan = buildNotificationPlan(coordBooking, {
            creator: { id: 11, name: 'Carrier' },
            users: [{ id: 1121, telegram_id: '123456', phone: '+992900000000' }]
        });

        assert.ok(plan.intents.length > 0);
        const coordIntent = plan.intents.find(i => i.recipientType === 'coordinator');
        assert.ok(coordIntent, 'Must create coordinator intent');
    });

    it('[E12-06] Unknown contact role produces safe default intents without throwing', () => {
        const unknownBooking = {
            id: 434,
            bus_ticket_id: 73,
            phone: '+992900000000',
            contact_role: 'unknown',
            status: 'confirmed'
        };

        assert.doesNotThrow(() => {
            const plan = buildNotificationPlan(unknownBooking, {
                creator: { id: 11, name: 'Carrier' },
                users: [{ id: 1121, telegram_id: '123456', phone: '+992900000000' }]
            });
            assert.ok(plan);
        });
    });
});
