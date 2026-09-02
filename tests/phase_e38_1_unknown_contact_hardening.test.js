/**
 * tests/phase_e38_1_unknown_contact_hardening.test.js
 * 
 * Phase E.38.1 — Unknown Contact Ownership Hardening Test Suite
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { evaluateAutoClaimEligibility, resolveRegisteredPassenger } = require('../utils/claimHelper');
const { buildNotificationPlan } = require('../utils/notificationRoutingEngine');

describe('PHASE E.38.1 — UNKNOWN CONTACT OWNERSHIP HARDENING', () => {

    const registeredUser = {
        id: 101,
        name: 'Фарход',
        phone: '+992900112233',
        telegram_id: '99887766'
    };

    const mockDbWithUser = {
        from: (table) => ({
            select: () => ({
                eq: (col, val) => ({
                    not: () => ({
                        data: col === 'phone' && val === '+992900112233' ? [registeredUser] : [],
                        error: null
                    })
                })
            })
        })
    };

    const mockDbNoUser = {
        from: (table) => ({
            select: () => ({
                eq: () => ({
                    not: () => ({
                        data: [],
                        error: null
                    })
                })
            })
        })
    };

    // Helper simulating busAdmin.js role and auto-claim resolution logic
    async function simulateManualBookingRoleResolution(contact_role, phone, dbClient) {
        const validContactRole = ['passenger', 'family_or_group', 'coordinator', 'unknown'].includes(contact_role) ? contact_role : 'unknown';
        
        let registeredPassenger = null;
        let effectiveContactRole = validContactRole;

        // E.38.1: Only explicit 'passenger' role may resolve registered passenger for auto-claim
        if (validContactRole === 'passenger') {
            registeredPassenger = await resolveRegisteredPassenger(phone, { supabaseClient: dbClient });
        }

        const isAutoClaimed = Boolean(registeredPassenger);
        const claimed_by_user_id = registeredPassenger ? registeredPassenger.id : null;
        const claim_status = isAutoClaimed ? 'claimed' : 'unclaimed';

        return {
            contact_role: effectiveContactRole,
            registeredPassenger,
            isAutoClaimed,
            claimed_by_user_id,
            claim_status
        };
    }

    it('CASE A: contact_role = passenger, phone matches registered Telegram passenger -> AUTO_CLAIM = YES', async () => {
        const result = await simulateManualBookingRoleResolution('passenger', '+992900112233', mockDbWithUser);
        assert.strictEqual(result.contact_role, 'passenger');
        assert.strictEqual(result.isAutoClaimed, true);
        assert.strictEqual(result.claimed_by_user_id, 101);
        assert.strictEqual(result.claim_status, 'claimed');

        // Verify notification plan has passenger telegram intent
        const booking = { id: 501, phone: '+992900112233', contact_role: 'passenger', bus_ticket_id: 73 };
        const plan = buildNotificationPlan(booking, {
            users: [registeredUser],
            creator: { id: 11, name: 'Carrier' },
            trip: { id: 73 }
        });
        const passengerIntent = plan.intents.find(i => i.recipientType === 'passenger' && i.channel === 'telegram');
        assert.ok(passengerIntent, 'Passenger Telegram intent must be created');
        assert.strictEqual(passengerIntent.status, 'pending');
    });

    it('CASE B: contact_role = passenger, phone does not match registered passenger -> AUTO_CLAIM = NO', async () => {
        const result = await simulateManualBookingRoleResolution('passenger', '+992900999999', mockDbNoUser);
        assert.strictEqual(result.contact_role, 'passenger');
        assert.strictEqual(result.isAutoClaimed, false);
        assert.strictEqual(result.claimed_by_user_id, null);
        assert.strictEqual(result.claim_status, 'unclaimed');
    });

    it('CASE C: contact_role = unknown, phone matches registered Telegram user -> AUTO_CLAIM = NO, AUTO_PROMOTION = NO', async () => {
        const result = await simulateManualBookingRoleResolution('unknown', '+992900112233', mockDbWithUser);
        assert.strictEqual(result.contact_role, 'unknown', 'Role must remain unknown, NOT auto-promoted to passenger');
        assert.strictEqual(result.isAutoClaimed, false, 'Must NOT auto-claim when role is unknown');
        assert.strictEqual(result.claimed_by_user_id, null, 'claimed_by_user_id must remain null');
        assert.strictEqual(result.claim_status, 'unclaimed');

        // Verify notification plan: MUST NOT create direct passenger ticket intent
        const booking = { id: 502, phone: '+992900112233', contact_role: 'unknown', bus_ticket_id: 73 };
        const plan = buildNotificationPlan(booking, {
            users: [registeredUser],
            creator: { id: 11, name: 'Carrier' },
            trip: { id: 73 }
        });
        const passengerIntent = plan.intents.find(i => i.recipientType === 'passenger');
        assert.strictEqual(passengerIntent, undefined, 'Must NOT send passenger ticket to matched user when role is unknown');

        // Phase E.45.3: the LATER, separate Telegram-verified claim flow
        // (evaluateAutoClaimEligibility) is identity/phone-based and no
        // longer gated on contact_role — it must succeed here on verified
        // identity + phone match alone. This does not reintroduce the E.38.1
        // risk above: that risk was a bare DB phone match silently granting
        // ownership at booking-CREATION time with no Telegram verification
        // at all, which simulateManualBookingRoleResolution above still
        // correctly blocks regardless of this change.
        const eligibility = evaluateAutoClaimEligibility(
            { id: 502, phone: '+992900112233', contact_role: 'unknown', status: 'confirmed' },
            registeredUser,
            {},
            '99887766'
        );
        assert.strictEqual(eligibility.canAutoClaim, true, 'contact_role=unknown must not block a verified-identity + phone-match claim');
        assert.strictEqual(eligibility.method, 'known_user_phone_match');
    });

    it('CASE D: contact_role = unknown, phone does not match -> AUTO_CLAIM = NO', async () => {
        const result = await simulateManualBookingRoleResolution('unknown', '+992900999999', mockDbNoUser);
        assert.strictEqual(result.contact_role, 'unknown');
        assert.strictEqual(result.isAutoClaimed, false);
        assert.strictEqual(result.claimed_by_user_id, null);
        assert.strictEqual(result.claim_status, 'unclaimed');
    });

    it('CASE E: contact_role = family_or_group, phone matches registered user -> AUTO_CLAIM = NO', async () => {
        const result = await simulateManualBookingRoleResolution('family_or_group', '+992900112233', mockDbWithUser);
        assert.strictEqual(result.contact_role, 'family_or_group');
        assert.strictEqual(result.isAutoClaimed, false);
        assert.strictEqual(result.claimed_by_user_id, null);
        assert.strictEqual(result.claim_status, 'unclaimed');

        // Phase E.45.3: verified-identity + phone-match claim must succeed
        // regardless of legacy contact_role value.
        const eligibility = evaluateAutoClaimEligibility(
            { id: 503, phone: '+992900112233', contact_role: 'family_or_group', status: 'confirmed' },
            registeredUser,
            {},
            '99887766'
        );
        assert.strictEqual(eligibility.canAutoClaim, true, 'contact_role=family_or_group must not block a verified-identity + phone-match claim');
        assert.strictEqual(eligibility.method, 'known_user_phone_match');
    });

    it('CASE F: contact_role = coordinator, phone matches registered user -> AUTO_CLAIM = NO', async () => {
        const result = await simulateManualBookingRoleResolution('coordinator', '+992900112233', mockDbWithUser);
        assert.strictEqual(result.contact_role, 'coordinator');
        assert.strictEqual(result.isAutoClaimed, false);
        assert.strictEqual(result.claimed_by_user_id, null);
        assert.strictEqual(result.claim_status, 'unclaimed');

        // Phase E.45.3: verified-identity + phone-match claim must succeed
        // regardless of legacy contact_role value.
        const eligibility = evaluateAutoClaimEligibility(
            { id: 504, phone: '+992900112233', contact_role: 'coordinator', status: 'confirmed' },
            registeredUser,
            {},
            '99887766'
        );
        assert.strictEqual(eligibility.canAutoClaim, true, 'contact_role=coordinator must not block a verified-identity + phone-match claim');
        assert.strictEqual(eligibility.method, 'known_user_phone_match');
    });

});
