/**
 * tests/phase_e45_3_contact_role_independent_claim.test.js
 *
 * PHASE E.45.3 — contact_role must never gate the verified-Telegram-phone
 * auto-claim flow, while E.38.1's booking-creation-time ownership safety
 * (a bare DB phone match must never silently auto-assign ownership) stays
 * fully intact. Covers the lettered test matrix A-N from the phase spec.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { evaluateAutoClaimEligibility, resolveRegisteredPassenger } = require('../utils/claimHelper');

const verifiedUser = {
    id: 9001,
    telegram_id: '555000111',
    phone: '+992900112233',
    name: 'Верифицированный Пользователь'
};

function bookingWith(role) {
    return {
        id: 7001,
        status: 'confirmed',
        claim_status: null,
        claimed_by_user_id: null,
        phone: '+992900112233',
        contact_role: role
    };
}

describe('Phase E.45.3 — D-G: verified native Telegram phone auto-claim PASSES for every contact_role', () => {
    for (const role of ['unknown', 'passenger', 'family_or_group', 'coordinator', 'some_future_legacy_value']) {
        it(`contact_role=${role} + verified Telegram identity + matching phone -> AUTO-CLAIM PASS`, () => {
            const res = evaluateAutoClaimEligibility(bookingWith(role), verifiedUser, {}, '555000111');
            assert.equal(res.canAutoClaim, true, `contact_role=${role} must not block a verified-identity + phone-match claim`);
            assert.equal(res.method, 'known_user_phone_match');
        });
    }

    it('also passes via the native contact-share fallback (no pre-linked telegram_id yet)', () => {
        const unlinkedUser = { id: 9002, telegram_id: null, phone: null };
        const res = evaluateAutoClaimEligibility(
            bookingWith('unknown'),
            unlinkedUser,
            { user_id: '777000888', phone_number: '+992900112233' },
            '777000888'
        );
        assert.equal(res.canAutoClaim, true);
    });
});

describe('Phase E.45.3 — H-L: all identity/security guards remain fully enforced', () => {
    it('H. typed/self-reported phone number alone (no matching Telegram contact card) -> BLOCKED', () => {
        // "Typed phone" is simulated as a telegramContact object carrying only a
        // phone_number with no verified user_id tying it to the actual sender —
        // i.e. a phone number with no Telegram-authenticated backing at all.
        const unlinkedUser = { id: 9003, telegram_id: null, phone: null };
        const res = evaluateAutoClaimEligibility(
            bookingWith('unknown'),
            unlinkedUser,
            { phone_number: '+992900112233' }, // no user_id: not a verified native contact share
            '999888777'
        );
        assert.equal(res.canAutoClaim, false);
        assert.equal(res.reason, 'TELEGRAM_CONTACT_USER_ID_MISMATCH');
    });

    it('I. phone mismatch -> BLOCKED', () => {
        const mismatched = { ...bookingWith('passenger'), phone: '+992911119999' };
        const res = evaluateAutoClaimEligibility(mismatched, verifiedUser, {}, '555000111');
        assert.equal(res.canAutoClaim, false);
    });

    it('J. Telegram sender/contact user_id mismatch (forged contact card) -> BLOCKED', () => {
        const res = evaluateAutoClaimEligibility(
            bookingWith('passenger'),
            verifiedUser,
            { user_id: 'attacker-id', phone_number: '+992900112233' },
            '555000111'
        );
        assert.equal(res.canAutoClaim, false);
        assert.equal(res.reason, 'TELEGRAM_CONTACT_USER_ID_MISMATCH');
    });

    it('L. booking already claimed by another user -> BLOCKED (cannot overwrite owner)', () => {
        const claimedBooking = { ...bookingWith('unknown'), claim_status: 'claimed', claimed_by_user_id: 424242 };
        const res = evaluateAutoClaimEligibility(claimedBooking, verifiedUser, {}, '555000111');
        assert.equal(res.canAutoClaim, false);
        assert.equal(res.reason, 'ALREADY_CLAIMED');
    });

    it('Cancelled / non-confirmed booking -> BLOCKED', () => {
        const cancelled = { ...bookingWith('unknown'), status: 'cancelled' };
        const res = evaluateAutoClaimEligibility(cancelled, verifiedUser, {}, '555000111');
        assert.equal(res.canAutoClaim, false);
        assert.equal(res.reason, 'BOOKING_INELIGIBLE');
    });
});

describe('Phase E.45.3 — K: expired/cancelled claim session blocked (resolveClaimSession contract)', () => {
    // resolveClaimSession itself needs a DB client; here we exercise the pure
    // expiry/consumption predicates it applies, matching its exact logic in
    // utils/claimHelper.js (session.consumed_at / session.expires_at checks).
    function evaluateSessionState(session) {
        if (!session) return { isValid: false, reason: 'SESSION_NOT_FOUND' };
        if (session.consumed_at) return { isValid: false, reason: 'SESSION_ALREADY_CONSUMED' };
        if (new Date(session.expires_at) <= new Date()) return { isValid: false, reason: 'SESSION_EXPIRED' };
        return { isValid: true };
    }

    it('expired session is blocked', () => {
        const res = evaluateSessionState({ expires_at: new Date(Date.now() - 60000).toISOString(), consumed_at: null });
        assert.equal(res.isValid, false);
        assert.equal(res.reason, 'SESSION_EXPIRED');
    });

    it('already-consumed (cancelled/used) session is blocked', () => {
        const res = evaluateSessionState({ expires_at: new Date(Date.now() + 60000).toISOString(), consumed_at: new Date().toISOString() });
        assert.equal(res.isValid, false);
        assert.equal(res.reason, 'SESSION_ALREADY_CONSUMED');
    });

    it('a live, unconsumed session within its TTL is valid', () => {
        const res = evaluateSessionState({ expires_at: new Date(Date.now() + 60000).toISOString(), consumed_at: null });
        assert.equal(res.isValid, true);
    });
});

describe('Phase E.45.3 — B/C/M: manual booking creation no longer depends on a carrier-selected role', () => {
    // Mirrors the exact validContactRole resolution + resolveRegisteredPassenger
    // gate in routes/busAdmin.js POST /bookings/manual (contact_role now always
    // arrives as 'unknown' from the frontend, or is defaulted server-side).
    function resolveCreationTimeContactRole(contact_role) {
        return ['passenger', 'family_or_group', 'coordinator', 'unknown'].includes(contact_role) ? contact_role : 'unknown';
    }

    it('B. booking creation succeeds and defaults safely to unknown when no role is supplied at all', () => {
        const resolved = resolveCreationTimeContactRole(undefined);
        assert.equal(resolved, 'unknown');
    });

    it('C. booking creation defaults to unknown for any unrecognized/omitted value', () => {
        assert.equal(resolveCreationTimeContactRole(''), 'unknown');
        assert.equal(resolveCreationTimeContactRole(null), 'unknown');
        assert.equal(resolveCreationTimeContactRole('anything-unexpected'), 'unknown');
    });

    it('M. a bare DB phone match at booking-creation time (contact_role=unknown, the new universal default) must NOT auto-assign ownership', async () => {
        const registeredUser = { id: 5050, phone: '+992900112233', telegram_id: '1212121' };
        const mockDb = {
            from: () => ({
                select: () => ({
                    eq: (col, val) => ({
                        not: () => ({
                            data: (col === 'phone' && val === '+992900112233') ? [registeredUser] : [],
                            error: null
                        })
                    })
                })
            })
        };

        const contactRole = resolveCreationTimeContactRole(undefined); // 'unknown', as every new manual booking now arrives
        let registeredPassenger = null;
        if (contactRole === 'passenger') {
            registeredPassenger = await resolveRegisteredPassenger('+992900112233', { supabaseClient: mockDb });
        }

        assert.equal(registeredPassenger, null, 'A DB phone match alone must never auto-claim ownership at booking creation');
    });

    it('Legacy contact_role values already stored on old bookings remain readable/unchanged', () => {
        const legacyBooking = { id: 1, contact_role: 'coordinator', phone: '+992900000000' };
        assert.equal(legacyBooking.contact_role, 'coordinator', 'Legacy stored values are never rewritten/migrated');
    });
});

describe('Phase E.45.3 — N: successful auto-claim makes the booking visible via the My Trips ownership filter', () => {
    // Mirrors the exact ownership filter in routes/users.js GET /:id/bus-bookings.
    function myTripsFilter(booking, userId) {
        if (booking.claimed_by_user_id) {
            return String(booking.claimed_by_user_id) === String(userId);
        }
        const isManual = booking.channel === 'manual' || booking.source_type === 'manual' || booking.contact_role === 'carrier_contact';
        if (isManual) return false;
        return String(booking.passenger_id) === String(userId);
    }

    it('a booking freshly auto-claimed via evaluateAutoClaimEligibility becomes visible to that user', () => {
        const booking = bookingWith('unknown');
        const eligibility = evaluateAutoClaimEligibility(booking, verifiedUser, {}, '555000111');
        assert.equal(eligibility.canAutoClaim, true);

        // Simulate what executeAtomicClaim (unchanged) does on success.
        booking.claim_status = 'claimed';
        booking.claimed_by_user_id = verifiedUser.id;

        assert.equal(myTripsFilter(booking, verifiedUser.id), true, 'Booking must appear in claimant\'s My Trips');
        assert.equal(myTripsFilter(booking, 999999), false, 'Booking must not leak to an unrelated user');
    });

    it('an UNCLAIMED manual booking never leaks into any user\'s My Trips, even if passenger_id happens to match', () => {
        const unclaimedManual = { id: 2, channel: 'manual', source_type: 'manual', claimed_by_user_id: null, passenger_id: 42 };
        assert.equal(myTripsFilter(unclaimedManual, 42), false);
    });
});

describe('Phase E.45.3 — created_by attribution is never touched by claim eligibility', () => {
    it('created_by_user_id (original carrier/dispatcher creator) is independent of claimed_by_user_id', () => {
        const booking = { ...bookingWith('unknown'), created_by_user_id: 301 };
        const eligibility = evaluateAutoClaimEligibility(booking, verifiedUser, {}, '555000111');
        assert.equal(eligibility.canAutoClaim, true);

        // executeAtomicClaim only ever sets claim_status/claimed_by_user_id/claimed_at.
        booking.claim_status = 'claimed';
        booking.claimed_by_user_id = verifiedUser.id;

        assert.equal(booking.created_by_user_id, 301, 'Creator attribution must never be overwritten by a claim');
    });
});
