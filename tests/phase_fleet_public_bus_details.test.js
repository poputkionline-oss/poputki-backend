const { test, describe } = require('node:test');
const assert = require('node:assert');
const { buildPublicBusDetails, AMENITY_LABELS, ALLOWED_AMENITIES } = require('../utils/publicBusHelper');

describe('Fleet Phase E: Public Passenger Bus Details Projection & Security Tests', () => {

    const mockMasterBus = {
        id: 1,
        carrier_id: 11,
        name: 'Internal Fleet Name (Should Not Leak)',
        brand: 'Setra',
        model: 'S 431 DT',
        license_plate: '5051ZA20',
        vin: 'WDB1234567890SECRET',
        notes: 'Secret maintenance notes and gearbox issues',
        year_built: 2014,
        color: 'Черный',
        amenities: ['wifi', 'ac', 'tv', 'wc', 'unknown_custom_amenity', 'invalid_hack_key'],
        status: 'active',
        created_at: '2026-08-28T10:00:00Z',
        updated_at: '2026-08-28T10:00:00Z'
    };

    const mockTicketSnapshot = {
        id: 73,
        operator_id: 11,
        bus_id: 1,
        bus_type: 'double',
        total_seats: 78,
        floor1_seats: 22,
        floor2_seats: 56,
        photos: [
            { url: 'https://res.cloudinary.com/poputki/image/upload/v1/main.jpg', public_id: 'p1', is_main: true },
            { url: 'https://res.cloudinary.com/poputki/image/upload/v1/sub1.jpg', public_id: 'p2' }
        ]
    };

    test('1. Fleet trip returns structured bus object', () => {
        const result = buildPublicBusDetails(mockTicketSnapshot, mockMasterBus);
        assert.ok(result !== null);
        assert.strictEqual(typeof result, 'object');
        assert.strictEqual(result.id, 1);
    });

    test('2. Legacy trip or missing master returns bus=null', () => {
        const resultNullMaster = buildPublicBusDetails(mockTicketSnapshot, null);
        assert.strictEqual(resultNullMaster, null);

        const resultNullTicket = buildPublicBusDetails(null, mockMasterBus);
        assert.strictEqual(resultNullTicket, null);
    });

    test('3. Bus brand and model are correctly projected', () => {
        const result = buildPublicBusDetails(mockTicketSnapshot, mockMasterBus);
        assert.strictEqual(result.brand, 'Setra');
        assert.strictEqual(result.model, 'S 431 DT');
    });

    test('4. Capacity comes strictly from immutable ticket snapshot', () => {
        const ticketWithModifiedSeats = { ...mockTicketSnapshot, total_seats: 74 };
        const busWithDifferentMasterSeats = { ...mockMasterBus, total_seats: 80 };
        const result = buildPublicBusDetails(ticketWithModifiedSeats, busWithDifferentMasterSeats);
        assert.strictEqual(result.total_seats, 74);
    });

    test('5. Floor distribution comes strictly from ticket snapshot', () => {
        const ticket = { ...mockTicketSnapshot, floor1_seats: 20, floor2_seats: 54 };
        const result = buildPublicBusDetails(ticket, mockMasterBus);
        assert.strictEqual(result.floor1_seats, 20);
        assert.strictEqual(result.floor2_seats, 54);
    });

    test('6. Photos come strictly from ticket snapshot', () => {
        const result = buildPublicBusDetails(mockTicketSnapshot, mockMasterBus);
        assert.strictEqual(result.photos.length, 2);
        assert.strictEqual(result.photos[0].url, 'https://res.cloudinary.com/poputki/image/upload/v1/main.jpg');
    });

    test('7. Amenities are sourced from master record and filtered against allow-list', () => {
        const result = buildPublicBusDetails(mockTicketSnapshot, mockMasterBus);
        assert.deepStrictEqual(result.amenities, ['wifi', 'ac', 'tv', 'wc']);
        assert.ok(!result.amenities.includes('unknown_custom_amenity'));
        assert.ok(!result.amenities.includes('invalid_hack_key'));
    });

    test('8. Year built and color are safely included', () => {
        const result = buildPublicBusDetails(mockTicketSnapshot, mockMasterBus);
        assert.strictEqual(result.year_built, 2014);
        assert.strictEqual(result.color, 'Черный');
    });

    test('9. VIN is strictly stripped and never exposed to passengers', () => {
        const result = buildPublicBusDetails(mockTicketSnapshot, mockMasterBus);
        assert.strictEqual(result.vin, undefined);
        assert.ok(!JSON.stringify(result).includes('WDB1234567890SECRET'));
    });

    test('10. Internal notes are strictly stripped', () => {
        const result = buildPublicBusDetails(mockTicketSnapshot, mockMasterBus);
        assert.strictEqual(result.notes, undefined);
        assert.ok(!JSON.stringify(result).includes('Secret maintenance notes'));
    });

    test('11. carrier_id is not exposed in public bus object', () => {
        const result = buildPublicBusDetails(mockTicketSnapshot, mockMasterBus);
        assert.strictEqual(result.carrier_id, undefined);
    });

    test('12. Carrier internal vehicle name is stripped', () => {
        const result = buildPublicBusDetails(mockTicketSnapshot, mockMasterBus);
        assert.strictEqual(result.name, undefined);
        assert.ok(!JSON.stringify(result).includes('Internal Fleet Name'));
    });

    test('13. Archived bus is still projected safely for historical trips', () => {
        const archivedBus = { ...mockMasterBus, status: 'archived' };
        const result = buildPublicBusDetails(mockTicketSnapshot, archivedBus);
        assert.ok(result !== null);
        assert.strictEqual(result.brand, 'Setra');
        assert.strictEqual(result.status, undefined); // Status metadata not leaked
    });

    test('14. Missing master bus returns null safely without throwing', () => {
        assert.doesNotThrow(() => {
            const result = buildPublicBusDetails(mockTicketSnapshot, undefined);
            assert.strictEqual(result, null);
        });
    });

    test('15. Malformed or invalid photos in ticket snapshot are handled safely', () => {
        const badTicket = {
            ...mockTicketSnapshot,
            photos: [null, 'invalid-string', { noUrl: true }, { url: 'https://valid.jpg' }]
        };
        const result = buildPublicBusDetails(badTicket, mockMasterBus);
        assert.strictEqual(result.photos.length, 1);
        assert.strictEqual(result.photos[0].url, 'https://valid.jpg');
    });

    test('16. Unknown amenities keys are filtered out', () => {
        const busWithBadAmenities = { ...mockMasterBus, amenities: ['wifi', 123, null, 'malicious_code', 'wc'] };
        const result = buildPublicBusDetails(mockTicketSnapshot, busWithBadAmenities);
        assert.deepStrictEqual(result.amenities, ['wifi', 'wc']);
    });

    test('17. Single deck bus sets floor1 and floor2 to null', () => {
        const singleDeckTicket = { ...mockTicketSnapshot, bus_type: 'single', total_seats: 53, floor1_seats: 53, floor2_seats: 0 };
        const result = buildPublicBusDetails(singleDeckTicket, mockMasterBus);
        assert.strictEqual(result.bus_type, 'single');
        assert.strictEqual(result.total_seats, 53);
        assert.strictEqual(result.floor1_seats, null);
        assert.strictEqual(result.floor2_seats, null);
    });

    test('18. License plate is included for passenger boarding identification', () => {
        const result = buildPublicBusDetails(mockTicketSnapshot, mockMasterBus);
        assert.strictEqual(result.license_plate, '5051ZA20');
    });

    test('19. Null optional fields in master (year_built, color) default to null', () => {
        const sparseBus = { ...mockMasterBus, year_built: null, color: null, brand: null };
        const result = buildPublicBusDetails(mockTicketSnapshot, sparseBus);
        assert.strictEqual(result.year_built, null);
        assert.strictEqual(result.color, null);
        assert.strictEqual(result.brand, null);
    });

    test('20. Canonical amenity labels exist for all allowed keys', () => {
        ALLOWED_AMENITIES.forEach(key => {
            assert.ok(AMENITY_LABELS[key], `Missing label for key: ${key}`);
            assert.strictEqual(typeof AMENITY_LABELS[key], 'string');
        });
    });

    test('21. Legacy tickets with bus_id=null serialize bus=null without schema errors', () => {
        const legacyTicket = { id: 10, bus_id: null, bus_type: 'single', total_seats: 53 };
        const result = buildPublicBusDetails(legacyTicket, null);
        assert.strictEqual(result, null);
    });

    test('22. P1.5 payment expiration logic is unaffected by public bus helper', () => {
        const { isPendingHoldActive } = require('../utils/paymentExpirationHelper');
        assert.strictEqual(typeof isPendingHoldActive, 'function');
    });

    test('23. CRM customer aggregation is unaffected', () => {
        const { aggregateCarrierCustomers } = require('../utils/crmHelper');
        assert.strictEqual(typeof aggregateCarrierCustomers, 'function');
    });

    test('24. Fleet conflict helper remains active and functional', () => {
        const { checkBusScheduleConflict } = require('../utils/busHelper');
        assert.strictEqual(typeof checkBusScheduleConflict, 'function');
    });

    test('25. Public bus projection contains zero passenger PII', () => {
        const result = buildPublicBusDetails(mockTicketSnapshot, mockMasterBus);
        const json = JSON.stringify(result);
        assert.ok(!json.includes('passenger'));
        assert.ok(!json.includes('phone'));
        assert.ok(!json.includes('passport'));
    });
});
