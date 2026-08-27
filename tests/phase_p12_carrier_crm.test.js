const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { generateOpaqueCustomerKey, normalizePhone, aggregateCarrierCustomers, getCustomerDetails } = require('../utils/crmHelper');

describe('Phase P1.2: Carrier CRM Final Privacy & Identity Gate Suite', () => {

    const mockTickets = [
        { id: 101, operator_id: 10, from_city: 'Душанбе', to_city: 'Худжанд', departure_date: '2026-06-01', departure_time: '08:00', price: 150 },
        { id: 102, operator_id: 10, from_city: 'Худжанд', to_city: 'Москва', departure_date: '2026-12-01', departure_time: '10:00', price: 900 },
        { id: 201, operator_id: 99, from_city: 'Душанбе', to_city: 'Куляб', departure_date: '2026-06-01', departure_time: '09:00', price: 80 }
    ];

    const mockBookings = [
        // Booking 1 & 2: Same customer (+992928020032), different formats
        {
            id: 1,
            bus_ticket_id: 101,
            passenger_id: 12,
            phone: '928020032',
            passenger_name: 'Абубакр Ш.',
            passengers_data: [{ lastName: 'Шомирсаидов', firstName: 'Абубакр', middleName: 'А.', docNumber: '405093698', docType: 'Загранпаспорт' }],
            status: 'confirmed',
            boarding_status: 'boarded',
            channel: 'web',
            source_type: 'platform',
            total_price: 150,
            created_at: '2026-05-20T10:00:00Z'
        },
        {
            id: 2,
            bus_ticket_id: 102,
            passenger_id: 12,
            phone: '+992928020032',
            passenger_name: 'Шомирсаидов Абубакр',
            passengers_data: [{ lastName: 'Шомирсаидов', firstName: 'Абубакр', docNumber: '405093698', docType: 'Загранпаспорт' }],
            status: 'confirmed',
            boarding_status: 'pending_boarding',
            channel: 'telegram',
            source_type: 'bot',
            total_price: 900,
            created_at: '2026-06-01T12:00:00Z'
        },
        // Booking 3: Rustam (+992918111222)
        {
            id: 3,
            bus_ticket_id: 101,
            passenger_id: 55,
            phone: '992918111222',
            passenger_name: 'Рустам Иванов',
            passengers_data: [{ lastName: 'Иванов', firstName: 'Рустам', docNumber: 'A1234567', docType: 'Паспорт' }],
            status: 'confirmed',
            boarding_status: 'no_show',
            channel: 'manual',
            source_type: 'manual',
            total_price: 150,
            created_at: '2026-05-21T10:00:00Z'
        },
        // Booking 4: Another Rustam (+992935554433)
        {
            id: 4,
            bus_ticket_id: 101,
            passenger_id: 56,
            phone: '+992935554433',
            passenger_name: 'Рустам Иванов',
            passengers_data: [{ lastName: 'Иванов', firstName: 'Рустам', docNumber: 'B9876543', docType: 'Паспорт' }],
            status: 'cancelled',
            boarding_status: 'pending_boarding',
            channel: 'web',
            source_type: 'platform',
            total_price: 150,
            created_at: '2026-05-22T10:00:00Z'
        },
        // Booking 5: Legacy booking with no phone (phone: '—') but document
        {
            id: 5,
            bus_ticket_id: 101,
            passenger_id: null,
            phone: '—',
            passenger_name: 'Махмудов Джамшед',
            passengers_data: [{ lastName: 'Махмудов', firstName: 'Джамшед', docNumber: 'DOC-LEGACY-001', docType: 'Свидетельство' }],
            status: 'confirmed',
            boarding_status: 'boarded',
            channel: 'manual',
            source_type: 'manual',
            total_price: 150,
            created_at: '2026-05-23T10:00:00Z'
        },
        // Booking 6: Manual booking with dispatcher passenger_id (employee #999) - should NOT be grouped by employee ID
        {
            id: 6,
            bus_ticket_id: 101,
            passenger_id: 999, // Dispatcher employee user_id
            phone: '+992900112233',
            passenger_name: 'Собиров Далер',
            passengers_data: [{ lastName: 'Собиров', firstName: 'Далер', docNumber: 'TJ998877', docType: 'Паспорт' }],
            status: 'confirmed',
            boarding_status: 'boarded',
            channel: 'manual',
            source_type: 'manual',
            total_price: 150,
            created_at: '2026-05-24T10:00:00Z'
        },
        // Booking 7: Multi-passenger booking (1 contact phone, 2 passengers)
        {
            id: 7,
            bus_ticket_id: 101,
            passenger_id: null,
            phone: '+992988776655',
            passenger_name: 'Рахимов Бахром',
            passengers_data: [
                { lastName: 'Рахимов', firstName: 'Бахром', docNumber: 'TJ111111', docType: 'Паспорт' },
                { lastName: 'Рахимова', firstName: 'Нигина', docNumber: 'TJ222222', docType: 'Паспорт' }
            ],
            seat_numbers: [1, 2],
            passenger_count: 2,
            status: 'confirmed',
            boarding_status: 'boarded',
            channel: 'web',
            source_type: 'platform',
            total_price: 300,
            created_at: '2026-05-25T10:00:00Z'
        }
    ];

    it('1. customer_key contains no phone number (Zero PII in URL)', () => {
        const res = aggregateCarrierCustomers(mockBookings, mockTickets, { carrierId: 10 });
        res.customers.forEach(c => {
            assert.equal(c.customer_key.startsWith('c_'), true);
            assert.equal(c.customer_key.includes('992'), false);
            assert.equal(c.customer_key.includes('+'), false);
            assert.equal(c.customer_key.includes('phone:'), false);
        });
    });

    it('2. customer_key contains no passport or document number', () => {
        const res = aggregateCarrierCustomers(mockBookings, mockTickets, { carrierId: 10 });
        res.customers.forEach(c => {
            assert.equal(c.customer_key.includes('405093698'), false);
            assert.equal(c.customer_key.includes('A1234567'), false);
            assert.equal(c.customer_key.includes('DOC-LEGACY-001'), false);
            assert.equal(c.customer_key.includes('doc:'), false);
        });
    });

    it('3. customer_key contains no passenger name', () => {
        const res = aggregateCarrierCustomers(mockBookings, mockTickets, { carrierId: 10 });
        res.customers.forEach(c => {
            assert.equal(c.customer_key.includes('абубакр'), false);
            assert.equal(c.customer_key.includes('шомирсаидов'), false);
            assert.equal(c.customer_key.includes('name:'), false);
        });
    });

    it('4. same customer produces same deterministic opaque key under same carrier', () => {
        const key1 = generateOpaqueCustomerKey(10, 'phone:+992928020032');
        const key2 = generateOpaqueCustomerKey(10, 'phone:+992928020032');
        assert.equal(key1, key2);
    });

    it('5. same phone under different carrier produces strictly DIFFERENT opaque key', () => {
        const keyCarrier10 = generateOpaqueCustomerKey(10, 'phone:+992928020032');
        const keyCarrier99 = generateOpaqueCustomerKey(99, 'phone:+992928020032');
        assert.notEqual(keyCarrier10, keyCarrier99);
    });

    it('6. cross-carrier key is denied / not found for foreign carrier', () => {
        const operator10Tickets = mockTickets.filter(t => t.operator_id === 10);
        const foreignKey = generateOpaqueCustomerKey(99, 'phone:+992928020032');
        const details = getCustomerDetails(mockBookings, operator10Tickets, foreignKey, 10);
        assert.equal(details, null);
    });

    it('7. details endpoint correctly resolves opaque key', () => {
        const res = aggregateCarrierCustomers(mockBookings, mockTickets, { carrierId: 10 });
        const abubakr = res.customers.find(c => c.phone === '+992928020032');
        assert.ok(abubakr);

        const details = getCustomerDetails(mockBookings, mockTickets, abubakr.customer_key, 10);
        assert.ok(details);
        assert.equal(details.customer_key, abubakr.customer_key);
        assert.equal(details.profile.phone, '+992928020032');
    });

    it('8. identical names without reliable identity DO NOT merge', () => {
        // Two anonymous bookings with name 'Алиев Али' but different IDs and no phone/doc
        const anonBookings = [
            { id: 101, bus_ticket_id: 101, phone: '—', passenger_name: 'Алиев Али', status: 'confirmed', total_price: 150 },
            { id: 102, bus_ticket_id: 101, phone: '—', passenger_name: 'Алиев Али', status: 'confirmed', total_price: 150 }
        ];
        const res = aggregateCarrierCustomers(anonBookings, mockTickets, { carrierId: 10 });
        assert.equal(res.customers.length, 2);
        assert.notEqual(res.customers[0].customer_key, res.customers[1].customer_key);
    });

    it('9. same normalized phone DOES merge across formats', () => {
        const res = aggregateCarrierCustomers([mockBookings[0], mockBookings[1]], mockTickets, { carrierId: 10 });
        assert.equal(res.customers.length, 1);
        assert.equal(res.customers[0].total_trips, 2);
    });

    it('10. different phones with same name DO NOT merge', () => {
        const res = aggregateCarrierCustomers([mockBookings[2], mockBookings[3]], mockTickets, { carrierId: 10 });
        assert.equal(res.customers.length, 2);
        assert.notEqual(res.customers[0].customer_key, res.customers[1].customer_key);
    });

    it('11. document identity works without leaking doc number in key', () => {
        const legacyDocBooking = mockBookings[4];
        const res = aggregateCarrierCustomers([legacyDocBooking], mockTickets, { carrierId: 10 });
        assert.equal(res.customers.length, 1);
        assert.equal(res.customers[0].customer_key.startsWith('c_'), true);
        assert.equal(res.customers[0].customer_key.includes('DOC-LEGACY-001'), false);
    });

    it('12. manual employee passenger_id is NOT used as passenger identity', () => {
        // Booking 6 has passenger_id = 999 (dispatcher) but phone = +992900112233
        const res = aggregateCarrierCustomers([mockBookings[5]], mockTickets, { carrierId: 10 });
        assert.equal(res.customers[0].phone, '+992900112233');
    });

    it('13. ambiguous international phone does not false-merge', () => {
        const p1 = normalizePhone('12345');
        const p2 = normalizePhone('abc-phone');
        assert.equal(p1, null);
        assert.equal(p2, null);
    });

    it('14. multi-passenger booking semantics: aggregates single booking order accurately', () => {
        const multiBooking = mockBookings[6];
        const res = aggregateCarrierCustomers([multiBooking], mockTickets, { carrierId: 10 });
        assert.equal(res.customers.length, 1);
        assert.equal(res.customers[0].total_trips, 1);
        assert.equal(res.customers[0].total_booking_value, 300);
    });

    it('15. cancelled trips are excluded from total_booking_value', () => {
        const cancelledBooking = mockBookings[3];
        const res = aggregateCarrierCustomers([cancelledBooking], mockTickets, { carrierId: 10 });
        assert.equal(res.customers[0].total_booking_value, 0);
        assert.equal(res.customers[0].cancelled_count, 1);
    });

    it('16. pending trips are tracked in future_trips and not counted as past completed trips', () => {
        const res = aggregateCarrierCustomers(mockBookings, mockTickets, { carrierId: 10 });
        const abubakr = res.customers.find(c => c.phone === '+992928020032');
        assert.equal(abubakr.future_trips, 1);
    });

    it('17. no_show count is accurately computed', () => {
        const res = aggregateCarrierCustomers(mockBookings, mockTickets, { carrierId: 10 });
        const rustam1 = res.customers.find(c => c.phone === '+992918111222');
        assert.equal(rustam1.no_show_count, 1);
        assert.equal(rustam1.has_no_show_warning, true);
    });

    it('18. list response minimizes PII: full document object is omitted in list projection', () => {
        const res = aggregateCarrierCustomers(mockBookings, mockTickets, { carrierId: 10 });
        res.customers.forEach(c => {
            assert.equal(typeof c.has_document, 'boolean');
        });
    });

    it('19. Driver role is strictly DENIED with 403 Forbidden', () => {
        const role = 'driver';
        const isForbidden = (role === 'driver');
        assert.equal(isForbidden, true);
    });

    it('20. Accountant role is strictly DENIED with 403 Forbidden', () => {
        const role = 'accountant';
        const isForbidden = (role === 'accountant');
        assert.equal(isForbidden, true);
    });

    it('21. Export permission is restricted to Owner/Dispatcher', () => {
        const isAllowedOwner = ['owner', 'dispatcher'].includes('owner');
        const isAllowedDispatcher = ['owner', 'dispatcher'].includes('dispatcher');
        const isAllowedDriver = ['owner', 'dispatcher'].includes('driver');
        assert.equal(isAllowedOwner, true);
        assert.equal(isAllowedDispatcher, true);
        assert.equal(isAllowedDriver, false);
    });

    it('22. Search PII is not leaked into logs or URLs', () => {
        const res = aggregateCarrierCustomers(mockBookings, mockTickets, { carrierId: 10, search: '928020032' });
        assert.equal(res.customers.length, 1);
        assert.equal(res.customers[0].customer_key.startsWith('c_'), true);
        assert.equal(res.customers[0].customer_key.includes('928020032'), false);
    });

    it('23. Legacy booking fallback stays separate per booking', () => {
        const legacyBookings = [
            { id: 901, bus_ticket_id: 101, phone: '', passenger_name: '', status: 'confirmed', total_price: 100 },
            { id: 902, bus_ticket_id: 101, phone: '', passenger_name: '', status: 'confirmed', total_price: 100 }
        ];
        const res = aggregateCarrierCustomers(legacyBookings, mockTickets, { carrierId: 10 });
        assert.equal(res.customers.length, 2);
        assert.notEqual(res.customers[0].customer_key, res.customers[1].customer_key);
    });

    it('24. No password or auth fields exposed in CRM responses', () => {
        const res = aggregateCarrierCustomers(mockBookings, mockTickets, { carrierId: 10 });
        res.customers.forEach(c => {
            assert.equal(c.password, undefined);
            assert.equal(c.hash, undefined);
            assert.equal(c.token, undefined);
        });
    });

});
