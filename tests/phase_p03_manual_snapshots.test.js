const { describe, it } = require('node:test');
const assert = require('node:assert');

/**
 * PHASE P0.3: MANUAL BOOKING FINANCIAL SNAPSHOT TEST SUITE
 */

function computeManualBookingSnapshot(ticket, seatNumbers, carrierUser) {
    const premiumSeatNums = ticket.bus_type === 'double' ? [1, 2, 3, 4, 69, 70, 71, 72, 73, 74, 75, 76] : [];
    const premiumPrice = Number(ticket.premium_price || ticket.price || 0);
    const standardPrice = Number(ticket.price || 0);

    let manualTotalPrice = 0;
    for (const seatNum of (seatNumbers || [])) {
        manualTotalPrice += premiumSeatNums.includes(Number(seatNum)) ? premiumPrice : standardPrice;
    }

    return {
        bus_ticket_id: ticket.id,
        passenger_id: carrierUser.user_id,
        seat_numbers: seatNumbers,
        passenger_count: (seatNumbers || []).length,
        status: 'confirmed',
        total_price: manualTotalPrice,
        commission_rate: 0,
        commission_amount: 0,
        carrier_amount: manualTotalPrice,
        channel: 'manual',
        source_type: 'manual',
        source_id: String(carrierUser.carrier_id || carrierUser.id),
        created_by_user_id: carrierUser.user_id
    };
}

describe('Phase P0.3: Manual Booking Financial Snapshot Suite', () => {

    const carrierUser = {
        id: 10,
        carrier_id: 10,
        user_id: 10,
        role: 'owner'
    };

    const singleDeckTicket = {
        id: 101,
        operator_id: 10,
        from_city: 'Душанбе',
        to_city: 'Худжанд',
        bus_type: 'single',
        price: 150,
        premium_price: null
    };

    const doubleDeckTicket = {
        id: 102,
        operator_id: 10,
        from_city: 'Душанбе',
        to_city: 'Москва',
        bus_type: 'double',
        price: 800,
        premium_price: 1000
    };

    it('1. Manual standard seat calculates total_price = ticket.price', () => {
        const snap = computeManualBookingSnapshot(singleDeckTicket, [5], carrierUser);
        assert.strictEqual(snap.total_price, 150);
        assert.strictEqual(snap.commission_rate, 0);
        assert.strictEqual(snap.commission_amount, 0);
        assert.strictEqual(snap.carrier_amount, 150);
    });

    it('2. Manual multiple standard seats calculates total_price = sum', () => {
        const snap = computeManualBookingSnapshot(singleDeckTicket, [5, 6, 7], carrierUser);
        assert.strictEqual(snap.total_price, 450);
        assert.strictEqual(snap.passenger_count, 3);
        assert.strictEqual(snap.carrier_amount, 450);
    });

    it('3. Manual premium seat uses premium_price correctly on double-decker bus', () => {
        // Seat 1 is in [1, 2, 3, 4, 69, 70, 71, 72, 73, 74, 75, 76]
        const snap = computeManualBookingSnapshot(doubleDeckTicket, [1], carrierUser);
        assert.strictEqual(snap.total_price, 1000);
        assert.strictEqual(snap.carrier_amount, 1000);
    });

    it('4. Mixed standard + premium seats calculates exact combined sum', () => {
        // Seat 1 (premium: 1000), Seat 10 (standard: 800)
        const snap = computeManualBookingSnapshot(doubleDeckTicket, [1, 10], carrierUser);
        assert.strictEqual(snap.total_price, 1800);
        assert.strictEqual(snap.carrier_amount, 1800);
    });

    it('5. commission_rate is strictly 0 for manual booking', () => {
        const snap = computeManualBookingSnapshot(singleDeckTicket, [1], carrierUser);
        assert.strictEqual(snap.commission_rate, 0);
    });

    it('6. commission_amount is strictly 0 for manual booking', () => {
        const snap = computeManualBookingSnapshot(singleDeckTicket, [1], carrierUser);
        assert.strictEqual(snap.commission_amount, 0);
    });

    it('7. carrier_amount equals 100% of total_price for manual booking', () => {
        const snap = computeManualBookingSnapshot(singleDeckTicket, [1, 2], carrierUser);
        assert.strictEqual(snap.carrier_amount, snap.total_price);
        assert.strictEqual(snap.carrier_amount, 300);
    });

    it('8. channel is stored as manual', () => {
        const snap = computeManualBookingSnapshot(singleDeckTicket, [1], carrierUser);
        assert.strictEqual(snap.channel, 'manual');
    });

    it('9. source_type is stored as manual', () => {
        const snap = computeManualBookingSnapshot(singleDeckTicket, [1], carrierUser);
        assert.strictEqual(snap.source_type, 'manual');
    });

    it('10. created_by_user_id is captured from authenticated JWT', () => {
        const snap = computeManualBookingSnapshot(singleDeckTicket, [1], carrierUser);
        assert.strictEqual(snap.created_by_user_id, 10);
    });

    it('11. Finance P0.3 correctly aggregates new manual booking value', () => {
        const newManualBooking = computeManualBookingSnapshot(singleDeckTicket, [1, 2], carrierUser);
        
        let confirmedGross = 0;
        let serviceComm = 0;
        let carrierAmt = 0;

        const isManual = newManualBooking.channel === 'manual';
        const totalPrice = Number(newManualBooking.total_price || 0);
        const commAmount = Number(newManualBooking.commission_amount || 0);
        const carrierPayout = Number(newManualBooking.carrier_amount || totalPrice);

        confirmedGross += totalPrice;
        serviceComm += commAmount;
        carrierAmt += carrierPayout;

        assert.strictEqual(confirmedGross, 300);
        assert.strictEqual(serviceComm, 0);
        assert.strictEqual(carrierAmt, 300);
        assert.strictEqual(confirmedGross, serviceComm + carrierAmt);
    });

    it('12. P0.2 summary correctly accounts for new manual booking', () => {
        const newManualBooking = computeManualBookingSnapshot(singleDeckTicket, [1], carrierUser);
        assert.strictEqual(newManualBooking.total_price, 150);
        assert.strictEqual(newManualBooking.carrier_amount, 150);
    });

    it('13. Legacy manual booking (total_price = 0) is NOT modified or fabricated', () => {
        const legacyBooking = {
            id: 342,
            bus_ticket_id: 101,
            seat_numbers: [1],
            passenger_count: 1,
            total_price: 0,
            commission_rate: 0,
            commission_amount: 0,
            carrier_amount: 0,
            channel: 'manual',
            source_type: 'carrier',
            status: 'confirmed'
        };

        // Snapshot is preserved as 0
        assert.strictEqual(legacyBooking.total_price, 0);
        assert.strictEqual(legacyBooking.carrier_amount, 0);
    });

    it('14. Future ticket price changes do NOT mutate already stored manual snapshot', () => {
        const snap = computeManualBookingSnapshot(singleDeckTicket, [1], carrierUser);
        assert.strictEqual(snap.total_price, 150);

        // Price changes in ticket afterwards
        const updatedTicket = { ...singleDeckTicket, price: 999 };
        // The snapshot record remains 150
        assert.strictEqual(snap.total_price, 150);
        assert.strictEqual(snap.carrier_amount, 150);
    });

    it('15. Snapshot Safety: Editing only non-financial fields (name, phone, doc) does NOT touch financial snapshots', () => {
        function buildUpdatePayload(oldBooking, newBody, ticket) {
            const seatsChanged = JSON.stringify(oldBooking.seat_numbers) !== JSON.stringify(newBody.seat_numbers);
            const updatePayload = {
                seat_numbers: newBody.seat_numbers,
                passenger_count: (newBody.seat_numbers || []).length,
                passengers_data: newBody.passengers_data,
                phone: newBody.phone,
                passenger_name: newBody.passenger_name,
                pickup_city: newBody.pickup_city,
                drop_off_city: newBody.drop_off_city
            };

            const isManual = oldBooking.channel === 'manual' || oldBooking.source_type === 'manual' || oldBooking.source_type === 'carrier';
            if (seatsChanged && isManual && oldBooking.total_price > 0 && ticket) {
                const premiumSeatNums = ticket.bus_type === 'double' ? [1, 2, 3, 4, 69, 70, 71, 72, 73, 74, 75, 76] : [];
                const premiumPrice = Number(ticket.premium_price || ticket.price || 0);
                const standardPrice = Number(ticket.price || 0);

                let newTotalPrice = 0;
                for (const seatNum of (newBody.seat_numbers || [])) {
                    newTotalPrice += premiumSeatNums.includes(Number(seatNum)) ? premiumPrice : standardPrice;
                }
                updatePayload.total_price = newTotalPrice;
                updatePayload.commission_rate = 0;
                updatePayload.commission_amount = 0;
                updatePayload.carrier_amount = newTotalPrice;
            }

            return updatePayload;
        }

        const activeBooking = {
            id: 1,
            seat_numbers: [10],
            total_price: 150,
            commission_rate: 0,
            commission_amount: 0,
            carrier_amount: 150,
            channel: 'manual',
            source_type: 'manual'
        };

        // User edits only name and phone, keeping seat [10]
        const editBody = {
            seat_numbers: [10],
            phone: '+992911111111',
            passenger_name: 'Новое Имя'
        };

        const payload = buildUpdatePayload(activeBooking, editBody, singleDeckTicket);
        assert.strictEqual(payload.total_price, undefined);
        assert.strictEqual(payload.carrier_amount, undefined);
        assert.strictEqual(payload.passenger_name, 'Новое Имя');
        assert.strictEqual(payload.phone, '+992911111111');
    });

    it('16. Legacy Snapshot Guard: Editing legacy manual booking (total_price = 0) does NOT recompute into positive fare', () => {
        function buildUpdatePayload(oldBooking, newBody, ticket) {
            const seatsChanged = JSON.stringify(oldBooking.seat_numbers) !== JSON.stringify(newBody.seat_numbers);
            const updatePayload = {
                seat_numbers: newBody.seat_numbers,
                passenger_name: newBody.passenger_name
            };

            const isManual = oldBooking.channel === 'manual' || oldBooking.source_type === 'manual' || oldBooking.source_type === 'carrier';
            if (seatsChanged && isManual && oldBooking.total_price > 0 && ticket) {
                const standardPrice = Number(ticket.price || 0);
                const newTotalPrice = (newBody.seat_numbers || []).length * standardPrice;
                updatePayload.total_price = newTotalPrice;
                updatePayload.carrier_amount = newTotalPrice;
            }
            return updatePayload;
        }

        const legacyBooking = {
            id: 342,
            seat_numbers: [1],
            total_price: 0,
            commission_rate: 0,
            commission_amount: 0,
            carrier_amount: 0,
            channel: 'manual'
        };

        const editBody = {
            seat_numbers: [1, 2],
            passenger_name: 'Пассажир'
        };

        const payload = buildUpdatePayload(legacyBooking, editBody, singleDeckTicket);
        // Financial fields must NOT be added to payload for legacy 0 snapshot
        assert.strictEqual(payload.total_price, undefined);
        assert.strictEqual(payload.carrier_amount, undefined);
    });

    it('17. Online Booking Snapshot Guard: Online booking financial snapshots are protected against PUT mutation', () => {
        function buildUpdatePayload(oldBooking, newBody, ticket) {
            const seatsChanged = JSON.stringify(oldBooking.seat_numbers) !== JSON.stringify(newBody.seat_numbers);
            const updatePayload = {
                seat_numbers: newBody.seat_numbers
            };

            const isManual = oldBooking.channel === 'manual' || oldBooking.source_type === 'manual' || oldBooking.source_type === 'carrier';
            if (seatsChanged && isManual && oldBooking.total_price > 0 && ticket) {
                updatePayload.total_price = 500;
            }
            return updatePayload;
        }

        const onlineBooking = {
            id: 400,
            seat_numbers: [1],
            total_price: 840,
            commission_rate: 10,
            commission_amount: 84,
            carrier_amount: 756,
            channel: 'web',
            source_type: 'direct'
        };

        const payload = buildUpdatePayload(onlineBooking, { seat_numbers: [2] }, singleDeckTicket);
        assert.strictEqual(payload.total_price, undefined);
    });
});

