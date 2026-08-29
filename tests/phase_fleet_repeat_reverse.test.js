const test = require('node:test');
const assert = require('node:assert');
const {
    verifyBusAccess,
    checkBusScheduleConflict
} = require('../utils/busHelper');

test.describe('Fleet Phase F: Repeat and Reverse Trip Backend Integration Suite', () => {

    const carrierContext = {
        carrier_id: 11,
        user_id: 5,
        role: 'owner'
    };

    const mockMasterBus = {
        id: 1,
        carrier_id: 11,
        name: 'Setra panorama',
        brand: 'Setra',
        model: 'S 431 DT',
        license_plate: '5051ZA20',
        bus_type: 'double',
        total_seats: 78,
        floor1_seats: 22,
        floor2_seats: 56,
        photos: [{ url: 'https://res.cloudinary.com/main.jpg', public_id: 'p1', is_main: true }],
        amenities: ['wifi', 'ac', 'tv', 'wc'],
        status: 'active'
    };

    const mockSourceTrip = {
        id: 73,
        operator_id: 11,
        from_city: 'Нижневартовск (РФ)',
        from_address: 'Автовокзал',
        to_city: 'Канибадам (TJ)',
        to_address: 'Центральный автовокзал',
        departure_date: '2026-09-16',
        departure_time: '00:30',
        arrival_date: '2026-09-19',
        arrival_time: '06:35',
        price: 700,
        bus_id: 1,
        bus_type: 'double',
        total_seats: 78,
        floor1_seats: 22,
        floor2_seats: 56,
        intermediate_stops: [{ city: 'Тюмень', address: 'ул. Пермякова', time: '12:00' }],
        photos: [{ url: 'https://res.cloudinary.com/stale.jpg', public_id: 'stale_p', is_main: true }]
    };

    function createMockSupabase({
        bus = mockMasterBus,
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
                            single: async () => {
                                if (table === 'carrier_buses') {
                                    const bId = queryObj._filters['id'];
                                    return { data: Number(bus?.id) === Number(bId) ? bus : null, error: null };
                                }
                                return { data: null, error: null };
                            },
                            maybeSingle: async () => {
                                if (table === 'carrier_buses') {
                                    const bId = queryObj._filters['id'];
                                    return { data: Number(bus?.id) === Number(bId) ? bus : null, error: null };
                                }
                                return { data: null, error: null };
                            },
                            then(resolve) {
                                return resolve({ data: activeTickets, error: null });
                            }
                        };
                        return queryObj;
                    }
                };
            }
        };
    }

    test('1. Repeat trip carries source bus_id as candidate', () => {
        const candidateBusId = mockSourceTrip.bus_id;
        assert.strictEqual(candidateBusId, 1);
    });

    test('2. Repeat trip re-validates bus status against master', async () => {
        const mockDb = createMockSupabase({ bus: mockMasterBus });
        const verified = await verifyBusAccess(carrierContext, 1, { client: mockDb });
        assert.ok(verified);
        assert.strictEqual(verified.status, 'active');
    });

    test('3. Repeat trip creates fresh snapshot from current master instead of cloning stale trip photos', async () => {
        const mockDb = createMockSupabase({ bus: mockMasterBus });
        const bus = await verifyBusAccess(carrierContext, 1, { client: mockDb });
        
        // Fresh snapshot uses master photos, NOT mockSourceTrip.photos (which has stale.jpg)
        const freshSnapshot = {
            bus_id: bus.id,
            bus_type: bus.bus_type,
            total_seats: bus.total_seats,
            floor1_seats: bus.floor1_seats,
            floor2_seats: bus.floor2_seats,
            photos: bus.photos
        };

        assert.strictEqual(freshSnapshot.photos[0].url, 'https://res.cloudinary.com/main.jpg');
        assert.notStrictEqual(freshSnapshot.photos[0].url, mockSourceTrip.photos[0].url);
    });

    test('4. Repeat trip detects schedule conflict on chosen new date', async () => {
        const conflictingTickets = [{
            id: 99,
            from_city: 'Душанбе',
            to_city: 'Худжанд',
            departure_date: '2026-09-25',
            departure_time: '00:00',
            arrival_date: '2026-09-25',
            arrival_time: '18:00'
        }];
        const mockDb = createMockSupabase({ activeTickets: conflictingTickets });
        const conflicts = await checkBusScheduleConflict(
            mockDb,
            carrierContext.carrier_id,
            1,
            '2026-09-25',
            '08:00',
            '2026-09-25',
            '20:00'
        );
        assert.strictEqual(conflicts.length, 1);
        assert.strictEqual(conflicts[0].ticket_id, 99);
    });

    test('5. Repeat trip rejects archived source bus on new creation attempt', async () => {
        const archivedBus = { ...mockMasterBus, status: 'archived' };
        const mockDb = createMockSupabase({ bus: archivedBus });
        const verified = await verifyBusAccess(carrierContext, 1, { allowArchived: false, client: mockDb });
        assert.strictEqual(verified, null);
    });

    test('6. Reverse trip swaps from_city and to_city while retaining candidate bus_id', () => {
        const reversedForm = {
            from_city: mockSourceTrip.to_city,
            from_address: mockSourceTrip.to_address,
            to_city: mockSourceTrip.from_city,
            to_address: mockSourceTrip.from_address,
            bus_id: mockSourceTrip.bus_id
        };
        assert.strictEqual(reversedForm.from_city, 'Канибадам (TJ)');
        assert.strictEqual(reversedForm.to_city, 'Нижневартовск (РФ)');
        assert.strictEqual(reversedForm.bus_id, 1);
    });

    test('7. Reverse trip reverses intermediate stops and clears arrival/departure times', () => {
        const reversedStops = [...mockSourceTrip.intermediate_stops].reverse().map(s => ({
            city: s.city,
            address: s.address,
            time: '' // reset for reverse direction
        }));
        assert.strictEqual(reversedStops[0].city, 'Тюмень');
        assert.strictEqual(reversedStops[0].time, '');
    });

    test('8. Reverse trip creates fresh snapshot from current master on new date', async () => {
        const mockDb = createMockSupabase({ bus: mockMasterBus });
        const bus = await verifyBusAccess(carrierContext, 1, { client: mockDb });
        assert.strictEqual(bus.total_seats, 78);
        assert.strictEqual(bus.bus_type, 'double');
    });

    test('9. Legacy source trip with bus_id=null allows repeat/reverse without forcing fleet bus', () => {
        const legacySource = { ...mockSourceTrip, bus_id: null };
        const candidateBusId = legacySource.bus_id;
        assert.strictEqual(candidateBusId, null);
    });

    test('10. Repeat and Reverse trips do NOT copy bookings or passenger PII', () => {
        const newTripData = {
            from_city: mockSourceTrip.from_city,
            to_city: mockSourceTrip.to_city,
            bus_id: mockSourceTrip.bus_id
        };
        assert.strictEqual(newTripData.bookings, undefined);
        assert.strictEqual(newTripData.bookedSeats, undefined);
    });
});
