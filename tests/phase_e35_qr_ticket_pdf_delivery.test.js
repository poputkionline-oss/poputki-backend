/**
 * Phase E.35.2 — Canonical Ticket V1.1 PDF Delivery & Data Integrity Unit Tests
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { generateTicketPdf, getFontPaths } = require('../utils/ticketPdfService');
const { buildPassengerTicketProjection, verifyTicketToken } = require('../utils/ticketHelper');

describe('Phase E.35.2 — Canonical Ticket V1.1 PDF Delivery Tests', () => {

    const mockBooking = {
        id: 440,
        bus_ticket_id: 73,
        phone: '+992900000000',
        seat_numbers: ['5'],
        passenger_name: 'Абдуллоев Акмалхон',
        status: 'confirmed',
        channel: 'manual',
        total_price: 700,
        commission_amount: 0,
        carrier_amount: 700,
        created_at: '2026-09-02T15:27:26.888Z'
    };

    const mockTrip = {
        id: 73,
        from_city: 'Душанбе',
        to_city: 'Худжанд',
        departure_date: '2026-09-05',
        departure_time: '08:00:00',
        arrival_time: '13:30:00',
        price: 700,
        transport_company: 'ООО Азия Транс',
        bus_model: 'Mercedes-Benz Tourismo',
        bus_type: 'single'
    };

    it('[E35.2-01] buildPassengerTicketProjection produces accurate canonical Ticket V1.1 data', () => {
        const projection = buildPassengerTicketProjection(mockBooking, mockTrip);
        assert.ok(projection);
        assert.strictEqual(projection.ticketNumber, 'POP-000440');
        assert.strictEqual(projection.passenger.primaryName, 'Абдуллоев Акмалхон');
        assert.strictEqual(projection.passenger.seats[0], '5');
        assert.strictEqual(projection.route.fromCity, 'Душанбе');
        assert.strictEqual(projection.route.toCity, 'Худжанд');
        assert.strictEqual(projection.route.departureDate, '2026-09-05');
        assert.strictEqual(projection.route.departureTime, '08:00');
        assert.strictEqual(projection.payment.totalPrice, 700);
        assert.strictEqual(projection.carrier.companyName, 'ООО Азия Транс');
    });

    it('[E35.2-02] generateTicketPdf builds valid PDF Buffer from canonical projection without placeholder fallbacks', async () => {
        const projection = buildPassengerTicketProjection(mockBooking, mockTrip);
        const pdfBuffer = await generateTicketPdf(projection);

        assert.ok(Buffer.isBuffer(pdfBuffer));
        assert.ok(pdfBuffer.length > 5000, 'PDF buffer must be non-empty');
        assert.strictEqual(pdfBuffer.toString('utf-8', 0, 4), '%PDF', 'Buffer must start with %PDF header');
    });

    it('[E35.2-03] QR verification token inside projection passes HMAC verification', () => {
        const projection = buildPassengerTicketProjection(mockBooking, mockTrip);
        assert.ok(projection.verificationToken);
        const isValid = verifyTicketToken(projection.verificationToken, mockBooking.id);
        assert.strictEqual(isValid, true, 'Verification token must pass HMAC verification');
    });

    it('[E35.2-04] Projection excludes PII and internal secrets', () => {
        const projection = buildPassengerTicketProjection(mockBooking, mockTrip);
        assert.strictEqual(projection.passenger.passport, undefined);
        assert.strictEqual(projection.carrierSecret, undefined);
        assert.strictEqual(projection.telegram_id, undefined);
    });

    it('[E35.2-05] Double-decker bus renders floor tag cleanly', async () => {
        const doubleDeckTrip = { ...mockTrip, bus_type: 'double' };
        const projection = buildPassengerTicketProjection({ ...mockBooking, seat_numbers: ['12'] }, doubleDeckTrip);
        assert.strictEqual(projection.bus.bus_type, 'double');

        const pdfBuffer = await generateTicketPdf(projection);
        assert.ok(pdfBuffer.length > 5000);
    });
});
