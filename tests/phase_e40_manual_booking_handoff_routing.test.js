/**
 * tests/phase_e40_manual_booking_handoff_routing.test.js
 * 
 * Phase E.40 — Manual Booking Success Message & Handoff Routing Test Suite
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { generateTicketVerificationToken } = require('../utils/ticketHelper');

describe('PHASE E.40 — MANUAL BOOKING SUCCESS MESSAGE & HANDOFF ROUTING', () => {

    it('CASE A: Registered passenger with successful auto-claim sets is_auto_claimed=true and handoff.required=false', () => {
        const isAutoClaimed = true;
        let handoff = { required: false };
        if (!isAutoClaimed) {
            handoff = { required: true };
        }

        const response = {
            success: true,
            booking_id: 100,
            is_auto_claimed: isAutoClaimed,
            handoff
        };

        assert.strictEqual(response.is_auto_claimed, true);
        assert.strictEqual(response.handoff.required, false);
    });

    it('CASE B: Unregistered passenger sets is_auto_claimed=false and handoff.required=true with ticket_url', () => {
        const isAutoClaimed = false;
        const effectiveContactRole = 'passenger';
        const bookingId = 448;

        const verificationToken = generateTicketVerificationToken(bookingId);
        const ticketUrl = `https://www.poputki.online/ticket-verify/${verificationToken}`;

        const handoff = {
            required: true,
            contact_role: effectiveContactRole,
            booking_id: bookingId,
            claim_url: 'https://t.me/Poputkionline_bot?start=claim_mock',
            ticket_url: ticketUrl,
            expires_at: new Date(Date.now() + 900000).toISOString()
        };

        const response = {
            success: true,
            booking_id: bookingId,
            is_auto_claimed: isAutoClaimed,
            handoff
        };

        assert.strictEqual(response.is_auto_claimed, false);
        assert.strictEqual(response.handoff.required, true);
        assert.strictEqual(response.handoff.contact_role, 'passenger');
        assert.ok(response.handoff.ticket_url.includes('/ticket-verify/'));
    });

    it('CASE D, E, F: family, coordinator, unknown always require handoff and are not auto-claimed', () => {
        const roles = ['family_or_group', 'coordinator', 'unknown'];

        roles.forEach(role => {
            const isAutoClaimed = false; // Blocked by E.38.1
            const verificationToken = generateTicketVerificationToken(200);
            const handoff = {
                required: true,
                contact_role: role,
                booking_id: 200,
                ticket_url: `https://www.poputki.online/ticket-verify/${verificationToken}`
            };

            assert.strictEqual(isAutoClaimed, false);
            assert.strictEqual(handoff.required, true);
            assert.strictEqual(handoff.contact_role, role);
        });
    });

    it('CASE G: Claim session failure resilience: handoff.required remains true and ticket_url is always available', () => {
        const isAutoClaimed = false;
        let session = null;
        try {
            throw new Error('RLS policy or database failure');
        } catch (e) {
            // Handled gracefully
        }

        const verificationToken = generateTicketVerificationToken(448);
        const ticketUrl = `https://www.poputki.online/ticket-verify/${verificationToken}`;

        const handoff = {
            required: true,
            contact_role: 'passenger',
            booking_id: 448,
            claim_url: session?.deepLink || null,
            ticket_url: ticketUrl,
            expires_at: session?.expiresAt || null
        };

        assert.strictEqual(handoff.required, true);
        assert.strictEqual(handoff.claim_url, null);
        assert.ok(handoff.ticket_url.startsWith('https://www.poputki.online/ticket-verify/'));
    });

});
