/**
 * phase_trip_group_leader.test.js
 * 
 * Test Suite: TRIP GROUP LEADER V1 — СТАРШИЙ ГРУППЫ / ОТВЕТСТВЕННЫЙ ЗА РЕЙС
 * POPUTKI.ONLINE
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { buildPassengerTicketProjection } = require('../utils/ticketHelper.js');

describe('PHASE: TRIP GROUP LEADER V1 TEST SUITE', () => {

    const sampleTripWithoutLeader = {
        id: 10,
        operator_id: 11,
        transport_company: 'ООО «Рохи Абрешим»',
        from_city: 'Худжанд',
        to_city: 'Нижневартовск',
        departure_date: '2026-09-01',
        departure_time: '08:30:00',
        arrival_date: '2026-09-03',
        arrival_time: '18:00:00',
        price: 700,
        total_seats: 53,
        bus_type: 'single',
        group_leader_name: null,
        group_leader_phone: null,
        group_leader_whatsapp: null
    };

    const sampleTripWithLeader = {
        id: 11,
        operator_id: 11,
        transport_company: 'ООО «Рохи Абрешим»',
        from_city: 'Худжанд',
        to_city: 'Нижневартовск',
        departure_date: '2026-09-01',
        departure_time: '08:30:00',
        arrival_date: '2026-09-03',
        arrival_time: '18:00:00',
        price: 700,
        total_seats: 78,
        bus_type: 'double',
        group_leader_name: 'Хочи Абдурауф',
        group_leader_phone: '+992 (92) 792 50 51',
        group_leader_whatsapp: '+7 (912) 912 50 51'
    };

    const sampleBooking = {
        id: 139,
        bus_ticket_id: 11,
        passenger_id: 42,
        passenger_name: 'Тестовый пассажир',
        seat_numbers: [25],
        passenger_count: 1,
        passengers_data: [{ firstName: 'Тестовый', lastName: 'Пассажир', seat: 25 }],
        status: 'confirmed',
        total_price: 700,
        commission_amount: 70,
        carrier_amount: 630,
        created_at: '2026-08-30T00:00:00Z'
    };

    it('1. Trip without group leader produces support object with null values', () => {
        const proj = buildPassengerTicketProjection(sampleBooking, sampleTripWithoutLeader, null);
        assert.ok(proj);
        assert.ok(proj.support);
        assert.equal(proj.support.name, null);
        assert.equal(proj.support.phone, null);
        assert.equal(proj.support.whatsapp, null);
    });

    it('2. Trip with group leader correctly maps name, phone, and whatsapp', () => {
        const proj = buildPassengerTicketProjection(sampleBooking, sampleTripWithLeader, null);
        assert.ok(proj);
        assert.equal(proj.support.name, 'Хочи Абдурауф');
        assert.equal(proj.support.phone, '+992 (92) 792 50 51');
        assert.equal(proj.support.whatsapp, '+7 (912) 912 50 51');
    });

    it('3. Group leader name NEVER falls back to transport_company', () => {
        const proj = buildPassengerTicketProjection(sampleBooking, sampleTripWithoutLeader, null);
        assert.notEqual(proj.support.name, sampleTripWithoutLeader.transport_company);
        assert.equal(proj.support.name, null);
        assert.equal(proj.carrier.companyName, 'ООО «Рохи Абрешим»');
    });

    it('4. No hardcoded phone fallback exists when group leader phone is missing', () => {
        const proj = buildPassengerTicketProjection(sampleBooking, sampleTripWithoutLeader, null, { isPublic: true });
        assert.equal(proj.support.phone, null);
        assert.equal(proj.support.whatsapp, null);
    });

    it('5. Group leader fields with whitespace are cleanly trimmed', () => {
        const tripWithSpaces = {
            ...sampleTripWithLeader,
            group_leader_name: '   Хочи Абдурауф   ',
            group_leader_phone: ' +992927925051  ',
            group_leader_whatsapp: '  +79129125051 '
        };
        const proj = buildPassengerTicketProjection(sampleBooking, tripWithSpaces, null);
        assert.equal(proj.support.name, 'Хочи Абдурауф');
        assert.equal(proj.support.phone, '+992927925051');
        assert.equal(proj.support.whatsapp, '+79129125051');
    });

    it('6. Legacy trips with undefined fields handle projection safely without throwing', () => {
        const legacyTrip = {
            id: 1,
            from_city: 'Душанбе',
            to_city: 'Худжанд',
            departure_date: '2026-09-01',
            price: 150
        };
        assert.doesNotThrow(() => {
            const proj = buildPassengerTicketProjection(sampleBooking, legacyTrip, null);
            assert.equal(proj.support.name, null);
            assert.equal(proj.support.phone, null);
            assert.equal(proj.support.whatsapp, null);
        });
    });

    it('7. Updating trip leader does NOT mutate booking financial snapshot or statuses', () => {
        const updatedTrip = { ...sampleTripWithLeader, group_leader_name: 'Новый Сопровождающий' };
        const proj = buildPassengerTicketProjection(sampleBooking, updatedTrip, null);
        assert.equal(proj.support.name, 'Новый Сопровождающий');
        assert.equal(proj.payment.totalPrice, 700);
        assert.equal(proj.payment.paidAmount, 70);
        assert.equal(proj.payment.remainingAmount, 630);
        assert.equal(proj.status, 'confirmed');
    });

    it('8. Public verification projection preserves support contact without leaking internal carrier IDs', () => {
        const proj = buildPassengerTicketProjection(sampleBooking, sampleTripWithLeader, null, { isPublic: true });
        assert.ok(proj.support);
        assert.equal(proj.support.name, 'Хочи Абдурауф');
        assert.equal(proj.support.phone, '+992 (92) 792 50 51');
        assert.equal(proj.support.whatsapp, '+7 (912) 912 50 51');
        // Carrier internal metadata is not present
        assert.equal(proj.carrier.carrier_id, undefined);
        assert.equal(proj.carrier.user_id, undefined);
    });

    it('9. Support object allows single contact when phone equals whatsapp', () => {
        const tripSamePhone = {
            ...sampleTripWithLeader,
            group_leader_phone: '+992927925051',
            group_leader_whatsapp: '+992927925051'
        };
        const proj = buildPassengerTicketProjection(sampleBooking, tripSamePhone, null);
        assert.equal(proj.support.phone, proj.support.whatsapp);
    });

    it('10. Clearing optional leader fields to empty strings or null sets them to null in projection', () => {
        const clearedTrip = {
            ...sampleTripWithLeader,
            group_leader_name: '',
            group_leader_phone: '',
            group_leader_whatsapp: null
        };
        const proj = buildPassengerTicketProjection(sampleBooking, clearedTrip, null);
        assert.equal(proj.support.name, null);
        assert.equal(proj.support.phone, null);
        assert.equal(proj.support.whatsapp, null);
    });
});
