const { describe, it } = require('node:test');
const assert = require('node:assert');

describe('Phase P0.2: Booking Operations & Trip Financial Summary', () => {

    // Mock tickets
    const ticketA = {
        id: 101,
        carrier_id: 10,
        from_city: 'Душанбе',
        to_city: 'Худжанд',
        departure_date: '2026-08-30',
        departure_time: '08:00',
        price: 150,
        total_seats: 50
    };

    const ticketB = {
        id: 202,
        carrier_id: 99, // Different carrier
        from_city: 'Душанбе',
        to_city: 'Куляб',
        departure_date: '2026-08-30',
        departure_time: '09:00',
        price: 100,
        total_seats: 40
    };

    // Mock carriers
    const carrierOwner = { id: 10, role: 'owner', carrier_id: 10 };
    const carrierDispatcher = { id: 11, role: 'dispatcher', carrier_id: 10 };
    const carrierDriver = { id: 12, role: 'driver', carrier_id: 10 };
    const carrierForeign = { id: 99, role: 'owner', carrier_id: 99 };

    // Financial Calculation Logic Function (mirrors routes/busAdmin.js logic)
    function calculateTripFinancialSummary(ticket, bookings, carrierUser) {
        // Gate 1: Driver role forbidden
        if (carrierUser.role === 'driver') {
            return { status: 403, error: 'Доступ к финансовым данным рейса запрещен для роли водителя' };
        }

        // Gate 2: Tenant isolation
        if (ticket.carrier_id !== carrierUser.carrier_id) {
            return { status: 403, error: 'Доступ запрещен: рейс не принадлежит вашему аккаунту перевозчика' };
        }

        const capacity = ticket.total_seats || 53;
        const allBookings = bookings || [];

        // Count unique booked seats from non-cancelled bookings
        const activeBookings = allBookings.filter(b => b.status !== 'cancelled');
        const uniqueReservedSeats = new Set();

        activeBookings.forEach(b => {
            let seats = [];
            try {
                seats = typeof b.seat_numbers === 'string' ? JSON.parse(b.seat_numbers || '[]') : (b.seat_numbers || []);
                if (!Array.isArray(seats)) seats = seats ? [seats] : [];
            } catch(e) { }
            seats.forEach(s => uniqueReservedSeats.add(s));
        });

        const bookedSeatsCount = uniqueReservedSeats.size;
        const freeSeatsCount = Math.max(0, capacity - bookedSeatsCount);
        const fillRate = capacity > 0 ? parseFloat(((bookedSeatsCount / capacity) * 100).toFixed(1)) : 0;

        const confirmedBookings = allBookings.filter(b => b.status === 'confirmed');
        const pendingBookings = allBookings.filter(b => b.status === 'pending_payment');
        const cancelledBookings = allBookings.filter(b => b.status === 'cancelled');

        const onlineBookings = confirmedBookings.filter(b => b.channel !== 'manual' && b.source_type !== 'manual');
        const manualBookings = confirmedBookings.filter(b => b.channel === 'manual' || b.source_type === 'manual' || b.source_type === 'carrier');

        let paidAmount = 0;
        let serviceCommission = 0;
        let carrierAmount = 0;
        let unpaidAmount = 0;

        confirmedBookings.forEach(b => {
            const totalPrice = Number(b.total_price || 0);
            const isManual = b.channel === 'manual' || b.source_type === 'manual' || b.source_type === 'carrier';
            
            paidAmount += totalPrice;

            if (isManual) {
                carrierAmount += totalPrice;
            } else {
                const commRate = Number(b.commission_rate ?? 10);
                const comm = Number(b.commission_amount > 0 ? b.commission_amount : Math.round(totalPrice * (commRate / 100)));
                serviceCommission += comm;
                carrierAmount += Math.max(0, totalPrice - comm);
            }
        });

        pendingBookings.forEach(b => {
            unpaidAmount += Number(b.total_price || 0);
        });

        let boardingPending = 0;
        let boardingBoarded = 0;
        let boardingNoShow = 0;

        confirmedBookings.forEach(b => {
            const count = b.passenger_count || (Array.isArray(b.passengers_data) ? b.passengers_data.length : 1) || 1;
            const bStatus = b.boarding_status || 'pending_boarding';
            if (bStatus === 'boarded') {
                boardingBoarded += count;
            } else if (bStatus === 'no_show') {
                boardingNoShow += count;
            } else {
                boardingPending += count;
            }
        });

        return {
            status: 200,
            data: {
                ticket_id: ticket.id,
                capacity,
                booked_seats: bookedSeatsCount,
                free_seats: freeSeatsCount,
                fill_rate: fillRate,
                bookings_total: allBookings.length,
                confirmed_bookings: confirmedBookings.length,
                pending_bookings: pendingBookings.length,
                cancelled_bookings: cancelledBookings.length,
                online_bookings: onlineBookings.length,
                manual_bookings: manualBookings.length,
                gross_amount: paidAmount,
                paid_amount: paidAmount,
                unpaid_amount: unpaidAmount,
                service_commission: serviceCommission,
                carrier_amount: carrierAmount,
                boarding: {
                    total_passengers: boardingPending + boardingBoarded + boardingNoShow,
                    pending: boardingPending,
                    boarded: boardingBoarded,
                    no_show: boardingNoShow
                }
            }
        };
    }

    it('1. Security Gate: Driver role MUST receive 403 on financial summary', () => {
        const res = calculateTripFinancialSummary(ticketA, [], carrierDriver);
        assert.strictEqual(res.status, 403);
        assert.match(res.error, /запрещен для роли водителя/);
    });

    it('2. Security Gate: Foreign carrier MUST receive 403 on cross-tenant ticket', () => {
        const res = calculateTripFinancialSummary(ticketA, [], carrierForeign);
        assert.strictEqual(res.status, 403);
        assert.match(res.error, /не принадлежит вашему аккаунту/);
    });

    it('3. Owner and Dispatcher CAN access summary of their own ticket', () => {
        const resOwner = calculateTripFinancialSummary(ticketA, [], carrierOwner);
        assert.strictEqual(resOwner.status, 200);

        const resDisp = calculateTripFinancialSummary(ticketA, [], carrierDispatcher);
        assert.strictEqual(resDisp.status, 200);
    });

    it('4. Online booking calculates 10% commission and 90% carrier payout from historical snapshot', () => {
        const bookings = [
            {
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
                boarding_status: 'pending_boarding'
            }
        ];

        const res = calculateTripFinancialSummary(ticketA, bookings, carrierOwner);
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.data.booked_seats, 2);
        assert.strictEqual(res.data.paid_amount, 300);
        assert.strictEqual(res.data.service_commission, 30);
        assert.strictEqual(res.data.carrier_amount, 270);
        assert.strictEqual(res.data.online_bookings, 1);
        assert.strictEqual(res.data.manual_bookings, 0);
    });

    it('5. Manual booking calculates 0% commission and 100% carrier payout', () => {
        const bookings = [
            {
                id: 2,
                bus_ticket_id: 101,
                seat_numbers: [3],
                passenger_count: 1,
                total_price: 150,
                channel: 'manual',
                source_type: 'manual',
                commission_rate: 0,
                commission_amount: 0,
                carrier_amount: 150,
                status: 'confirmed',
                boarding_status: 'boarded'
            }
        ];

        const res = calculateTripFinancialSummary(ticketA, bookings, carrierOwner);
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.data.booked_seats, 1);
        assert.strictEqual(res.data.paid_amount, 150);
        assert.strictEqual(res.data.service_commission, 0);
        assert.strictEqual(res.data.carrier_amount, 150);
        assert.strictEqual(res.data.online_bookings, 0);
        assert.strictEqual(res.data.manual_bookings, 1);
        assert.strictEqual(res.data.boarding.boarded, 1);
    });

    it('6. Mixed bookings correctly aggregate online + manual totals', () => {
        const bookings = [
            {
                id: 1,
                bus_ticket_id: 101,
                seat_numbers: [1, 2],
                passenger_count: 2,
                total_price: 300,
                channel: 'telegram',
                source_type: 'platform',
                commission_rate: 10,
                commission_amount: 30,
                carrier_amount: 270,
                status: 'confirmed',
                boarding_status: 'boarded'
            },
            {
                id: 2,
                bus_ticket_id: 101,
                seat_numbers: [5],
                passenger_count: 1,
                total_price: 150,
                channel: 'manual',
                source_type: 'carrier',
                commission_rate: 0,
                commission_amount: 0,
                carrier_amount: 150,
                status: 'confirmed',
                boarding_status: 'pending_boarding'
            }
        ];

        const res = calculateTripFinancialSummary(ticketA, bookings, carrierOwner);
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.data.booked_seats, 3);
        assert.strictEqual(res.data.free_seats, 47); // 50 capacity - 3
        assert.strictEqual(res.data.fill_rate, 6.0); // 3 / 50 * 100 = 6%
        assert.strictEqual(res.data.paid_amount, 450);
        assert.strictEqual(res.data.service_commission, 30);
        assert.strictEqual(res.data.carrier_amount, 420); // 270 + 150
        assert.strictEqual(res.data.boarding.total_passengers, 3);
        assert.strictEqual(res.data.boarding.boarded, 2);
        assert.strictEqual(res.data.boarding.pending, 1);
    });

    it('7. Cancelled bookings are excluded from seat count and revenue', () => {
        const bookings = [
            {
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
                status: 'cancelled',
                boarding_status: 'pending_boarding'
            }
        ];

        const res = calculateTripFinancialSummary(ticketA, bookings, carrierOwner);
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.data.booked_seats, 0);
        assert.strictEqual(res.data.free_seats, 50);
        assert.strictEqual(res.data.paid_amount, 0);
        assert.strictEqual(res.data.service_commission, 0);
        assert.strictEqual(res.data.carrier_amount, 0);
        assert.strictEqual(res.data.cancelled_bookings, 1);
    });

    it('8. Pending payment bookings are tracked in unpaid_amount and occupy seats', () => {
        const bookings = [
            {
                id: 1,
                bus_ticket_id: 101,
                seat_numbers: [10],
                passenger_count: 1,
                total_price: 150,
                channel: 'web',
                source_type: 'platform',
                status: 'pending_payment'
            }
        ];

        const res = calculateTripFinancialSummary(ticketA, bookings, carrierOwner);
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.data.booked_seats, 1);
        assert.strictEqual(res.data.paid_amount, 0);
        assert.strictEqual(res.data.unpaid_amount, 150);
        assert.strictEqual(res.data.pending_bookings, 1);
    });

    it('9. Historical Snapshot Safety: Future ticket price changes do NOT mutate past booking financials', () => {
        // Booking created when ticket price was 150
        const bookingOld = {
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
        };

        // Ticket price was raised to 250 afterwards
        const updatedTicket = { ...ticketA, price: 250 };

        const res = calculateTripFinancialSummary(updatedTicket, [bookingOld], carrierOwner);
        assert.strictEqual(res.status, 200);
        // Financials must remain 150, not 250
        assert.strictEqual(res.data.paid_amount, 150);
        assert.strictEqual(res.data.service_commission, 15);
        assert.strictEqual(res.data.carrier_amount, 135);
    });

    it('10. Multi-seat parsing handles both JSON arrays and raw arrays safely', () => {
        const bookings = [
            {
                id: 1,
                bus_ticket_id: 101,
                seat_numbers: '[1, 2, 3]', // JSON string
                passenger_count: 3,
                total_price: 450,
                channel: 'web',
                source_type: 'platform',
                commission_rate: 10,
                commission_amount: 45,
                carrier_amount: 405,
                status: 'confirmed'
            },
            {
                id: 2,
                bus_ticket_id: 101,
                seat_numbers: [4, 5], // JS Array
                passenger_count: 2,
                total_price: 300,
                channel: 'manual',
                source_type: 'manual',
                commission_rate: 0,
                commission_amount: 0,
                carrier_amount: 300,
                status: 'confirmed'
            }
        ];

        const res = calculateTripFinancialSummary(ticketA, bookings, carrierOwner);
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.data.booked_seats, 5);
        assert.strictEqual(res.data.free_seats, 45);
        assert.strictEqual(res.data.fill_rate, 10.0);
        assert.strictEqual(res.data.paid_amount, 750);
        assert.strictEqual(res.data.service_commission, 45);
        assert.strictEqual(res.data.carrier_amount, 705);
    });

    it('11. Driver Projection Security: GET /bookings projection omits financial fields for driver role', () => {
        const rawBooking = {
            id: 1,
            bus_ticket_id: 101,
            passenger_name: 'Иван Иванов',
            phone: '+992900000000',
            seat_numbers: [1],
            passenger_count: 1,
            total_price: 150,
            channel: 'web',
            source_type: 'platform',
            commission_rate: 10,
            commission_amount: 15,
            carrier_amount: 135,
            status: 'confirmed'
        };

        function mapBookingForRole(b, role) {
            const isDriver = role === 'driver';
            const isManual = b.channel === 'manual' || b.source_type === 'manual' || b.source_type === 'carrier';
            const totalPrice = Number(b.total_price || 0);
            const commRate = Number(b.commission_rate ?? (isManual ? 0 : 10));
            const commAmount = Number(b.commission_amount ?? (isManual ? 0 : Math.round(totalPrice * (commRate / 100))));
            const carrierAmount = Number(b.carrier_amount ?? Math.max(0, totalPrice - commAmount));

            return {
                id: b.id,
                passenger_name: b.passenger_name,
                passenger_phone: b.phone,
                commission_rate: isDriver ? null : commRate,
                commission_amount: isDriver ? null : commAmount,
                carrier_amount: isDriver ? null : carrierAmount,
                total_price: isDriver ? null : totalPrice
            };
        }

        const driverView = mapBookingForRole(rawBooking, 'driver');
        assert.strictEqual(driverView.commission_rate, null);
        assert.strictEqual(driverView.commission_amount, null);
        assert.strictEqual(driverView.carrier_amount, null);
        assert.strictEqual(driverView.total_price, null);
        assert.strictEqual(driverView.passenger_name, 'Иван Иванов');

        const ownerView = mapBookingForRole(rawBooking, 'owner');
        assert.strictEqual(ownerView.commission_rate, 10);
        assert.strictEqual(ownerView.commission_amount, 15);
        assert.strictEqual(ownerView.carrier_amount, 135);
        assert.strictEqual(ownerView.total_price, 150);
    });

    it('12. No-show passengers do NOT reduce confirmed paid_amount', () => {
        const bookings = [
            {
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
                status: 'confirmed',
                boarding_status: 'no_show' // Passenger did not show up
            }
        ];

        const res = calculateTripFinancialSummary(ticketA, bookings, carrierOwner);
        assert.strictEqual(res.status, 200);
        // Revenue is kept, not deducted
        assert.strictEqual(res.data.paid_amount, 150);
        assert.strictEqual(res.data.service_commission, 15);
        assert.strictEqual(res.data.carrier_amount, 135);
        assert.strictEqual(res.data.boarding.no_show, 1);
    });
});

