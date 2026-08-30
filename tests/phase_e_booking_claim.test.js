/**
 * phase_e_booking_claim.test.js
 * 
 * POPUTKI.ONLINE — Manual Booking Passenger Activation V1
 * Phase E.2A.1 Comprehensive Test Suite: Atomicity, Invariants & Audit Retention
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const {
    CLAIM_SESSION_TTL_MS,
    hashSessionToken,
    generateClaimSession,
    resolveClaimSession,
    evaluateAutoClaimEligibility,
    executeAtomicClaim,
    createClaimRequest,
    reviewClaimRequest
} = require('../utils/claimHelper');
const { buildPassengerTicketProjection } = require('../utils/ticketHelper');

// Mock DB with predicate support, hash lookups, and audit preservation
function createMockDb() {
    const sessions = new Map(); // keyed by session_token_hash
    const bookings = new Map();
    const requests = new Map();

    return {
        _sessions: sessions,
        _bookings: bookings,
        _requests: requests,
        from(table) {
            if (table === 'booking_claim_sessions') {
                return {
                    insert(rows) {
                        const r = Array.isArray(rows) ? rows[0] : rows;
                        const id = r.id || 'sess-' + Math.random().toString(36).substring(2, 9);
                        const record = { ...r, id };
                        sessions.set(record.session_token_hash, record);
                        return {
                            select() {
                                return {
                                    single: async () => ({ data: record, error: null })
                                };
                            }
                        };
                    },
                    select() {
                        return {
                            eq(col, val) {
                                return {
                                    single: async () => {
                                        const rec = sessions.get(val);
                                        return { data: rec || null, error: rec ? null : { message: 'Not found' } };
                                    }
                                };
                            }
                        };
                    },
                    update(updates) {
                        return {
                            eq(col, val) {
                                for (const [hashKey, rec] of sessions.entries()) {
                                    if (rec[col] === val || rec.id === val) {
                                        sessions.set(hashKey, { ...rec, ...updates });
                                    }
                                }
                                return Promise.resolve({ error: null });
                            }
                        };
                    }
                };
            }
            if (table === 'bus_ticket_bookings') {
                return {
                    select() {
                        return {
                            eq(col, val) {
                                return {
                                    single: async () => {
                                        const rec = bookings.get(val);
                                        return { data: rec || null, error: rec ? null : { message: 'Not found' } };
                                    }
                                };
                            }
                        };
                    },
                    update(updates) {
                        const filters = [];
                        let isNullCheck = null;
                        const queryObj = {
                            eq(col, val) {
                                filters.push({ type: 'eq', col, val });
                                return queryObj;
                            },
                            neq(col, val) {
                                filters.push({ type: 'neq', col, val });
                                return queryObj;
                            },
                            is(col, val) {
                                isNullCheck = { col, val };
                                return queryObj;
                            },
                            select() {
                                return {
                                    single: async () => {
                                        let matchedId = null;
                                        for (const [id, rec] of bookings.entries()) {
                                            const matchEq = filters.every(f => {
                                                if (f.type === 'eq') return rec[f.col] === f.val;
                                                if (f.type === 'neq') return rec[f.col] !== f.val;
                                                return true;
                                            });
                                            const matchNull = isNullCheck ? (isNullCheck.val === null ? rec[isNullCheck.col] == null : rec[isNullCheck.col] === isNullCheck.val) : true;
                                            if (matchEq && matchNull) {
                                                matchedId = id;
                                                break;
                                            }
                                        }
                                        if (matchedId == null) {
                                            return { data: null, error: { message: 'Condition failed' } };
                                        }
                                        const current = bookings.get(matchedId);
                                        const updated = { ...current, ...updates };
                                        bookings.set(matchedId, updated);
                                        return { data: updated, error: null };
                                    }
                                };
                            },
                            then(resolve) {
                                for (const [id, rec] of bookings.entries()) {
                                    const matchEq = filters.every(f => {
                                        if (f.type === 'eq') return rec[f.col] === f.val;
                                        if (f.type === 'neq') return rec[f.col] !== f.val;
                                        return true;
                                    });
                                    if (matchEq) {
                                        bookings.set(id, { ...rec, ...updates });
                                    }
                                }
                                resolve({ error: null });
                            }
                        };
                        return queryObj;
                    }
                };
            }
            if (table === 'booking_claim_requests') {
                return {
                    insert(rows) {
                        const r = Array.isArray(rows) ? rows[0] : rows;
                        const id = r.id || 'req-' + Math.random().toString(36).substring(2, 9);
                        const record = { ...r, id };
                        requests.set(id, record);
                        return {
                            select() {
                                return {
                                    single: async () => ({ data: record, error: null })
                                };
                            }
                        };
                    },
                    select() {
                        const filters = [];
                        const queryObj = {
                            eq(col, val) {
                                filters.push({ col, val });
                                return queryObj;
                            },
                            limit() {
                                return queryObj;
                            },
                            maybeSingle: async () => {
                                for (const rec of requests.values()) {
                                    const match = filters.every(f => rec[f.col] === f.val);
                                    if (match) return { data: rec, error: null };
                                }
                                return { data: null, error: null };
                            },
                            single: async () => {
                                for (const rec of requests.values()) {
                                    const match = filters.every(f => rec[f.col] === f.val);
                                    if (match) {
                                        const b = bookings.get(rec.booking_id);
                                        const joined = {
                                            ...rec,
                                            bus_ticket_bookings: {
                                                ...b,
                                                bus_tickets: {
                                                    id: b ? b.bus_ticket_id : 50,
                                                    carrier_id: 11,
                                                    created_by_user_id: 11
                                                }
                                            }
                                        };
                                        return { data: joined, error: null };
                                    }
                                }
                                return { data: null, error: { message: 'Not found' } };
                            },
                            then(resolve) {
                                const list = [];
                                for (const rec of requests.values()) {
                                    const match = filters.every(f => rec[f.col] === f.val);
                                    if (match) list.push(rec);
                                }
                                resolve({ data: list, error: null });
                            }
                        };
                        return queryObj;
                    },
                    update(updates) {
                        const filters = [];
                        let notEqFilter = null;
                        const updateObj = {
                            eq(col, val) {
                                filters.push({ col, val });
                                return updateObj;
                            },
                            neq(col, val) {
                                notEqFilter = { col, val };
                                return updateObj;
                            },
                            then(resolve) {
                                for (const rec of requests.values()) {
                                    const matchEq = filters.every(f => rec[f.col] === f.val);
                                    const matchNeq = notEqFilter ? rec[notEqFilter.col] !== notEqFilter.val : true;
                                    if (matchEq && matchNeq) {
                                        requests.set(rec.id, { ...rec, ...updates });
                                    }
                                }
                                resolve({ error: null });
                            }
                        };
                        return updateObj;
                    }
                };
            }
            throw new Error('Unknown table: ' + table);
        }
    };
}

describe('MANUAL BOOKING PASSENGER ACTIVATION V1 — PHASE E.2A.1 ATOMICITY SUITE', () => {
    let mockDb;

    beforeEach(() => {
        mockDb = createMockDb();
        mockDb._bookings.set(100, {
            id: 100,
            bus_ticket_id: 50,
            status: 'confirmed',
            contact_role: 'passenger',
            phone: '+992900112233',
            passenger_name: 'Zarif Verified Passenger',
            claim_status: 'unclaimed',
            claimed_by_user_id: null,
            channel: 'manual',
            source_type: 'manual',
            created_by_user_id: 11
        });
    });

    describe('1. Confirmed Status & Claimed By User ID Invariants', () => {
        it('1. claims confirmed booking setting claimed_by_user_id and status claimed', async () => {
            const claimResult = await executeAtomicClaim(100, 77, { supabaseClient: mockDb });
            assert.equal(claimResult.success, true);
            assert.equal(mockDb._bookings.get(100).claim_status, 'claimed');
            assert.equal(mockDb._bookings.get(100).claimed_by_user_id, 77);
            assert.equal(mockDb._bookings.get(100).created_by_user_id, 11);
        });

        it('2. claim vs cancel race: cancelled booking affects zero rows and returns BOOKING_INELIGIBLE_OR_ALREADY_CLAIMED', async () => {
            mockDb._bookings.get(100).status = 'cancelled';
            const claimResult = await executeAtomicClaim(100, 77, { supabaseClient: mockDb });
            assert.equal(claimResult.success, false);
            assert.equal(claimResult.error, 'BOOKING_INELIGIBLE_OR_ALREADY_CLAIMED');
            assert.equal(mockDb._bookings.get(100).claimed_by_user_id, null);
        });

        it('3. approval vs cancel race: carrier approval on cancelled booking fails safely', async () => {
            const reqRes = await createClaimRequest(100, 99, { method: 'telegram_contact' }, { supabaseClient: mockDb });
            // Carrier cancels booking right before dispatcher approves
            mockDb._bookings.get(100).status = 'cancelled';
            const reviewRes = await reviewClaimRequest(reqRes.requestId, 11, 'approved', { enforceTenant: false, supabaseClient: mockDb });
            assert.equal(reviewRes.success, false);
            assert.equal(reviewRes.error, 'BOOKING_INELIGIBLE_OR_ALREADY_CLAIMED');
            assert.equal(mockDb._requests.get(reqRes.requestId).status, 'superseded');
            assert.equal(mockDb._bookings.get(100).claimed_by_user_id, null);
        });

        it('4. ownership overwrite protection: second claim cannot overwrite existing claimed_by_user_id', async () => {
            const first = await executeAtomicClaim(100, 77, { supabaseClient: mockDb });
            assert.equal(first.success, true);
            const second = await executeAtomicClaim(100, 88, { supabaseClient: mockDb });
            assert.equal(second.success, false);
            assert.equal(second.error, 'BOOKING_INELIGIBLE_OR_ALREADY_CLAIMED');
            assert.equal(mockDb._bookings.get(100).claimed_by_user_id, 77);
        });
    });

    describe('2. Competing Requests Superseding & Idempotency', () => {
        it('5. auto-claim supersedes competing pending requests for the same booking', async () => {
            const r1 = await createClaimRequest(100, 88, { reason: 'FAMILY_GROUP' }, { supabaseClient: mockDb });
            const r2 = await createClaimRequest(100, 99, { reason: 'PHONE_MISMATCH' }, { supabaseClient: mockDb });
            assert.equal(mockDb._requests.get(r1.requestId).status, 'pending');
            assert.equal(mockDb._requests.get(r2.requestId).status, 'pending');

            // Legitimate passenger auto-claims
            const autoRes = await executeAtomicClaim(100, 77, { supabaseClient: mockDb });
            assert.equal(autoRes.success, true);
            assert.equal(mockDb._requests.get(r1.requestId).status, 'superseded');
            assert.equal(mockDb._requests.get(r2.requestId).status, 'superseded');
        });

        it('6. carrier approval supersedes other competing pending requests', async () => {
            const r1 = await createClaimRequest(100, 88, { reason: 'FAMILY_GROUP' }, { supabaseClient: mockDb });
            const r2 = await createClaimRequest(100, 99, { reason: 'PHONE_MISMATCH' }, { supabaseClient: mockDb });

            // Dispatcher approves r1
            const reviewRes = await reviewClaimRequest(r1.requestId, 11, 'approved', { enforceTenant: false, supabaseClient: mockDb });
            assert.equal(reviewRes.success, true);
            assert.equal(mockDb._requests.get(r1.requestId).status, 'approved');
            assert.equal(mockDb._requests.get(r2.requestId).status, 'superseded');
        });

        it('7. rejected claim request restores booking to unclaimed if no other pending requests remain', async () => {
            const reqRes = await createClaimRequest(100, 99, { method: 'telegram_contact' }, { supabaseClient: mockDb });
            assert.equal(mockDb._bookings.get(100).claim_status, 'pending_verification');

            const reviewRes = await reviewClaimRequest(reqRes.requestId, 11, 'rejected', { reason: 'CARRIER_REJECTED', enforceTenant: false, supabaseClient: mockDb });
            assert.equal(reviewRes.success, true);
            assert.equal(mockDb._requests.get(reqRes.requestId).status, 'rejected');
            assert.equal(mockDb._bookings.get(100).claim_status, 'unclaimed');
        });

        it('8. rejected request allows same claimant to retry later without unique deadlock', async () => {
            const r1 = await createClaimRequest(100, 99, { method: 'telegram_contact' }, { supabaseClient: mockDb });
            await reviewClaimRequest(r1.requestId, 11, 'rejected', { reason: 'DOC_MISMATCH', enforceTenant: false, supabaseClient: mockDb });
            assert.equal(mockDb._requests.get(r1.requestId).status, 'rejected');

            // Claimant submits fresh request
            const r2 = await createClaimRequest(100, 99, { method: 'telegram_contact', reason: 'UPDATED_DOCS' }, { supabaseClient: mockDb });
            assert.equal(r2.success, true);
            assert.equal(r2.isExisting, false);
            assert.notEqual(r1.requestId, r2.requestId);
            assert.equal(mockDb._requests.get(r2.requestId).status, 'pending');
        });
    });

    describe('3. Session Consumption Timing & Audit Retention', () => {
        it('9. session is NOT consumed if atomic claim fails due to cancellation', async () => {
            const session = await generateClaimSession(100, { supabaseClient: mockDb });
            const hash = hashSessionToken(session.sessionToken);
            mockDb._bookings.get(100).status = 'cancelled';

            const claimRes = await executeAtomicClaim(100, 77, {
                sessionId: mockDb._sessions.get(hash).id,
                supabaseClient: mockDb
            });
            assert.equal(claimRes.success, false);
            assert.equal(mockDb._sessions.get(hash).consumed_at, null); // Session remains unconsumed on failure!
        });

        it('10. session is consumed on successful auto claim', async () => {
            const session = await generateClaimSession(100, { supabaseClient: mockDb });
            const hash = hashSessionToken(session.sessionToken);
            const sessId = mockDb._sessions.get(hash).id;

            const claimRes = await executeAtomicClaim(100, 77, {
                sessionId: sessId,
                supabaseClient: mockDb
            });
            assert.equal(claimRes.success, true);
            assert.ok(mockDb._sessions.get(hash).consumed_at);
        });

        it('11. session is consumed on successful pending request creation', async () => {
            const session = await generateClaimSession(100, { supabaseClient: mockDb });
            const hash = hashSessionToken(session.sessionToken);
            const sessId = mockDb._sessions.get(hash).id;

            const reqRes = await createClaimRequest(100, 99, { reason: 'PHONE_MISMATCH' }, {
                sessionId: sessId,
                supabaseClient: mockDb
            });
            assert.equal(reqRes.success, true);
            assert.ok(mockDb._sessions.get(hash).consumed_at);
        });

        it('12. claim request preserves audit trail if requesting user or reviewer is later deleted', async () => {
            const reqRes = await createClaimRequest(100, 99, { method: 'telegram_contact' }, { supabaseClient: mockDb });
            await reviewClaimRequest(reqRes.requestId, 11, 'approved', { enforceTenant: false, supabaseClient: mockDb });

            // Simulate user account deletion in PostgreSQL (ON DELETE SET NULL)
            mockDb._requests.get(reqRes.requestId).requesting_user_id = null;
            mockDb._requests.get(reqRes.requestId).reviewed_by_user_id = null;

            assert.equal(mockDb._requests.get(reqRes.requestId).status, 'approved');
            assert.equal(mockDb._requests.get(reqRes.requestId).requesting_user_id, null);
            assert.equal(mockDb._requests.get(reqRes.requestId).reviewed_by_user_id, null);
        });
    });
});
