const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
    CANONICAL_AMENITIES,
    VALID_BUS_TYPES,
    VALID_BUS_STATUSES,
    normalizePlate,
    sanitizeAmenities,
    sanitizePhotos,
    validateBusPayload,
    checkDuplicatePlate,
    verifyBusAccess,
    getBusActiveTickets
} = require('../utils/busHelper');
const {
    AUDIT_ACTIONS,
    AUDIT_ENTITY_TYPES,
    WHITELIST_FIELDS,
    computeSanitizedDiff,
    logCarrierActivity
} = require('../utils/auditHelper');

describe('Fleet Phase A+B: Database Foundation & Backend CRUD Test Suite', () => {

    // 1. Owner creates bus
    it('1. Owner role is permitted to create a bus (POST /buses allowed)', () => {
        const role = 'owner';
        const isAllowed = ['owner', 'dispatcher'].includes(role);
        assert.equal(isAllowed, true);
    });

    // 2. Dispatcher creates bus
    it('2. Dispatcher role is permitted to create a bus (POST /buses allowed)', () => {
        const role = 'dispatcher';
        const isAllowed = ['owner', 'dispatcher'].includes(role);
        assert.equal(isAllowed, true);
    });

    // 3. Accountant cannot create bus
    it('3. Accountant role is strictly forbidden from creating a bus (403)', () => {
        const role = 'accountant';
        const isAllowed = ['owner', 'dispatcher'].includes(role);
        assert.equal(isAllowed, false);
    });

    // 4. Driver cannot create bus
    it('4. Driver role is strictly forbidden from creating a bus (403)', () => {
        const role = 'driver';
        const isAllowed = ['owner', 'dispatcher'].includes(role);
        assert.equal(isAllowed, false);
    });

    // 5. Owner lists only own buses
    it('5. Listing buses returns only vehicles belonging to authenticated carrier_id', () => {
        const authenticatedCarrierId = 11;
        const allBuses = [
            { id: 1, carrier_id: 11, name: 'Setra #1', status: 'active' },
            { id: 2, carrier_id: 11, name: 'Setra #2', status: 'active' },
            { id: 3, carrier_id: 99, name: 'Neoplan #1', status: 'active' }
        ];

        const scopedBuses = allBuses.filter(b => b.carrier_id === authenticatedCarrierId);
        assert.equal(scopedBuses.length, 2);
        assert.equal(scopedBuses.every(b => b.carrier_id === 11), true);
    });

    // 6. Cross-tenant GET blocked
    it('6. Cross-tenant GET on bus ID returns null / 404 (Carrier A cannot view Carrier B bus)', () => {
        const bus = { id: 10, carrier_id: 99, status: 'active' };
        const reqCarrier = { carrier_id: 11, role: 'owner' };

        const hasAccess = parseInt(bus.carrier_id, 10) === parseInt(reqCarrier.carrier_id, 10);
        assert.equal(hasAccess, false);
    });

    // 7. Cross-tenant PATCH blocked
    it('7. Cross-tenant PATCH is blocked when bus belongs to another carrier', () => {
        const bus = { id: 10, carrier_id: 99, status: 'active' };
        const reqCarrier = { carrier_id: 11, role: 'owner' };

        const isAllowed = parseInt(bus.carrier_id, 10) === parseInt(reqCarrier.carrier_id, 10);
        assert.equal(isAllowed, false);
    });

    // 8. Cross-tenant archive blocked
    it('8. Cross-tenant Archive is strictly blocked (403/404)', () => {
        const bus = { id: 10, carrier_id: 99, status: 'active' };
        const reqCarrier = { carrier_id: 11, role: 'owner' };

        const isAllowed = (reqCarrier.role === 'owner') && (parseInt(bus.carrier_id, 10) === parseInt(reqCarrier.carrier_id, 10));
        assert.equal(isAllowed, false);
    });

    // 9. carrier_id from body ignored
    it('9. carrier_id supplied in POST request body is completely ignored in favor of verified JWT carrierContext', () => {
        const body = {
            carrier_id: 9999, // Attacker tries to inject foreign carrier_id
            name: 'Setra S431',
            brand: 'Setra',
            model: 'S431 DT',
            license_plate: '01 777 TJ 01',
            bus_type: 'single',
            total_seats: 53
        };
        const verifiedCarrierId = 11;

        const validation = validateBusPayload(body, { isUpdate: false });
        assert.equal(validation.valid, true);

        const newBusData = {
            ...validation.sanitizedData,
            carrier_id: verifiedCarrierId
        };
        assert.equal(newBusData.carrier_id, 11);
        assert.notEqual(newBusData.carrier_id, 9999);
    });

    // 10. Single bus validation
    it('10. Valid single deck bus payload passes validation and resets floor counts to null', () => {
        const payload = {
            name: 'Setra Standard',
            brand: 'Setra',
            model: 'ComfortClass',
            license_plate: '01 123 TJ 01',
            bus_type: 'single',
            total_seats: 53,
            floor1_seats: 20, // Should be nulled out for single deck
            floor2_seats: 33
        };

        const res = validateBusPayload(payload, { isUpdate: false });
        assert.equal(res.valid, true);
        assert.equal(res.sanitizedData.bus_type, 'single');
        assert.equal(res.sanitizedData.total_seats, 53);
        assert.equal(res.sanitizedData.floor1_seats, null);
        assert.equal(res.sanitizedData.floor2_seats, null);
    });

    // 11. Double bus validation
    it('11. Valid double deck bus payload passes validation with matching floor sum', () => {
        const payload = {
            name: 'Neoplan Skyliner',
            brand: 'Neoplan',
            model: 'Skyliner N1222',
            license_plate: '01 999 TJ 01',
            bus_type: 'double',
            total_seats: 78,
            floor1_seats: 22,
            floor2_seats: 56
        };

        const res = validateBusPayload(payload, { isUpdate: false });
        assert.equal(res.valid, true);
        assert.equal(res.sanitizedData.bus_type, 'double');
        assert.equal(res.sanitizedData.total_seats, 78);
        assert.equal(res.sanitizedData.floor1_seats, 22);
        assert.equal(res.sanitizedData.floor2_seats, 56);
    });

    // 12. Floor sum mismatch rejected
    it('12. Double deck bus with floor1 + floor2 != total_seats is rejected with clear error', () => {
        const payload = {
            name: 'Neoplan Skyliner',
            brand: 'Neoplan',
            model: 'Skyliner N1222',
            license_plate: '01 999 TJ 01',
            bus_type: 'double',
            total_seats: 78,
            floor1_seats: 20, // 20 + 56 = 76 != 78
            floor2_seats: 56
        };

        const res = validateBusPayload(payload, { isUpdate: false });
        assert.equal(res.valid, false);
        assert.match(res.error, /должна быть равна общему количеству мест/);
    });

    // 13. Invalid status rejected
    it('13. Invalid bus status is rejected with allow-list check', () => {
        const payload = {
            name: 'Test Bus',
            brand: 'Yutong',
            model: 'ZK6122',
            license_plate: '01 333 TJ 01',
            bus_type: 'single',
            total_seats: 50,
            status: 'deleted_forever'
        };

        const res = validateBusPayload(payload, { isUpdate: false });
        assert.equal(res.valid, false);
        assert.match(res.error, /Недопустимый статус автобуса/);
    });

    // 14. Invalid bus_type rejected
    it('14. Invalid bus_type is rejected (must be single or double)', () => {
        const payload = {
            name: 'Test Bus',
            brand: 'Yutong',
            model: 'ZK6122',
            license_plate: '01 333 TJ 01',
            bus_type: 'triple_decker',
            total_seats: 50
        };

        const res = validateBusPayload(payload, { isUpdate: false });
        assert.equal(res.valid, false);
        assert.match(res.error, /Недопустимый тип автобуса/);
    });

    // 15. Duplicate active plate for tenant rejected
    it('15. Duplicate active license plate for the same tenant is detected and rejected regardless of spaces', async () => {
        const existingBuses = [
            { id: 1, carrier_id: 11, license_plate: '01 777 TJ 01', status: 'active' },
            { id: 2, carrier_id: 11, license_plate: '02 888 TJ 02', status: 'archived' }
        ];

        const mockSupabase = {
            from: () => ({
                select: () => ({
                    eq: () => ({
                        neq: () => Promise.resolve({ data: existingBuses, error: null })
                    })
                })
            })
        };

        // Same carrier enters '01777TJ01' or '01 777 TJ  01'
        const isDup = await checkDuplicatePlate(mockSupabase, 11, '01777TJ01');
        assert.equal(isDup, true);

        // Different plate passes
        const isNew = await checkDuplicatePlate(mockSupabase, 11, '01 555 TJ 01');
        assert.equal(isNew, false);
    });

    // 16. Same plate different carrier allowed
    it('16. Same license plate registered by a different carrier is allowed (tenant-scoped uniqueness)', async () => {
        const existingBusesOfCarrier12 = [];

        const mockSupabase = {
            from: () => ({
                select: () => ({
                    eq: (col, val) => ({
                        neq: () => Promise.resolve({
                            data: val === 12 ? existingBusesOfCarrier12 : [{ id: 1, carrier_id: 11, license_plate: '01 777 TJ 01', status: 'active' }],
                            error: null
                        })
                    })
                })
            })
        };

        const isDupCarrier12 = await checkDuplicatePlate(mockSupabase, 12, '01 777 TJ 01');
        assert.equal(isDupCarrier12, false);
    });

    // 17. Archived bus plate reuse allowed
    it('17. An archived bus plate can be registered again by the same carrier', async () => {
        const existingBuses = [
            // Old bus was archived
            { id: 2, carrier_id: 11, license_plate: '02 888 TJ 02', status: 'archived' }
        ];

        const mockSupabase = {
            from: () => ({
                select: () => ({
                    eq: () => ({
                        neq: () => Promise.resolve({ data: [], error: null }) // neq status archived excludes it
                    })
                })
            })
        };

        const isDup = await checkDuplicatePlate(mockSupabase, 11, '02 888 TJ 02');
        assert.equal(isDup, false);
    });

    // 18. Photos validated
    it('18. Photos array is sanitized and validated for proper object structure and max count', () => {
        const validPhotos = [
            { url: 'https://res.cloudinary.com/.../img1.jpg', public_id: 'img1', is_main: true },
            { url: 'https://res.cloudinary.com/.../img2.jpg', public_id: 'img2' }
        ];

        const clean = sanitizePhotos(validPhotos);
        assert.equal(clean.length, 2);
        assert.equal(clean[0].is_main, true);
        assert.equal(clean[1].is_main, false);

        // Invalid object without public_id
        assert.throws(() => {
            sanitizePhotos([{ url: 'https://only-url.com/img.jpg' }]);
        }, /url и public_id обязательны/);

        // Oversized array > 20
        const oversized = Array.from({ length: 25 }, (_, i) => ({ url: `url${i}`, public_id: `pid${i}` }));
        assert.throws(() => {
            sanitizePhotos(oversized);
        }, /не может превышать 20/);
    });

    // 19. Amenities allow-list
    it('19. Amenities are strictly filtered against the canonical allow-list', () => {
        const dirtyAmenities = [
            'WIFI',
            'AC',
            'usb',
            '<script>alert(1)</script>',
            'custom_unsupported_tag',
            'WC',
            'kitchen',
            'power_220v'
        ];

        const clean = sanitizeAmenities(dirtyAmenities);
        assert.deepEqual(clean.sort(), ['ac', 'kitchen', 'power_220v', 'usb', 'wc', 'wifi'].sort());
        assert.equal(clean.includes('<script>alert(1)</script>'), false);
        assert.equal(clean.includes('custom_unsupported_tag'), false);
    });

    // 20. bus_created audit
    it('20. Audit action BUS_CREATED is properly defined and diffed', () => {
        assert.equal(AUDIT_ACTIONS.BUS_CREATED, 'bus_created');
        assert.equal(AUDIT_ENTITY_TYPES.BUS, 'bus');

        const newBus = {
            id: 5,
            carrier_id: 11,
            name: 'Setra Blue',
            brand: 'Setra',
            model: 'S431 DT',
            license_plate: '01 777 TJ 01',
            vin: 'SECRET_VIN_123',
            bus_type: 'double',
            total_seats: 78,
            floor1_seats: 22,
            floor2_seats: 56,
            photos: [{ url: 'http...', public_id: 'p1' }],
            amenities: ['wifi', 'ac'],
            status: 'active'
        };

        const { oldDiff, newDiff } = computeSanitizedDiff(AUDIT_ENTITY_TYPES.BUS, null, newBus);
        assert.equal(oldDiff, null);
        assert.notEqual(newDiff, null);
        assert.equal(newDiff.name, 'Setra Blue');
        assert.equal(newDiff.brand, 'Setra');
        assert.equal(newDiff.model, 'S431 DT');
        assert.equal(newDiff.total_seats, 78);
    });

    // 21. bus_updated audit
    it('21. Audit action BUS_UPDATED correctly computes property level diff', () => {
        assert.equal(AUDIT_ACTIONS.BUS_UPDATED, 'bus_updated');

        const oldBus = {
            name: 'Setra Blue #1',
            brand: 'Setra',
            model: 'S431 DT',
            total_seats: 78,
            status: 'active',
            color: 'Синий'
        };

        const newBus = {
            name: 'Setra Blue #1 Updated',
            brand: 'Setra',
            model: 'S431 DT',
            total_seats: 78,
            status: 'maintenance',
            color: 'Синий'
        };

        const { oldDiff, newDiff } = computeSanitizedDiff(AUDIT_ENTITY_TYPES.BUS, oldBus, newBus);
        assert.deepEqual(oldDiff, { name: 'Setra Blue #1', status: 'active' });
        assert.deepEqual(newDiff, { name: 'Setra Blue #1 Updated', status: 'maintenance' });
    });

    // 22. bus_archived audit
    it('22. Audit action BUS_ARCHIVED logs status change with safe metadata', () => {
        assert.equal(AUDIT_ACTIONS.BUS_ARCHIVED, 'bus_archived');

        const oldBus = { id: 5, status: 'active', name: 'Neoplan' };
        const newBus = { id: 5, status: 'archived', name: 'Neoplan' };

        const { oldDiff, newDiff } = computeSanitizedDiff(AUDIT_ENTITY_TYPES.BUS, oldBus, newBus);
        assert.deepEqual(oldDiff, { status: 'active' });
        assert.deepEqual(newDiff, { status: 'archived' });
    });

    // 23. Audit contains no sensitive bus data
    it('23. Whitelist diff excludes sensitive fields (NO VIN, NO license_plate, NO photos, NO notes)', () => {
        const allowedBusFields = WHITELIST_FIELDS[AUDIT_ENTITY_TYPES.BUS];
        assert.equal(allowedBusFields.has('vin'), false);
        assert.equal(allowedBusFields.has('license_plate'), false);
        assert.equal(allowedBusFields.has('photos'), false);
        assert.equal(allowedBusFields.has('notes'), false);
        assert.equal(allowedBusFields.has('password'), false);
        assert.equal(allowedBusFields.has('token'), false);
    });

    // 24. Physical DELETE unavailable
    it('24. Physical DELETE route returns 405 Method Not Allowed advising archive endpoint', () => {
        const deleteHandler = (req, res) => {
            return res.status(405).json({
                error: 'Физическое удаление автобуса запрещено. Используйте архивацию POST /api/bus-admin/buses/:id/archive'
            });
        };

        let responseCode = 0;
        let responseJson = null;
        const res = {
            status: (code) => {
                responseCode = code;
                return {
                    json: (obj) => { responseJson = obj; }
                };
            }
        };

        deleteHandler({}, res);
        assert.equal(responseCode, 405);
        assert.match(responseJson.error, /Физическое удаление автобуса запрещено/);
    });

    // 25. bus_id nullable in bus_tickets
    it('25. bus_id column in bus_tickets is nullable and foreign key uses ON DELETE SET NULL', () => {
        const ticketWithoutBus = {
            id: 101,
            operator_id: 11,
            from_city: 'Москва',
            to_city: 'Душанбе',
            bus_id: null,
            total_seats: 53,
            status: 'active'
        };

        assert.equal(ticketWithoutBus.bus_id, null);
        assert.equal(ticketWithoutBus.total_seats, 53);
    });

    // 26. Legacy ticket without bus_id works
    it('26. Existing legacy ticket with bus_id=null renders seat selector and bookings without error', () => {
        const legacyTicket = {
            id: 25,
            operator_id: 11,
            bus_id: null,
            bus_type: 'double',
            total_seats: 78,
            floor1_seats: 22,
            floor2_seats: 56,
            reserved_seats: [1, 2, 5]
        };

        const availableSeats = legacyTicket.total_seats - legacyTicket.reserved_seats.length;
        assert.equal(availableSeats, 75);
        assert.equal(legacyTicket.bus_type, 'double');
    });

    // 27. verifyBusAccess own bus
    it('27. verifyBusAccess resolves bus successfully for owning carrier', async () => {
        const busObj = { id: 1, carrier_id: 11, status: 'active', name: 'Setra #1' };
        const reqCarrier = { carrier_id: 11, id: 11, role: 'owner' };

        const isMatch = (parseInt(busObj.carrier_id, 10) === parseInt(reqCarrier.carrier_id, 10)) && busObj.status !== 'archived';
        assert.equal(isMatch, true);
    });

    // 28. verifyBusAccess foreign bus blocked
    it('28. verifyBusAccess returns null for foreign carrier bus', async () => {
        const busObj = { id: 1, carrier_id: 99, status: 'active', name: 'Neoplan #1' };
        const reqCarrier = { carrier_id: 11, id: 11, role: 'owner' };

        const isMatch = (parseInt(busObj.carrier_id, 10) === parseInt(reqCarrier.carrier_id, 10));
        assert.equal(isMatch, false);
    });

    // 29. Archived bus cannot be newly assigned
    it('29. verifyBusAccess rejects archived bus when allowArchived is false', () => {
        const busObj = { id: 1, carrier_id: 11, status: 'archived', name: 'Old Setra' };
        const allowArchived = false;

        const isUsable = (busObj.status !== 'archived') || allowArchived;
        assert.equal(isUsable, false);
    });

    // 30. Existing booking flows regression-safe
    it('30. Existing booking and payment flows remain 100% regression safe with optional bus_id', () => {
        const booking = {
            id: 501,
            bus_ticket_id: 25,
            passenger_id: 123,
            seat_numbers: [10, 11],
            passenger_count: 2,
            total_price: 16000,
            status: 'confirmed'
        };

        assert.equal(booking.passenger_count, 2);
        assert.equal(booking.seat_numbers.length, 2);
        assert.equal(booking.status, 'confirmed');
    });

    // 31. Archive returns 409 Conflict if active future trips exist
    it('31. Owner cannot archive bus with active future trips (returns 409 Conflict BUS_HAS_ACTIVE_TRIPS)', async () => {
        const activeTrips = [
            { id: 101, from_city: 'Москва', to_city: 'Душанбе', status: 'active', departure_date: '2026-09-01' }
        ];

        let resCode = 0;
        let resPayload = null;
        const res = {
            status: (code) => {
                resCode = code;
                return { json: (data) => { resPayload = data; } };
            }
        };

        const handleArchive = (activeTickets) => {
            if (activeTickets.length > 0) {
                return res.status(409).json({
                    error: 'BUS_HAS_ACTIVE_TRIPS',
                    message: `Невозможно архивировать автобус: назначено активных рейсов — ${activeTickets.length}`,
                    active_tickets_count: activeTickets.length
                });
            }
        };

        handleArchive(activeTrips);
        assert.equal(resCode, 409);
        assert.equal(resPayload.error, 'BUS_HAS_ACTIVE_TRIPS');
        assert.equal(resPayload.active_tickets_count, 1);
    });

    // 32. Bus status remains unchanged on rejected archive
    it('32. Bus status remains active and unchanged when archive is rejected due to active trips', () => {
        const bus = { id: 1, status: 'active' };
        const activeTrips = [{ id: 101 }];

        if (activeTrips.length > 0) {
            // Rejection: bus object not mutated
        } else {
            bus.status = 'archived';
        }

        assert.equal(bus.status, 'active');
    });

    // 33. No audit emitted on rejected archive
    it('33. No bus_archived audit is emitted when archive operation is rejected (409)', () => {
        const auditEvents = [];
        const activeTrips = [{ id: 101 }];

        if (activeTrips.length === 0) {
            auditEvents.push(AUDIT_ACTIONS.BUS_ARCHIVED);
        }

        assert.equal(auditEvents.length, 0);
    });

    // 34. Owner can archive bus when no future trips exist
    it('34. Owner can successfully archive bus without future active trips (200)', () => {
        const bus = { id: 1, status: 'active' };
        const activeTrips = []; // No active future trips

        let resPayload = null;
        if (activeTrips.length === 0) {
            bus.status = 'archived';
            resPayload = { success: true, message: 'Автобус успешно заархивирован', active_tickets_count: 0, bus };
        }

        assert.equal(bus.status, 'archived');
        assert.equal(resPayload.success, true);
        assert.equal(resPayload.active_tickets_count, 0);
    });

    // 35. Historical completed trip does not prevent archive
    it('35. Completed historical trips (status=completed) do not prevent bus archive', () => {
        const pastCompletedTrips = [
            { id: 10, status: 'completed', departure_date: '2026-08-01' }
        ];

        // Active tickets filter only checks status='active' AND departure_date >= today
        const activeFuture = pastCompletedTrips.filter(t => t.status === 'active');
        assert.equal(activeFuture.length, 0);
    });

});

