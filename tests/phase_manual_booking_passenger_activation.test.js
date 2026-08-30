/**
 * phase_manual_booking_passenger_activation.test.js
 * 
 * Test Suite: MANUAL BOOKING PASSENGER ACTIVATION V1 — PHASE A & A.1
 * POPUTKI.ONLINE
 */

require('dotenv').config();
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { normalizePhone, isValidPhone, cleanPhoneForStorage, maskPhone } = require('../utils/phoneHelper');
const { resolveBookingRecipients, findTelegramUserByVerifiedPhone } = require('../utils/recipientResolver');
const {
    generateNotificationIdempotencyKey,
    TelegramProvider,
    WhatsAppProvider
} = require('../utils/notificationProvider');

describe('MANUAL BOOKING PASSENGER ACTIVATION V1 — PHASE A.1 TEST SUITE', () => {

    describe('1. Phone Normalization & Validation (phoneHelper)', () => {
        it('1. normalizePhone formats international numbers correctly', () => {
            assert.equal(normalizePhone('+992 92 792 50 51'), '+992927925051');
            assert.equal(normalizePhone('89991234567'), '+79991234567');
            assert.equal(normalizePhone('79991234567'), '+79991234567');
            assert.equal(normalizePhone('992927925051'), '+992927925051');
            assert.equal(normalizePhone('+998 (90) 123-45-67'), '+998901234567');
        });

        it('2. normalizePhone returns null for empty and legacy placeholder values', () => {
            assert.equal(normalizePhone(''), null);
            assert.equal(normalizePhone(null), null);
            assert.equal(normalizePhone(undefined), null);
            assert.equal(normalizePhone('-'), null);
            assert.equal(normalizePhone('—'), null);
            assert.equal(normalizePhone('–'), null);
            assert.equal(normalizePhone('null'), null);
            assert.equal(normalizePhone('undefined'), null);
        });

        it('3. normalizePhone returns null for invalid text or corrupted input', () => {
            assert.equal(normalizePhone('Бах'), null);
            assert.equal(normalizePhone('invalid_phone'), null);
            assert.equal(normalizePhone('123'), null); // Too short
            assert.equal(normalizePhone('+1234567890123456789'), null); // Too long
        });

        it('4. isValidPhone validates correctly', () => {
            assert.equal(isValidPhone('+992927925051', true), true);
            assert.equal(isValidPhone('', true), true);
            assert.equal(isValidPhone(null, true), true);
            assert.equal(isValidPhone('—', true), true);
            assert.equal(isValidPhone('Бах', true), false);
            assert.equal(isValidPhone('invalid', true), false);
        });

        it('5. cleanPhoneForStorage returns sanitized phone or null', () => {
            assert.equal(cleanPhoneForStorage('+992 92 792 50 51'), '+992927925051');
            assert.equal(cleanPhoneForStorage('—'), null);
            assert.equal(cleanPhoneForStorage(''), null);
            assert.equal(cleanPhoneForStorage(null), null);
            assert.equal(cleanPhoneForStorage('Бах'), null);
        });

        it('6. maskPhone masks numbers securely for logs', () => {
            assert.equal(maskPhone('+992927925051'), '+992******051');
            assert.equal(maskPhone('+79991234567'), '+799*****567');
            assert.equal(maskPhone(null), 'N/A');
        });
    });

    describe('2. Recipient Resolution & Family/Group Non-Mutation Invariant (Phase A.1)', () => {
        const mockUsers = [
            { id: 11, phone: '+992927925051', name: 'Ali Carrier', telegram_id: 111111 },
            { id: 55, phone: '+992900112233', name: 'Father Family Head', telegram_id: 555555 },
            { id: 77, phone: '+79998887766', name: 'No Tg Coordinator', telegram_id: null }
        ];

        it('7. resolves passenger recipient when contact_role is explicitly passenger', () => {
            const booking = {
                id: 101,
                passenger_name: 'Zarif Passenger',
                phone: '+992900112233',
                contact_role: 'passenger',
                created_by_user_id: 11,
                claim_status: 'unclaimed'
            };

            const result = resolveBookingRecipients(booking, { users: mockUsers });
            assert.equal(result.effectiveRole, 'passenger');
            assert.equal(result.trustClassification, 'KNOWN_TELEGRAM_PASSENGER');
            assert.ok(result.passenger);
            assert.equal(result.passenger.phone, '+992900112233');
            assert.equal(result.passenger.telegramEligible, true);
            assert.equal(result.passenger.telegramChatId, 555555);
            assert.equal(result.familyOrGroup, null);
            assert.equal(result.coordinator, null);
            assert.ok(result.creator);
            assert.equal(result.creator.userId, 11);
        });

        it('8. resolves family_or_group recipient when explicitly chosen', () => {
            const booking = {
                id: 102,
                passenger_name: 'Child 1',
                phone: '+992900112233',
                contact_role: 'family_or_group',
                created_by_user_id: 11,
                claim_status: 'unclaimed'
            };

            const result = resolveBookingRecipients(booking, { users: mockUsers });
            assert.equal(result.effectiveRole, 'family_or_group');
            assert.equal(result.trustClassification, 'KNOWN_TELEGRAM_FAMILY_CONTACT');
            assert.equal(result.passenger, null);
            assert.ok(result.familyOrGroup);
            assert.equal(result.familyOrGroup.phone, '+992900112233');
            assert.equal(result.familyOrGroup.telegramEligible, true);
            assert.equal(result.familyOrGroup.telegramChatId, 555555);
            // CRITICAL: Telegram user is contact owner, NOT the traveler identity
            assert.equal(result.familyOrGroup.contactName, 'Child 1');
            assert.equal(result.coordinator, null);
        });

        it('9. same phone with 2, 3, or 6+ passengers NEVER mutates contact_role to coordinator automatically', () => {
            const sixPassengerTripBookings = [
                { id: 1, passenger_name: 'Father', phone: '+992900112233' },
                { id: 2, passenger_name: 'Mother', phone: '+992900112233' },
                { id: 3, passenger_name: 'Child 1', phone: '+992900112233' },
                { id: 4, passenger_name: 'Child 2', phone: '+992900112233' },
                { id: 5, passenger_name: 'Child 3', phone: '+992900112233' },
                { id: 6, passenger_name: 'Grandmother', phone: '+992900112233' }
            ];

            // Case A: role is unknown with 6 passengers -> stays unknown, does NOT become coordinator
            const unknownBooking = {
                id: 1,
                passenger_name: 'Father',
                phone: '+992900112233',
                contact_role: 'unknown',
                created_by_user_id: 11
            };
            const resUnknown = resolveBookingRecipients(unknownBooking, { users: mockUsers, tripBookings: sixPassengerTripBookings });
            assert.equal(resUnknown.effectiveRole, 'unknown');
            assert.equal(resUnknown.trustClassification, 'UNKNOWN_PHONE');
            assert.equal(resUnknown.coordinator, null);
            assert.equal(resUnknown.advisoryWarning, 'MULTI_PASSENGER_CONTACT');

            // Case B: role is passenger with 6 passengers -> stays passenger, does NOT become coordinator
            const passBooking = {
                id: 2,
                passenger_name: 'Mother',
                phone: '+992900112233',
                contact_role: 'passenger',
                created_by_user_id: 11
            };
            const resPass = resolveBookingRecipients(passBooking, { users: mockUsers, tripBookings: sixPassengerTripBookings });
            assert.equal(resPass.effectiveRole, 'passenger');
            assert.ok(resPass.passenger);
            assert.equal(resPass.coordinator, null);
            assert.equal(resPass.advisoryWarning, 'MULTI_PASSENGER_CONTACT');
        });

        it('10. resolves coordinator recipient when explicitly selected', () => {
            const booking = {
                id: 103,
                passenger_name: 'Suhrob Traveler',
                phone: '+79998887766',
                contact_role: 'coordinator',
                created_by_user_id: 11,
                claim_status: 'unclaimed'
            };

            const result = resolveBookingRecipients(booking, { users: mockUsers });
            assert.equal(result.effectiveRole, 'coordinator');
            assert.equal(result.trustClassification, 'COORDINATOR_CONTACT');
            assert.equal(result.passenger, null);
            assert.equal(result.familyOrGroup, null);
            assert.ok(result.coordinator);
            assert.equal(result.coordinator.phone, '+79998887766');
            assert.equal(result.coordinator.telegramEligible, false); // User 77 has no telegram_id
        });

        it('11. resolves missing phone cleanly without passenger messaging candidate', () => {
            const booking = {
                id: 104,
                passenger_name: 'Anonymous Traveler',
                phone: '—',
                contact_role: 'unknown',
                created_by_user_id: 11,
                claim_status: 'unclaimed'
            };

            const result = resolveBookingRecipients(booking, { users: mockUsers });
            assert.equal(result.trustClassification, 'MISSING_PHONE');
            assert.equal(result.passenger, null);
            assert.equal(result.familyOrGroup, null);
            assert.equal(result.coordinator, null);
            assert.ok(result.creator);
            assert.equal(result.creator.userId, 11);
            assert.equal(result.creator.telegramEligible, true);
        });

        it('12. findTelegramUserByVerifiedPhone strictly requires telegram_id in local DB', () => {
            assert.equal(findTelegramUserByVerifiedPhone('+992900112233', mockUsers)?.telegram_id, 555555);
            assert.equal(findTelegramUserByVerifiedPhone('+79998887766', mockUsers), null);
            assert.equal(findTelegramUserByVerifiedPhone('+99999999999', mockUsers), null);
        });
    });

    describe('3. Notification Providers & Idempotency', () => {
        it('13. generates deterministic idempotency key for family_or_group recipient', () => {
            const key1 = generateNotificationIdempotencyKey(139, 'family_or_group', 55, 'telegram', 'ticket_issued');
            const key2 = generateNotificationIdempotencyKey(139, 'family_or_group', 55, 'telegram', 'ticket_issued');
            assert.equal(key1, 'booking:139:family_or_group:55:telegram:ticket_issued');
            assert.equal(key1, key2);
        });

        it('14. TelegramProvider canSend validates recipient eligibility', () => {
            const provider = new TelegramProvider();
            provider.enabled = true;
            assert.equal(provider.canSend({ telegramEligible: true, telegramChatId: 12345 }), true);
            assert.equal(provider.canSend({ telegramEligible: false, telegramChatId: null }), false);
            assert.equal(provider.canSend(null), false);
        });

        it('15. TelegramProvider supports dryRun without calling external Telegram API', async () => {
            const provider = new TelegramProvider();
            provider.enabled = true;
            const res = await provider.send({ telegramEligible: true, telegramChatId: 12345 }, { text: 'Test' }, { dryRun: true });
            assert.equal(res.success, true);
            assert.equal(res.status, 'dry_run_success');
            assert.equal(res.chatId, 12345);
        });

        it('16. WhatsAppProvider is explicitly disabled and returns NOT_CONFIGURED', async () => {
            const provider = new WhatsAppProvider();
            assert.equal(provider.enabled, false);
            assert.equal(provider.canSend({ phone: '+992927925051' }), false);
            const res = await provider.send({ phone: '+992927925051' }, { text: 'Test' });
            assert.equal(res.success, false);
            assert.equal(res.reason, 'WHATSAPP_BUSINESS_API_NOT_CONFIGURED');
        });
    });

    describe('4. Legacy Compatibility & Semantics Preservation', () => {
        it('17. legacy manual bookings with surrogate passenger_id=11 are preserved', () => {
            const legacyBooking = {
                id: 1,
                bus_ticket_id: 10,
                passenger_id: 11,
                passenger_name: 'Холзода Чахонгир',
                phone: '—',
                channel: 'manual',
                created_by_user_id: 11,
                status: 'confirmed'
            };
            assert.equal(legacyBooking.passenger_id, 11);
            assert.equal(legacyBooking.created_by_user_id, 11);
            const norm = normalizePhone(legacyBooking.phone);
            assert.equal(norm, null);
        });

        it('18. contact_role defaults to unknown for all legacy items', () => {
            const legacyBooking = { id: 2, phone: '+992920000000' };
            const result = resolveBookingRecipients(legacyBooking);
            assert.equal(result.contactRole, 'unknown');
        });
    });
});
