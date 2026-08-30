/**
 * phase_telegram_delivery_dryrun.test.js
 * 
 * Test Suite: MANUAL BOOKING PASSENGER ACTIVATION V1 — PHASE C
 * TELEGRAM DELIVERY ENGINE, MESSAGE RENDERER & DRY-RUN PROCESSOR
 * POPUTKI.ONLINE
 */

require('dotenv').config();
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { renderTelegramNotification, escapeHtml } = require('../utils/telegramMessageRenderer');
const { classifyTelegramError, isDeliveryEnabled, processNotificationIntents } = require('../utils/telegramDeliveryService');
const { buildNotificationPlan } = require('../utils/notificationRoutingEngine');

describe('MANUAL BOOKING PASSENGER ACTIVATION V1 — PHASE C TEST SUITE', () => {

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
        departure_time: '08:00:00',
        transport_company: 'ООО «Рохи Абрешим»'
    };

    describe('1. Message Rendering & Templates', () => {
        it('1. passenger Telegram message renders with correct layout, route and ticket link', () => {
            const intent = {
                recipientType: 'passenger',
                templateKey: 'passenger_ticket_issued',
                shareableUrl: 'https://www.poputki.online/ticket-verify/101-abcdef'
            };
            const booking = {
                id: 101,
                passenger_name: 'Zarif Passenger',
                seat_numbers: [14]
            };

            const rendered = renderTelegramNotification(intent, { booking, trip: mockTrip });
            assert.ok(rendered.text.includes('Ваш электронный билет готов.'));
            assert.ok(rendered.text.includes('Zarif Passenger'));
            assert.ok(rendered.text.includes('Худжанд → Нижневартовск'));
            assert.ok(rendered.text.includes('№14'));
            assert.ok(rendered.text.includes('ООО «Рохи Абрешим»'));
            assert.ok(rendered.text.includes('https://www.poputki.online/ticket-verify/101-abcdef'));
            assert.ok(rendered.reply_markup.inline_keyboard.length > 0);
        });

        it('2. family/group single contact wording avoids claiming contact owner is the traveler', () => {
            const intent = {
                recipientType: 'family_or_group',
                templateKey: 'family_group_tickets_ready',
                shareableUrl: 'https://www.poputki.online/ticket-verify/102-abcdef'
            };
            const booking = {
                id: 102,
                passenger_name: 'Child Traveler',
                seat_numbers: [5]
            };

            const rendered = renderTelegramNotification(intent, { booking, trip: mockTrip });
            assert.ok(rendered.text.includes('На ваш контакт оформлен электронный билет:'));
            assert.equal(rendered.text.includes('Вы зарегистрированы'), false);
        });

        it('3. family/group aggregate message lists multiple passengers cleanly', () => {
            const intent = {
                recipientType: 'family_or_group',
                templateKey: 'family_group_tickets_ready',
                shareableUrl: 'https://www.poputki.online/ticket-verify/103-abcdef'
            };
            const bookingsList = [
                { id: 103, passenger_name: 'Father', seat_numbers: [1] },
                { id: 104, passenger_name: 'Mother', seat_numbers: [2] },
                { id: 105, passenger_name: 'Child', seat_numbers: [3] }
            ];

            const rendered = renderTelegramNotification(intent, { bookingsList, trip: mockTrip });
            assert.ok(rendered.text.includes('Пассажиров:</b> 3'));
            assert.ok(rendered.text.includes('Father — место №1'));
            assert.ok(rendered.text.includes('Mother — место №2'));
            assert.ok(rendered.text.includes('Child — место №3'));
            assert.ok(rendered.text.includes('Передайте ссылки на электронные билеты'));
        });

        it('4. coordinator single passenger wording directs coordinator to forward the ticket', () => {
            const intent = {
                recipientType: 'coordinator',
                templateKey: 'coordinator_tickets_ready',
                shareableUrl: 'https://www.poputki.online/ticket-verify/106-abcdef'
            };
            const booking = {
                id: 106,
                passenger_name: 'Rustam Client',
                seat_numbers: [7]
            };

            const rendered = renderTelegramNotification(intent, { booking, trip: mockTrip });
            assert.ok(rendered.text.includes('Вы оформили пассажира'));
            assert.ok(rendered.text.includes('Перешлите билет пассажиру'));
        });

        it('5. coordinator aggregate message aggregates multiple passengers', () => {
            const intent = {
                recipientType: 'coordinator',
                templateKey: 'coordinator_tickets_ready',
                shareableUrl: 'https://www.poputki.online/ticket-verify/107-abcdef'
            };
            const bookingsList = [
                { id: 107, passenger_name: 'Client 1', seat_numbers: [10] },
                { id: 108, passenger_name: 'Client 2', seat_numbers: [11] }
            ];

            const rendered = renderTelegramNotification(intent, { bookingsList, trip: mockTrip });
            assert.ok(rendered.text.includes('Вы оформили 2 пассажиров'));
            assert.ok(rendered.text.includes('Client 1 (место №10)'));
            assert.ok(rendered.text.includes('Client 2 (место №11)'));
            assert.ok(rendered.text.includes('Перешлите билеты пассажирам'));
        });

        it('6. creator handoff message never addresses creator as passenger', () => {
            const intent = {
                recipientType: 'creator',
                templateKey: 'creator_tickets_ready_for_handoff',
                shareableUrl: 'https://www.poputki.online/ticket-verify/109-abcdef'
            };
            const booking = {
                id: 109,
                passenger_name: 'Offline Traveler',
                seat_numbers: [12]
            };

            const rendered = renderTelegramNotification(intent, { booking, trip: mockTrip });
            assert.ok(rendered.text.includes('Ручная бронь успешно оформлена.'));
            assert.ok(rendered.text.includes('Передайте билет пассажиру'));
            assert.equal(rendered.text.includes('Вы зарегистрированы'), false);
        });

        it('7. templates exclude sensitive PII (passports, payment cards, internal tokens)', () => {
            const intent = {
                recipientType: 'passenger',
                templateKey: 'passenger_ticket_issued',
                shareableUrl: 'https://www.poputki.online/ticket-verify/110-abcdef'
            };
            const booking = {
                id: 110,
                passenger_name: 'Zarif Passenger',
                passport: 'A12345678',
                internal_token: 'secret_jwt_xyz'
            };

            const rendered = renderTelegramNotification(intent, { booking, trip: mockTrip });
            assert.equal(rendered.text.includes('A12345678'), false);
            assert.equal(rendered.text.includes('passport'), false);
            assert.equal(rendered.text.includes('secret_jwt_xyz'), false);
        });
    });

    describe('2. Delivery Engine & Kill Switches', () => {
        it('8. isDeliveryEnabled returns false by default', () => {
            assert.equal(isDeliveryEnabled(), false);
        });

        it('9. dry-run processor performs zero API requests and marks status pending with dryRun=true', async () => {
            const booking = {
                id: 111,
                bus_ticket_id: 10,
                passenger_name: 'Zarif Verified Passenger',
                phone: '+992900112233',
                contact_role: 'passenger',
                created_by_user_id: 11
            };

            const plan = buildNotificationPlan(booking, { users: mockUsers, trip: mockTrip });
            const results = await processNotificationIntents(plan.intents, { booking, trip: mockTrip }, { dryRun: true });

            const tgResult = results.find(r => r.channel === 'telegram');
            assert.ok(tgResult);
            assert.equal(tgResult.dryRun, true);
            assert.equal(tgResult.status, 'pending');
            assert.equal(tgResult.wouldSend, true);
            assert.equal(tgResult.deliveryBlockedByKillSwitch, true);
            assert.ok(tgResult.renderedPreview);
        });

        it('10. WhatsApp intents are always marked skipped with WHATSAPP_BUSINESS_API_NOT_CONFIGURED', async () => {
            const booking = { id: 112, phone: '+992900112233', contact_role: 'passenger', created_by_user_id: 11 };
            const plan = buildNotificationPlan(booking, { users: mockUsers, trip: mockTrip });
            const results = await processNotificationIntents(plan.intents, { booking, trip: mockTrip }, { dryRun: true });

            const waResult = results.find(r => r.channel === 'whatsapp');
            assert.ok(waResult);
            assert.equal(waResult.status, 'skipped');
            assert.equal(waResult.reason, 'WHATSAPP_BUSINESS_API_NOT_CONFIGURED');
        });
    });

    describe('3. Error Classification & Resilience', () => {
        it('11. classifies 429 rate limit as temporary failure with retryAfterSeconds', () => {
            const err = { response: { status: 429, data: { parameters: { retry_after: 10 } } } };
            const res = classifyTelegramError(err);
            assert.equal(res.isTemporary, true);
            assert.equal(res.errorCode, 'TELEGRAM_RATE_LIMITED');
            assert.equal(res.retryAfterSeconds, 10);
        });

        it('12. classifies 500/502 server error as temporary failure', () => {
            const err = { response: { status: 502, data: { description: 'Bad Gateway' } } };
            const res = classifyTelegramError(err);
            assert.equal(res.isTemporary, true);
            assert.equal(res.errorCode, 'TELEGRAM_SERVER_ERROR');
        });

        it('13. classifies 403 bot blocked by user as permanent failure', () => {
            const err = { response: { status: 403, data: { description: 'Forbidden: bot was blocked by the user' } } };
            const res = classifyTelegramError(err);
            assert.equal(res.isTemporary, false);
            assert.equal(res.errorCode, 'TELEGRAM_BOT_BLOCKED_BY_USER');
        });

        it('14. classifies 400 chat not found as permanent failure', () => {
            const err = { response: { status: 400, data: { description: 'Bad Request: chat not found' } } };
            const res = classifyTelegramError(err);
            assert.equal(res.isTemporary, false);
            assert.equal(res.errorCode, 'TELEGRAM_CHAT_NOT_FOUND');
        });

        it('15. test mode blocks non-allowlisted recipients with TEST_MODE_RECIPIENT_NOT_ALLOWED', async () => {
            const prevMode = process.env.NOTIFICATION_TEST_MODE;
            const prevAllowlist = process.env.TELEGRAM_NOTIFICATION_TEST_USER_IDS;
            try {
                process.env.NOTIFICATION_TEST_MODE = 'true';
                process.env.TELEGRAM_NOTIFICATION_TEST_USER_IDS = '999999'; // Different user

                const intent = {
                    channel: 'telegram',
                    recipientType: 'passenger',
                    recipientUserId: 55,
                    telegramChatId: 555555,
                    templateKey: 'passenger_ticket_issued'
                };

                const results = await processNotificationIntents([intent], { booking: {}, trip: mockTrip }, { dryRun: false });
                assert.equal(results[0].status, 'skipped');
                assert.equal(results[0].reason, 'TEST_MODE_RECIPIENT_NOT_ALLOWED');
            } finally {
                process.env.NOTIFICATION_TEST_MODE = prevMode;
                process.env.TELEGRAM_NOTIFICATION_TEST_USER_IDS = prevAllowlist;
            }
        });
    });
});
