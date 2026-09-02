/**
 * tests/phase_e39_manual_booking_delete_seat_release.test.js
 * 
 * Phase E.39 — Manual Booking Delete Must Release Seat Test Suite
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { isSeatLockedByBooking } = require('../utils/paymentExpirationHelper');

describe('PHASE E.39 — MANUAL BOOKING DELETE MUST RELEASE SEAT', () => {

    // Helper simulating canonical seat calculation from active bookings
    function computeCanonicalReservedSeats(bookings, ticketId) {
        const remainingSeats = [];
        bookings
            .filter(b => Number(b.bus_ticket_id) === Number(ticketId) && b.status !== 'cancelled')
            .forEach(b => {
                if (isSeatLockedByBooking(b)) {
                    const sList = typeof b.seat_numbers === 'string' ? JSON.parse(b.seat_numbers || '[]') : (b.seat_numbers || []);
                    if (Array.isArray(sList)) {
                        sList.forEach(s => {
                            const num = Number(s);
                            if (!isNaN(num)) remainingSeats.push(num);
                        });
                    } else if (sList != null) {
                        const num = Number(sList);
                        if (!isNaN(num)) remainingSeats.push(num);
                    }
                }
            });
        return [...new Set(remainingSeats)];
    }

    // Helper simulating canonical seat gender calculation from active bookings
    function computeCanonicalSeatGenders(bookings, ticketId) {
        const seatGenders = {};
        bookings
            .filter(b => Number(b.bus_ticket_id) === Number(ticketId) && b.status !== 'cancelled')
            .forEach(b => {
                if (isSeatLockedByBooking(b)) {
                    const sList = typeof b.seat_numbers === 'string' ? JSON.parse(b.seat_numbers || '[]') : (b.seat_numbers || []);
                    const pData = typeof b.passengers_data === 'string' ? JSON.parse(b.passengers_data || '[]') : (b.passengers_data || []);
                    if (Array.isArray(sList)) {
                        sList.forEach((s, idx) => {
                            const num = Number(s);
                            const g = pData[idx]?.gender;
                            if (!isNaN(num) && (g === 'male' || g === 'female')) {
                                seatGenders[num] = g;
                            }
                        });
                    }
                }
            });
        return seatGenders;
    }

    it('CASE A: Manual confirmed booking seat 4 -> delete -> seat 4 becomes free', () => {
        let bookings = [
            { id: 445, bus_ticket_id: 73, seat_numbers: [4], status: 'confirmed' },
            { id: 446, bus_ticket_id: 73, seat_numbers: [5], status: 'confirmed' }
        ];

        let reserved = computeCanonicalReservedSeats(bookings, 73);
        assert.deepStrictEqual(reserved.sort(), [4, 5]);

        // Physically delete booking #445
        bookings = bookings.filter(b => b.id !== 445);

        reserved = computeCanonicalReservedSeats(bookings, 73);
        assert.deepStrictEqual(reserved, [5], 'Seat 4 must be released after deleting booking 445');
        assert.strictEqual(reserved.includes(4), false);
    });

    it('CASE B: Manual confirmed female booking -> delete -> female booked style released', () => {
        let bookings = [
            { id: 445, bus_ticket_id: 73, seat_numbers: [4], status: 'confirmed', passengers_data: [{ gender: 'female' }] },
            { id: 446, bus_ticket_id: 73, seat_numbers: [5], status: 'confirmed', passengers_data: [{ gender: 'male' }] }
        ];

        let genders = computeCanonicalSeatGenders(bookings, 73);
        assert.strictEqual(genders[4], 'female');
        assert.strictEqual(genders[5], 'male');

        // Delete female booking
        bookings = bookings.filter(b => b.id !== 445);

        genders = computeCanonicalSeatGenders(bookings, 73);
        assert.strictEqual(genders[4], undefined, 'Seat 4 female gender must be released');
        assert.strictEqual(genders[5], 'male', 'Seat 5 male gender must remain');
    });

    it('CASE C: Manual confirmed male booking -> delete -> male booked style released', () => {
        let bookings = [
            { id: 446, bus_ticket_id: 73, seat_numbers: [5], status: 'confirmed', passengers_data: [{ gender: 'male' }] }
        ];

        let genders = computeCanonicalSeatGenders(bookings, 73);
        assert.strictEqual(genders[5], 'male');

        bookings = bookings.filter(b => b.id !== 446);
        genders = computeCanonicalSeatGenders(bookings, 73);
        assert.strictEqual(genders[5], undefined, 'Seat 5 male gender must be released');
    });

    it('CASE D: Two active records reference same trip + seat -> delete one -> seat remains occupied', () => {
        let bookings = [
            { id: 445, bus_ticket_id: 73, seat_numbers: [4], status: 'confirmed' },
            { id: 447, bus_ticket_id: 73, seat_numbers: [4], status: 'confirmed' }
        ];

        // Delete one of the duplicate bookings
        bookings = bookings.filter(b => b.id !== 445);

        const reserved = computeCanonicalReservedSeats(bookings, 73);
        assert.deepStrictEqual(reserved, [4], 'Seat 4 must remain occupied because booking 447 still exists');
    });

    it('CASE E: Cancelled booking -> seat is not occupied', () => {
        const bookings = [
            { id: 445, bus_ticket_id: 73, seat_numbers: [4], status: 'cancelled' },
            { id: 446, bus_ticket_id: 73, seat_numbers: [5], status: 'confirmed' }
        ];

        const reserved = computeCanonicalReservedSeats(bookings, 73);
        assert.deepStrictEqual(reserved, [5]);
    });

    it('CASE F: Expired pending_payment -> seat is not occupied', () => {
        const bookings = [
            { id: 445, bus_ticket_id: 73, seat_numbers: [4], status: 'pending_payment', hold_expires_at: new Date(Date.now() - 60000).toISOString() },
            { id: 446, bus_ticket_id: 73, seat_numbers: [5], status: 'confirmed' }
        ];

        const reserved = computeCanonicalReservedSeats(bookings, 73);
        assert.deepStrictEqual(reserved, [5]);
    });

    it('CASE G: Active pending_payment -> seat is occupied', () => {
        const bookings = [
            { id: 445, bus_ticket_id: 73, seat_numbers: [4], status: 'pending_payment', hold_expires_at: new Date(Date.now() + 600000).toISOString() },
            { id: 446, bus_ticket_id: 73, seat_numbers: [5], status: 'confirmed' }
        ];

        const reserved = computeCanonicalReservedSeats(bookings, 73);
        assert.deepStrictEqual(reserved.sort(), [4, 5]);
    });

    it('CASE I: String vs number types in seat numbers are normalized and release works', () => {
        let bookings = [
            { id: 445, bus_ticket_id: 73, seat_numbers: ['4'], status: 'confirmed' },
            { id: 446, bus_ticket_id: 73, seat_numbers: [5], status: 'confirmed' }
        ];

        let reserved = computeCanonicalReservedSeats(bookings, 73);
        assert.deepStrictEqual(reserved.sort(), [4, 5]);

        bookings = bookings.filter(b => b.id !== 445);
        reserved = computeCanonicalReservedSeats(bookings, 73);
        assert.deepStrictEqual(reserved, [5]);
    });

    it('CASE J: Remaining occupied seat with gender style is preserved after another is deleted', () => {
        let bookings = [
            { id: 445, bus_ticket_id: 73, seat_numbers: [4], status: 'confirmed', passengers_data: [{ gender: 'female' }] },
            { id: 446, bus_ticket_id: 73, seat_numbers: [12], status: 'confirmed', passengers_data: [{ gender: 'male' }] }
        ];

        bookings = bookings.filter(b => b.id !== 445);
        const genders = computeCanonicalSeatGenders(bookings, 73);
        assert.strictEqual(genders[4], undefined);
        assert.strictEqual(genders[12], 'male');
    });

});
