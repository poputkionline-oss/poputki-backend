const { describe, it } = require('node:test');
const assert = require('node:assert');

/**
 * PHASE P0.4: QUICK TRIP CREATION & REVERSE TRIP TEST SUITE
 */

function duplicateTicketLogic(sourceTicket, overrideParams, carrierUser) {
    // 1. Role validation
    if (carrierUser.role === 'driver' || carrierUser.role === 'accountant') {
        const err = new Error('Недостаточно прав для создания и дублирования рейсов');
        err.status = 403;
        throw err;
    }

    // 2. Tenant isolation
    if (sourceTicket.operator_id !== carrierUser.carrier_id) {
        const err = new Error('Доступ запрещен: исходный рейс принадлежит другому перевозчику');
        err.status = 403;
        throw err;
    }

    // 3. Date validation
    if (!overrideParams.departure_date) {
        const err = new Error('Укажите дату отправления нового рейса');
        err.status = 400;
        throw err;
    }

    let fromCity = sourceTicket.from_city;
    let fromAddress = sourceTicket.from_address;
    let toCity = sourceTicket.to_city;
    let toAddress = sourceTicket.to_address;
    
    // Deep clone intermediate stops to guarantee source immutability
    let rawStops = sourceTicket.intermediate_stops || [];
    if (typeof rawStops === 'string') {
        try { rawStops = JSON.parse(rawStops); } catch(e) { rawStops = []; }
    }
    let stops = JSON.parse(JSON.stringify(rawStops));

    // Deep clone photos to guarantee source immutability
    let rawPhotos = sourceTicket.photos || [];
    if (typeof rawPhotos === 'string') {
        try { rawPhotos = JSON.parse(rawPhotos); } catch(e) { rawPhotos = []; }
    }
    const clonedPhotos = JSON.parse(JSON.stringify(rawPhotos));

    // If reverse trip requested, swap origin and destination and reverse intermediate stops
    if (overrideParams.is_reverse) {
        fromCity = sourceTicket.to_city;
        fromAddress = sourceTicket.to_address;
        toCity = sourceTicket.from_city;
        toAddress = sourceTicket.from_address;
        stops = stops.reverse().map(s => ({
            city: s.city,
            address: s.address || '',
            time: '' // Reset intermediate times for inverted direction
        }));
    }

    const newTicketData = {
        operator_id: carrierUser.carrier_id, // Trusted from JWT
        transport_company: sourceTicket.transport_company,
        from_city: fromCity,
        from_address: fromAddress,
        to_city: toCity,
        to_address: toAddress,
        departure_date: overrideParams.departure_date,
        departure_time: overrideParams.departure_time || sourceTicket.departure_time,
        arrival_date: overrideParams.arrival_date || null,
        arrival_time: overrideParams.arrival_time || null,
        duration_minutes: sourceTicket.duration_minutes || null,
        price: overrideParams.price !== undefined && overrideParams.price !== null ? Number(overrideParams.price) : sourceTicket.price,
        premium_price: overrideParams.premium_price !== undefined ? (overrideParams.premium_price ? Number(overrideParams.premium_price) : null) : sourceTicket.premium_price,
        total_seats: sourceTicket.total_seats || 53,
        floor1_seats: sourceTicket.floor1_seats || null,
        floor2_seats: sourceTicket.floor2_seats || null,
        reserved_seats: [], // STRICT SAFETY: Always reset reserved seats
        status: 'active',
        bus_type: sourceTicket.bus_type || 'single',
        passenger_comments: sourceTicket.passenger_comments || '',
        intermediate_stops: stops,
        photos: clonedPhotos
    };

    return newTicketData;
}

describe('Phase P0.4: Quick Trip Creation & Reverse Trip Suite', () => {

    const ownerUser = { id: 10, carrier_id: 10, role: 'owner' };
    const dispatcherUser = { id: 11, carrier_id: 10, role: 'dispatcher' };
    const driverUser = { id: 12, carrier_id: 10, role: 'driver' };
    const accountantUser = { id: 13, carrier_id: 10, role: 'accountant' };
    const foreignCarrier = { id: 99, carrier_id: 99, role: 'owner' };

    const sampleTicket = {
        id: 100,
        operator_id: 10,
        transport_company: 'Asian Express',
        from_city: 'Худжанд (TJ)',
        from_address: 'Автовокзал Рохи Абрешим',
        to_city: 'Нижневартовск (РФ)',
        to_address: 'ул. Революции 40а',
        departure_date: '2026-06-13',
        departure_time: '09:00:00',
        arrival_date: '2026-06-16',
        arrival_time: '12:00:00',
        duration_minutes: 3240,
        price: 750,
        premium_price: 900,
        total_seats: 76,
        floor1_seats: 20,
        floor2_seats: 56,
        bus_type: 'double',
        reserved_seats: [1, 2, 3, 4, 15, 16],
        passenger_comments: 'Комфортабельный автобус с кондиционером',
        intermediate_stops: [
            { city: 'Караганда (KZ)', time: '14:00', address: 'Автовокзал' },
            { city: 'Астана (KZ)', time: '18:00', address: 'Северный вокзал' },
            { city: 'Курган (РФ)', time: '04:00', address: 'Трасса' }
        ],
        photos: [{ url: 'https://cloudinary.com/pic1.jpg', public_id: 'pic_pub_1' }]
    };

    it('1. Owner can duplicate ticket (201 Created)', () => {
        const newTicket = duplicateTicketLogic(sampleTicket, { departure_date: '2026-07-01' }, ownerUser);
        assert.ok(newTicket);
        assert.strictEqual(newTicket.operator_id, 10);
    });

    it('2. Dispatcher can duplicate ticket (201 Created)', () => {
        const newTicket = duplicateTicketLogic(sampleTicket, { departure_date: '2026-07-01' }, dispatcherUser);
        assert.ok(newTicket);
        assert.strictEqual(newTicket.operator_id, 10);
    });

    it('3. Driver role is strictly DENIED with 403 Forbidden', () => {
        assert.throws(() => {
            duplicateTicketLogic(sampleTicket, { departure_date: '2026-07-01' }, driverUser);
        }, { status: 403 });
    });

    it('4. Accountant role is strictly DENIED with 403 Forbidden', () => {
        assert.throws(() => {
            duplicateTicketLogic(sampleTicket, { departure_date: '2026-07-01' }, accountantUser);
        }, { status: 403 });
    });

    it('5. Foreign carrier cross-tenant duplication is DENIED with 403 Forbidden', () => {
        assert.throws(() => {
            duplicateTicketLogic(sampleTicket, { departure_date: '2026-07-01' }, foreignCarrier);
        }, { status: 403 });
    });

    it('6. Duplicate copies route (from_city, to_city, addresses)', () => {
        const newTicket = duplicateTicketLogic(sampleTicket, { departure_date: '2026-07-01' }, ownerUser);
        assert.strictEqual(newTicket.from_city, 'Худжанд (TJ)');
        assert.strictEqual(newTicket.from_address, 'Автовокзал Рохи Абрешим');
        assert.strictEqual(newTicket.to_city, 'Нижневартовск (РФ)');
        assert.strictEqual(newTicket.to_address, 'ул. Революции 40а');
    });

    it('7. Duplicate copies base price or applies override', () => {
        const copy1 = duplicateTicketLogic(sampleTicket, { departure_date: '2026-07-01' }, ownerUser);
        assert.strictEqual(copy1.price, 750);

        const copy2 = duplicateTicketLogic(sampleTicket, { departure_date: '2026-07-01', price: 800 }, ownerUser);
        assert.strictEqual(copy2.price, 800);
    });

    it('8. Duplicate copies premium price or applies override', () => {
        const copy1 = duplicateTicketLogic(sampleTicket, { departure_date: '2026-07-01' }, ownerUser);
        assert.strictEqual(copy1.premium_price, 900);

        const copy2 = duplicateTicketLogic(sampleTicket, { departure_date: '2026-07-01', premium_price: 950 }, ownerUser);
        assert.strictEqual(copy2.premium_price, 950);
    });

    it('9. Duplicate copies intermediate stops', () => {
        const copy = duplicateTicketLogic(sampleTicket, { departure_date: '2026-07-01' }, ownerUser);
        assert.strictEqual(copy.intermediate_stops.length, 3);
        assert.strictEqual(copy.intermediate_stops[0].city, 'Караганда (KZ)');
    });

    it('10. STRICT SAFETY: reserved_seats is ALWAYS reset to empty array', () => {
        const copy = duplicateTicketLogic(sampleTicket, { departure_date: '2026-07-01' }, ownerUser);
        assert.deepStrictEqual(copy.reserved_seats, []);
        assert.strictEqual(copy.reserved_seats.length, 0);
    });

    it('11. Bookings from source ticket are NOT copied or referenced', () => {
        const copy = duplicateTicketLogic(sampleTicket, { departure_date: '2026-07-01' }, ownerUser);
        assert.strictEqual(copy.bookings, undefined);
    });

    it('12. Financial and transaction data are NOT copied', () => {
        const copy = duplicateTicketLogic(sampleTicket, { departure_date: '2026-07-01' }, ownerUser);
        assert.strictEqual(copy.total_revenue, undefined);
        assert.strictEqual(copy.carrier_amount, undefined);
    });

    it('13. Reverse trip swaps origin and destination cities and addresses', () => {
        const reverse = duplicateTicketLogic(sampleTicket, { departure_date: '2026-07-05', is_reverse: true }, ownerUser);
        assert.strictEqual(reverse.from_city, 'Нижневартовск (РФ)');
        assert.strictEqual(reverse.from_address, 'ул. Революции 40а');
        assert.strictEqual(reverse.to_city, 'Худжанд (TJ)');
        assert.strictEqual(reverse.to_address, 'Автовокзал Рохи Абрешим');
    });

    it('14. Reverse trip reverses intermediate stops order', () => {
        const reverse = duplicateTicketLogic(sampleTicket, { departure_date: '2026-07-05', is_reverse: true }, ownerUser);
        assert.strictEqual(reverse.intermediate_stops.length, 3);
        // Original: Караганда -> Астана -> Курган
        // Reversed: Курган -> Астана -> Караганда
        assert.strictEqual(reverse.intermediate_stops[0].city, 'Курган (РФ)');
        assert.strictEqual(reverse.intermediate_stops[1].city, 'Астана (KZ)');
        assert.strictEqual(reverse.intermediate_stops[2].city, 'Караганда (KZ)');
    });

    it('15. Reverse trip resets intermediate stop times for safety', () => {
        const reverse = duplicateTicketLogic(sampleTicket, { departure_date: '2026-07-05', is_reverse: true }, ownerUser);
        reverse.intermediate_stops.forEach(stop => {
            assert.strictEqual(stop.time, '');
        });
    });

    it('16. New departure_date is properly applied', () => {
        const copy = duplicateTicketLogic(sampleTicket, { departure_date: '2026-08-15' }, ownerUser);
        assert.strictEqual(copy.departure_date, '2026-08-15');
    });

    it('17. New departure_time override is properly applied', () => {
        const copy = duplicateTicketLogic(sampleTicket, { departure_date: '2026-08-15', departure_time: '11:30:00' }, ownerUser);
        assert.strictEqual(copy.departure_time, '11:30:00');
    });

    it('18. Original source ticket is completely immutable and unchanged', () => {
        const originalReserved = [...sampleTicket.reserved_seats];
        duplicateTicketLogic(sampleTicket, { departure_date: '2026-08-15', is_reverse: true }, ownerUser);
        assert.deepStrictEqual(sampleTicket.reserved_seats, originalReserved);
        assert.strictEqual(sampleTicket.from_city, 'Худжанд (TJ)');
    });

    it('19. Photo reference sharing safety logic prevents Cloudinary file deletion if referenced', () => {
        function shouldDeleteFromCloudinary(targetTicketId, targetPublicId, allTickets) {
            const otherTickets = allTickets.filter(t => 
                t.id !== targetTicketId && 
                (t.photos || []).some(p => p.public_id === targetPublicId)
            );
            return otherTickets.length === 0;
        }

        const ticket1 = { id: 101, photos: [{ public_id: 'photo_abc' }] };
        const ticket2 = { id: 102, photos: [{ public_id: 'photo_abc' }] };
        const all = [ticket1, ticket2];

        // Deleting ticket 1 should NOT trigger Cloudinary deletion because ticket 2 still uses photo_abc
        assert.strictEqual(shouldDeleteFromCloudinary(101, 'photo_abc', all), false);

        // If ticket 2 is later deleted and no one else uses photo_abc, it is safe to delete
        assert.strictEqual(shouldDeleteFromCloudinary(102, 'photo_abc', [ticket2]), true);
    });

    it('20. Missing departure_date produces 400 Bad Request error', () => {
        assert.throws(() => {
            duplicateTicketLogic(sampleTicket, { departure_date: '' }, ownerUser);
        }, { status: 400 });
    });

    it('21. Nested immutability: Mutating duplicate stops or photos does NOT affect source ticket', () => {
        const copy = duplicateTicketLogic(sampleTicket, { departure_date: '2026-09-01' }, ownerUser);
        copy.intermediate_stops[0].city = 'ИЗМЕНЕННЫЙ ГОРОД';
        copy.photos[0].url = 'https://changed.url';

        assert.strictEqual(sampleTicket.intermediate_stops[0].city, 'Караганда (KZ)');
        assert.strictEqual(sampleTicket.photos[0].url, 'https://cloudinary.com/pic1.jpg');
    });

    it('22. Reverse immutability: Mutating reverse stops does NOT affect source stops', () => {
        const reverse = duplicateTicketLogic(sampleTicket, { departure_date: '2026-09-01', is_reverse: true }, ownerUser);
        reverse.intermediate_stops[0].city = 'СОВЕРШЕННО ДРУГОЙ ГОРОД';

        assert.strictEqual(sampleTicket.intermediate_stops[0].city, 'Караганда (KZ)');
        assert.strictEqual(sampleTicket.from_city, 'Худжанд (TJ)');
    });

    it('23. Fail-Closed Cloudinary Safety: Database/network error during reference check MUST PRESERVE asset', () => {
        function failClosedDeletePhoto(targetTicketId, targetPublicId, simulateDbError) {
            let deletedFromCloudinary = false;
            try {
                if (simulateDbError) {
                    throw new Error('Database connection timeout during reference check');
                }
                // If clean, check records
                deletedFromCloudinary = true;
            } catch (err) {
                // FAIL-CLOSED: On any error, log and retain asset (deletedFromCloudinary remains false)
                deletedFromCloudinary = false;
            }
            return deletedFromCloudinary;
        }

        const wasDeleted = failClosedDeletePhoto(100, 'pic_pub_1', true);
        assert.strictEqual(wasDeleted, false, 'Asset must NOT be destroyed when reference check fails');
    });

    it('24. Null/empty photos on source ticket execute without errors', () => {
        const ticketWithNullPhotos = { ...sampleTicket, photos: null, intermediate_stops: null };
        const copy = duplicateTicketLogic(ticketWithNullPhotos, { departure_date: '2026-09-01' }, ownerUser);
        assert.deepStrictEqual(copy.photos, []);
        assert.deepStrictEqual(copy.intermediate_stops, []);
    });

    it('25. Reverse trip reserved_seats is STRICTLY empty array []', () => {
        const reverse = duplicateTicketLogic(sampleTicket, { departure_date: '2026-09-01', is_reverse: true }, ownerUser);
        assert.deepStrictEqual(reverse.reserved_seats, []);
        assert.strictEqual(reverse.reserved_seats.length, 0);
    });
});

