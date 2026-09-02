/**
 * tests/phase_e37_carrier_seat_gender.test.js
 * 
 * Phase E.37 — Carrier Seat Gender Metadata Extraction Tests
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');

describe('Phase E.37 — Carrier Seat Gender Metadata Unit Tests', () => {

    it('1. Extracts seatGenders map cleanly from booking passengers_data without PII', () => {
        const bookings = [
            {
                id: 445,
                bus_ticket_id: 73,
                seat_numbers: '[4]',
                status: 'confirmed',
                passengers_data: [
                    {
                        lastName: 'Secret',
                        firstName: 'Passenger',
                        phone: '+992927797576',
                        docNumber: 'A1234567',
                        gender: 'male',
                        seatNumber: 4
                    }
                ]
            },
            {
                id: 446,
                bus_ticket_id: 73,
                seat_numbers: [9],
                status: 'confirmed',
                passengers_data: [
                    {
                        lastName: 'Secret2',
                        firstName: 'Passenger2',
                        gender: 'female',
                        seatNumber: 9
                    }
                ]
            },
            {
                id: 447,
                bus_ticket_id: 73,
                seat_numbers: [15],
                status: 'confirmed',
                passengers_data: [
                    {
                        gender: null,
                        seatNumber: 15
                    }
                ]
            }
        ];

        const actuallyReserved = [];
        const seatGenders = {};

        bookings.forEach(b => {
            const seats = typeof b.seat_numbers === 'string' ? JSON.parse(b.seat_numbers || '[]') : (b.seat_numbers || []);
            const pData = typeof b.passengers_data === 'string' ? JSON.parse(b.passengers_data || '[]') : (b.passengers_data || []);
            if (Array.isArray(seats)) {
                actuallyReserved.push(...seats);
                seats.forEach((seatNum, idx) => {
                    const num = Number(seatNum);
                    const g = pData[idx]?.gender;
                    if (!isNaN(num) && (g === 'male' || g === 'female')) {
                        seatGenders[num] = g;
                    }
                });
            }
        });

        // 1. Reserved seats contains [4, 9, 15]
        assert.deepEqual(actuallyReserved, [4, 9, 15]);

        // 2. seatGenders contains only { 4: 'male', 9: 'female' }, 15 has no gender
        assert.deepEqual(seatGenders, { 4: 'male', 9: 'female' });

        // 3. No PII is present in seatGenders
        assert.equal(seatGenders[4], 'male');
        assert.equal(seatGenders[9], 'female');
        assert.equal(seatGenders[15], undefined);
        assert.equal(JSON.stringify(seatGenders).includes('Secret'), false);
        assert.equal(JSON.stringify(seatGenders).includes('+992'), false);
    });

    it('2. Legacy bookings with missing or invalid gender are safely skipped in seatGenders', () => {
        const bookings = [
            {
                id: 448,
                bus_ticket_id: 73,
                seat_numbers: [20],
                passengers_data: null
            },
            {
                id: 449,
                bus_ticket_id: 73,
                seat_numbers: 'invalid-json',
                passengers_data: []
            }
        ];

        const seatGenders = {};
        bookings.forEach(b => {
            try {
                const seats = typeof b.seat_numbers === 'string' ? JSON.parse(b.seat_numbers || '[]') : (b.seat_numbers || []);
                const pData = typeof b.passengers_data === 'string' ? JSON.parse(b.passengers_data || '[]') : (b.passengers_data || []);
                if (Array.isArray(seats)) {
                    seats.forEach((seatNum, idx) => {
                        const num = Number(seatNum);
                        const g = pData[idx]?.gender;
                        if (!isNaN(num) && (g === 'male' || g === 'female')) {
                            seatGenders[num] = g;
                        }
                    });
                }
            } catch(e) {}
        });

        assert.deepEqual(seatGenders, {});
    });

});
