/**
 * phase_notification_routing_engine.test.js
 * 
 * Test Suite: MANUAL BOOKING PASSENGER ACTIVATION V1 — PHASE B
 * NOTIFICATION ROUTING ENGINE & INTENT PLANNING
 * POPUTKI.ONLINE
 */

require('dotenv').config();
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
    hashIdentity,
    generateSafeIdempotencyKey,
    buildShareableTicketUrl,
    buildNotificationPlan,
    buildTripNotificationPlans
} = require('../utils/notificationRoutingEngine');

describe('MANUAL BOOKING PASSENGER ACTIVATION V1 — PHASE B TEST SUITE', () => {

    const mockUsers = [
        { id: 11, phone: '+992927925051', name: 'Ali Carrier Dispatcher', telegram_id: 111111 },
        { id: 55, phone: '+992900112233', name: 'Zarif Verified Passenger', telegram_id: 555555 },
        { id: 77, phone: '+79998887766', name: 'Unlinked User', telegram_id: null }
    ];

    const mockTrip = {
        id: 10,
        from_city: 'Худжанд',
        to_city: 'Нижневартовск',
        departure_date: '2026-09-01',
        price: 700
    };

    describe('1. Passenger Intent Routing', () => {
        it('1. passenger + linked Telegram creates pending Telegram candidate with passenger_ticket_issued template', () => {
            const booking = {
                id: 101,
                bus_ticket_id: 10,
                passenger_id: 11,
                passenger_name: 'Zarif Verified Passenger',
                phone: '+992900112233',
                contact_role: 'passenger',
                created_by_user_id: 11
            };

            const plan = buildNotificationPlan(booking, { users: mockUsers, trip: mockTrip });
            const tgIntent = plan.intents.find(i => i.channel === 'telegram');
            assert.ok(tgIntent);
            assert.equal(tgIntent.recipientType, 'passenger');
            assert.equal(tgIntent.recipientUserId, 55);
            assert.equal(tgIntent.telegramChatId, 555555);
            assert.equal(tgIntent.notificationType, 'ticket_issued');
            assert.equal(tgIntent.templateKey, 'passenger_ticket_issued');
            assert.equal(tgIntent.status, 'pending');
            assert.equal(tgIntent.reason, 'VERIFIED_TELEGRAM_PASSENGER');
        });

        it('2. passenger + unlinked Telegram creates skipped Telegram intent (NO_LINKED_TELEGRAM_ACCOUNT)', () => {
            const booking = {
                id: 102,
                bus_ticket_id: 10,
                passenger_name: 'Unlinked Passenger',
                phone: '+79998887766',
                contact_role: 'passenger',
                created_by_user_id: 11
            };

            const plan = buildNotificationPlan(booking, { users: mockUsers, trip: mockTrip });
            const tgIntent = plan.intents.find(i => i.channel === 'telegram');
            assert.ok(tgIntent);
            assert.equal(tgIntent.status, 'skipped');
            assert.equal(tgIntent.reason, 'NO_LINKED_TELEGRAM_ACCOUNT');
        });

        it('3. WhatsApp intent returns skipped status with WHATSAPP_BUSINESS_API_NOT_CONFIGURED', () => {
            const booking = {
                id: 103,
                bus_ticket_id: 10,
                passenger_name: 'Zarif Verified Passenger',
                phone: '+992900112233',
                contact_role: 'passenger',
                created_by_user_id: 11
            };

            const plan = buildNotificationPlan(booking, { users: mockUsers, trip: mockTrip });
            const waIntent = plan.intents.find(i => i.channel === 'whatsapp');
            assert.ok(waIntent);
            assert.equal(waIntent.status, 'skipped');
            assert.equal(waIntent.reason, 'WHATSAPP_BUSINESS_API_NOT_CONFIGURED');
        });
    });

    describe('2. Family / Group Intent Routing', () => {
        it('4. family_or_group with 1 booking creates ticket_issued intent for group contact', () => {
            const booking = {
                id: 104,
                bus_ticket_id: 10,
                passenger_name: 'Family Member 1',
                phone: '+992900112233',
                contact_role: 'family_or_group',
                created_by_user_id: 11
            };

            const plan = buildNotificationPlan(booking, { users: mockUsers, trip: mockTrip, tripBookings: [booking] });
            const tgIntent = plan.intents.find(i => i.channel === 'telegram');
            assert.ok(tgIntent);
            assert.equal(tgIntent.recipientType, 'family_or_group');
            assert.equal(tgIntent.notificationType, 'ticket_issued');
            assert.equal(tgIntent.templateKey, 'family_group_tickets_ready');
            assert.equal(tgIntent.status, 'pending');
        });

        it('5. family_or_group with 2+ bookings on same trip creates family_group_manifest intent', () => {
            const b1 = { id: 105, bus_ticket_id: 10, passenger_name: 'Father', phone: '+992900112233', contact_role: 'family_or_group', created_by_user_id: 11 };
            const b2 = { id: 106, bus_ticket_id: 10, passenger_name: 'Child 1', phone: '+992900112233', contact_role: 'family_or_group', created_by_user_id: 11 };

            const plan = buildNotificationPlan(b1, { users: mockUsers, trip: mockTrip, tripBookings: [b1, b2] });
            const tgIntent = plan.intents.find(i => i.channel === 'telegram');
            assert.ok(tgIntent);
            assert.equal(tgIntent.recipientType, 'family_or_group');
            assert.equal(tgIntent.notificationType, 'family_group_manifest');
            assert.equal(tgIntent.templateKey, 'family_group_tickets_ready');
            assert.equal(tgIntent.isMultiBooking, true);
        });
    });

    describe('3. Coordinator & Creator Intent Routing', () => {
        it('6. coordinator with 1 booking creates ticket_issued intent', () => {
            const booking = {
                id: 107,
                bus_ticket_id: 10,
                passenger_name: 'Client A',
                phone: '+992927925051',
                contact_role: 'coordinator',
                created_by_user_id: 11
            };

            const plan = buildNotificationPlan(booking, { users: mockUsers, trip: mockTrip, tripBookings: [booking] });
            const tgIntent = plan.intents.find(i => i.channel === 'telegram');
            assert.ok(tgIntent);
            assert.equal(tgIntent.recipientType, 'coordinator');
            assert.equal(tgIntent.notificationType, 'ticket_issued');
            assert.equal(tgIntent.templateKey, 'coordinator_tickets_ready');
        });

        it('7. coordinator with multiple bookings creates coordinator_manifest intent', () => {
            const b1 = { id: 108, bus_ticket_id: 10, passenger_name: 'Client A', phone: '+992927925051', contact_role: 'coordinator', created_by_user_id: 11 };
            const b2 = { id: 109, bus_ticket_id: 10, passenger_name: 'Client B', phone: '+992927925051', contact_role: 'coordinator', created_by_user_id: 11 };

            const plan = buildNotificationPlan(b1, { users: mockUsers, trip: mockTrip, tripBookings: [b1, b2] });
            const tgIntent = plan.intents.find(i => i.channel === 'telegram');
            assert.ok(tgIntent);
            assert.equal(tgIntent.recipientType, 'coordinator');
            assert.equal(tgIntent.notificationType, 'coordinator_manifest');
            assert.equal(tgIntent.templateKey, 'coordinator_tickets_ready');
        });

        it('8. missing phone generates creator_handoff fallback intent for authenticated creator', () => {
            const booking = {
                id: 110,
                bus_ticket_id: 10,
                passenger_name: 'Offline Passenger',
                phone: '—',
                contact_role: 'unknown',
                created_by_user_id: 11
            };

            const plan = buildNotificationPlan(booking, { users: mockUsers, trip: mockTrip });
            const creatorIntent = plan.intents.find(i => i.recipientType === 'creator');
            assert.ok(creatorIntent);
            assert.equal(creatorIntent.notificationType, 'creator_handoff');
            assert.equal(creatorIntent.templateKey, 'creator_tickets_ready_for_handoff');
            assert.equal(creatorIntent.recipientUserId, 11);
            assert.equal(creatorIntent.status, 'pending');
        });

        it('9. unknown contact role falls back to creator_handoff and does NOT message unvetted phone', () => {
            const booking = {
                id: 111,
                bus_ticket_id: 10,
                passenger_name: 'Unknown Person',
                phone: '+992911223344',
                contact_role: 'unknown',
                created_by_user_id: 11
            };

            const plan = buildNotificationPlan(booking, { users: mockUsers, trip: mockTrip });
            assert.equal(plan.intents.some(i => i.recipientType === 'passenger'), false);
            assert.equal(plan.intents.some(i => i.recipientType === 'family_or_group'), false);
            const creatorIntent = plan.intents.find(i => i.recipientType === 'creator');
            assert.ok(creatorIntent);
        });
    });

    describe('4. Idempotency & Privacy Protection', () => {
        it('10. generateSafeIdempotencyKey creates deterministic keys', () => {
            const k1 = generateSafeIdempotencyKey({
                scopeId: 101,
                scopeType: 'booking',
                recipientType: 'passenger',
                recipientIdentity: 55,
                channel: 'telegram',
                notificationType: 'ticket_issued'
            });
            const k2 = generateSafeIdempotencyKey({
                scopeId: 101,
                scopeType: 'booking',
                recipientType: 'passenger',
                recipientIdentity: 55,
                channel: 'telegram',
                notificationType: 'ticket_issued'
            });
            assert.equal(k1, k2);
        });

        it('11. raw phone number is NEVER present in plain text inside idempotency key', () => {
            const rawPhone = '+992927925051';
            const key = generateSafeIdempotencyKey({
                scopeId: 101,
                scopeType: 'booking',
                recipientType: 'family_or_group',
                recipientIdentity: rawPhone,
                channel: 'telegram',
                notificationType: 'ticket_issued'
            });
            assert.equal(key.includes('+992'), false);
            assert.equal(key.includes('927925051'), false);
            assert.ok(key.includes(hashIdentity(rawPhone)));
        });

        it('12. buildShareableTicketUrl produces public ticket URL with 32-hex HMAC token without PII', () => {
            const url = buildShareableTicketUrl({ id: 139, bus_ticket_id: 10 }, mockTrip);
            assert.ok(url.startsWith('https://www.poputki.online/ticket-verify/139-'));
            assert.equal(url.includes('passport'), false);
            assert.equal(url.includes('token='), false);
        });

        it('13. legacy invalid phone formats (em-dash, text) do not crash routing engine', () => {
            assert.doesNotThrow(() => {
                buildNotificationPlan({ id: 112, phone: '—', contact_role: 'unknown', created_by_user_id: 11 });
                buildNotificationPlan({ id: 113, phone: 'Бах', contact_role: 'unknown', created_by_user_id: 11 });
                buildNotificationPlan({ id: 114, phone: null, contact_role: 'unknown', created_by_user_id: 11 });
            });
        });
    });

    describe('5. Trip-Level Aggregation (buildTripNotificationPlans)', () => {
        it('14. aggregates trip plans for multiple bookings cleanly', () => {
            const tripBookings = [
                { id: 1, bus_ticket_id: 10, passenger_name: 'Passenger A', phone: '+992900112233', contact_role: 'passenger', created_by_user_id: 11 },
                { id: 2, bus_ticket_id: 10, passenger_name: 'Passenger B', phone: '—', contact_role: 'unknown', created_by_user_id: 11 }
            ];

            const plans = buildTripNotificationPlans(10, tripBookings, { users: mockUsers, trip: mockTrip });
            assert.equal(plans.length, 2);
            assert.equal(plans[0].intents.length > 0, true);
            assert.equal(plans[1].intents.some(i => i.recipientType === 'creator'), true);
        });
    });
});
