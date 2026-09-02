/**
 * Phase E.35 — QR Ticket PDF Delivery & Telegram Document Integration Unit Tests
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { generateTicketPdf, getFontPaths } = require('../utils/ticketPdfService');
const { buildPassengerTicketProjection, verifyTicketToken } = require('../utils/ticketHelper');
const { sendDocument } = require('../utils/telegramBot');

describe('Phase E.35 — QR Ticket PDF Delivery Unit Tests', () => {

    const mockBooking = {
        id: 439,
        bus_ticket_id: 73,
        phone: '+992900000000',
        seat_numbers: ['5'],
        passenger_name: 'Алишер Смирнов',
        status: 'confirmed',
        channel: 'manual',
        total_price: 150,
        commission_amount: 0,
        carrier_amount: 150,
        created_at: '2026-09-02T15:00:00.000Z'
    };

    const mockTrip = {
        id: 73,
        from_city: 'Душанбе',
        to_city: 'Худжанд',
        departure_date: '2026-09-05',
        departure_time: '08:00:00',
        arrival_time: '13:30:00',
        price: 150,
        bus_model: 'Mercedes-Benz Tourismo',
        bus_type: 'single'
    };

    it('[E35-01] Font loader locates Cyrillic Arial fonts safely', () => {
        const fonts = getFontPaths();
        assert.ok(fonts, 'Font loader must find valid Cyrillic font files');
        assert.ok(fonts.regular, 'Regular font path must be defined');
        assert.ok(fonts.bold, 'Bold font path must be defined');
    });

    it('[E35-02] generateTicketPdf produces valid non-empty PDF Buffer with Ticket V1.1 data', async () => {
        const projection = buildPassengerTicketProjection(mockBooking, mockTrip);
        assert.ok(projection);
        assert.strictEqual(projection.ticketNumber, 'POP-000439');

        const pdfBuffer = await generateTicketPdf(projection);
        assert.ok(Buffer.isBuffer(pdfBuffer));
        assert.ok(pdfBuffer.length > 5000, 'PDF buffer must be substantial (non-empty PDF document)');

        // Check standard PDF Magic Bytes: %PDF
        const pdfHeader = pdfBuffer.toString('utf-8', 0, 4);
        assert.strictEqual(pdfHeader, '%PDF', 'PDF buffer must start with standard %PDF header');
    });

    it('[E35-03] PDF projection embeds valid secure QR HMAC token and URL', () => {
        const projection = buildPassengerTicketProjection(mockBooking, mockTrip);
        assert.ok(projection.verificationToken);
        assert.ok(projection.verificationUrl.includes(projection.verificationToken));

        // Prove secure HMAC verification passes
        const isValid = verifyTicketToken(projection.verificationToken, mockBooking.id);
        assert.strictEqual(isValid, true, 'QR verification token inside ticket projection must pass HMAC verification');
    });

    it('[E35-04] Ticket projection excludes PII and internal secrets', () => {
        const projection = buildPassengerTicketProjection(mockBooking, mockTrip);
        assert.strictEqual(projection.passenger.passport, undefined);
        assert.strictEqual(projection.carrierSecret, undefined);
        assert.strictEqual(projection.telegram_id, undefined);
    });

    it('[E35-05] Double-decker bus renders floor information cleanly', async () => {
        const doubleDeckTrip = { ...mockTrip, bus_type: 'double' };
        const projection1 = buildPassengerTicketProjection({ ...mockBooking, seat_numbers: ['12'] }, doubleDeckTrip);
        assert.strictEqual(projection1.bus.bus_type, 'double');

        const pdfBuffer = await generateTicketPdf(projection1);
        assert.ok(pdfBuffer.length > 5000);
    });

    it('[E35-06] Legacy ticket without fleet bus projection renders safely', async () => {
        const legacyTrip = { ...mockTrip, bus_model: 'Volvo B12R' };
        const projection = buildPassengerTicketProjection(mockBooking, legacyTrip, null);
        assert.strictEqual(projection.bus.model, 'Volvo B12R');

        const pdfBuffer = await generateTicketPdf(projection);
        assert.ok(pdfBuffer.length > 5000);
    });
});
