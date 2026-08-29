/**
 * phase_ticket_module_v1.test.js — Automated Test Suite for Passenger Ticket Module V1
 * POPUTKI.ONLINE
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
    generateTicketVerificationToken,
    verifyTicketToken,
    extractBookingIdFromToken,
    formatTicketNumber,
    buildPassengerTicketProjection,
    buildTripPrintManifest
} = require('../utils/ticketHelper');

describe('TICKET MODULE V1 — CORE TEST SUITE', () => {

    const sampleTicket = {
        id: 105,
        operator_id: 11,
        transport_company: 'Asian Express',
        from_city: 'Душанбе',
        to_city: 'Худжанд',
        from_address: 'Автовокзал Азиатский экспресс',
        to_address: 'Центральный автовокзал',
        departure_date: '2026-09-01',
        departure_time: '08:30:00',
        arrival_date: '2026-09-01',
        arrival_time: '14:30:00',
        duration_minutes: 360,
        price: 150,
        total_seats: 53,
        bus_type: 'single',
        bus_id: 42,
        photos: [{ url: 'https://example.com/bus.jpg' }]
    };

    const sampleBusMaster = {
        id: 42,
        carrier_id: 11,
        brand: 'Setra',
        model: 'S 431 DT',
        license_plate: '5051ZA20',
        color: 'Белый',
        year_built: 2020,
        amenities: ['wifi', 'ac', 'usb', 'wc'],
        vin: 'WDB1234567890SECRET',
        notes: 'Secret maintenance note'
    };

    const sampleOnlineBooking = {
        id: 139,
        bus_ticket_id: 105,
        passenger_id: 55,
        passenger_name: 'Шомирсаидов Али',
        seat_numbers: [12],
        passenger_count: 1,
        passengers_data: [
            {
                lastName: 'Шомирсаидов',
                firstName: 'Али',
                middleName: 'Каримович',
                gender: 'male',
                docType: 'Загранпаспорт',
                docNumber: 'A1234567',
                phone: '+992900112233'
            }
        ],
        phone: '+992900112233',
        status: 'confirmed',
        boarding_status: 'pending_boarding',
        total_price: 150,
        commission_rate: 10,
        commission_amount: 15,
        carrier_amount: 135,
        channel: 'web',
        source_type: 'platform',
        created_at: '2026-08-30T01:00:00.000Z'
    };

    it('1. Confirmed booking produces valid ticket projection with POPUTKI.ONLINE branding', () => {
        const ticket = buildPassengerTicketProjection(sampleOnlineBooking, sampleTicket, sampleBusMaster);
        assert.ok(ticket);
        assert.equal(ticket.brand, 'POPUTKI.ONLINE');
        assert.equal(ticket.ticketNumber, 'POP-000139');
        assert.equal(ticket.isValid, true);
        assert.equal(ticket.status, 'confirmed');
        assert.equal(ticket.statusLabel, 'Подтвержден');
    });

    it('2. Pending payment booking is marked as unpaid / not valid ticket', () => {
        const unpaidBooking = { ...sampleOnlineBooking, status: 'pending_payment' };
        const ticket = buildPassengerTicketProjection(unpaidBooking, sampleTicket, sampleBusMaster);
        assert.equal(ticket.isValid, false);
        assert.equal(ticket.isPendingPayment, true);
        assert.equal(ticket.statusLabel, 'Ожидает оплаты');
        assert.equal(ticket.payment.paidAmount, 0);
    });

    it('3. Cancelled booking is marked as cancelled state', () => {
        const cancelledBooking = { ...sampleOnlineBooking, status: 'cancelled' };
        const ticket = buildPassengerTicketProjection(cancelledBooking, sampleTicket, sampleBusMaster);
        assert.equal(ticket.isValid, false);
        assert.equal(ticket.isCancelled, true);
        assert.equal(ticket.statusLabel, 'Отменен');
    });

    it('4. Manual confirmed booking produces valid ticket immediately with 0 online paid and full carrier amount', () => {
        const manualBooking = {
            id: 201,
            bus_ticket_id: 105,
            passenger_id: 11,
            passenger_name: 'Ручной Пассажир',
            seat_numbers: [5],
            passenger_count: 1,
            passengers_data: [],
            status: 'confirmed',
            boarding_status: 'pending_boarding',
            total_price: 150,
            commission_rate: 0,
            commission_amount: 0,
            carrier_amount: 150,
            channel: 'manual',
            source_type: 'manual',
            created_at: '2026-08-30T01:30:00.000Z'
        };
        const ticket = buildPassengerTicketProjection(manualBooking, sampleTicket, sampleBusMaster);
        assert.equal(ticket.isValid, true);
        assert.equal(ticket.payment.isManual, true);
        assert.equal(ticket.payment.totalPrice, 150);
        assert.equal(ticket.payment.paidAmount, 0);
        assert.equal(ticket.payment.remainingAmount, 150);
    });

    it('5. Online confirmed booking calculates correct paid online and remaining to carrier', () => {
        const ticket = buildPassengerTicketProjection(sampleOnlineBooking, sampleTicket, sampleBusMaster);
        assert.equal(ticket.payment.totalPrice, 150);
        assert.equal(ticket.payment.paidAmount, 15);
        assert.equal(ticket.payment.remainingAmount, 135);
    });

    it('6. Legacy trip with bus_id = null renders safely with fallback without crashing', () => {
        const legacyTicket = { ...sampleTicket, bus_id: null, bus_model: 'Mercedes Sprinter' };
        const result = buildPassengerTicketProjection(sampleOnlineBooking, legacyTicket, null);
        assert.ok(result);
        assert.equal(result.bus.id, null);
        assert.equal(result.bus.model, 'Mercedes Sprinter');
        assert.equal(result.bus.license_plate, null);
    });

    it('7. Fleet bus master vehicle data is included safely (brand, model, license_plate)', () => {
        const ticket = buildPassengerTicketProjection(sampleOnlineBooking, sampleTicket, sampleBusMaster);
        assert.equal(ticket.bus.brand, 'Setra');
        assert.equal(ticket.bus.model, 'S 431 DT');
        assert.equal(ticket.bus.license_plate, '5051ZA20');
        assert.equal(ticket.bus.color, 'Белый');
    });

    it('8. Passenger phone and carrier internal secrets are NOT leaked in public ticket projection', () => {
        const publicTicket = buildPassengerTicketProjection(sampleOnlineBooking, sampleTicket, sampleBusMaster, { isPublic: true });
        
        // Ensure private vehicle secrets are stripped
        assert.equal(publicTicket.bus.vin, undefined);
        assert.equal(publicTicket.bus.notes, undefined);
        assert.equal(publicTicket.bus.carrier_id, undefined);

        // In public mode, document numbers/types and carrier phone are completely stripped
        assert.equal(publicTicket.passenger.items[0].docNumber, undefined);
        assert.equal(publicTicket.passenger.items[0].docType, undefined);
        assert.equal(publicTicket.carrier.operatorPhone, null);
    });

    it('9. Correct seat numbers and multi-seat passenger items are formatted properly', () => {
        const multiSeatBooking = {
            id: 250,
            bus_ticket_id: 105,
            passenger_id: 55,
            seat_numbers: [10, 11],
            passenger_count: 2,
            passengers_data: [
                { lastName: 'Алиев', firstName: 'Фарход', seatNumber: 10, docType: 'Паспорт', docNumber: '111' },
                { lastName: 'Алиева', firstName: 'Нигина', seatNumber: 11, docType: 'Паспорт', docNumber: '222' }
            ],
            status: 'confirmed',
            total_price: 300,
            commission_amount: 30,
            carrier_amount: 270,
            created_at: '2026-08-30T02:00:00.000Z'
        };
        const ticket = buildPassengerTicketProjection(multiSeatBooking, sampleTicket, sampleBusMaster);
        assert.equal(ticket.passenger.passengerCount, 2);
        assert.equal(ticket.passenger.seatNumbersDisplay, '10, 11');
        assert.equal(ticket.passenger.items.length, 2);
        assert.equal(ticket.passenger.items[0].name, 'Алиев Фарход');
        assert.equal(ticket.passenger.items[0].seat, 10);
        assert.equal(ticket.passenger.items[1].name, 'Алиева Нигина');
        assert.equal(ticket.passenger.items[1].seat, 11);
    });

    it('10. Route and timing information are clean and formatted', () => {
        const ticket = buildPassengerTicketProjection(sampleOnlineBooking, sampleTicket, sampleBusMaster);
        assert.equal(ticket.route.fromCity, 'Душанбе');
        assert.equal(ticket.route.toCity, 'Худжанд');
        assert.equal(ticket.route.departureDate, '2026-09-01');
        assert.equal(ticket.route.departureTime, '08:30');
        assert.equal(ticket.route.arrivalTime, '14:30');
    });

    it('11. Null/undefined pricing fields are handled safely without NaN', () => {
        const messyBooking = {
            id: 999,
            bus_ticket_id: 105,
            status: 'confirmed',
            total_price: null,
            commission_amount: null,
            carrier_amount: undefined,
            seat_numbers: null,
            created_at: '2026-08-30T00:00:00Z'
        };
        const ticket = buildPassengerTicketProjection(messyBooking, sampleTicket, null);
        assert.equal(ticket.payment.totalPrice, 0);
        assert.equal(ticket.payment.paidAmount, 0);
        assert.equal(ticket.payment.remainingAmount, 0);
        assert.equal(isNaN(ticket.payment.totalPrice), false);
    });

    it('12. Verification token generation uses 32-hex HMAC signature and domain-separated payload', () => {
        const token = generateTicketVerificationToken(139);
        assert.ok(token.startsWith('139-'));
        const parts = token.split('-');
        assert.equal(parts[0], '139');
        assert.equal(parts[1].length, 32); // 32 hex chars (128-bit truncated HMAC)
        assert.equal(/^[a-f0-9]{32}$/.test(parts[1]), true);

        // Verification tests
        assert.equal(verifyTicketToken(token, 139), true);
        assert.equal(verifyTicketToken(token, 140), false); // Tampered ID
        assert.equal(verifyTicketToken(`139-${'a'.repeat(32)}`, 139), false); // Tampered Signature
        assert.equal(verifyTicketToken('139-short', 139), false); // Malformed signature
        assert.equal(verifyTicketToken('invalid-token', 139), false); // Non-numeric
        assert.equal(extractBookingIdFromToken(token), 139);
        assert.equal(extractBookingIdFromToken('invalid'), null);
        assert.equal(extractBookingIdFromToken('139-short'), null);
    });

    it('13. Bulk print manifest includes ONLY confirmed bookings and excludes cancelled/pending', () => {
        const bookings = [
            { id: 1, seat_numbers: [20], status: 'cancelled', total_price: 150 },
            { id: 2, seat_numbers: [5], status: 'confirmed', total_price: 150, passenger_name: 'Пассажир 5' },
            { id: 3, seat_numbers: [1], status: 'confirmed', total_price: 150, passenger_name: 'Пассажир 1' },
            { id: 4, seat_numbers: [15], status: 'pending_payment', total_price: 150 },
            { id: 5, seat_numbers: [12], status: 'confirmed', total_price: 150, passenger_name: 'Пассажир 12' }
        ];

        const manifest = buildTripPrintManifest(sampleTicket, bookings, sampleBusMaster);
        
        // Only 3 confirmed tickets
        assert.equal(manifest.length, 3);
        
        // Manifest must be strictly sorted by seat number: 1, 5, 12
        assert.equal(manifest[0].passenger.seats[0], 1);
        assert.equal(manifest[1].passenger.seats[0], 5);
        assert.equal(manifest[2].passenger.seats[0], 12);
    });

    it('14. Boarding status human readable translations work correctly', () => {
        const b1 = { ...sampleOnlineBooking, boarding_status: 'pending_boarding' };
        const b2 = { ...sampleOnlineBooking, boarding_status: 'boarded' };
        const b3 = { ...sampleOnlineBooking, boarding_status: 'no_show' };

        assert.equal(buildPassengerTicketProjection(b1, sampleTicket).boardingLabel, 'Ожидает посадки');
        assert.equal(buildPassengerTicketProjection(b2, sampleTicket).boardingLabel, 'Пассажир сел');
        assert.equal(buildPassengerTicketProjection(b3, sampleTicket).boardingLabel, 'Не явился');
    });

    it('15. Ticket number formatting is zero-padded with POP- prefix', () => {
        assert.equal(formatTicketNumber(7), 'POP-000007');
        assert.equal(formatTicketNumber(139), 'POP-000139');
        assert.equal(formatTicketNumber(10245), 'POP-010245');
    });
});
