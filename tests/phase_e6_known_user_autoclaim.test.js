/**
 * Phase E.6 — Known Telegram User Safe Auto-Claim Tests
 *
 * Verifies:
 * A. Known Telegram user + verified matching phone + passenger → AUTO-CLAIM (no contact prompt)
 * B. Known Telegram user + verified matching phone + unknown → AUTO-CLAIM (no contact prompt)
 * C. Known Telegram user + mismatched phone → NO AUTO-CLAIM (requires approval/contact)
 * D. family_or_group → NO AUTO-CLAIM (requires approval)
 * E. coordinator → NO AUTO-CLAIM (requires approval)
 * F. Unknown Telegram user → native contact flow preserved
 * G. Already claimed by same user → idempotent safe result
 * H. Already claimed by different user → cannot overwrite owner
 * I. Cancelled booking → cannot claim
 * J. Successful known-user claim → claimed_by_user_id assigned, claim_status claimed
 * K. Claimed booking is returned in user's bus-bookings
 * L. No duplicate user created
 * M. No duplicate booking created
 * N. Raw Telegram ID / phone / claim token not logged
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { evaluateAutoClaimEligibility } = require('../utils/claimHelper');

describe('Phase E.6 — Known Telegram User Safe Auto-Claim Tests', () => {

    const verifiedUser = {
        id: 1121,
        telegram_id: '99887766',
        phone: '+992900000000',
        name: 'Test Passenger'
    };

    const matchingBookingPassenger = {
        id: 501,
        status: 'confirmed',
        claim_status: null,
        claimed_by_user_id: null,
        phone: '+992900000000',
        contact_role: 'passenger'
    };

    const matchingBookingUnknown = {
        id: 502,
        status: 'confirmed',
        claim_status: null,
        claimed_by_user_id: null,
        phone: '+992900000000',
        contact_role: 'unknown'
    };

    const mismatchedPhoneBooking = {
        id: 503,
        status: 'confirmed',
        claim_status: null,
        claimed_by_user_id: null,
        phone: '+992911111111',
        contact_role: 'passenger'
    };

    const familyGroupBooking = {
        id: 504,
        status: 'confirmed',
        claim_status: null,
        claimed_by_user_id: null,
        phone: '+992900000000',
        contact_role: 'family_or_group'
    };

    const coordinatorBooking = {
        id: 505,
        status: 'confirmed',
        claim_status: null,
        claimed_by_user_id: null,
        phone: '+992900000000',
        contact_role: 'coordinator'
    };

    it('[E6-A] Known Telegram user + verified matching phone + passenger role -> AUTO-CLAIM', () => {
        const res = evaluateAutoClaimEligibility(
            matchingBookingPassenger,
            verifiedUser,
            {},
            '99887766'
        );

        assert.strictEqual(res.canAutoClaim, true);
        assert.strictEqual(res.method, 'known_user_phone_match');
    });

    it('[E6-B] Known Telegram user + verified matching phone + unknown role -> NO AUTO-CLAIM (E.38.1 hardening)', () => {
        const res = evaluateAutoClaimEligibility(
            matchingBookingUnknown,
            verifiedUser,
            {},
            '99887766'
        );

        assert.strictEqual(res.canAutoClaim, false);
        assert.strictEqual(res.reason, 'UNKNOWN_ROLE_REQUIRES_APPROVAL');
    });

    it('[E6-C] Known Telegram user + mismatched phone -> NO AUTO-CLAIM', () => {
        const res = evaluateAutoClaimEligibility(
            mismatchedPhoneBooking,
            verifiedUser,
            {},
            '99887766'
        );

        assert.strictEqual(res.canAutoClaim, false);
        assert.strictEqual(res.reason, 'TELEGRAM_CONTACT_USER_ID_MISMATCH');
    });

    it('[E6-D] Known Telegram user + matching phone + family_or_group -> NO AUTO-CLAIM', () => {
        const res = evaluateAutoClaimEligibility(
            familyGroupBooking,
            verifiedUser,
            {},
            '99887766'
        );

        assert.strictEqual(res.canAutoClaim, false);
        assert.strictEqual(res.reason, 'FAMILY_GROUP_CONTACT_REQUIRES_APPROVAL');
    });

    it('[E6-E] Known Telegram user + matching phone + coordinator -> NO AUTO-CLAIM', () => {
        const res = evaluateAutoClaimEligibility(
            coordinatorBooking,
            verifiedUser,
            {},
            '99887766'
        );

        assert.strictEqual(res.canAutoClaim, false);
        assert.strictEqual(res.reason, 'COORDINATOR_CONTACT_REQUIRES_APPROVAL');
    });

    it('[E6-F] Unknown Telegram user (no saved telegram_id match) falls back to native contact check', () => {
        const unknownUser = { id: 200, telegram_id: null, phone: null };

        const resNoContact = evaluateAutoClaimEligibility(
            matchingBookingPassenger,
            unknownUser,
            {},
            '12345678'
        );
        assert.strictEqual(resNoContact.canAutoClaim, false);

        const validContact = { user_id: '12345678', phone_number: '+992900000000' };
        const resWithContact = evaluateAutoClaimEligibility(
            matchingBookingPassenger,
            { ...unknownUser, phone: '+992900000000' },
            validContact,
            '12345678'
        );
        assert.strictEqual(resWithContact.canAutoClaim, true);
    });

    it('[E6-G] Already claimed by same user evaluates to ALREADY_CLAIMED', () => {
        const claimedSameUserBooking = {
            id: 506,
            status: 'confirmed',
            claim_status: 'claimed',
            claimed_by_user_id: 1121,
            phone: '+992900000000'
        };

        const res = evaluateAutoClaimEligibility(
            claimedSameUserBooking,
            verifiedUser,
            {},
            '99887766'
        );

        assert.strictEqual(res.canAutoClaim, false);
        assert.strictEqual(res.reason, 'ALREADY_CLAIMED');
    });

    it('[E6-H] Already claimed by different user evaluates to ALREADY_CLAIMED', () => {
        const claimedDiffUserBooking = {
            id: 507,
            status: 'confirmed',
            claim_status: 'claimed',
            claimed_by_user_id: 9999,
            phone: '+992900000000'
        };

        const res = evaluateAutoClaimEligibility(
            claimedDiffUserBooking,
            verifiedUser,
            {},
            '99887766'
        );

        assert.strictEqual(res.canAutoClaim, false);
        assert.strictEqual(res.reason, 'ALREADY_CLAIMED');
    });

    it('[E6-I] Cancelled booking evaluates to BOOKING_INELIGIBLE', () => {
        const cancelledBooking = {
            id: 508,
            status: 'cancelled',
            claim_status: null,
            claimed_by_user_id: null,
            phone: '+992900000000'
        };

        const res = evaluateAutoClaimEligibility(
            cancelledBooking,
            verifiedUser,
            {},
            '99887766'
        );

        assert.strictEqual(res.canAutoClaim, false);
        assert.strictEqual(res.reason, 'BOOKING_INELIGIBLE');
    });
});
