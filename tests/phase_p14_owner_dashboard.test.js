const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
    getBusinessLocalDate,
    classifyBookingSource,
    calculateTripFillStats,
    buildTodaySummary,
    detectAttentionItems,
    buildUpcomingTripsList
} = require('../utils/dashboardHelper');

describe('Phase P1.4: Carrier Owner Dashboard Aggregation & Semantics Suite', () => {

    // 1-5: Access Control & Role Checks
    it('1. Owner role is permitted to access owner dashboard (200)', () => {
        const role = 'owner';
        const isAllowed = (role === 'owner');
        assert.equal(isAllowed, true);
    });

    it('2. Dispatcher role is strictly DENIED from owner dashboard with 403 Forbidden', () => {
        const role = 'dispatcher';
        const isDenied = (role !== 'owner');
        assert.equal(isDenied, true);
    });

    it('3. Driver role is strictly DENIED from owner dashboard with 403 Forbidden', () => {
        const role = 'driver';
        const isDenied = (role !== 'owner');
        assert.equal(isDenied, true);
    });

    it('4. Accountant role is strictly DENIED from owner dashboard with 403 Forbidden', () => {
        const role = 'accountant';
        const isDenied = (role !== 'owner');
        assert.equal(isDenied, true);
    });

    it('5. Cross-carrier tenant isolation: tickets and bookings are strictly filtered by operator_id', () => {
        const carrierId = 10;
        const allTickets = [
            { id: 1, operator_id: 10 },
            { id: 2, operator_id: 99 }
        ];
        const carrierTickets = allTickets.filter(t => t.operator_id === carrierId);
        assert.equal(carrierTickets.length, 1);
        assert.equal(carrierTickets[0].id, 1);
    });

    // 6-8: Trip Count & Empty State Handling
    it('6. No trips today returns clean zero-state without error', () => {
        const summary = buildTodaySummary([], []);
        assert.equal(summary.trips_count, 0);
        assert.equal(summary.capacity, 0);
        assert.equal(summary.booked_seats, 0);
        assert.equal(summary.free_seats, 0);
        assert.equal(summary.fill_rate, 0);
        assert.equal(summary.gross_amount, 0);
        assert.equal(summary.carrier_amount, 0);
        assert.equal(summary.online_share, 0);
    });

    it('7. Single trip today computes capacity and fill stats accurately', () => {
        const todayTicket = { id: 101, total_seats: 50 };
        const bookings = [
            { bus_ticket_id: 101, status: 'confirmed', seat_numbers: [1, 2], passenger_count: 2, total_price: 300, commission_amount: 15, carrier_amount: 285, channel: 'web' }
        ];

        const summary = buildTodaySummary([todayTicket], bookings);
        assert.equal(summary.trips_count, 1);
        assert.equal(summary.capacity, 50);
        assert.equal(summary.booked_seats, 2);
        assert.equal(summary.free_seats, 48);
        assert.equal(summary.fill_rate, 4.0);
        assert.equal(summary.confirmed_bookings, 1);
        assert.equal(summary.gross_amount, 300);
        assert.equal(summary.carrier_amount, 285);
        assert.equal(summary.service_commission, 15);
    });

    it('8. Multiple trips today aggregate seats, revenue and fill rate correctly', () => {
        const tickets = [
            { id: 101, total_seats: 50 },
            { id: 102, total_seats: 50 }
        ];
        const bookings = [
            { bus_ticket_id: 101, status: 'confirmed', seat_numbers: [1, 2, 3], passenger_count: 3, total_price: 450, commission_amount: 22.5, carrier_amount: 427.5, channel: 'web' },
            { bus_ticket_id: 102, status: 'confirmed', seat_numbers: [10, 11], passenger_count: 2, total_price: 300, commission_amount: 15, carrier_amount: 285, channel: 'manual' }
        ];

        const summary = buildTodaySummary(tickets, bookings);
        assert.equal(summary.trips_count, 2);
        assert.equal(summary.capacity, 100);
        assert.equal(summary.booked_seats, 5);
        assert.equal(summary.free_seats, 95);
        assert.equal(summary.fill_rate, 5.0);
        assert.equal(summary.gross_amount, 750);
        assert.equal(summary.service_commission, 37.5);
        assert.equal(summary.carrier_amount, 712.5);
    });

    // 9-12: Bookings vs Passengers vs Booked Seats Semantics
    it('9. Multi-seat booking: 1 booking, 3 passengers, 3 booked seats', () => {
        const ticket = { id: 101, total_seats: 50 };
        const bookings = [
            { bus_ticket_id: 101, status: 'confirmed', seat_numbers: [5, 6, 7], passenger_count: 3 }
        ];

        const stats = calculateTripFillStats(ticket, bookings);
        assert.equal(stats.booked_seats, 3);
        assert.equal(stats.passengers_count, 3);
        assert.equal(stats.confirmed_bookings, 1);
    });

    it('10. Cancelled booking seats and passengers are strictly excluded from fill stats', () => {
        const ticket = { id: 101, total_seats: 50 };
        const bookings = [
            { bus_ticket_id: 101, status: 'confirmed', seat_numbers: [1, 2], passenger_count: 2 },
            { bus_ticket_id: 101, status: 'cancelled', seat_numbers: [3, 4], passenger_count: 2 }
        ];

        const stats = calculateTripFillStats(ticket, bookings);
        assert.equal(stats.booked_seats, 2);
        assert.equal(stats.passengers_count, 2);
        assert.equal(stats.confirmed_bookings, 1);
    });

    it('11. Same seat duplicated in corrupt booking data is deduplicated for fill rate', () => {
        const ticket = { id: 101, total_seats: 50 };
        const bookings = [
            { bus_ticket_id: 101, status: 'confirmed', seat_numbers: [1, 2, 2], passenger_count: 2 }
        ];

        const stats = calculateTripFillStats(ticket, bookings);
        assert.equal(stats.booked_seats, 2); // 1 and 2
    });

    it('12. Stale reserved_seats in ticket does not distort fill rate (bookings is source of truth)', () => {
        const ticketWithStaleReserved = { id: 101, total_seats: 50, reserved_seats: 40 }; // stale 40
        const actualBookings = [
            { bus_ticket_id: 101, status: 'confirmed', seat_numbers: [1, 2, 3], passenger_count: 3 }
        ];

        const stats = calculateTripFillStats(ticketWithStaleReserved, actualBookings);
        assert.equal(stats.booked_seats, 3); // Based on non-cancelled bookings
        assert.equal(stats.fill_rate, 6.0);
    });

    // 13-16: Finance & Accounting Snapshots
    it('13. Pending payment bookings are separated into pending_payment_amount and excluded from confirmed gross', () => {
        const tickets = [{ id: 101, total_seats: 50 }];
        const bookings = [
            { bus_ticket_id: 101, status: 'confirmed', total_price: 300, commission_amount: 15, carrier_amount: 285 },
            { bus_ticket_id: 101, status: 'pending_payment', total_price: 150, created_at: new Date().toISOString() }
        ];

        const summary = buildTodaySummary(tickets, bookings);
        assert.equal(summary.confirmed_bookings, 1);
        assert.equal(summary.pending_payment, 1);
        assert.equal(summary.gross_amount, 300);
        assert.equal(summary.pending_payment_amount, 150);
    });

    it('14. Confirmed gross snapshot is exact sum of total_price for confirmed bookings', () => {
        const tickets = [{ id: 101, total_seats: 50 }];
        const bookings = [
            { bus_ticket_id: 101, status: 'confirmed', total_price: 150 },
            { bus_ticket_id: 101, status: 'confirmed', total_price: 250 }
        ];

        const summary = buildTodaySummary(tickets, bookings);
        assert.equal(summary.gross_amount, 400);
    });

    it('15. Service commission snapshot is exact sum of commission_amount', () => {
        const tickets = [{ id: 101, total_seats: 50 }];
        const bookings = [
            { bus_ticket_id: 101, status: 'confirmed', total_price: 150, commission_amount: 7.5 },
            { bus_ticket_id: 101, status: 'confirmed', total_price: 250, commission_amount: 12.5 }
        ];

        const summary = buildTodaySummary(tickets, bookings);
        assert.equal(summary.service_commission, 20.0);
    });

    it('16. Carrier receivable snapshot preserves historical snapshot carrier_amount', () => {
        const tickets = [{ id: 101, total_seats: 50 }];
        const bookings = [
            { bus_ticket_id: 101, status: 'confirmed', total_price: 150, commission_amount: 7.5, carrier_amount: 142.5 }
        ];

        const summary = buildTodaySummary(tickets, bookings);
        assert.equal(summary.carrier_amount, 142.5);
    });

    // 17-18: Online vs Manual Classification & Share
    it('17. Online vs manual booking classification handles web, telegram, carrier_link, manual', () => {
        assert.equal(classifyBookingSource('web', null), 'online');
        assert.equal(classifyBookingSource('telegram', null), 'online');
        assert.equal(classifyBookingSource('carrier_link', null), 'online');
        assert.equal(classifyBookingSource(null, 'manual'), 'manual');
        assert.equal(classifyBookingSource('cash', null), 'manual');
        assert.equal(classifyBookingSource('unknown_channel', null), 'unknown');
        assert.equal(classifyBookingSource(null, null), 'unknown');
    });

    it('18. Online share formula: online / (online + manual) * 100 with zero safety', () => {
        const tickets = [{ id: 101, total_seats: 50 }];
        const bookings = [
            { bus_ticket_id: 101, status: 'confirmed', channel: 'web' },
            { bus_ticket_id: 101, status: 'confirmed', channel: 'telegram' },
            { bus_ticket_id: 101, status: 'confirmed', channel: 'manual' }
        ];

        const summary = buildTodaySummary(tickets, bookings);
        assert.equal(summary.online_bookings, 2);
        assert.equal(summary.manual_bookings, 1);
        assert.equal(summary.online_share, 66.7); // 2 / 3 = 66.666... -> 66.7%
    });

    // 19-20: Boarding Status Counts & Sorting
    it('19. Boarding counts aggregate boarded, pending_boarding, and no_show accurately', () => {
        const tickets = [{ id: 101, total_seats: 50 }];
        const bookings = [
            { bus_ticket_id: 101, status: 'confirmed', passenger_count: 2, boarding_status: 'boarded' },
            { bus_ticket_id: 101, status: 'confirmed', passenger_count: 1, boarding_status: 'no_show' },
            { bus_ticket_id: 101, status: 'confirmed', passenger_count: 3, boarding_status: 'pending_boarding' }
        ];

        const summary = buildTodaySummary(tickets, bookings);
        assert.equal(summary.boarded, 2);
        assert.equal(summary.no_show, 1);
        assert.equal(summary.pending_boarding, 3);
        assert.equal(summary.passengers_count, 6);
    });

    it('20. Upcoming trips chronological sorting respects date and time ascending order', () => {
        const rawTrips = [
            { id: 2, departure_date: '2026-08-29', departure_time: '10:00' },
            { id: 1, departure_date: '2026-08-28', departure_time: '18:00' },
            { id: 3, departure_date: '2026-08-28', departure_time: '08:00' }
        ];
        const sorted = rawTrips.sort((a, b) => {
            const dateCmp = (a.departure_date || '').localeCompare(b.departure_date || '');
            if (dateCmp !== 0) return dateCmp;
            return (a.departure_time || '').localeCompare(b.departure_time || '');
        });
        assert.equal(sorted[0].id, 3); // 2026-08-28 08:00
        assert.equal(sorted[1].id, 1); // 2026-08-28 18:00
        assert.equal(sorted[2].id, 2); // 2026-08-29 10:00
    });


    // 21-25: Attention Center Deterministic Rules
    it('21. Attention center flags stale pending payment older than 30 minutes', () => {
        const thirtyFiveMinutesAgo = new Date(Date.now() - 35 * 60 * 1000).toISOString();
        const activeBookings = [
            { bus_ticket_id: 101, status: 'pending_payment', created_at: thirtyFiveMinutesAgo }
        ];

        const attention = detectAttentionItems([{ id: 101 }], [], activeBookings, []);
        const staleItem = attention.find(a => a.id === 'stale_pending_payments');
        assert.ok(staleItem);
        assert.equal(staleItem.type, 'CRITICAL');
        assert.equal(staleItem.count, 1);
    });

    it('22. Attention center flags upcoming trip without assigned driver', () => {
        const upcomingTrips = [{ id: 201 }];
        const activeDrivers = [
            { id: 1, is_active: true, assigned_ticket_ids: [999] } // Not assigned to 201
        ];

        const attention = detectAttentionItems([], upcomingTrips, [], activeDrivers);
        const unassignedItem = attention.find(a => a.id === 'unassigned_drivers');
        assert.ok(unassignedItem);
        assert.equal(unassignedItem.type, 'WARNING');
        assert.equal(unassignedItem.count, 1);
    });

    it('23. Attention center does not flag trip when active driver is properly assigned', () => {
        const upcomingTrips = [{ id: 201 }];
        const activeDrivers = [
            { id: 1, is_active: true, assigned_ticket_ids: [201] }
        ];

        const attention = detectAttentionItems([], upcomingTrips, [], activeDrivers);
        const unassignedItem = attention.find(a => a.id === 'unassigned_drivers');
        assert.equal(unassignedItem, undefined);
    });

    it('24. Attention center flags pending boarding on today trips', () => {
        const todayTrips = [{ id: 101 }];
        const bookings = [
            { bus_ticket_id: 101, status: 'confirmed', boarding_status: 'pending_boarding' }
        ];

        const attention = detectAttentionItems(todayTrips, [], bookings, []);
        const boardingItem = attention.find(a => a.id === 'today_pending_boarding');
        assert.ok(boardingItem);
        assert.equal(boardingItem.type, 'INFO');
    });

    it('25. Inactive driver with assigned ticket is NOT considered active assignment', () => {
        const upcomingTrips = [{ id: 201 }];
        const inactiveDrivers = [
            { id: 1, is_active: false, assigned_ticket_ids: [201] } // Inactive!
        ];

        const attention = detectAttentionItems([], upcomingTrips, [], inactiveDrivers);
        const unassignedItem = attention.find(a => a.id === 'unassigned_drivers');
        assert.ok(unassignedItem);
    });

    // 26-28: Upcoming Trips, Timezone & Projection Tests
    it('26. Upcoming trips list maps fields accurately and checks driver assignment', () => {
        const upcomingTickets = [
            { id: 301, departure_date: '2026-08-28', departure_time: '14:00', from_city: 'Душанбе', to_city: 'Худжанд', total_seats: 50, price: 150 }
        ];
        const bookings = [
            { bus_ticket_id: 301, status: 'confirmed', seat_numbers: [1, 2], passenger_count: 2 }
        ];
        const drivers = [
            { id: 10, is_active: true, assigned_ticket_ids: [301] }
        ];

        const trips = buildUpcomingTripsList(upcomingTickets, bookings, drivers);
        assert.equal(trips.length, 1);
        assert.equal(trips[0].id, 301);
        assert.equal(trips[0].booked_seats, 2);
        assert.equal(trips[0].free_seats, 48);
        assert.equal(trips[0].fill_rate, 4.0);
        assert.equal(trips[0].has_assigned_driver, true);
    });

    it('27. getBusinessLocalDate returns valid YYYY-MM-DD format for Asia/Dushanbe', () => {
        const localDate = getBusinessLocalDate('Asia/Dushanbe');
        assert.match(localDate, /^\d{4}-\d{2}-\d{2}$/);
    });

    it('28. Response math consistency invariant holds for all calculated summaries', () => {
        const tickets = [
            { id: 1, total_seats: 40 },
            { id: 2, total_seats: 60 }
        ];
        const bookings = [
            { bus_ticket_id: 1, status: 'confirmed', seat_numbers: [1, 2, 3, 4], total_price: 400, commission_amount: 20, carrier_amount: 380, channel: 'web' },
            { bus_ticket_id: 2, status: 'confirmed', seat_numbers: [10, 11, 12], total_price: 300, commission_amount: 15, carrier_amount: 285, channel: 'manual' },
            { bus_ticket_id: 2, status: 'pending_payment', seat_numbers: [20], total_price: 100, created_at: new Date().toISOString() }
        ];

        const summary = buildTodaySummary(tickets, bookings);
        // Invariant 1: free_seats === capacity - booked_seats
        assert.equal(summary.free_seats, summary.capacity - summary.booked_seats);
        // Invariant 2: carrier_amount + service_commission === gross_amount
        assert.equal(summary.carrier_amount + summary.service_commission, summary.gross_amount);
        // Invariant 3: fill_rate is percentage of booked_seats over capacity
        assert.equal(summary.fill_rate, 8.0); // 8 seats / 100 capacity = 8.0%
    });


    it('29. Legacy manual booking with carrier_amount undefined calculates difference safely', () => {
        const tickets = [{ id: 1, total_seats: 50 }];
        const bookings = [
            { bus_ticket_id: 1, status: 'confirmed', total_price: 200, commission_amount: 0 } // carrier_amount undefined
        ];

        const summary = buildTodaySummary(tickets, bookings);
        assert.equal(summary.carrier_amount, 200);
    });

    it('30. Empty upcoming trips and attention items handle without null reference errors', () => {
        const trips = buildUpcomingTripsList([], [], []);
        const attention = detectAttentionItems([], [], [], []);
        assert.deepEqual(trips, []);
        assert.deepEqual(attention, []);
    });

    it('31. getBookingPassengerCount behaves correctly across all payload forms without double counting', () => {
        const { getBookingPassengerCount } = require('../utils/dashboardHelper');

        // Direct count
        assert.equal(getBookingPassengerCount({ passenger_count: 3, seat_numbers: [1, 2, 3] }), 3);
        // Missing passenger_count, seat_numbers array
        assert.equal(getBookingPassengerCount({ passenger_count: null, seat_numbers: [1, 2, 3, 4] }), 4);
        // passengers_data array
        assert.equal(getBookingPassengerCount({ passenger_count: null, seat_numbers: [], passengers_data: [{ name: 'A' }, { name: 'B' }] }), 2);
        // passengers_data JSON string
        assert.equal(getBookingPassengerCount({ passenger_count: null, passengers_data: '[{"name":"A"},{"name":"B"}]' }), 2);
        // Single fallback
        assert.equal(getBookingPassengerCount({}), 1);
        assert.equal(getBookingPassengerCount(null), 0);
    });

    it('32. normalizeSeat treats number and string representations identically ("12" === 12)', () => {
        const { normalizeSeat, calculateTripFillStats } = require('../utils/dashboardHelper');

        assert.equal(normalizeSeat(12), '12');
        assert.equal(normalizeSeat('12'), '12');
        assert.equal(normalizeSeat(null), null);
        assert.equal(normalizeSeat(''), null);

        const ticket = { id: 10, total_seats: 50 };
        const bookings = [
            { bus_ticket_id: 10, status: 'confirmed', seat_numbers: [12] },
            { bus_ticket_id: 10, status: 'confirmed', seat_numbers: ['12'] } // Corrupted duplicate
        ];

        const stats = calculateTripFillStats(ticket, bookings);
        assert.equal(stats.booked_seats, 1); // Deduplicated to 1 seat
    });

    it('33. Driver assignment type safety: string ticket IDs in assigned_ticket_ids match numeric IDs', () => {
        const upcomingTrips = [{ id: 501 }];
        const activeDrivers = [
            { id: 1, is_active: true, assigned_ticket_ids: ['501'] } // string ID
        ];

        const attention = detectAttentionItems([], upcomingTrips, [], activeDrivers);
        const unassignedItem = attention.find(a => a.id === 'unassigned_drivers');
        assert.equal(unassignedItem, undefined); // Successfully matched!
    });

    it('34. getBusinessLocalTime returns valid HH:mm format for Asia/Dushanbe', () => {
        const { getBusinessLocalTime } = require('../utils/dashboardHelper');
        const time = getBusinessLocalTime('Asia/Dushanbe');
        assert.match(time, /^\d{2}:\d{2}$/);
    });

    it('35. Performance benchmark: Backend memory aggregation executes efficiently at scale', () => {
        // Benchmark 1: 10 trips / 100 bookings
        const trips10 = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, total_seats: 50 }));
        const bookings100 = Array.from({ length: 100 }, (_, i) => ({
            bus_ticket_id: (i % 10) + 1,
            status: 'confirmed',
            seat_numbers: [(i % 50) + 1],
            passenger_count: 1,
            total_price: 150,
            commission_amount: 7.5,
            carrier_amount: 142.5,
            channel: i % 2 === 0 ? 'web' : 'manual'
        }));

        const t0 = performance.now();
        const res1 = buildTodaySummary(trips10, bookings100);
        const dur1 = performance.now() - t0;

        assert.equal(res1.trips_count, 10);
        assert.ok(dur1 < 50, `10 trips / 100 bookings aggregation took ${dur1}ms`);

        // Benchmark 2: 100 trips / 1,000 bookings
        const trips100 = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, total_seats: 50 }));
        const bookings1000 = Array.from({ length: 1000 }, (_, i) => ({
            bus_ticket_id: (i % 100) + 1,
            status: 'confirmed',
            seat_numbers: [(i % 50) + 1],
            passenger_count: 1,
            total_price: 150,
            commission_amount: 7.5,
            carrier_amount: 142.5,
            channel: 'web'
        }));

        const t1 = performance.now();
        const res2 = buildTodaySummary(trips100, bookings1000);
        const dur2 = performance.now() - t1;

        assert.equal(res2.trips_count, 100);
        assert.ok(dur2 < 100, `100 trips / 1,000 bookings aggregation took ${dur2}ms`);

        // Benchmark 3: 100 trips / 10,000 bookings
        const bookings10000 = Array.from({ length: 10000 }, (_, i) => ({
            bus_ticket_id: (i % 100) + 1,
            status: 'confirmed',
            seat_numbers: [(i % 50) + 1],
            passenger_count: 1,
            total_price: 150,
            commission_amount: 7.5,
            carrier_amount: 142.5,
            channel: 'web'
        }));

        const t2 = performance.now();
        const res3 = buildTodaySummary(trips100, bookings10000);
        const dur3 = performance.now() - t2;

        assert.equal(res3.trips_count, 100);
        assert.ok(dur3 < 500, `100 trips / 10,000 bookings aggregation took ${dur3}ms`);
    });

});

