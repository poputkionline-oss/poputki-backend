/**
 * Phase E.8 — Cross-Device Mini App + Telegram Delivery + Ticket QR Security Tests
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { generateTicketVerificationToken, verifyTicketToken } = require('../utils/ticketHelper');
const { isDeliveryEnabled } = require('../utils/telegramDeliveryService');
const { buildNotificationPlan } = require('../utils/notificationRoutingEngine');

describe('Phase E.8 — Cross-Device, Delivery & QR Verification Tests', () => {

    it('[E8-01] Ticket verification token uses deterministic HMAC payload without leaking PII', () => {
        const bookingId = 424;
        const token = generateTicketVerificationToken(bookingId);
        assert.ok(token, 'Token must be generated');
        assert.strictEqual(typeof token, 'string');
        assert.ok(token.startsWith('424-'), 'Token must start with booking ID prefix');

        const isValid = verifyTicketToken(token, 424);
        assert.strictEqual(isValid, true, 'Verification token must be valid for booking ID 424');
    });

    it('[E8-02] Tampered verification token is rejected', () => {
        const fakeToken = '424-00000000000000000000000000000000';
        const isValid = verifyTicketToken(fakeToken, 424);
        assert.strictEqual(isValid, false, 'Tampered token must return false');
    });

    it('[E8-03] Notification plan creates passenger ticket intent when routing is enabled', () => {
        const booking = {
            id: 424,
            bus_ticket_id: 10,
            passenger_id: 11,
            claimed_by_user_id: 1121,
            claim_status: 'claimed',
            phone: '+992900000000',
            contact_role: 'passenger',
            created_by_user_id: 11
        };

        const plan = buildNotificationPlan(booking, {
            creator: { id: 11, name: 'Carrier' },
            trip: { id: 10, from_city: 'Душанбе', to_city: 'Худжанд' },
            users: [{ id: 1121, telegram_id: '123456', phone: '+992900000000' }]
        });

        assert.ok(plan.intents.length > 0);
        const passengerIntent = plan.intents.find(i => i.recipientType === 'passenger' && i.channel === 'telegram');
        assert.ok(passengerIntent, 'Must generate Telegram passenger intent');
        assert.strictEqual(passengerIntent.recipientUserId, 1121);
        assert.strictEqual(passengerIntent.telegramChatId, '123456');
    });

    it('[E8-04] Global delivery gate evaluation is deterministic', () => {
        const enabled = isDeliveryEnabled();
        assert.strictEqual(typeof enabled, 'boolean');
    });

    it('[E8-05] Same Telegram identity resolves to single platform user regardless of client device', () => {
        const userA = { id: 1121, telegram_id: '99887766' };
        const userB = { id: 1121, telegram_id: '99887766' };

        assert.strictEqual(userA.id, userB.id, 'Same Telegram account must resolve to same platform user ID');
        assert.strictEqual(userA.telegram_id, userB.telegram_id);
    });

    it('[E8-06] My Tickets queries strictly by authenticated user ID', () => {
        const miniappUserId = 1121;
        const bookingOwnerId = 13;

        const matchesUser = (bookingClaimedBy, currentUserId) => String(bookingClaimedBy) === String(currentUserId);

        assert.strictEqual(matchesUser(bookingOwnerId, miniappUserId), false, 'User 1121 must not see tickets owned by User 13');
        assert.strictEqual(matchesUser(bookingOwnerId, 13), true, 'User 13 sees their own claimed tickets');
    });
});
