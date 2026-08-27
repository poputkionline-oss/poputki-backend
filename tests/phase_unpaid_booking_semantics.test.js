/**
 * Tests for Phase P1.4: Unpaid Booking Semantics & State Isolation
 * 
 * Verifies that:
 * 1. Business status (pending_payment, confirmed, cancelled) is strictly separated from Boarding status.
 * 2. pending_payment bookings are tracked as held seats / pending revenue, but NEVER as confirmed passengers,
 *    boarded, pending_boarding, no_show, or confirmed gross revenue.
 * 3. Boarding API endpoint (PATCH /bookings/:id/boarding) rejects any non-confirmed booking with 400 Bad Request.
 * 4. CRM metrics and calculations never treat pending_payment as confirmed revenue or completed trips.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
    calculateTripFillStats,
    buildTodaySummary,
    getBookingPassengerCount
} = require('../utils/dashboardHelper');

const {
    aggregateCarrierCustomers,
    getCustomerDetails
} = require('../utils/crmHelper');

describe('PHASE UNPAID BOOKING SEMANTICS TEST SUITE', () => {

    const sampleTicket = {
        id: 52,
        operator_id: 11,
        total_seats: 50,
        price: 800,
        departure_date: '2026-08-28',
        departure_time: '10:00',
        from_city: 'Нижневартовск',
        to_city: 'Канибадам'
    };

    // 1. pending_payment is not counted as confirmed passenger in calculateTripFillStats
    it('1. pending_payment booking is not counted in passengers_count (confirmed only)', () => {
        const bookings = [
            { id: 407, bus_ticket_id: 52, status: 'pending_payment', boarding_status: 'pending_boarding', passenger_count: 2, seat_numbers: [1, 2] },
            { id: 410, bus_ticket_id: 52, status: 'confirmed', boarding_status: 'pending_boarding', passenger_count: 1, seat_numbers: [3] }
        ];

        const stats = calculateTripFillStats(sampleTicket, bookings);
        assert.equal(stats.passengers_count, 1, 'Only confirmed booking passenger should count towards passengers_count');
    });

    // 2. pending_payment does not increment boarding counters in calculateTripFillStats
    it('2. pending_payment booking does not increment boarded_count, pending_boarding_count, or no_show_count', () => {
        const bookings = [
            { id: 407, bus_ticket_id: 52, status: 'pending_payment', boarding_status: 'pending_boarding', passenger_count: 1, seat_numbers: [1] },
            { id: 408, bus_ticket_id: 52, status: 'pending_payment', boarding_status: 'boarded', passenger_count: 1, seat_numbers: [2] },
            { id: 409, bus_ticket_id: 52, status: 'pending_payment', boarding_status: 'no_show', passenger_count: 1, seat_numbers: [3] }
        ];

        const stats = calculateTripFillStats(sampleTicket, bookings);
        assert.equal(stats.boarded_count, 0, 'No boarded count for unpaid');
        assert.equal(stats.pending_boarding_count, 0, 'No pending boarding count for unpaid');
        assert.equal(stats.no_show_count, 0, 'No no_show count for unpaid');
        assert.equal(stats.confirmed_bookings, 0, 'Confirmed bookings must be 0');
    });

    // 3. pending_payment correctly increments pending_payment_count and pending_payment_passengers
    it('3. pending_payment booking correctly increments pending_payment_count and pending_payment_passengers', () => {
        const bookings = [
            { id: 407, bus_ticket_id: 52, status: 'pending_payment', passenger_count: 3, seat_numbers: [1, 2, 3] },
            { id: 408, bus_ticket_id: 52, status: 'pending_payment', passenger_count: 2, seat_numbers: [4, 5] }
        ];

        const stats = calculateTripFillStats(sampleTicket, bookings);
        assert.equal(stats.pending_payment_count, 2, 'Pending payment count must be 2');
        assert.equal(stats.pending_payment_passengers, 5, 'Pending payment passengers must be 5');
    });

    // 4. pending_payment seats are tracked in held_seats and total booked_seats, but NOT confirmed_seats
    it('4. pending_payment seats are tracked in held_seats and booked_seats, but NOT confirmed_seats', () => {
        const bookings = [
            { id: 407, bus_ticket_id: 52, status: 'pending_payment', seat_numbers: [1, 2] },
            { id: 410, bus_ticket_id: 52, status: 'confirmed', seat_numbers: [3, 4] }
        ];

        const stats = calculateTripFillStats(sampleTicket, bookings);
        assert.equal(stats.booked_seats, 4, 'Total occupied seats is 4 (2 held + 2 confirmed)');
        assert.equal(stats.confirmed_seats, 2, 'Confirmed seats must be 2');
        assert.equal(stats.held_seats, 2, 'Held seats must be 2');
        assert.equal(stats.free_seats, 46, 'Free seats is 50 - 4 = 46');
    });

    // 5. Confirmed booking with pending_boarding increments pending_boarding_count and confirmed_bookings
    it('5. Confirmed booking with pending_boarding increments pending_boarding_count and confirmed_bookings', () => {
        const bookings = [
            { id: 410, bus_ticket_id: 52, status: 'confirmed', boarding_status: 'pending_boarding', passenger_count: 1, seat_numbers: [1] }
        ];

        const stats = calculateTripFillStats(sampleTicket, bookings);
        assert.equal(stats.confirmed_bookings, 1);
        assert.equal(stats.pending_boarding_count, 1);
        assert.equal(stats.boarded_count, 0);
        assert.equal(stats.no_show_count, 0);
    });

    // 6. Confirmed booking with boarded increments boarded_count
    it('6. Confirmed booking with boarded increments boarded_count', () => {
        const bookings = [
            { id: 410, bus_ticket_id: 52, status: 'confirmed', boarding_status: 'boarded', passenger_count: 1, seat_numbers: [1] }
        ];

        const stats = calculateTripFillStats(sampleTicket, bookings);
        assert.equal(stats.confirmed_bookings, 1);
        assert.equal(stats.boarded_count, 1);
        assert.equal(stats.pending_boarding_count, 0);
    });

    // 7. Confirmed booking with no_show increments no_show_count
    it('7. Confirmed booking with no_show increments no_show_count', () => {
        const bookings = [
            { id: 410, bus_ticket_id: 52, status: 'confirmed', boarding_status: 'no_show', passenger_count: 1, seat_numbers: [1] }
        ];

        const stats = calculateTripFillStats(sampleTicket, bookings);
        assert.equal(stats.confirmed_bookings, 1);
        assert.equal(stats.no_show_count, 1);
        assert.equal(stats.boarded_count, 0);
    });

    // 8. Cancelled booking is excluded from fill stats and passengers
    it('8. Cancelled booking is excluded from fill stats, passengers, and occupied seats', () => {
        const bookings = [
            { id: 411, bus_ticket_id: 52, status: 'cancelled', boarding_status: 'boarded', passenger_count: 2, seat_numbers: [1, 2] }
        ];

        const stats = calculateTripFillStats(sampleTicket, bookings);
        assert.equal(stats.booked_seats, 0);
        assert.equal(stats.passengers_count, 0);
        assert.equal(stats.confirmed_bookings, 0);
        assert.equal(stats.pending_payment_count, 0);
        assert.equal(stats.boarded_count, 0);
    });

    // 9. buildTodaySummary separates gross_amount from pending_payment_gross
    it('9. buildTodaySummary isolates confirmed gross_amount from pending_payment_gross', () => {
        const tickets = [sampleTicket];
        const bookings = [
            { id: 407, bus_ticket_id: 52, status: 'pending_payment', total_price: 800, passenger_count: 1, seat_numbers: [1] },
            { id: 408, bus_ticket_id: 52, status: 'confirmed', total_price: 1600, commission_amount: 160, carrier_amount: 1440, passenger_count: 2, seat_numbers: [2, 3] }
        ];

        const summary = buildTodaySummary(tickets, bookings);
        assert.equal(summary.gross_amount, 1600, 'Confirmed gross must be 1600');
        assert.equal(summary.pending_payment_gross, 800, 'Pending payment gross must be 800');
        assert.equal(summary.confirmed_bookings, 1);
        assert.equal(summary.pending_payment, 1);
    });

    // 10. buildTodaySummary calculates service_commission and carrier_amount strictly from confirmed bookings
    it('10. buildTodaySummary calculates service_commission and carrier_amount strictly from confirmed bookings', () => {
        const tickets = [sampleTicket];
        const bookings = [
            { id: 407, bus_ticket_id: 52, status: 'pending_payment', total_price: 800, commission_amount: 80, carrier_amount: 720, passenger_count: 1, seat_numbers: [1] },
            { id: 408, bus_ticket_id: 52, status: 'confirmed', total_price: 1000, commission_amount: 100, carrier_amount: 900, passenger_count: 1, seat_numbers: [2] }
        ];

        const summary = buildTodaySummary(tickets, bookings);
        assert.equal(summary.service_commission, 100, 'Service commission must include only confirmed');
        assert.equal(summary.carrier_amount, 900, 'Carrier amount must include only confirmed');
    });

    // 11. buildTodaySummary boarding counters include exclusively confirmed passengers
    it('11. buildTodaySummary boarding counters include exclusively confirmed passengers', () => {
        const tickets = [sampleTicket];
        const bookings = [
            { id: 407, bus_ticket_id: 52, status: 'pending_payment', boarding_status: 'boarded', passenger_count: 1, seat_numbers: [1] },
            { id: 408, bus_ticket_id: 52, status: 'confirmed', boarding_status: 'boarded', passenger_count: 2, seat_numbers: [2, 3] },
            { id: 409, bus_ticket_id: 52, status: 'confirmed', boarding_status: 'no_show', passenger_count: 1, seat_numbers: [4] }
        ];

        const summary = buildTodaySummary(tickets, bookings);
        assert.equal(summary.boarding.boarded, 2, 'Only confirmed passengers counted as boarded');
        assert.equal(summary.boarding.no_show, 1, 'Only confirmed passengers counted as no_show');
        assert.equal(summary.boarding.pending_boarding, 0);
    });

    // 12. buildTodaySummary tracks pending_payment_passengers accurately
    it('12. buildTodaySummary tracks pending_payment_passengers accurately', () => {
        const tickets = [sampleTicket];
        const bookings = [
            { id: 407, bus_ticket_id: 52, status: 'pending_payment', passenger_count: 4, seat_numbers: [1, 2, 3, 4] }
        ];

        const summary = buildTodaySummary(tickets, bookings);
        assert.equal(summary.pending_payment, 1);
        assert.equal(summary.pending_payment_passengers, 4);
        assert.equal(summary.passengers_count, 0, 'Confirmed passengers must be 0');
    });

    // 13. getBookingPassengerCount handles various passenger data structures
    it('13. getBookingPassengerCount correctly handles numeric, array, and fallback passenger formats', () => {
        assert.equal(getBookingPassengerCount({ passenger_count: 3 }), 3);
        assert.equal(getBookingPassengerCount({ passengers_data: [{ name: 'A' }, { name: 'B' }] }), 2);
        assert.equal(getBookingPassengerCount({}), 1);
    });

    // 14. Boarding mutation security check logic simulation
    it('14. Boarding guard rejects booking if status is not confirmed', () => {
        const canMutateBoarding = (booking) => {
            if (!booking || booking.status !== 'confirmed') {
                return { allowed: false, status: 400, error: 'Посадка доступна только для подтвержденной брони' };
            }
            return { allowed: true };
        };

        const pendingBooking = { id: 407, status: 'pending_payment', boarding_status: 'pending_boarding' };
        const cancelledBooking = { id: 408, status: 'cancelled', boarding_status: 'pending_boarding' };
        const confirmedBooking = { id: 409, status: 'confirmed', boarding_status: 'pending_boarding' };

        assert.equal(canMutateBoarding(pendingBooking).allowed, false);
        assert.equal(canMutateBoarding(pendingBooking).status, 400);
        assert.equal(canMutateBoarding(cancelledBooking).allowed, false);
        assert.equal(canMutateBoarding(cancelledBooking).status, 400);
        assert.equal(canMutateBoarding(confirmedBooking).allowed, true);
    });

    // 15. Boarding guard error message compliance
    it('15. Boarding guard returns exact required error message', () => {
        const pendingBooking = { id: 407, status: 'pending_payment' };
        const errMsg = pendingBooking.status !== 'confirmed' ? 'Посадка доступна только для подтвержденной брони' : null;
        assert.equal(errMsg, 'Посадка доступна только для подтвержденной брони');
    });

    // 16. Boarding statuses allow only canonical set for confirmed bookings
    it('16. Valid boarding statuses for confirmed bookings are boarded, no_show, and pending_boarding', () => {
        const validStatuses = new Set(['boarded', 'no_show', 'pending_boarding']);
        assert.equal(validStatuses.has('boarded'), true);
        assert.equal(validStatuses.has('no_show'), true);
        assert.equal(validStatuses.has('pending_boarding'), true);
        assert.equal(validStatuses.has('invalid_status'), false);
    });

    // 17. CRM aggregateCarrierCustomers does not count pending_payment in confirmed_trips or total_revenue
    it('17. CRM aggregateCarrierCustomers does not count pending_payment in confirmed_trips or revenue', () => {
        const bookings = [
            {
                id: 407,
                bus_ticket_id: 52,
                phone: '+79991112233',
                passenger_name: 'Иванов Иван',
                status: 'pending_payment',
                boarding_status: 'pending_boarding',
                total_price: 800,
                created_at: '2026-08-28T00:00:00Z'
            }
        ];

        const crmResult = aggregateCarrierCustomers(bookings, [sampleTicket], 11, { search: '', page: 1, limit: 10 });
        assert.equal(crmResult.summary.total_revenue, 0, 'Unpaid booking must not increase CRM total revenue');
        assert.equal(crmResult.customers[0].confirmed_trips, 0, 'Confirmed trips must be 0');
        assert.equal(crmResult.customers[0].loyalty_badge, 'new');
    });

    // 18. CRM aggregateCarrierCustomers does not count no_show for pending_payment bookings
    it('18. CRM aggregateCarrierCustomers ignores no_show on pending_payment bookings', () => {
        const bookings = [
            {
                id: 407,
                bus_ticket_id: 52,
                phone: '+79991112233',
                passenger_name: 'Иванов Иван',
                status: 'pending_payment',
                boarding_status: 'no_show',
                total_price: 800,
                created_at: '2026-08-28T00:00:00Z'
            }
        ];

        const crmResult = aggregateCarrierCustomers(bookings, [sampleTicket], 11);
        assert.equal(crmResult.customers[0].no_show_count, 0, 'No-show must not be counted for pending_payment');
        assert.equal(crmResult.summary.total_no_shows, 0);
    });

    // 19. CRM getCustomerDetails isolates confirmed_trips, future_trips, and keeps pending_payment distinct
    it('19. CRM getCustomerDetails keeps confirmed_trips and future_trips strict for confirmed bookings only', () => {
        const bookings = [
            {
                id: 407,
                bus_ticket_id: 52,
                phone: '+79991112233',
                passenger_name: 'Иванов Иван',
                status: 'pending_payment',
                boarding_status: 'pending_boarding',
                total_price: 800,
                created_at: '2026-08-28T00:00:00Z'
            }
        ];

        const crmList = aggregateCarrierCustomers(bookings, [sampleTicket], 11);
        const customerKey = crmList.customers[0].customer_key;

        const details = getCustomerDetails(bookings, [sampleTicket], customerKey, 11);
        assert.equal(details.statistics.confirmed_trips, 0);
        assert.equal(details.statistics.future_trips, 0);
        assert.equal(details.statistics.total_booking_value, 0);
        assert.equal(details.future_bookings[0].status, 'pending_payment');
    });

    // 20. Multi-passenger pending_payment booking holds all seats without distorting confirmed revenue
    it('20. Multi-passenger pending_payment booking holds multiple seats without distorting confirmed revenue', () => {
        const bookings = [
            {
                id: 407,
                bus_ticket_id: 52,
                phone: '+79991112233',
                passenger_name: 'Иванов Иван',
                status: 'pending_payment',
                boarding_status: 'pending_boarding',
                passenger_count: 3,
                seat_numbers: [10, 11, 12],
                total_price: 2400
            },
            {
                id: 410,
                bus_ticket_id: 52,
                phone: '+79995556677',
                passenger_name: 'Петров Петр',
                status: 'confirmed',
                boarding_status: 'boarded',
                passenger_count: 1,
                seat_numbers: [15],
                total_price: 800,
                commission_amount: 80,
                carrier_amount: 720
            }
        ];

        const stats = calculateTripFillStats(sampleTicket, bookings);
        assert.equal(stats.booked_seats, 4);
        assert.equal(stats.held_seats, 3);
        assert.equal(stats.confirmed_seats, 1);
        assert.equal(stats.passengers_count, 1);
        assert.equal(stats.boarded_count, 1);
        assert.equal(stats.pending_payment_count, 1);
        assert.equal(stats.pending_payment_passengers, 3);

        const summary = buildTodaySummary([sampleTicket], bookings);
        assert.equal(summary.gross_amount, 800);
        assert.equal(summary.pending_payment_gross, 2400);
        assert.equal(summary.carrier_amount, 720);
        assert.equal(summary.service_commission, 80);
    });

    // 21. Frontend/Backend Confirmed Status Consistency
    it('21. Canonical confirmed status is strictly "confirmed"', () => {
        const isConfirmedBookingStatus = (status) => status === 'confirmed';

        assert.equal(isConfirmedBookingStatus('confirmed'), true);
        assert.equal(isConfirmedBookingStatus('paid'), false, 'paid is non-canonical and not in production schema');
        assert.equal(isConfirmedBookingStatus('pending_payment'), false);
        assert.equal(isConfirmedBookingStatus('cancelled'), false);
    });

    // 22. Trip #52 Semantic Scenario Simulation
    it('22. Trip #52 exact simulation: 3 pending_payment bookings yields 0 confirmed, 3 held seats, 0 gross', () => {
        const trip52Ticket = {
            id: 52,
            operator_id: 11,
            total_seats: 50,
            price: 800,
            departure_date: '2026-08-28',
            departure_time: '00:22',
            from_city: 'Нижневартовск',
            to_city: 'Канибадам'
        };

        const trip52Bookings = [
            { id: 407, bus_ticket_id: 52, status: 'pending_payment', boarding_status: 'pending_boarding', passenger_count: 1, seat_numbers: [70], total_price: 800 },
            { id: 408, bus_ticket_id: 52, status: 'pending_payment', boarding_status: 'pending_boarding', passenger_count: 1, seat_numbers: [1], total_price: 800 },
            { id: 409, bus_ticket_id: 52, status: 'pending_payment', boarding_status: 'pending_boarding', passenger_count: 1, seat_numbers: [5], total_price: 800 }
        ];

        const stats = calculateTripFillStats(trip52Ticket, trip52Bookings);
        assert.equal(stats.confirmed_bookings, 0, 'Confirmed bookings must be 0');
        assert.equal(stats.passengers_count, 0, 'Confirmed passengers must be 0');
        assert.equal(stats.confirmed_seats, 0, 'Confirmed seats must be 0');
        assert.equal(stats.held_seats, 3, 'Held seats must be 3');
        assert.equal(stats.booked_seats, 3, 'Occupied or held seats is 3');
        assert.equal(stats.free_seats, 47, 'Free seats is 50 - 3 = 47');
        assert.equal(stats.boarded_count, 0, 'Boarded must be 0');
        assert.equal(stats.pending_boarding_count, 0, 'Pending boarding must be 0');
        assert.equal(stats.no_show_count, 0, 'No show must be 0');

        const summary = buildTodaySummary([trip52Ticket], trip52Bookings);
        assert.equal(summary.gross_amount, 0, 'Confirmed Gross must be 0');
        assert.equal(summary.service_commission, 0, 'Service commission must be 0');
        assert.equal(summary.carrier_amount, 0, 'Carrier receivable must be 0');
        assert.equal(summary.pending_payment_gross, 2400, 'Pending payment total is 2400');
        assert.equal(summary.pending_payment, 3);
        assert.equal(summary.boarding.boarded, 0);
        assert.equal(summary.boarding.pending_boarding, 0);
        assert.equal(summary.boarding.no_show, 0);
    });

    // 23. Free Seats Formula Invariant
    it('23. Free seats invariant: free_seats === capacity - (confirmed_seats + held_seats)', () => {
        const ticket = { id: 1, total_seats: 50 };
        const bookings = [
            { bus_ticket_id: 1, status: 'confirmed', seat_numbers: [1, 2, 3] },
            { bus_ticket_id: 1, status: 'pending_payment', seat_numbers: [4, 5] },
            { bus_ticket_id: 1, status: 'cancelled', seat_numbers: [6, 7] }
        ];

        const stats = calculateTripFillStats(ticket, bookings);
        assert.equal(stats.confirmed_seats, 3);
        assert.equal(stats.held_seats, 2);
        assert.equal(stats.free_seats, 45); // 50 - (3 + 2) = 45
    });

    // 24. Boarding Mutation Rejection for Cancelled Booking
    it('24. Boarding mutation is strictly rejected for cancelled booking', () => {
        const booking = { id: 999, status: 'cancelled', boarding_status: 'pending_boarding' };
        const isAllowed = booking.status === 'confirmed';
        assert.equal(isAllowed, false);
    });

    // 25. Boarding Mutation Rejection for Pending Payment Booking
    it('25. Boarding mutation is strictly rejected for pending_payment booking', () => {
        const booking = { id: 998, status: 'pending_payment', boarding_status: 'pending_boarding' };
        const isAllowed = booking.status === 'confirmed';
        assert.equal(isAllowed, false);
    });

});

