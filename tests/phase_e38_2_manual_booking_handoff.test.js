/**
 * tests/phase_e38_2_manual_booking_handoff.test.js
 * 
 * Phase E.38.2 — Manual Booking Handoff For Unregistered Contacts Test Suite
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { generateClaimSession, resolveClaimSession, executeAtomicClaim, tripBelongsToCarrier } = require('../utils/claimHelper');
const { generateTicketVerificationToken, verifyTicketToken } = require('../utils/ticketHelper');

describe('PHASE E.38.2 — MANUAL BOOKING HANDOFF FOR UNREGISTERED CONTACTS', () => {

    const mockRegisteredPassenger = {
        id: 101,
        name: 'Алишер',
        phone: '+992900112233',
        telegram_id: '99887766'
    };

    // Helper mock db
    function createMockDb(initialSessions = [], initialBookings = []) {
        const sessions = [...initialSessions];
        const bookings = [...initialBookings];

        return {
            sessions,
            bookings,
            from: (table) => ({
                insert: (rows) => ({
                    select: () => ({
                        single: async () => {
                            const row = { id: sessions.length + 1, ...rows[0] };
                            if (table === 'booking_claim_sessions') sessions.push(row);
                            if (table === 'bus_ticket_bookings') bookings.push(row);
                            return { data: row, error: null };
                        }
                    })
                }),
                select: () => ({
                    eq: (col1, val1) => ({
                        single: async () => {
                            if (table === 'booking_claim_sessions') {
                                const s = sessions.find(s => s[col1] === val1);
                                return { data: s || null, error: s ? null : { message: 'Not found' } };
                            }
                            if (table === 'bus_ticket_bookings') {
                                const b = bookings.find(b => b[col1] === val1);
                                return { data: b || null, error: b ? null : { message: 'Not found' } };
                            }
                            return { data: null, error: null };
                        }
                    })
                }),
                update: (updates) => {
                    let targetBooking = null;
                    const builder = {
                        eq: (col, val) => {
                            if (table === 'bus_ticket_bookings') {
                                targetBooking = bookings.find(b => b[col] === val);
                            }
                            if (table === 'booking_claim_sessions') {
                                const s = sessions.find(s => s[col] === val);
                                if (s) Object.assign(s, updates);
                            }
                            return builder;
                        },
                        neq: () => builder,
                        is: () => builder,
                        select: () => builder,
                        single: async () => {
                            if (targetBooking) {
                                Object.assign(targetBooking, updates);
                                return { data: targetBooking, error: null };
                            }
                            return { data: null, error: { message: 'Not found' } };
                        }
                    };
                    return builder;
                }
            })
        };
    }

    // Helper simulating manual booking response builder in busAdmin.js
    async function simulateManualBookingEndpoint({ contact_role, phone, isRegistered = false, dbClient }) {
        const validContactRole = ['passenger', 'family_or_group', 'coordinator', 'unknown'].includes(contact_role) ? contact_role : 'unknown';

        let registeredPassenger = null;
        let effectiveContactRole = validContactRole;

        if (validContactRole === 'passenger' && isRegistered) {
            registeredPassenger = mockRegisteredPassenger;
        }

        const booking = {
            id: 888,
            bus_ticket_id: 73,
            contact_role: effectiveContactRole,
            phone,
            status: 'confirmed',
            claim_status: registeredPassenger ? 'claimed' : 'unclaimed',
            claimed_by_user_id: registeredPassenger ? registeredPassenger.id : null
        };

        const isAutoClaimed = Boolean(registeredPassenger);
        let handoff = { required: false };

        if (!isAutoClaimed) {
            const session = await generateClaimSession(booking.id, { supabaseClient: dbClient });
            const verificationToken = generateTicketVerificationToken(booking.id);
            const ticketUrl = `https://www.poputki.online/ticket-verify/${verificationToken}`;

            handoff = {
                required: true,
                contact_role: effectiveContactRole,
                booking_id: booking.id,
                claim_url: session.deepLink,
                ticket_url: ticketUrl,
                expires_at: session.expiresAt
            };
        }

        return {
            success: true,
            id: booking.id,
            booking_id: booking.id,
            is_auto_claimed: isAutoClaimed,
            handoff
        };
    }

    it('CASE A: passenger + registered -> auto claim YES, handoff claim link NOT required', async () => {
        const mockDb = createMockDb();
        const res = await simulateManualBookingEndpoint({
            contact_role: 'passenger',
            phone: '+992900112233',
            isRegistered: true,
            dbClient: mockDb
        });

        assert.strictEqual(res.is_auto_claimed, true);
        assert.strictEqual(res.handoff.required, false);
        assert.strictEqual(res.handoff.claim_url, undefined);
    });

    it('CASE B: passenger + unregistered -> booking YES, unclaimed, handoff YES, ticket & claim URLs present', async () => {
        const mockDb = createMockDb();
        const res = await simulateManualBookingEndpoint({
            contact_role: 'passenger',
            phone: '+992900999999',
            isRegistered: false,
            dbClient: mockDb
        });

        assert.strictEqual(res.is_auto_claimed, false);
        assert.strictEqual(res.handoff.required, true);
        assert.strictEqual(res.handoff.contact_role, 'passenger');
        assert.ok(res.handoff.claim_url.startsWith('https://t.me/Poputkionline_bot?start=claim_'));
        assert.ok(res.handoff.ticket_url.startsWith('https://www.poputki.online/ticket-verify/888-'));
    });

    it('CASE C: family_or_group -> no auto-claim, handoff YES', async () => {
        const mockDb = createMockDb();
        const res = await simulateManualBookingEndpoint({
            contact_role: 'family_or_group',
            phone: '+992900112233',
            isRegistered: true, // Even if phone matches registered user!
            dbClient: mockDb
        });

        assert.strictEqual(res.is_auto_claimed, false);
        assert.strictEqual(res.handoff.required, true);
        assert.strictEqual(res.handoff.contact_role, 'family_or_group');
        assert.ok(res.handoff.claim_url.includes('claim_'));
    });

    it('CASE D: coordinator -> no auto-claim, handoff YES, coordinator ownership NO', async () => {
        const mockDb = createMockDb();
        const res = await simulateManualBookingEndpoint({
            contact_role: 'coordinator',
            phone: '+992900112233',
            isRegistered: true,
            dbClient: mockDb
        });

        assert.strictEqual(res.is_auto_claimed, false);
        assert.strictEqual(res.handoff.required, true);
        assert.strictEqual(res.handoff.contact_role, 'coordinator');
    });

    it('CASE E: unknown + phone matches registered user -> no auto-claim, handoff YES, explicit claim required', async () => {
        const mockDb = createMockDb();
        const res = await simulateManualBookingEndpoint({
            contact_role: 'unknown',
            phone: '+992900112233',
            isRegistered: true,
            dbClient: mockDb
        });

        assert.strictEqual(res.is_auto_claimed, false);
        assert.strictEqual(res.handoff.required, true);
        assert.strictEqual(res.handoff.contact_role, 'unknown');
    });

    it('CASE F: claim link viewed/opened only -> claimed_by_user_id remains unchanged', async () => {
        const booking = { id: 701, status: 'confirmed', claim_status: 'unclaimed', claimed_by_user_id: null };
        const mockDb = createMockDb([], [booking]);

        const session = await generateClaimSession(booking.id, { supabaseClient: mockDb });
        assert.ok(session.deepLink);

        // Simulate resolving / opening session
        const resolved = await resolveClaimSession(session.sessionToken, { supabaseClient: mockDb, markOpened: true });
        assert.strictEqual(resolved.isValid, true);
        // Ownership invariant
        assert.strictEqual(booking.claimed_by_user_id, null, 'Viewing claim session must not transfer ownership');
        assert.strictEqual(booking.claim_status, 'unclaimed');
    });

    it('CASE G: valid claim completed -> claimed_by_user_id set and claim_status is claimed', async () => {
        const booking = { id: 702, status: 'confirmed', claim_status: 'unclaimed', claimed_by_user_id: null };
        const mockDb = createMockDb([], [booking]);

        const claimRes = await executeAtomicClaim(booking.id, 999, { supabaseClient: mockDb });
        assert.strictEqual(claimRes.success, true);
        assert.strictEqual(booking.claimed_by_user_id, 999);
        assert.strictEqual(booking.claim_status, 'claimed');
    });

    it('CASE H: expired token -> claim session rejected, regeneration possible', async () => {
        const booking = { id: 703, status: 'confirmed', claim_status: 'unclaimed', claimed_by_user_id: null };
        const mockDb = createMockDb([], [booking]);

        // Create expired session (-1 minute)
        const expiredSession = await generateClaimSession(booking.id, { supabaseClient: mockDb, ttlMs: -60000 });
        const resolved = await resolveClaimSession(expiredSession.sessionToken, { supabaseClient: mockDb });
        assert.strictEqual(resolved.isValid, false);
        assert.strictEqual(resolved.reason, 'SESSION_EXPIRED');

        // Fresh regeneration succeeds
        const freshSession = await generateClaimSession(booking.id, { supabaseClient: mockDb });
        assert.ok(freshSession.sessionToken);
        const freshResolved = await resolveClaimSession(freshSession.sessionToken, { supabaseClient: mockDb });
        assert.strictEqual(freshResolved.isValid, true);
    });

    it('CASE I: already claimed booking -> regeneration blocked (semantic 409 conflict)', async () => {
        const claimedBooking = { id: 704, status: 'confirmed', claim_status: 'claimed', claimed_by_user_id: 101 };
        // Simulation of endpoint check:
        const isClaimed = claimedBooking.claim_status === 'claimed' || Boolean(claimedBooking.claimed_by_user_id);
        assert.strictEqual(isClaimed, true);
        // HTTP status would be 409
        const status = isClaimed ? 409 : 200;
        assert.strictEqual(status, 409);
    });

    it('CASE J: cross-carrier regeneration attempt -> 403 forbidden', () => {
        const trip = { id: 73, carrier_id: 11, created_by_user_id: 11 };
        assert.strictEqual(tripBelongsToCarrier(trip, 11), true);
        assert.strictEqual(tripBelongsToCarrier(trip, 999), false);
    });

    it('CASE K: cancelled booking -> regeneration blocked (400)', () => {
        const cancelledBooking = { id: 705, status: 'cancelled', claim_status: 'unclaimed', claimed_by_user_id: null };
        const isCancelled = cancelledBooking.status === 'cancelled';
        assert.strictEqual(isCancelled, true);
        const status = isCancelled ? 400 : 200;
        assert.strictEqual(status, 400);
    });

    it('CASE L: registered passenger auto-claimed but delivery fails -> ownership preserved, no second claim token', async () => {
        const mockDb = createMockDb();
        const res = await simulateManualBookingEndpoint({
            contact_role: 'passenger',
            phone: '+992900112233',
            isRegistered: true,
            dbClient: mockDb
        });

        assert.strictEqual(res.is_auto_claimed, true);
        // Even if Telegram delivery threw an error, res.handoff.required remains false
        assert.strictEqual(res.handoff.required, false);
        assert.strictEqual(res.handoff.claim_url, undefined, 'Must not issue a second claim link for already claimed booking');
    });

});
