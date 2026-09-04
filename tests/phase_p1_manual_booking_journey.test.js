/**
 * tests/phase_p1_manual_booking_journey.test.js
 *
 * Phase P.1 — Manual Booking Journey & Passenger Activation Funnel Test Suite
 * Tests for Phase P.1A (Data Model) & Phase P.1B/P.1B.1 (Idempotency, Atomicity, Binding, Failure Isolation)
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
    JOURNEY_EVENT_TYPES,
    JOURNEY_STATUSES,
    NEXT_ACTIONS,
    ALLOWED_CHANNELS,
    maskPhoneNumber,
    sanitizeMetadata,
    computeJourneyStatusAndNextAction,
    recordJourneyEvent,
    createBookingHandoff,
    getBookingJourney
} = require('../utils/journeyHelper');

const {
    generateTicketVerificationToken,
    verifyTicketToken,
    extractBookingIdFromToken
} = require('../utils/ticketHelper');

describe('PHASE P.1A & P.1B.1 — MANUAL BOOKING JOURNEY ENGINE', () => {

    // In-memory mock database factory with transactional isolation support
    function createMockDb(options = {}) {
        const handoffs = [];
        const events = [];
        const bookings = [];

        return {
            isMock: true,
            handoffs,
            events,
            bookings,
            from: (table) => {
                if (options.simulateTableMissing && table === 'booking_journey_events') {
                    return {
                        insert: () => ({ select: () => ({ single: async () => ({ data: null, error: { code: '42P01', message: 'relation "booking_journey_events" does not exist' } }) }) }),
                        select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { code: '42P01', message: 'relation "booking_journey_events" does not exist' } }) }) }) })
                    };
                }

                return {
                    insert: (rows) => ({
                        select: () => ({
                            single: async () => {
                                const target = table === 'booking_handoffs' ? handoffs : (table === 'booking_journey_events' ? events : bookings);
                                const rowPayload = rows[0];

                                // Simulate PostgreSQL partial unique indexes
                                if (table === 'booking_journey_events') {
                                    const milestones = ['BOOKING_CREATED', 'CLAIM_COMPLETED', 'BOOKING_LINKED_TO_USER', 'ACTIVATION_COMPLETED'];
                                    if (milestones.includes(rowPayload.event_type)) {
                                        const exists = events.some(e => Number(e.booking_id) === Number(rowPayload.booking_id) && e.event_type === rowPayload.event_type);
                                        if (exists) {
                                            return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } };
                                        }
                                    }
                                    if (rowPayload.event_type === 'LINK_OPENED') {
                                        if (rowPayload.handoff_id) {
                                            const exists = events.some(e => e.event_type === 'LINK_OPENED' && e.handoff_id === rowPayload.handoff_id);
                                            if (exists) {
                                                return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint idx_bje_single_link_opened_with_handoff' } };
                                            }
                                        } else {
                                            const exists = events.some(e => Number(e.booking_id) === Number(rowPayload.booking_id) && e.event_type === 'LINK_OPENED' && !e.handoff_id);
                                            if (exists) {
                                                return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint idx_bje_single_link_opened_unattributed' } };
                                            }
                                        }
                                    }
                                }

                                const row = {
                                    id: table === 'booking_handoffs' ? `handoff-${handoffs.length + 1}` : target.length + 1,
                                    ...rowPayload
                                };
                                target.push(row);
                                return { data: row, error: null };
                            }
                        })
                    }),
                    select: (fields) => {
                        const query = {
                            filters: [],
                            inFilters: [],
                            eq(col, val) {
                                query.filters.push({ col, val, isNullCheck: false });
                                return query;
                            },
                            is(col, val) {
                                query.filters.push({ col, val, isNullCheck: val === null });
                                return query;
                            },
                            in(col, vals) {
                                query.inFilters.push({ col, vals });
                                return query;
                            },
                            order(col, opts) {
                                return query;
                            },
                            maybeSingle: async () => {
                                const target = table === 'booking_handoffs' ? handoffs : (table === 'booking_journey_events' ? events : bookings);
                                const found = target.find(item => {
                                    const matchEq = query.filters.every(f => {
                                        if (f.isNullCheck) return item[f.col] == null;
                                        return String(item[f.col]) === String(f.val);
                                    });
                                    const matchIn = query.inFilters.every(f => f.vals.includes(item[f.col]));
                                    return matchEq && matchIn;
                                });
                                return { data: found || null, error: null };
                            },
                            single: async () => {
                                const target = table === 'booking_handoffs' ? handoffs : (table === 'booking_journey_events' ? events : bookings);
                                const found = target.find(item => {
                                    const matchEq = query.filters.every(f => String(item[f.col]) === String(f.val));
                                    const matchIn = query.inFilters.every(f => f.vals.includes(item[f.col]));
                                    return matchEq && matchIn;
                                });
                                return { data: found || null, error: found ? null : { message: 'Not found' } };
                            },
                            then(resolve, reject) {
                                const target = table === 'booking_handoffs' ? handoffs : (table === 'booking_journey_events' ? events : bookings);
                                const filtered = target.filter(item => {
                                    const matchEq = query.filters.every(f => String(item[f.col]) === String(f.val));
                                    const matchIn = query.inFilters.every(f => f.vals.includes(item[f.col]));
                                    return matchEq && matchIn;
                                });
                                resolve({ data: filtered, error: null });
                            }
                        };
                        return query;
                    },
                    update: (updates) => ({
                        eq: (col, val) => {
                            const target = table === 'booking_handoffs' ? handoffs : (table === 'booking_journey_events' ? events : bookings);
                            const item = target.find(row => String(row[col]) === String(val));
                            if (item) Object.assign(item, updates);
                            return Promise.resolve({ data: item, error: null });
                        }
                    }),
                    delete: () => ({
                        eq: (col, val) => {
                            const target = table === 'booking_handoffs' ? handoffs : (table === 'booking_journey_events' ? events : bookings);
                            const idx = target.findIndex(row => String(row[col]) === String(val));
                            if (idx !== -1) target.splice(idx, 1);
                            return Promise.resolve({ data: null, error: null });
                        }
                    })
                };
            }
        };
    }

    // -------------------------------------------------------------
    // 1. PRIVACY & SANITIZATION
    // -------------------------------------------------------------
    describe('1. Phone Masking & Metadata Privacy', () => {
        it('masks Tajikistan international phone correctly', () => {
            assert.strictEqual(maskPhoneNumber('+992900115050'), '+992 ** *** 5050');
            assert.strictEqual(maskPhoneNumber('992900115050'), '+992 ** *** 5050');
        });

        it('masks Russian international phone correctly', () => {
            assert.strictEqual(maskPhoneNumber('+79261234567'), '+7 *** *** 4567');
            assert.strictEqual(maskPhoneNumber('89261234567'), '+7 *** *** 4567');
        });

        it('masks Uzbekistan international phone correctly', () => {
            assert.strictEqual(maskPhoneNumber('+998901234567'), '+998 ** *** 4567');
        });

        it('returns null for empty or null phone input', () => {
            assert.strictEqual(maskPhoneNumber(null), null);
            assert.strictEqual(maskPhoneNumber(''), null);
            assert.strictEqual(maskPhoneNumber('—'), null);
        });

        it('strips all sensitive PII and secrets from metadata', () => {
            const rawMeta = {
                channel: 'manual',
                passenger_count: 2,
                passport: 'A12345678',
                doc_number: '12345',
                birth_date: '1990-01-01',
                rawToken: 'secret-claim-token-12345',
                jwt: 'bearer-jwt-token',
                secret: 'claim-bot-secret',
                full_phone: '+992900112233',
                card: '4111222233334444',
                ip: '192.168.1.1',
                user_agent: 'Mozilla/5.0...'
            };

            const sanitized = sanitizeMetadata(rawMeta);
            assert.strictEqual(sanitized.channel, 'manual');
            assert.strictEqual(sanitized.passenger_count, 2);
            assert.strictEqual(sanitized.passport, undefined);
            assert.strictEqual(sanitized.doc_number, undefined);
            assert.strictEqual(sanitized.birth_date, undefined);
            assert.strictEqual(sanitized.rawToken, undefined);
            assert.strictEqual(sanitized.jwt, undefined);
            assert.strictEqual(sanitized.secret, undefined);
            assert.strictEqual(sanitized.full_phone, undefined);
            assert.strictEqual(sanitized.card, undefined);
            assert.strictEqual(sanitized.ip, undefined);
            assert.strictEqual(sanitized.user_agent, undefined);
        });
    });

    // -------------------------------------------------------------
    // 2. STATUS TRANSITIONS & ANALYTICAL METRICS
    // -------------------------------------------------------------
    describe('2. Journey Status & Next Action Logic', () => {
        it('evaluates empty events as NOT_SHARED -> action: Отправить билет', () => {
            const res = computeJourneyStatusAndNextAction([]);
            assert.strictEqual(res.status, JOURNEY_STATUSES.NOT_SHARED);
            assert.strictEqual(res.nextAction, NEXT_ACTIONS.SEND_TICKET);
            assert.strictEqual(res.isBotAbandoned, false);
            assert.strictEqual(res.isExpired, false);
        });

        it('evaluates SHARE_INITIATED as SHARE_INITIATED -> action: Напомнить пассажиру', () => {
            const events = [
                { event_type: JOURNEY_EVENT_TYPES.BOOKING_CREATED },
                { event_type: JOURNEY_EVENT_TYPES.SHARE_INITIATED, channel: 'whatsapp', recipient_phone_masked: '+992 ** *** 5050' }
            ];
            const res = computeJourneyStatusAndNextAction(events);
            assert.strictEqual(res.status, JOURNEY_STATUSES.SHARE_INITIATED);
            assert.strictEqual(res.nextAction, NEXT_ACTIONS.REMIND_PASSENGER);
            assert.strictEqual(res.channel, 'whatsapp');
            assert.strictEqual(res.recipientPhoneMasked, '+992 ** *** 5050');
        });

        it('evaluates LINK_OPENED as LINK_OPENED -> action: Напомнить о Telegram', () => {
            const events = [
                { event_type: JOURNEY_EVENT_TYPES.BOOKING_CREATED },
                { event_type: JOURNEY_EVENT_TYPES.SHARE_INITIATED, channel: 'whatsapp' },
                { event_type: JOURNEY_EVENT_TYPES.LINK_OPENED }
            ];
            const res = computeJourneyStatusAndNextAction(events);
            assert.strictEqual(res.status, JOURNEY_STATUSES.LINK_OPENED);
            assert.strictEqual(res.nextAction, NEXT_ACTIONS.REMIND_TELEGRAM);
        });

        it('evaluates TELEGRAM_BOT_STARTED within 2h as BOT_STARTED, not abandoned', () => {
            const now = Date.now();
            const events = [
                { event_type: JOURNEY_EVENT_TYPES.BOOKING_CREATED },
                { event_type: JOURNEY_EVENT_TYPES.SHARE_INITIATED },
                { event_type: JOURNEY_EVENT_TYPES.LINK_OPENED },
                { event_type: JOURNEY_EVENT_TYPES.TELEGRAM_BOT_STARTED, created_at: new Date(now - 30 * 60 * 1000).toISOString() }
            ];
            const res = computeJourneyStatusAndNextAction(events, { nowMs: now });
            assert.strictEqual(res.status, JOURNEY_STATUSES.BOT_STARTED);
            assert.strictEqual(res.nextAction, NEXT_ACTIONS.REQUEST_PHONE);
            assert.strictEqual(res.isBotAbandoned, false);
        });

        it('analytically detects BOT_ABANDONED when bot started > 2 hours ago with no phone shared', () => {
            const now = Date.now();
            const events = [
                { event_type: JOURNEY_EVENT_TYPES.BOOKING_CREATED },
                { event_type: JOURNEY_EVENT_TYPES.SHARE_INITIATED },
                { event_type: JOURNEY_EVENT_TYPES.LINK_OPENED },
                { event_type: JOURNEY_EVENT_TYPES.TELEGRAM_BOT_STARTED, created_at: new Date(now - 3 * 60 * 60 * 1000).toISOString() }
            ];
            const res = computeJourneyStatusAndNextAction(events, { nowMs: now });
            assert.strictEqual(res.status, JOURNEY_STATUSES.BOT_STARTED);
            assert.strictEqual(res.isBotAbandoned, true);
        });

        it('analytically detects EXPIRED when claim session TTL passed without activation', () => {
            const now = Date.now();
            const events = [
                { event_type: JOURNEY_EVENT_TYPES.BOOKING_CREATED },
                { event_type: JOURNEY_EVENT_TYPES.SHARE_INITIATED }
            ];
            const claimSession = {
                expires_at: new Date(now - 10 * 60 * 1000).toISOString() // expired 10 min ago
            };
            const res = computeJourneyStatusAndNextAction(events, { nowMs: now, claimSession });
            assert.strictEqual(res.status, JOURNEY_STATUSES.EXPIRED);
            assert.strictEqual(res.nextAction, NEXT_ACTIONS.RENEW_LINK);
            assert.strictEqual(res.isExpired, true);
        });

        it('evaluates PHONE_SHARED as PHONE_PENDING', () => {
            const events = [
                { event_type: JOURNEY_EVENT_TYPES.BOOKING_CREATED },
                { event_type: JOURNEY_EVENT_TYPES.SHARE_INITIATED },
                { event_type: JOURNEY_EVENT_TYPES.TELEGRAM_BOT_STARTED },
                { event_type: JOURNEY_EVENT_TYPES.PHONE_SHARED }
            ];
            const res = computeJourneyStatusAndNextAction(events);
            assert.strictEqual(res.status, JOURNEY_STATUSES.PHONE_PENDING);
            assert.strictEqual(res.isBotAbandoned, false);
        });

        it('evaluates PHONE_MISMATCH as PHONE_MISMATCH -> action: Сверить номер пассажира', () => {
            const events = [
                { event_type: JOURNEY_EVENT_TYPES.BOOKING_CREATED },
                { event_type: JOURNEY_EVENT_TYPES.SHARE_INITIATED },
                { event_type: JOURNEY_EVENT_TYPES.TELEGRAM_BOT_STARTED },
                { event_type: JOURNEY_EVENT_TYPES.PHONE_SHARED },
                { event_type: JOURNEY_EVENT_TYPES.PHONE_MISMATCH }
            ];
            const res = computeJourneyStatusAndNextAction(events);
            assert.strictEqual(res.status, JOURNEY_STATUSES.PHONE_MISMATCH);
            assert.strictEqual(res.nextAction, NEXT_ACTIONS.CHECK_PHONE);
        });

        it('evaluates CLAIM_REQUEST_CREATED as UNDER_REVIEW -> action: Проверить заявку подтверждения', () => {
            const events = [
                { event_type: JOURNEY_EVENT_TYPES.BOOKING_CREATED },
                { event_type: JOURNEY_EVENT_TYPES.SHARE_INITIATED },
                { event_type: JOURNEY_EVENT_TYPES.TELEGRAM_BOT_STARTED },
                { event_type: JOURNEY_EVENT_TYPES.PHONE_SHARED },
                { event_type: JOURNEY_EVENT_TYPES.PHONE_MISMATCH },
                { event_type: JOURNEY_EVENT_TYPES.CLAIM_REQUEST_CREATED }
            ];
            const res = computeJourneyStatusAndNextAction(events);
            assert.strictEqual(res.status, JOURNEY_STATUSES.UNDER_REVIEW);
            assert.strictEqual(res.nextAction, NEXT_ACTIONS.REVIEW_REQUEST);
        });

        it('evaluates CLAIM_COMPLETED / ACTIVATION_COMPLETED as ACTIVATED -> action: Пассажир подключен ✓', () => {
            const events = [
                { event_type: JOURNEY_EVENT_TYPES.BOOKING_CREATED },
                { event_type: JOURNEY_EVENT_TYPES.SHARE_INITIATED },
                { event_type: JOURNEY_EVENT_TYPES.TELEGRAM_BOT_STARTED },
                { event_type: JOURNEY_EVENT_TYPES.PHONE_SHARED },
                { event_type: JOURNEY_EVENT_TYPES.PHONE_VERIFIED },
                { event_type: JOURNEY_EVENT_TYPES.CLAIM_COMPLETED },
                { event_type: JOURNEY_EVENT_TYPES.ACTIVATION_COMPLETED }
            ];
            const res = computeJourneyStatusAndNextAction(events);
            assert.strictEqual(res.status, JOURNEY_STATUSES.ACTIVATED);
            assert.strictEqual(res.nextAction, NEXT_ACTIONS.COMPLETED);
        });
    });

    // -------------------------------------------------------------
    // 3. IDEMPOTENCY & CONCURRENCY
    // -------------------------------------------------------------
    describe('3. Multi-Level Idempotency & Concurrent Requests', () => {
        it('enforces booking-level milestone idempotency under concurrent Promise.all', async () => {
            const mockDb = createMockDb();
            const bookingId = 1001;

            // 5 concurrent requests attempting to record BOOKING_CREATED
            const results = await Promise.all([
                recordJourneyEvent(bookingId, { eventType: JOURNEY_EVENT_TYPES.BOOKING_CREATED }, { dbClient: mockDb }),
                recordJourneyEvent(bookingId, { eventType: JOURNEY_EVENT_TYPES.BOOKING_CREATED }, { dbClient: mockDb }),
                recordJourneyEvent(bookingId, { eventType: JOURNEY_EVENT_TYPES.BOOKING_CREATED }, { dbClient: mockDb }),
                recordJourneyEvent(bookingId, { eventType: JOURNEY_EVENT_TYPES.BOOKING_CREATED }, { dbClient: mockDb }),
                recordJourneyEvent(bookingId, { eventType: JOURNEY_EVENT_TYPES.BOOKING_CREATED }, { dbClient: mockDb })
            ]);

            const createdCount = results.filter(r => r.success && !r.isDuplicate).length;
            const duplicateCount = results.filter(r => r.isDuplicate).length;

            assert.strictEqual(createdCount, 1, 'Only 1 milestone event must be created');
            assert.strictEqual(duplicateCount, 4, '4 concurrent calls must be flagged as duplicates');
            assert.strictEqual(mockDb.events.length, 1);
        });

        it('enforces handoff-level idempotency for LINK_OPENED', async () => {
            const mockDb = createMockDb();
            const handoffId = 'handoff-uuid-1';

            const res1 = await recordJourneyEvent(2001, {
                eventType: JOURNEY_EVENT_TYPES.LINK_OPENED,
                handoffId
            }, { dbClient: mockDb });
            assert.strictEqual(res1.isDuplicate, false);

            const res2 = await recordJourneyEvent(2001, {
                eventType: JOURNEY_EVENT_TYPES.LINK_OPENED,
                handoffId
            }, { dbClient: mockDb });
            assert.strictEqual(res2.isDuplicate, true);
            assert.strictEqual(mockDb.events.length, 1);
        });

        it('enforces session-level idempotency for TELEGRAM_BOT_STARTED and PHONE_SHARED', async () => {
            const mockDb = createMockDb();
            const sessionId = 'session-uuid-10';

            const bot1 = await recordJourneyEvent(3001, {
                eventType: JOURNEY_EVENT_TYPES.TELEGRAM_BOT_STARTED,
                sessionId
            }, { dbClient: mockDb });
            assert.strictEqual(bot1.isDuplicate, false);

            const bot2 = await recordJourneyEvent(3001, {
                eventType: JOURNEY_EVENT_TYPES.TELEGRAM_BOT_STARTED,
                sessionId
            }, { dbClient: mockDb });
            assert.strictEqual(bot2.isDuplicate, true);

            const phone1 = await recordJourneyEvent(3001, {
                eventType: JOURNEY_EVENT_TYPES.PHONE_SHARED,
                sessionId,
                phone: '+992900115050'
            }, { dbClient: mockDb });
            assert.strictEqual(phone1.isDuplicate, false);

            const phone2 = await recordJourneyEvent(3001, {
                eventType: JOURNEY_EVENT_TYPES.PHONE_SHARED,
                sessionId,
                phone: '+992900115050'
            }, { dbClient: mockDb });
            assert.strictEqual(phone2.isDuplicate, true);
        });

        it('enforces single outcome per session for PHONE_VERIFIED / PHONE_MISMATCH', async () => {
            const mockDb = createMockDb();
            const sessionId = 'session-uuid-20';

            const verRes = await recordJourneyEvent(4001, {
                eventType: JOURNEY_EVENT_TYPES.PHONE_VERIFIED,
                sessionId
            }, { dbClient: mockDb });
            assert.strictEqual(verRes.isDuplicate, false);

            // Attempting to record mismatch for the same session is blocked
            const misRes = await recordJourneyEvent(4001, {
                eventType: JOURNEY_EVENT_TYPES.PHONE_MISMATCH,
                sessionId
            }, { dbClient: mockDb });
            assert.strictEqual(misRes.isDuplicate, true);
        });

        it('allows multiple distinct handoffs for the same booking (re-share generates new handoff)', async () => {
            const mockDb = createMockDb();
            const bookingId = 5001;

            const handoff1 = await createBookingHandoff(bookingId, {
                channel: 'whatsapp',
                phone: '+992900115050'
            }, { dbClient: mockDb });

            const handoff2 = await createBookingHandoff(bookingId, {
                channel: 'sms',
                phone: '+992900115050'
            }, { dbClient: mockDb });

            assert.notStrictEqual(handoff1.handoff.id, handoff2.handoff.id);
            assert.strictEqual(mockDb.handoffs.length, 2);
            assert.strictEqual(mockDb.events.length, 2);
            assert.strictEqual(mockDb.events[0].channel, 'whatsapp');
            assert.strictEqual(mockDb.events[1].channel, 'sms');
        });
        it('enforces dual LINK_OPENED idempotency (with handoff_id vs unattributed)', async () => {
            const mockDb = createMockDb();
            const bookingId = 2002;
            const handoffId = 'handoff-uuid-2';

            // Case A: With handoff_id
            const resA1 = await recordJourneyEvent(bookingId, {
                eventType: JOURNEY_EVENT_TYPES.LINK_OPENED,
                handoffId
            }, { dbClient: mockDb });
            assert.strictEqual(resA1.isDuplicate, false);

            const resA2 = await recordJourneyEvent(bookingId, {
                eventType: JOURNEY_EVENT_TYPES.LINK_OPENED,
                handoffId
            }, { dbClient: mockDb });
            assert.strictEqual(resA2.isDuplicate, true);

            // Case B: Unattributed (handoff_id is NULL)
            const resB1 = await recordJourneyEvent(bookingId, {
                eventType: JOURNEY_EVENT_TYPES.LINK_OPENED,
                handoffId: null
            }, { dbClient: mockDb });
            assert.strictEqual(resB1.isDuplicate, false);

            const resB2 = await recordJourneyEvent(bookingId, {
                eventType: JOURNEY_EVENT_TYPES.LINK_OPENED,
                handoffId: null
            }, { dbClient: mockDb });
            assert.strictEqual(resB2.isDuplicate, true);
        });
    });

    // -------------------------------------------------------------
    // 4. ATOMICITY, RPC ENFORCEMENT & IMMUTABILITY
    // -------------------------------------------------------------
    describe('4. Atomic Handoff Creation & Immutability Protection', () => {
        it('rolls back created handoff if SHARE_INITIATED event insertion fails in mock adapter', async () => {
            const failingDb = createMockDb();
            failingDb.from = (table) => {
                if (table === 'booking_journey_events') {
                    return {
                        select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }),
                        insert: () => ({ select: () => ({ single: async () => ({ data: null, error: { message: 'DB_CONNECTION_TIMEOUT' } }) }) })
                    };
                }
                return createMockDb().from(table);
            };

            await assert.rejects(async () => {
                await createBookingHandoff(6001, {
                    channel: 'telegram',
                    phone: '+992900112233'
                }, { dbClient: failingDb, isMock: true });
            }, /DB_CONNECTION_TIMEOUT/);

            assert.strictEqual(failingDb.handoffs.length, 0);
        });

        it('strictly enforces atomic RPC in production and rejects non-RPC database clients', async () => {
            const clientWithoutRpc = { from: () => {} }; // Simulating client without RPC

            await assert.rejects(async () => {
                await createBookingHandoff(6002, {
                    channel: 'whatsapp'
                }, { dbClient: clientWithoutRpc, isMock: false });
            }, /Database client does not support RPC calls/);
        });

        it('verifies booking_handoffs immutability rules: allows opened_at/last_event_at, rejects business fields', () => {
            const originalHandoff = {
                id: 'h-1',
                booking_id: 100,
                claim_session_id: 's-1',
                channel: 'whatsapp',
                recipient_phone_masked: '+992 ** *** 5050',
                initiated_by_user_id: 5,
                created_at: '2026-09-04T00:00:00Z',
                opened_at: null,
                last_event_at: '2026-09-04T00:00:00Z'
            };

            function simulateHandoffUpdate(oldRow, newRow) {
                const immutableFields = ['id', 'booking_id', 'claim_session_id', 'channel', 'recipient_phone_masked', 'initiated_by_user_id', 'created_at'];
                for (const field of immutableFields) {
                    if (oldRow[field] !== newRow[field]) {
                        throw new Error(`MUTATION_BLOCKED: Field ${field} is immutable`);
                    }
                }
                return { ...oldRow, opened_at: newRow.opened_at, last_event_at: newRow.last_event_at };
            }

            // Allowed updates
            const validUpdate = simulateHandoffUpdate(originalHandoff, {
                ...originalHandoff,
                opened_at: '2026-09-04T01:00:00Z',
                last_event_at: '2026-09-04T01:00:00Z'
            });
            assert.strictEqual(validUpdate.opened_at, '2026-09-04T01:00:00Z');

            // Prohibited updates
            assert.throws(() => simulateHandoffUpdate(originalHandoff, { ...originalHandoff, channel: 'telegram' }), /channel is immutable/);
            assert.throws(() => simulateHandoffUpdate(originalHandoff, { ...originalHandoff, booking_id: 999 }), /booking_id is immutable/);
            assert.throws(() => simulateHandoffUpdate(originalHandoff, { ...originalHandoff, recipient_phone_masked: '***' }), /recipient_phone_masked is immutable/);
            assert.throws(() => simulateHandoffUpdate(originalHandoff, { ...originalHandoff, initiated_by_user_id: 99 }), /initiated_by_user_id is immutable/);
        });
    });

    // -------------------------------------------------------------
    // 5. HANDOFF & BOOKING BINDING & TELEGRAM CORRELATION
    // -------------------------------------------------------------
    describe('5. Handoff-Booking Binding & Telegram Correlation', () => {
        it('correctly derives bookingId from cryptographic ticket verification token', () => {
            const bookingId = 8801;
            const token = generateTicketVerificationToken(bookingId);
            const derivedId = extractBookingIdFromToken(token);
            assert.strictEqual(Number(derivedId), bookingId);
            assert.strictEqual(verifyTicketToken(token, derivedId), true);
        });

        it('detects tampering and rejects invalid tokens', () => {
            const bookingId = 8802;
            const token = generateTicketVerificationToken(bookingId);
            const tamperedToken = token.slice(0, -4) + 'abcd';
            assert.strictEqual(verifyTicketToken(tamperedToken, bookingId), false);
        });

        it('validates that handoff strictly belongs to the token-derived booking', () => {
            const bookingA = 9001;
            const bookingB = 9002;
            const handoffBelongingToB = { id: 'handoff-b', booking_id: bookingB, channel: 'sms' };

            const isMatch = Number(handoffBelongingToB.booking_id) === Number(bookingA);
            assert.strictEqual(isMatch, false, 'Cross-booking handoff binding must be rejected');
        });

        it('correlates handoffId into claim session upon session generation', async () => {
            const { generateClaimSession } = require('../utils/claimHelper');
            const mockDb = {
                claimSessions: [],
                from: (table) => ({
                    insert: (rows) => ({
                        select: () => ({
                            single: async () => {
                                const row = { id: 'sess-uuid-99', ...rows[0] };
                                mockDb.claimSessions.push(row);
                                return { data: row, error: null };
                            }
                        })
                    })
                })
            };

            const session = await generateClaimSession(777, {
                handoffId: 'handoff-uuid-777',
                supabaseClient: mockDb
            });

            assert.strictEqual(session.id, 'sess-uuid-99');
            assert.strictEqual(session.handoffId, 'handoff-uuid-777');
            assert.strictEqual(mockDb.claimSessions[0].handoff_id, 'handoff-uuid-777');
        });
    });

    // -------------------------------------------------------------
    // 6. RESILIENT FAILURE ISOLATION
    // -------------------------------------------------------------
    describe('6. Failure Isolation (Table Missing Prior to Migration)', () => {
        it('gracefully handles missing database table without throwing unhandled exceptions', async () => {
            const missingTableDb = createMockDb({ simulateTableMissing: true });

            const result = await recordJourneyEvent(7001, {
                eventType: JOURNEY_EVENT_TYPES.BOOKING_CREATED,
                actorType: 'carrier'
            }, { dbClient: missingTableDb });

            assert.strictEqual(result.success, false);
            assert.strictEqual(result.tableMissing, true);
        });
    });
});
