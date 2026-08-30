const { describe, it } = require('node:test');
const assert = require('node:assert');

const {
    executeAtomicClaim,
    reviewClaimRequest,
    tripBelongsToCarrier,
    evaluateAutoClaimEligibility
} = require('../utils/claimHelper');

describe('Phase E.2B claim security', () => {
    it('uses fn_claim_booking_auto RPC for production ownership transition', async () => {
        let captured = null;
        const rpcClient = {
            async rpc(name, params) {
                captured = { name, params };
                return { data: { success: true, booking_id: 101 }, error: null };
            }
        };

        const result = await executeAtomicClaim(101, 77, {
            sessionId: '11111111-1111-1111-1111-111111111111',
            rpcClient
        });

        assert.equal(result.success, true);
        assert.equal(captured.name, 'fn_claim_booking_auto');
        assert.deepEqual(captured.params, {
            p_booking_id: 101,
            p_user_id: 77,
            p_session_id: '11111111-1111-1111-1111-111111111111'
        });
    });

    it('propagates an atomic RPC business rejection without claiming', async () => {
        const rpcClient = {
            async rpc() {
                return {
                    data: { success: false, error: 'SESSION_INVALID_EXPIRED_OR_CONSUMED' },
                    error: null
                };
            }
        };

        const result = await executeAtomicClaim(101, 77, { rpcClient });
        assert.equal(result.success, false);
        assert.equal(result.error, 'SESSION_INVALID_EXPIRED_OR_CONSUMED');
    });

    it('does not expose legacy carrier_id=NULL trips to another carrier', () => {
        assert.equal(
            tripBelongsToCarrier({ carrier_id: null, created_by_user_id: 11 }, 22),
            false
        );
        assert.equal(
            tripBelongsToCarrier({ carrier_id: null, created_by_user_id: 11 }, 11),
            true
        );
    });

    it('uses explicit carrier_id when it exists', () => {
        assert.equal(
            tripBelongsToCarrier({ carrier_id: 11, created_by_user_id: 22 }, 11),
            true
        );
        assert.equal(
            tripBelongsToCarrier({ carrier_id: 11, created_by_user_id: 22 }, 22),
            false
        );
    });

    it('requires a native Telegram contact from the same sender for auto-claim', () => {
        const booking = {
            status: 'confirmed',
            claim_status: 'unclaimed',
            claimed_by_user_id: null,
            contact_role: 'passenger',
            phone: '+992900112233'
        };
        const user = { id: 77, telegram_id: 555, phone: '+992900112233' };

        const forged = evaluateAutoClaimEligibility(
            booking,
            user,
            { phone_number: '+992900112233', user_id: 999 },
            555
        );
        assert.equal(forged.canAutoClaim, false);
        assert.equal(forged.reason, 'TELEGRAM_CONTACT_USER_ID_MISMATCH');

        const valid = evaluateAutoClaimEligibility(
            booking,
            user,
            { phone_number: '+992900112233', user_id: 555 },
            555
        );
        assert.equal(valid.canAutoClaim, true);
    });

    it('carrier review uses strict tenant check before RPC', async () => {
        let rpcCalled = false;
        const fakeDb = {
            rpc: async () => {
                rpcCalled = true;
                return { data: { success: true, status: 'approved' }, error: null };
            },
            from(table) {
                assert.equal(table, 'booking_claim_requests');
                return {
                    select() {
                        return {
                            eq() {
                                return {
                                    single: async () => ({
                                        data: {
                                            id: 'req-1',
                                            booking_id: 101,
                                            requesting_user_id: 77,
                                            status: 'pending',
                                            bus_ticket_bookings: {
                                                bus_tickets: {
                                                    carrier_id: null,
                                                    created_by_user_id: 11
                                                }
                                            }
                                        },
                                        error: null
                                    })
                                };
                            }
                        };
                    }
                };
            }
        };

        const result = await reviewClaimRequest('req-1', 22, 'approved', {
            supabaseClient: fakeDb,
            reviewerUserId: 222
        });

        assert.equal(result.success, false);
        assert.equal(result.error, 'TENANT_UNAUTHORIZED');
        assert.equal(rpcCalled, false);
    });
});
