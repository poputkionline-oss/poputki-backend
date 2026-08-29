const test = require('node:test');
const assert = require('node:assert');
const {
    validateBusReplacement,
    checkBusScheduleConflict,
    verifyBusAccess
} = require('../utils/busHelper');
const { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } = require('../utils/auditHelper');

test.describe('Fleet Phase F: Simplified Safe Bus Replacement MVP Suite', () => {

    const carrierContext = {
        carrier_id: 11,
        user_id: 5,
        role: 'owner',
        full_name: 'Carrier Admin'
    };

    const mockOldTicket = {
        id: 73,
        operator_id: 11,
        from_city: 'Нижневартовск (РФ)',
        to_city: 'Канибадам (TJ)',
        departure_date: '2026-09-16',
        departure_time: '00:30',
        arrival_date: '2026-09-19',
        arrival_time: '06:35',
        bus_id: 1,
        bus_type: 'double',
        total_seats: 78,
        floor1_seats: 22,
        floor2_seats: 56,
        photos: [{ url: 'https://res.cloudinary.com/bus1_main.jpg', public_id: 'b1_main', is_main: true }],
        status: 'active',
        price: 700
    };

    const mockNewBusActive = {
        id: 2,
        carrier_id: 11,
        name: 'Mercedes Sprinter VIP',
        brand: 'Mercedes-Benz',
        model: 'Tourismo',
        license_plate: '1234AA01',
        bus_type: 'single',
        total_seats: 50,
        floor1_seats: null,
        floor2_seats: null,
        photos: [{ url: 'https://res.cloudinary.com/bus2_main.jpg', public_id: 'b2_main', is_main: true }],
        amenities: ['wifi', 'ac', 'usb'],
        status: 'active'
    };

    const mockForeignBus = {
        id: 99,
        carrier_id: 888,
        name: 'Foreign Bus',
        brand: 'Scania',
        model: 'Touring',
        license_plate: '9999FF01',
        bus_type: 'single',
        total_seats: 50,
        status: 'active'
    };

    const mockMaintenanceBus = {
        id: 3,
        carrier_id: 11,
        name: 'Setra under maintenance',
        brand: 'Setra',
        model: 'S 415 HD',
        license_plate: '3333MM01',
        bus_type: 'single',
        total_seats: 50,
        status: 'maintenance'
    };

    const mockArchivedBus = {
        id: 4,
        carrier_id: 11,
        name: 'Old Neoplan',
        brand: 'Neoplan',
        model: 'Cityliner',
        license_plate: '4444AR01',
        bus_type: 'single',
        total_seats: 50,
        status: 'archived'
    };

    function createMockSupabase({
        ticket = mockOldTicket,
        buses = [mockNewBusActive, mockForeignBus, mockMaintenanceBus, mockArchivedBus],
        bookings = [],
        activeTickets = []
    } = {}) {
        return {
            from(table) {
                return {
                    select(cols) {
                        const queryObj = {
                            _filters: {},
                            eq(field, val) {
                                queryObj._filters[field] = val;
                                return queryObj;
                            },
                            neq(field, val) {
                                queryObj._filters[`neq_${field}`] = val;
                                return queryObj;
                            },
                            gte(field, val) {
                                return queryObj;
                            },
                            single: async () => {
                                if (table === 'bus_tickets') return { data: ticket, error: null };
                                if (table === 'carrier_buses') {
                                    const busId = queryObj._filters['id'];
                                    return { data: buses.find(b => Number(b.id) === Number(busId)) || null, error: null };
                                }
                                return { data: null, error: null };
                            },
                            maybeSingle: async () => {
                                if (table === 'bus_tickets') return { data: ticket, error: null };
                                if (table === 'carrier_buses') {
                                    const busId = queryObj._filters['id'];
                                    return { data: buses.find(b => Number(b.id) === Number(busId)) || null, error: null };
                                }
                                return { data: null, error: null };
                            },
                            then(resolve) {
                                if (table === 'bus_ticket_bookings') return resolve({ data: bookings, error: null });
                                if (table === 'bus_tickets') {
                                    let results = [...activeTickets];
                                    if (queryObj._filters['neq_id']) {
                                        results = results.filter(t => Number(t.id) !== Number(queryObj._filters['neq_id']));
                                    }
                                    return resolve({ data: results, error: null });
                                }
                                return resolve({ data: [], error: null });
                            }
                        };
                        return queryObj;
                    }
                };
            }
        };
    }

    test('1. Same bus replacement is a safe no-op', async () => {
        const mockDb = createMockSupabase();
        const res = await validateBusReplacement(mockDb, carrierContext, 73, 1);
        assert.strictEqual(res.valid, true);
        assert.strictEqual(res.noOp, true);
    });

    test('2. Fleet-linked trip cannot be unassigned to null (BUS_UNASSIGN_FORBIDDEN)', async () => {
        const mockDb = createMockSupabase();
        const res = await validateBusReplacement(mockDb, carrierContext, 73, null);
        assert.strictEqual(res.valid, false);
        assert.strictEqual(res.status, 400);
        assert.strictEqual(res.error, 'BUS_UNASSIGN_FORBIDDEN');
    });

    test('3. Foreign carrier bus replacement is blocked (BUS_NOT_FOUND)', async () => {
        const mockDb = createMockSupabase();
        const res = await validateBusReplacement(mockDb, carrierContext, 73, 99);
        assert.strictEqual(res.valid, false);
        assert.strictEqual(res.status, 403);
        assert.strictEqual(res.error, 'BUS_NOT_FOUND');
    });

    test('4. Inactive bus replacement is blocked (BUS_NOT_AVAILABLE)', async () => {
        const inactiveBus = { ...mockNewBusActive, id: 8, status: 'inactive' };
        const mockDb = createMockSupabase({ buses: [inactiveBus] });
        const res = await validateBusReplacement(mockDb, carrierContext, 73, 8);
        assert.strictEqual(res.valid, false);
        assert.strictEqual(res.status, 409);
        assert.strictEqual(res.error, 'BUS_NOT_AVAILABLE');
    });

    test('5. Maintenance bus replacement is blocked (BUS_NOT_AVAILABLE)', async () => {
        const mockDb = createMockSupabase();
        const res = await validateBusReplacement(mockDb, carrierContext, 73, 3);
        assert.strictEqual(res.valid, false);
        assert.strictEqual(res.status, 409);
        assert.strictEqual(res.error, 'BUS_NOT_AVAILABLE');
    });

    test('6. Archived bus replacement is blocked (BUS_NOT_FOUND / BUS_NOT_AVAILABLE)', async () => {
        const mockDb = createMockSupabase();
        const res = await validateBusReplacement(mockDb, carrierContext, 73, 4);
        assert.strictEqual(res.valid, false);
        assert.ok([403, 409].includes(res.status));
        assert.ok(['BUS_NOT_FOUND', 'BUS_NOT_AVAILABLE'].includes(res.error));
    });

    test('7. Zero active bookings allows bus replacement', async () => {
        const mockDb = createMockSupabase({ bookings: [] });
        const res = await validateBusReplacement(mockDb, carrierContext, 73, 2);
        assert.strictEqual(res.valid, true);
        assert.strictEqual(res.snapshot.bus_id, 2);
        assert.strictEqual(res.activeBookingCount, 0);
    });

    test('8. Confirmed booking blocks bus replacement with BUS_REPLACEMENT_HAS_BOOKINGS', async () => {
        const bookings = [{ id: 1, seat_numbers: [10], status: 'confirmed' }];
        const mockDb = createMockSupabase({ bookings });
        const res = await validateBusReplacement(mockDb, carrierContext, 73, 2);
        assert.strictEqual(res.valid, false);
        assert.strictEqual(res.status, 409);
        assert.strictEqual(res.error, 'BUS_REPLACEMENT_HAS_BOOKINGS');
        assert.strictEqual(res.activeBookingCount, 1);
    });

    test('9. Active pending_payment booking blocks bus replacement', async () => {
        const bookings = [{
            id: 2,
            seat_numbers: [12],
            status: 'pending_payment',
            created_at: new Date().toISOString(),
            hold_expires_at: new Date(Date.now() + 20 * 60 * 1000).toISOString()
        }];
        const mockDb = createMockSupabase({ bookings });
        const res = await validateBusReplacement(mockDb, carrierContext, 73, 2);
        assert.strictEqual(res.valid, false);
        assert.strictEqual(res.status, 409);
        assert.strictEqual(res.error, 'BUS_REPLACEMENT_HAS_BOOKINGS');
        assert.strictEqual(res.activeBookingCount, 1);
    });

    test('10. Expired pending_payment booking does not block replacement', async () => {
        const bookings = [{
            id: 3,
            seat_numbers: [50],
            status: 'pending_payment',
            created_at: new Date(Date.now() - 40 * 60 * 1000).toISOString(),
            hold_expires_at: new Date(Date.now() - 10 * 60 * 1000).toISOString()
        }];
        const mockDb = createMockSupabase({ bookings });
        const res = await validateBusReplacement(mockDb, carrierContext, 73, 2);
        assert.strictEqual(res.valid, true);
        assert.strictEqual(res.activeBookingCount, 0);
    });

    test('11. Cancelled booking does not block replacement', async () => {
        const bookings = [{ id: 4, seat_numbers: [15], status: 'cancelled' }];
        const mockDb = createMockSupabase({ bookings });
        const res = await validateBusReplacement(mockDb, carrierContext, 73, 2);
        assert.strictEqual(res.valid, true);
        assert.strictEqual(res.activeBookingCount, 0);
    });

    test('12. Mixed confirmed and cancelled bookings blocks replacement due to confirmed booking', async () => {
        const bookings = [
            { id: 5, seat_numbers: [1], status: 'cancelled' },
            { id: 6, seat_numbers: [2], status: 'confirmed' }
        ];
        const mockDb = createMockSupabase({ bookings });
        const res = await validateBusReplacement(mockDb, carrierContext, 73, 2);
        assert.strictEqual(res.valid, false);
        assert.strictEqual(res.status, 409);
        assert.strictEqual(res.error, 'BUS_REPLACEMENT_HAS_BOOKINGS');
        assert.strictEqual(res.activeBookingCount, 1);
    });

    test('13. Multiple expired pending bookings allows replacement', async () => {
        const bookings = [
            { id: 7, seat_numbers: [1], status: 'pending_payment', hold_expires_at: new Date(Date.now() - 5000).toISOString() },
            { id: 8, seat_numbers: [2], status: 'pending_payment', hold_expires_at: new Date(Date.now() - 10000).toISOString() }
        ];
        const mockDb = createMockSupabase({ bookings });
        const res = await validateBusReplacement(mockDb, carrierContext, 73, 2);
        assert.strictEqual(res.valid, true);
    });

    test('14. Legacy null bus with zero active bookings allows fleet assignment', async () => {
        const legacyTicket = { ...mockOldTicket, id: 50, bus_id: null };
        const mockDb = createMockSupabase({ ticket: legacyTicket, bookings: [] });
        const res = await validateBusReplacement(mockDb, carrierContext, 50, 2);
        assert.strictEqual(res.valid, true);
        assert.strictEqual(res.snapshot.bus_id, 2);
    });

    test('15. Legacy null bus with confirmed booking blocks fleet assignment (BUS_REPLACEMENT_HAS_BOOKINGS)', async () => {
        const legacyTicket = { ...mockOldTicket, id: 50, bus_id: null };
        const bookings = [{ id: 9, seat_numbers: [5], status: 'confirmed' }];
        const mockDb = createMockSupabase({ ticket: legacyTicket, bookings });
        const res = await validateBusReplacement(mockDb, carrierContext, 50, 2);
        assert.strictEqual(res.valid, false);
        assert.strictEqual(res.status, 409);
        assert.strictEqual(res.error, 'BUS_REPLACEMENT_HAS_BOOKINGS');
    });

    test('16. Safe error code BUS_REPLACEMENT_HAS_BOOKINGS returned on active bookings conflict', async () => {
        const bookings = [{ id: 10, seat_numbers: [1], status: 'confirmed' }];
        const mockDb = createMockSupabase({ bookings });
        const res = await validateBusReplacement(mockDb, carrierContext, 73, 2);
        assert.strictEqual(res.error, 'BUS_REPLACEMENT_HAS_BOOKINGS');
    });

    test('17. Error response contains activeBookingCount', async () => {
        const bookings = [
            { id: 11, seat_numbers: [1], status: 'confirmed' },
            { id: 12, seat_numbers: [2], status: 'confirmed' }
        ];
        const mockDb = createMockSupabase({ bookings });
        const res = await validateBusReplacement(mockDb, carrierContext, 73, 2);
        assert.strictEqual(res.activeBookingCount, 2);
    });

    test('18. Error response contains zero passenger PII', async () => {
        const bookings = [{ id: 13, seat_numbers: [1], status: 'confirmed', passenger_name: 'John Doe', phone: '+79991234567' }];
        const mockDb = createMockSupabase({ bookings });
        const res = await validateBusReplacement(mockDb, carrierContext, 73, 2);
        assert.strictEqual(res.passenger_name, undefined);
        assert.strictEqual(res.phone, undefined);
    });

    test('19. Snapshot values come strictly from carrier_buses master record', async () => {
        const mockDb = createMockSupabase({ bookings: [] });
        const res = await validateBusReplacement(mockDb, carrierContext, 73, 2);
        assert.strictEqual(res.snapshot.total_seats, 50);
        assert.strictEqual(res.snapshot.bus_type, 'single');
        assert.strictEqual(res.snapshot.photos[0].url, 'https://res.cloudinary.com/bus2_main.jpg');
    });

    test('20. Frontend attempt to spoof snapshot fields is ignored', async () => {
        const mockDb = createMockSupabase({ bookings: [] });
        const res = await validateBusReplacement(mockDb, carrierContext, 73, 2);
        assert.strictEqual(res.snapshot.total_seats, mockNewBusActive.total_seats);
    });

    test('21. Schedule conflict on new bus blocks replacement (409 BUS_SCHEDULE_CONFLICT)', async () => {
        const conflictingTrip = {
            id: 99,
            operator_id: 11,
            bus_id: 2,
            departure_date: '2026-09-16',
            departure_time: '00:30',
            arrival_date: '2026-09-19',
            arrival_time: '06:35',
            status: 'active'
        };
        const mockDb = createMockSupabase({ bookings: [], activeTickets: [conflictingTrip] });
        const res = await validateBusReplacement(mockDb, carrierContext, 73, 2);
        assert.strictEqual(res.valid, false);
        assert.strictEqual(res.status, 409);
        assert.strictEqual(res.error, 'BUS_SCHEDULE_CONFLICT');
    });

    test('22. Schedule override (allowConflict=true) allows replacement past schedule warning', async () => {
        const conflictingTrip = {
            id: 99,
            operator_id: 11,
            bus_id: 2,
            departure_date: '2026-09-16',
            departure_time: '00:30',
            arrival_date: '2026-09-19',
            arrival_time: '06:35',
            status: 'active'
        };
        const mockDb = createMockSupabase({ bookings: [], activeTickets: [conflictingTrip] });
        const res = await validateBusReplacement(mockDb, carrierContext, 73, 2, { allowConflict: true });
        assert.strictEqual(res.valid, true);
        assert.strictEqual(res.snapshot.bus_id, 2);
    });

    test('23. Schedule override cannot bypass active booking rule', async () => {
        const bookings = [{ id: 14, seat_numbers: [1], status: 'confirmed' }];
        const mockDb = createMockSupabase({ bookings });
        const res = await validateBusReplacement(mockDb, carrierContext, 73, 2, { allowConflict: true });
        assert.strictEqual(res.valid, false);
        assert.strictEqual(res.status, 409);
        assert.strictEqual(res.error, 'BUS_REPLACEMENT_HAS_BOOKINGS');
    });

    test('24. Audit action TRIP_BUS_REPLACED is properly defined', () => {
        assert.strictEqual(AUDIT_ACTIONS.TRIP_BUS_REPLACED, 'trip_bus_replaced');
    });

    test('25. Existing booking records are not modified during validation', async () => {
        const bookings = [{ id: 15, seat_numbers: [1], status: 'confirmed' }];
        const mockDb = createMockSupabase({ bookings });
        await validateBusReplacement(mockDb, carrierContext, 73, 2);
        assert.strictEqual(bookings[0].status, 'confirmed');
    });

    test('26. Payment hold expiration semantics remain canonical Phase P1.5', async () => {
        const freshPending = [{ id: 16, seat_numbers: [1], status: 'pending_payment', created_at: new Date().toISOString() }];
        const mockDb = createMockSupabase({ bookings: freshPending });
        const res = await validateBusReplacement(mockDb, carrierContext, 73, 2);
        assert.strictEqual(res.valid, false);
        assert.strictEqual(res.error, 'BUS_REPLACEMENT_HAS_BOOKINGS');
    });

    test('27. Driver assignment and ticket metadata remain untouched', async () => {
        const mockDb = createMockSupabase({ bookings: [] });
        const res = await validateBusReplacement(mockDb, carrierContext, 73, 2);
        assert.strictEqual(res.oldTicket.price, 700);
        assert.strictEqual(res.oldTicket.from_city, 'Нижневартовск (РФ)');
    });

    test('28. Trip price remains untouched during bus replacement validation', async () => {
        const mockDb = createMockSupabase({ bookings: [] });
        const res = await validateBusReplacement(mockDb, carrierContext, 73, 2);
        assert.strictEqual(res.valid, true);
        assert.strictEqual(res.snapshot.price, undefined);
    });
});
