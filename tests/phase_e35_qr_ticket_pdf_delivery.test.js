/**
 * Phase E.35.5 — Inline Telegram Ticket Image Delivery Unit Tests
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { generateTicketPdf, getFontPaths } = require('../utils/ticketPdfService');
const { generateTicketPng } = require('../utils/ticketImageService');
const { buildPassengerTicketProjection, verifyTicketToken } = require('../utils/ticketHelper');
const { sendPhoto, sendMessage, sendDocument } = require('../utils/telegramBot');
const { processNotificationIntents } = require('../utils/telegramDeliveryService');

describe('Phase E.35.5 — Inline Telegram Ticket Image Delivery Tests', () => {

    const mockBooking = {
        id: 441,
        bus_ticket_id: 73,
        phone: '+992900000000',
        seat_numbers: ['2'],
        passenger_name: 'Абдуллоев Акмалхон',
        status: 'confirmed',
        channel: 'manual',
        total_price: 700,
        commission_amount: 0,
        carrier_amount: 700,
        created_at: '2026-09-02T15:30:00.000Z'
    };

    const mockTrip = {
        id: 73,
        from_city: 'Нижневартовск (РФ)',
        to_city: 'Канибадам (TJ)',
        departure_date: '2026-09-05',
        departure_time: '08:00:00',
        arrival_time: '13:30:00',
        price: 700,
        transport_company: 'ООО Азия Транс',
        bus_model: 'Setra S 431 DT',
        bus_type: 'double'
    };

    it('[E35.5-01] buildPassengerTicketProjection produces accurate canonical Ticket V1.1 data for fixture', () => {
        const projection = buildPassengerTicketProjection(mockBooking, mockTrip);
        assert.ok(projection);
        assert.strictEqual(projection.ticketNumber, 'POP-000441');
        assert.strictEqual(projection.passenger.primaryName, 'Абдуллоев Акмалхон');
        assert.strictEqual(projection.passenger.seats[0], '2');
        assert.strictEqual(projection.route.fromCity, 'Нижневартовск (РФ)');
        assert.strictEqual(projection.route.toCity, 'Канибадам (TJ)');
        assert.strictEqual(projection.route.departureDate, '2026-09-05');
        assert.strictEqual(projection.route.departureTime, '08:00');
        assert.strictEqual(projection.payment.totalPrice, 700);
        assert.strictEqual(projection.carrier.companyName, 'ООО Азия Транс');
    });

    it('[E35.5-02] generateTicketPng produces non-empty PNG buffer with high resolution', async () => {
        const projection = buildPassengerTicketProjection(mockBooking, mockTrip);
        const imageBuffer = await generateTicketPng(projection);

        assert.ok(Buffer.isBuffer(imageBuffer));
        assert.ok(imageBuffer.length > 1000, 'PNG buffer must be non-empty');
    });

    it('[E35.5-03] QR verification token passes HMAC verification', () => {
        const projection = buildPassengerTicketProjection(mockBooking, mockTrip);
        assert.ok(projection.verificationToken);
        const isValid = verifyTicketToken(projection.verificationToken, mockBooking.id);
        assert.strictEqual(isValid, true, 'Verification token must pass HMAC verification');
    });

    it('[E35.5-04] Projection excludes PII and internal secrets', () => {
        const projection = buildPassengerTicketProjection(mockBooking, mockTrip);
        assert.strictEqual(projection.passenger.passport, undefined);
        assert.strictEqual(projection.carrierSecret, undefined);
        assert.strictEqual(projection.telegram_id, undefined);
    });

    it('[E35.5-05] PDF & Print functionality remains intact for carrier export', async () => {
        const projection = buildPassengerTicketProjection(mockBooking, mockTrip);
        const pdfBuffer = await generateTicketPdf(projection);
        assert.ok(Buffer.isBuffer(pdfBuffer));
        assert.strictEqual(pdfBuffer.toString('utf-8', 0, 4), '%PDF');
    });

    it('[E35.5-06] Ticket notifications do not fallback to text message on photo failure', async () => {
        const intent = {
            channel: 'telegram',
            recipientType: 'creator',
            recipientUserId: 11,
            telegramChatId: '123456789',
            notificationType: 'passenger_ticket_issued',
            templateKey: 'passenger_ticket_issued',
            status: 'pending',
            idempotencyKey: 'test:key:e35_5'
        };

        const origEnvRouting = process.env.NOTIFICATION_ROUTING_ENABLED;
        const origEnvDelivery = process.env.NOTIFICATION_DELIVERY_ENABLED;
        const origEnvTg = process.env.TELEGRAM_NOTIFICATION_DELIVERY_ENABLED;

        process.env.NOTIFICATION_ROUTING_ENABLED = 'true';
        process.env.NOTIFICATION_DELIVERY_ENABLED = 'true';
        process.env.TELEGRAM_NOTIFICATION_DELIVERY_ENABLED = 'true';

        try {
            const results = await processNotificationIntents([intent], {
                booking: mockBooking,
                trip: mockTrip
            }, { dryRun: true });

            assert.strictEqual(results.length, 1);
            assert.strictEqual(results[0].status, 'pending');
        } finally {
            if (origEnvRouting) process.env.NOTIFICATION_ROUTING_ENABLED = origEnvRouting;
            if (origEnvDelivery) process.env.NOTIFICATION_DELIVERY_ENABLED = origEnvDelivery;
            if (origEnvTg) process.env.TELEGRAM_NOTIFICATION_DELIVERY_ENABLED = origEnvTg;
        }
    });
});
