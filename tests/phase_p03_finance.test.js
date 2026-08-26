const { describe, it } = require('node:test');
const assert = require('node:assert');

/**
 * PHASE P0.3: CARRIER FINANCE & SETTLEMENTS
 * Automated Test Suite
 */

// Core finance calculation helper mimicking router logic
function calculateCarrierFinance(tickets, allBookings, carrierUser, dateRange) {
    if (carrierUser.role === 'driver') {
        return { status: 403, error: 'Доступ к финансовому разделу запрещен для роли водителя' };
    }

    const operatorId = carrierUser.carrier_id;
    const fromDate = dateRange.from;
    const toDate = dateRange.to;

    // Filter tickets by operator and date range
    const periodTickets = (tickets || []).filter(t => {
        if (t.operator_id !== operatorId) return false;
        if (fromDate && t.departure_date < fromDate) return false;
        if (toDate && t.departure_date > toDate) return false;
        return true;
    });

    const ticketIds = periodTickets.map(t => t.id);

    if (ticketIds.length === 0) {
        return {
            status: 200,
            data: {
                period: { from: fromDate, to: toDate },
                totals: {
                    confirmed_gross: 0,
                    pending_amount: 0,
                    service_commission: 0,
                    carrier_amount: 0,
                    online_amount: 0,
                    manual_amount: 0,
                    online_bookings: 0,
                    manual_bookings: 0,
                    refunds_amount: 0,
                    refund_needed_amount: 0
                },
                booking_counts: {
                    confirmed: 0,
                    pending_payment: 0,
                    cancelled: 0,
                    refund_needed: 0
                },
                boarding: {
                    total: 0,
                    boarded: 0,
                    pending: 0,
                    no_show: 0
                },
                source_breakdown: [],
                trips: []
            }
        };
    }

    const bookings = (allBookings || []).filter(b => ticketIds.includes(b.bus_ticket_id));

    const sourceMap = {
        web: { key: 'web', label: 'Платформа (Web)', count: 0, gross: 0, commission: 0, carrier_amount: 0 },
        telegram: { key: 'telegram', label: 'Telegram Bot', count: 0, gross: 0, commission: 0, carrier_amount: 0 },
        carrier_link: { key: 'carrier_link', label: 'Ссылка перевозчика', count: 0, gross: 0, commission: 0, carrier_amount: 0 },
        partner_link: { key: 'partner_link', label: 'Партнерская ссылка', count: 0, gross: 0, commission: 0, carrier_amount: 0 },
        manual: { key: 'manual', label: 'Ручная бронь', count: 0, gross: 0, commission: 0, carrier_amount: 0 },
        legacy_unknown: { key: 'legacy_unknown', label: 'Legacy / Неизвестно', count: 0, gross: 0, commission: 0, carrier_amount: 0 }
    };

    let totalConfirmedGross = 0;
    let totalPendingAmount = 0;
    let totalServiceCommission = 0;
    let totalCarrierAmount = 0;
    let totalOnlineAmount = 0;
    let totalManualAmount = 0;
    let totalOnlineBookings = 0;
    let totalManualBookings = 0;

    let countConfirmed = 0;
    let countPending = 0;
    let countCancelled = 0;

    let boardingTotal = 0;
    let boardingBoarded = 0;
    let boardingPending = 0;
    let boardingNoShow = 0;

    const trips = periodTickets.map(ticket => {
        const tripBookings = bookings.filter(b => b.bus_ticket_id === ticket.id);
        const capacity = ticket.total_seats || 53;

        const confirmedBookings = tripBookings.filter(b => b.status === 'confirmed');
        const pendingBookings = tripBookings.filter(b => b.status === 'pending_payment');
        const cancelledBookings = tripBookings.filter(b => b.status === 'cancelled');

        const activeBookings = tripBookings.filter(b => b.status !== 'cancelled');
        const uniqueSeats = new Set();
        activeBookings.forEach(b => {
            let seats = [];
            try {
                seats = typeof b.seat_numbers === 'string' ? JSON.parse(b.seat_numbers || '[]') : (b.seat_numbers || []);
                if (!Array.isArray(seats)) seats = seats ? [seats] : [];
            } catch(e) {}
            seats.forEach(s => uniqueSeats.add(s));
        });

        const bookedSeatsCount = uniqueSeats.size;
        const freeSeatsCount = Math.max(0, capacity - bookedSeatsCount);
        const fillRate = capacity > 0 ? parseFloat(((bookedSeatsCount / capacity) * 100).toFixed(1)) : 0;

        let tripConfirmedGross = 0;
        let tripPendingAmount = 0;
        let tripServiceCommission = 0;
        let tripCarrierAmount = 0;
        let tripOnlineBookings = 0;
        let tripManualBookings = 0;

        let tripBoarded = 0;
        let tripPending = 0;
        let tripNoShow = 0;

        confirmedBookings.forEach(b => {
            const totalPrice = Number(b.total_price || 0);
            const isManual = b.channel === 'manual' || b.source_type === 'manual' || b.source_type === 'carrier';
            const commRate = Number(b.commission_rate ?? (isManual ? 0 : 10));
            const commAmount = Number(b.commission_amount > 0 ? b.commission_amount : (isManual ? 0 : Math.round(totalPrice * (commRate / 100))));
            const carrierAmount = Number(b.carrier_amount > 0 ? b.carrier_amount : Math.max(0, totalPrice - commAmount));

            tripConfirmedGross += totalPrice;
            tripServiceCommission += commAmount;
            tripCarrierAmount += carrierAmount;

            if (isManual) {
                tripManualBookings += 1;
                totalManualAmount += totalPrice;
                totalManualBookings += 1;
            } else {
                tripOnlineBookings += 1;
                totalOnlineAmount += totalPrice;
                totalOnlineBookings += 1;
            }

            let sKey = 'legacy_unknown';
            if (isManual) sKey = 'manual';
            else if (b.source_type === 'carrier_link') sKey = 'carrier_link';
            else if (b.source_type === 'partner_link') sKey = 'partner_link';
            else if (b.channel === 'telegram') sKey = 'telegram';
            else if (b.channel === 'web' || b.source_type === 'platform') sKey = 'web';

            sourceMap[sKey].count += 1;
            sourceMap[sKey].gross += totalPrice;
            sourceMap[sKey].commission += commAmount;
            sourceMap[sKey].carrier_amount += carrierAmount;

            const pCount = b.passenger_count || (Array.isArray(b.passengers_data) ? b.passengers_data.length : 1) || 1;
            const bStatus = b.boarding_status || 'pending_boarding';
            if (bStatus === 'boarded') {
                tripBoarded += pCount;
            } else if (bStatus === 'no_show') {
                tripNoShow += pCount;
            } else {
                tripPending += pCount;
            }
        });

        pendingBookings.forEach(b => {
            tripPendingAmount += Number(b.total_price || 0);
        });

        totalConfirmedGross += tripConfirmedGross;
        totalPendingAmount += tripPendingAmount;
        totalServiceCommission += tripServiceCommission;
        totalCarrierAmount += tripCarrierAmount;

        countConfirmed += confirmedBookings.length;
        countPending += pendingBookings.length;
        countCancelled += cancelledBookings.length;

        boardingBoarded += tripBoarded;
        boardingPending += tripPending;
        boardingNoShow += tripNoShow;
        boardingTotal += (tripBoarded + tripPending + tripNoShow);

        return {
            ticket_id: ticket.id,
            from_city: ticket.from_city,
            to_city: ticket.to_city,
            departure_date: ticket.departure_date,
            departure_time: ticket.departure_time,
            price: ticket.price,
            capacity: capacity,
            booked_seats: bookedSeatsCount,
            free_seats: freeSeatsCount,
            fill_rate: fillRate,

            confirmed_gross: tripConfirmedGross,
            service_commission: tripServiceCommission,
            carrier_amount: tripCarrierAmount,
            pending_amount: tripPendingAmount,

            bookings_total: tripBookings.length,
            confirmed_bookings: confirmedBookings.length,
            pending_bookings: pendingBookings.length,
            cancelled_bookings: cancelledBookings.length,

            online_bookings: tripOnlineBookings,
            manual_bookings: tripManualBookings,

            boarding: {
                total: tripBoarded + tripPending + tripNoShow,
                boarded: tripBoarded,
                pending: tripPending,
                no_show: tripNoShow
            }
        };
    });

    const sourceBreakdownList = Object.values(sourceMap).filter(s => s.count > 0);

    return {
        status: 200,
        data: {
            period: {
                from: fromDate,
                to: toDate
            },
            totals: {
                confirmed_gross: totalConfirmedGross,
                pending_amount: totalPendingAmount,
                service_commission: totalServiceCommission,
                carrier_amount: totalCarrierAmount,
                online_amount: totalOnlineAmount,
                manual_amount: totalManualAmount,
                online_bookings: totalOnlineBookings,
                manual_bookings: totalManualBookings,
                refunds_amount: 0,
                refund_needed_amount: 0
            },
            booking_counts: {
                confirmed: countConfirmed,
                pending_payment: countPending,
                cancelled: countCancelled,
                refund_needed: 0
            },
            boarding: {
                total: boardingTotal,
                boarded: boardingBoarded,
                pending: boardingPending,
                no_show: boardingNoShow
            },
            source_breakdown: sourceBreakdownList,
            trips: trips
        }
    };
}

describe('Phase P0.3: Carrier Finance & Settlements Suite', () => {

    const carrierOwner = { carrier_id: 10, role: 'owner' };
    const carrierDispatcher = { carrier_id: 10, role: 'dispatcher' };
    const carrierDriver = { carrier_id: 10, role: 'driver' };
    const foreignCarrier = { carrier_id: 99, role: 'owner' };

    const sampleTickets = [
        {
            id: 101,
            operator_id: 10,
            from_city: 'Душанбе',
            to_city: 'Худжанд',
            departure_date: '2026-08-10',
            departure_time: '08:00',
            price: 150,
            total_seats: 50
        },
        {
            id: 102,
            operator_id: 10,
            from_city: 'Худжанд',
            to_city: 'Душанбе',
            departure_date: '2026-08-15',
            departure_time: '14:00',
            price: 200,
            total_seats: 40
        }
    ];

    it('1. Owner can access finance endpoint (200 OK)', () => {
        const res = calculateCarrierFinance(sampleTickets, [], carrierOwner, { from: '2026-08-01', to: '2026-08-31' });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.data.trips.length, 2);
    });

    it('2. Dispatcher can access finance endpoint (200 OK)', () => {
        const res = calculateCarrierFinance(sampleTickets, [], carrierDispatcher, { from: '2026-08-01', to: '2026-08-31' });
        assert.strictEqual(res.status, 200);
    });

    it('3. Driver role MUST receive 403 Forbidden', () => {
        const res = calculateCarrierFinance(sampleTickets, [], carrierDriver, { from: '2026-08-01', to: '2026-08-31' });
        assert.strictEqual(res.status, 403);
    });

    it('4. Cross-carrier tenant isolation: Foreign carrier sees only their own trips', () => {
        const res = calculateCarrierFinance(sampleTickets, [], foreignCarrier, { from: '2026-08-01', to: '2026-08-31' });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.data.trips.length, 0);
        assert.strictEqual(res.data.totals.confirmed_gross, 0);
    });

    it('5. Empty period returns zeroed totals structure gracefully', () => {
        const res = calculateCarrierFinance(sampleTickets, [], carrierOwner, { from: '2026-01-01', to: '2026-01-31' });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.data.trips.length, 0);
        assert.strictEqual(res.data.totals.confirmed_gross, 0);
        assert.strictEqual(res.data.totals.carrier_amount, 0);
    });

    it('6. Confirmed online booking calculates 10% commission and 90% carrier payout from historical snapshot', () => {
        const bookings = [{
            id: 1,
            bus_ticket_id: 101,
            seat_numbers: [1, 2],
            passenger_count: 2,
            total_price: 300,
            channel: 'web',
            source_type: 'platform',
            commission_rate: 10,
            commission_amount: 30,
            carrier_amount: 270,
            status: 'confirmed',
            boarding_status: 'boarded'
        }];

        const res = calculateCarrierFinance(sampleTickets, bookings, carrierOwner, { from: '2026-08-01', to: '2026-08-31' });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.data.totals.confirmed_gross, 300);
        assert.strictEqual(res.data.totals.service_commission, 30);
        assert.strictEqual(res.data.totals.carrier_amount, 270);
        assert.strictEqual(res.data.totals.online_bookings, 1);
        assert.strictEqual(res.data.totals.manual_bookings, 0);
    });

    it('7. Confirmed manual booking calculates 0% commission and 100% carrier payout', () => {
        const bookings = [{
            id: 2,
            bus_ticket_id: 101,
            seat_numbers: [5],
            passenger_count: 1,
            total_price: 150,
            channel: 'manual',
            source_type: 'manual',
            commission_rate: 0,
            commission_amount: 0,
            carrier_amount: 150,
            status: 'confirmed',
            boarding_status: 'boarded'
        }];

        const res = calculateCarrierFinance(sampleTickets, bookings, carrierOwner, { from: '2026-08-01', to: '2026-08-31' });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.data.totals.confirmed_gross, 150);
        assert.strictEqual(res.data.totals.service_commission, 0);
        assert.strictEqual(res.data.totals.carrier_amount, 150);
        assert.strictEqual(res.data.totals.online_bookings, 0);
        assert.strictEqual(res.data.totals.manual_bookings, 1);
    });

    it('8. Pending payment bookings are tracked in pending_amount and NOT counted in confirmed_gross', () => {
        const bookings = [{
            id: 3,
            bus_ticket_id: 101,
            seat_numbers: [10],
            passenger_count: 1,
            total_price: 150,
            channel: 'web',
            source_type: 'platform',
            status: 'pending_payment'
        }];

        const res = calculateCarrierFinance(sampleTickets, bookings, carrierOwner, { from: '2026-08-01', to: '2026-08-31' });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.data.totals.confirmed_gross, 0);
        assert.strictEqual(res.data.totals.pending_amount, 150);
        assert.strictEqual(res.data.booking_counts.pending_payment, 1);
    });

    it('9. Cancelled bookings are excluded from revenue and occupied seats', () => {
        const bookings = [{
            id: 4,
            bus_ticket_id: 101,
            seat_numbers: [11],
            passenger_count: 1,
            total_price: 150,
            channel: 'web',
            source_type: 'platform',
            status: 'cancelled'
        }];

        const res = calculateCarrierFinance(sampleTickets, bookings, carrierOwner, { from: '2026-08-01', to: '2026-08-31' });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.data.totals.confirmed_gross, 0);
        assert.strictEqual(res.data.booking_counts.cancelled, 1);
        assert.strictEqual(res.data.trips[0].booked_seats, 0);
    });

    it('10. No-show passengers do NOT reduce confirmed gross revenue', () => {
        const bookings = [{
            id: 5,
            bus_ticket_id: 101,
            seat_numbers: [12],
            passenger_count: 1,
            total_price: 150,
            channel: 'web',
            source_type: 'platform',
            commission_rate: 10,
            commission_amount: 15,
            carrier_amount: 135,
            status: 'confirmed',
            boarding_status: 'no_show'
        }];

        const res = calculateCarrierFinance(sampleTickets, bookings, carrierOwner, { from: '2026-08-01', to: '2026-08-31' });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.data.totals.confirmed_gross, 150);
        assert.strictEqual(res.data.boarding.no_show, 1);
    });

    it('11. Future ticket price changes do NOT mutate historical finance figures', () => {
        const bookings = [{
            id: 1,
            bus_ticket_id: 101,
            seat_numbers: [1],
            passenger_count: 1,
            total_price: 150,
            channel: 'web',
            source_type: 'platform',
            commission_rate: 10,
            commission_amount: 15,
            carrier_amount: 135,
            status: 'confirmed'
        }];

        // Modifying ticket price to 500
        const modifiedTickets = [{ ...sampleTickets[0], price: 500 }];
        const res = calculateCarrierFinance(modifiedTickets, bookings, carrierOwner, { from: '2026-08-01', to: '2026-08-31' });

        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.data.totals.confirmed_gross, 150);
        assert.strictEqual(res.data.totals.carrier_amount, 135);
    });

    it('12. Date range boundary filtering: Only tickets within range are included', () => {
        const res = calculateCarrierFinance(sampleTickets, [], carrierOwner, { from: '2026-08-12', to: '2026-08-20' });
        assert.strictEqual(res.status, 200);
        // Only ticket #102 is on 2026-08-15
        assert.strictEqual(res.data.trips.length, 1);
        assert.strictEqual(res.data.trips[0].ticket_id, 102);
    });

    it('13. Source breakdown correctly attributes Web, Telegram, Links and Manual', () => {
        const bookings = [
            { id: 1, bus_ticket_id: 101, total_price: 100, channel: 'web', source_type: 'platform', commission_rate: 10, commission_amount: 10, carrier_amount: 90, status: 'confirmed' },
            { id: 2, bus_ticket_id: 101, total_price: 200, channel: 'telegram', source_type: 'platform', commission_rate: 10, commission_amount: 20, carrier_amount: 180, status: 'confirmed' },
            { id: 3, bus_ticket_id: 101, total_price: 300, channel: 'web', source_type: 'carrier_link', commission_rate: 10, commission_amount: 30, carrier_amount: 270, status: 'confirmed' },
            { id: 4, bus_ticket_id: 101, total_price: 400, channel: 'manual', source_type: 'manual', commission_rate: 0, commission_amount: 0, carrier_amount: 400, status: 'confirmed' }
        ];

        const res = calculateCarrierFinance(sampleTickets, bookings, carrierOwner, { from: '2026-08-01', to: '2026-08-31' });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.data.source_breakdown.length, 4);

        const web = res.data.source_breakdown.find(s => s.key === 'web');
        assert.strictEqual(web.gross, 100);

        const tg = res.data.source_breakdown.find(s => s.key === 'telegram');
        assert.strictEqual(tg.gross, 200);

        const carrierLink = res.data.source_breakdown.find(s => s.key === 'carrier_link');
        assert.strictEqual(carrierLink.gross, 300);

        const manual = res.data.source_breakdown.find(s => s.key === 'manual');
        assert.strictEqual(manual.gross, 400);
    });

    it('14. Mathematical Reconciliation Invariant: confirmed_gross === service_commission + carrier_amount', () => {
        const bookings = [
            { id: 1, bus_ticket_id: 101, total_price: 150, channel: 'web', source_type: 'platform', commission_rate: 10, commission_amount: 15, carrier_amount: 135, status: 'confirmed' },
            { id: 2, bus_ticket_id: 101, total_price: 250, channel: 'manual', source_type: 'manual', commission_rate: 0, commission_amount: 0, carrier_amount: 250, status: 'confirmed' },
            { id: 3, bus_ticket_id: 102, total_price: 400, channel: 'web', source_type: 'platform', commission_rate: 10, commission_amount: 40, carrier_amount: 360, status: 'confirmed' }
        ];

        const res = calculateCarrierFinance(sampleTickets, bookings, carrierOwner, { from: '2026-08-01', to: '2026-08-31' });
        assert.strictEqual(res.status, 200);

        const totals = res.data.totals;
        assert.strictEqual(totals.confirmed_gross, totals.service_commission + totals.carrier_amount);
        assert.strictEqual(totals.confirmed_gross, 800);
        assert.strictEqual(totals.service_commission, 55);
        assert.strictEqual(totals.carrier_amount, 745);
    });
});
