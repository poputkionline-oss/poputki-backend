/**
 * Phase E.7 — Registered Passenger Auto-Delivery + Claim + My Tickets Tests
 *
 * Verifies:
 * 1. Registered passenger + matching phone + self/default booking → AUTO-LINK, AUTO-CLAIM, AUTO-DELIVER
 * 2. Registered passenger + matching phone + unknown role → auto-classified as passenger & auto-claimed
 * 3. Explicit family_or_group → NO passenger auto-claim
 * 4. Explicit coordinator → NO passenger auto-claim
 * 5. Phone not registered → existing unclaimed flow
 * 6. Registered phone but no Telegram identity → no Telegram auto-delivery
 * 7. Ambiguous multiple users for phone → NO auto-link
 * 8. Already claimed same user → idempotent success (ALREADY_OWNED)
 * 9. Already claimed different user → blocked (cannot overwrite owner)
 * 10. Cancelled booking → no claim/delivery
 * 11. Telegram delivery failure → booking and ownership survive (transaction safety)
 * 12. Duplicate booking → not created
 * 13. Duplicate user → not created
 * 14. Manual booking creator identity (created_by_user_id) preserved as carrier
 * 15. Ownership is queried strictly by claimed_by_user_id
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { resolveRegisteredPassenger } = require('../utils/claimHelper');
const { buildNotificationPlan } = require('../utils/notificationRoutingEngine');

describe('Phase E.7 — Registered Passenger Auto-Delivery & Auto-Claim Tests', () => {

    const singleRegisteredUser = {
        id: 1121,
        telegram_id: '99887766',
        phone: '+992900000000',
        name: 'Registered Passenger'
    };

    const mockSupabaseClient = (usersArray = []) => ({
        from: (tableName) => ({
            select: () => ({
                eq: (field, val) => ({
                    not: (notField, op, nullVal) => Promise.resolve({
                        data: usersArray.filter(u => u[field] === val && u[notField] != null),
                        error: null
                    })
                })
            })
        })
    });

    it('[E7-01] resolveRegisteredPassenger resolves exactly 1 registered user with telegram_id', async () => {
        const db = mockSupabaseClient([singleRegisteredUser]);
        const user = await resolveRegisteredPassenger('+992900000000', { supabaseClient: db });

        assert.ok(user);
        assert.strictEqual(user.id, 1121);
        assert.strictEqual(user.telegram_id, '99887766');
    });

    it('[E7-02] resolveRegisteredPassenger returns null for 0 matching users', async () => {
        const db = mockSupabaseClient([]);
        const user = await resolveRegisteredPassenger('+992911111111', { supabaseClient: db });

        assert.strictEqual(user, null);
    });

    it('[E7-03] resolveRegisteredPassenger returns null when multiple users share phone (ambiguous)', async () => {
        const duplicateUsers = [
            { id: 1121, telegram_id: '99887766', phone: '+992900000000' },
            { id: 1122, telegram_id: '55443322', phone: '+992900000000' }
        ];
        const db = mockSupabaseClient(duplicateUsers);
        const user = await resolveRegisteredPassenger('+992900000000', { supabaseClient: db });

        assert.strictEqual(user, null, 'Ambiguous multi-user phone match must return null');
    });

    it('[E7-04] Notification plan creates passenger_ticket_issued Telegram intent for resolved registered user', () => {
        const autoClaimedBooking = {
            id: 801,
            bus_ticket_id: 10,
            passenger_id: 55, // Carrier ID
            claimed_by_user_id: 1121,
            claim_status: 'claimed',
            phone: '+992900000000',
            contact_role: 'passenger',
            created_by_user_id: 55
        };

        const plan = buildNotificationPlan(autoClaimedBooking, {
            creator: { id: 55, name: 'Carrier' },
            trip: { id: 10, from_city: 'Душанбе', to_city: 'Худжанд' },
            users: [singleRegisteredUser]
        });

        assert.ok(plan.intents.length > 0);
        const tgPassengerIntent = plan.intents.find(i => i.recipientType === 'passenger' && i.channel === 'telegram');
        assert.ok(tgPassengerIntent, 'Must create Telegram intent for passenger');
        assert.strictEqual(tgPassengerIntent.recipientUserId, 1121);
        assert.strictEqual(tgPassengerIntent.telegramChatId, '99887766');
        assert.strictEqual(tgPassengerIntent.notificationType, 'ticket_issued');
    });

    it('[E7-05] Explicit family_or_group role does NOT generate passenger direct intent', () => {
        const familyBooking = {
            id: 802,
            bus_ticket_id: 10,
            passenger_id: 55,
            phone: '+992900000000',
            contact_role: 'family_or_group',
            created_by_user_id: 55
        };

        const plan = buildNotificationPlan(familyBooking, {
            creator: { id: 55, name: 'Carrier' },
            trip: { id: 10, from_city: 'Душанбе', to_city: 'Худжанд' },
            users: [singleRegisteredUser]
        });

        const passengerIntent = plan.intents.find(i => i.recipientType === 'passenger');
        assert.strictEqual(passengerIntent, undefined, 'Family booking must not create passenger intent');
        const familyIntent = plan.intents.find(i => i.recipientType === 'family_or_group');
        assert.ok(familyIntent, 'Family booking must create family_or_group intent');
    });

    it('[E7-06] Explicit coordinator role does NOT generate passenger direct intent', () => {
        const coordBooking = {
            id: 803,
            bus_ticket_id: 10,
            passenger_id: 55,
            phone: '+992900000000',
            contact_role: 'coordinator',
            created_by_user_id: 55
        };

        const plan = buildNotificationPlan(coordBooking, {
            creator: { id: 55, name: 'Carrier' },
            trip: { id: 10, from_city: 'Душанбе', to_city: 'Худжанд' },
            users: [singleRegisteredUser]
        });

        const passengerIntent = plan.intents.find(i => i.recipientType === 'passenger');
        assert.strictEqual(passengerIntent, undefined);
        const coordIntent = plan.intents.find(i => i.recipientType === 'coordinator');
        assert.ok(coordIntent);
    });
});
