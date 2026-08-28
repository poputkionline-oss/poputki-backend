const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
    detectAttentionItems,
    getTicketDepartureTimestamp
} = require('../utils/dashboardHelper');
const { aggregateCarrierCustomers } = require('../utils/crmHelper');

describe('PHASE 1 REGRESSION SUITE: CRM & DRIVER WARNING SEVERITY', () => {

    describe('1. Driver Warning Severity Model (>24h / <=24h / <=6h / assigned)', () => {
        // Base reference time: 2026-08-28 12:00:00 UTC+5
        const baseNow = new Date('2026-08-28T12:00:00+05:00').getTime();

        it('1.1. Departure in 48 hours without driver => NO ALERT', () => {
            const trip48h = {
                id: 101,
                departure_date: '2026-08-30',
                departure_time: '12:00:00'
            };
            const attention = detectAttentionItems([], [trip48h], [], [], baseNow);
            const driverAlert = attention.find(a => a.id === 'unassigned_drivers');
            assert.equal(driverAlert, undefined, 'Trip 48h away must not trigger attention alert');
        });

        it('1.2. Departure in 25 hours without driver => NO ALERT', () => {
            const trip25h = {
                id: 102,
                departure_date: '2026-08-29',
                departure_time: '13:00:00'
            };
            const attention = detectAttentionItems([], [trip25h], [], [], baseNow);
            const driverAlert = attention.find(a => a.id === 'unassigned_drivers');
            assert.equal(driverAlert, undefined, 'Trip 25h away must not trigger attention alert');
        });

        it('1.3. Departure in exactly 24 hours without driver => WARNING', () => {
            const trip24h = {
                id: 103,
                departure_date: '2026-08-29',
                departure_time: '12:00:00' // exactly +24h
            };
            const attention = detectAttentionItems([], [trip24h], [], [], baseNow);
            const driverAlert = attention.find(a => a.id === 'unassigned_drivers');
            assert.ok(driverAlert, 'Trip 24h away must trigger WARNING alert');
            assert.equal(driverAlert.type, 'WARNING');
            assert.equal(driverAlert.count, 1);
            assert.ok(driverAlert.message.includes('#103'));
        });

        it('1.4. Departure in 12 hours without driver => WARNING', () => {
            const trip12h = {
                id: 104,
                departure_date: '2026-08-29',
                departure_time: '00:00:00' // +12h
            };
            const attention = detectAttentionItems([], [trip12h], [], [], baseNow);
            const driverAlert = attention.find(a => a.id === 'unassigned_drivers');
            assert.ok(driverAlert);
            assert.equal(driverAlert.type, 'WARNING');
            assert.equal(driverAlert.count, 1);
        });

        it('1.5. Departure in exactly 6 hours without driver => CRITICAL', () => {
            const trip6h = {
                id: 105,
                departure_date: '2026-08-28',
                departure_time: '18:00:00' // exactly +6h
            };
            const attention = detectAttentionItems([], [trip6h], [], [], baseNow);
            const driverAlert = attention.find(a => a.id === 'unassigned_drivers');
            assert.ok(driverAlert, 'Trip <= 6h must trigger CRITICAL alert');
            assert.equal(driverAlert.type, 'CRITICAL');
            assert.equal(driverAlert.count, 1);
            assert.equal(driverAlert.icon, '🚨');
        });

        it('1.6. Departure in 1 hour without driver => CRITICAL', () => {
            const trip1h = {
                id: 106,
                departure_date: '2026-08-28',
                departure_time: '13:00:00' // +1h
            };
            const attention = detectAttentionItems([trip1h], [], [], [], baseNow);
            const driverAlert = attention.find(a => a.id === 'unassigned_drivers');
            assert.ok(driverAlert);
            assert.equal(driverAlert.type, 'CRITICAL');
            assert.equal(driverAlert.count, 1);
        });

        it('1.7. Assigned active driver => NO ALERT (alert disappears)', () => {
            const tripNear = {
                id: 107,
                departure_date: '2026-08-28',
                departure_time: '14:00:00' // +2h
            };
            const activeDrivers = [
                { id: 1, is_active: true, assigned_ticket_ids: [107] }
            ];
            const attention = detectAttentionItems([], [tripNear], [], activeDrivers, baseNow);
            const driverAlert = attention.find(a => a.id === 'unassigned_drivers');
            assert.equal(driverAlert, undefined, 'Assigned active driver must eliminate the alert');
        });

        it('1.8. Inactive driver assigned to near trip => STILL ALERTS (WARNING / CRITICAL)', () => {
            const tripNear = {
                id: 108,
                departure_date: '2026-08-28',
                departure_time: '14:00:00' // +2h
            };
            const inactiveDrivers = [
                { id: 1, is_active: false, assigned_ticket_ids: [108] }
            ];
            const attention = detectAttentionItems([], [tripNear], [], inactiveDrivers, baseNow);
            const driverAlert = attention.find(a => a.id === 'unassigned_drivers');
            assert.ok(driverAlert, 'Inactive driver assignment must not suppress alert');
            assert.equal(driverAlert.type, 'CRITICAL');
        });

        it('1.9. Mixed urgency: trip A at 4h, trip B at 18h => CRITICAL with total count 2', () => {
            const tripA = { id: 201, departure_date: '2026-08-28', departure_time: '16:00:00' }; // +4h
            const tripB = { id: 202, departure_date: '2026-08-29', departure_time: '06:00:00' }; // +18h
            const tripC = { id: 203, departure_date: '2026-09-02', departure_time: '12:00:00' }; // +120h (excluded)

            const attention = detectAttentionItems([], [tripA, tripB, tripC], [], [], baseNow);
            const driverAlert = attention.find(a => a.id === 'unassigned_drivers');
            assert.ok(driverAlert);
            assert.equal(driverAlert.type, 'CRITICAL');
            assert.equal(driverAlert.count, 2);
            assert.ok(driverAlert.message.includes('#201'));
            assert.ok(driverAlert.message.includes('#202'));
            assert.equal(driverAlert.message.includes('#203'), false);
        });

        it('1.10. Production scenario: trips #53 (+5d) and #54 (+12d) => NO ALERT on current date', () => {
            const trip53 = { id: 53, departure_date: '2026-09-02', departure_time: '00:05:00' };
            const trip54 = { id: 54, departure_date: '2026-09-09', departure_time: '00:30:00' };

            const attention = detectAttentionItems([], [trip53, trip54], [], [], baseNow);
            const driverAlert = attention.find(a => a.id === 'unassigned_drivers');
            assert.equal(driverAlert, undefined, 'Far upcoming trips #53 and #54 must not trigger warning on 2026-08-28');
        });
    });

    describe('2. CRM Customers Aggregation & Invariants', () => {
        const mockTickets = [
            { id: 1, operator_id: 11, from_city: 'Худжанд', to_city: 'Сургут', departure_date: '2026-07-01', price: 900 }
        ];

        it('2.1. Successful aggregation of valid booking data', () => {
            const mockBookings = [
                {
                    id: 10,
                    bus_ticket_id: 1,
                    phone: '+992927925051',
                    passenger_name: 'Али Абдурауфзода',
                    status: 'confirmed',
                    boarding_status: 'boarded',
                    total_price: 900,
                    channel: 'web'
                }
            ];

            const result = aggregateCarrierCustomers(mockBookings, mockTickets, { carrierId: 11 });
            assert.equal(result.summary.total_customers, 1);
            assert.equal(result.summary.total_revenue, 900);
            assert.equal(result.customers.length, 1);
            assert.equal(result.customers[0].phone, '+992927925051');
            assert.equal(result.customers[0].customer_key.startsWith('c_'), true);
        });

        it('2.2. Empty bookings list returns valid empty summary (0 customers)', () => {
            const result = aggregateCarrierCustomers([], mockTickets, { carrierId: 11 });
            assert.equal(result.summary.total_customers, 0);
            assert.equal(result.summary.repeat_customers, 0);
            assert.equal(result.summary.total_revenue, 0);
            assert.equal(result.customers.length, 0);
            assert.equal(result.pagination.total, 0);
        });

        it('2.3. Multi-tenant isolation: bookings for other carrier tickets are ignored', () => {
            const mockOtherTickets = [
                { id: 99, operator_id: 999, from_city: 'Душанбе', to_city: 'Куляб' }
            ];
            const mockOtherBookings = [
                { id: 50, bus_ticket_id: 99, phone: '+992900000000', passenger_name: 'Foreign Passenger', status: 'confirmed' }
            ];

            const result = aggregateCarrierCustomers(mockOtherBookings, mockTickets, { carrierId: 11 });
            assert.equal(result.summary.total_customers, 0, 'Foreign bookings must not be aggregated');
            assert.equal(result.customers.length, 0);
        });
    });

    describe('3. Timestamp Resolution & Timezone Helper', () => {
        it('3.1. getTicketDepartureTimestamp correctly resolves date and time to ms in +05:00', () => {
            const t = { departure_date: '2026-09-02', departure_time: '15:30:00' };
            const ts = getTicketDepartureTimestamp(t, '+05:00');
            const expected = new Date('2026-09-02T15:30:00+05:00').getTime();
            assert.equal(ts, expected);
        });

        it('3.2. getTicketDepartureTimestamp handles missing or short time (HH:mm)', () => {
            const t1 = { departure_date: '2026-09-02', departure_time: '15:30' };
            const ts1 = getTicketDepartureTimestamp(t1, '+05:00');
            assert.equal(ts1, new Date('2026-09-02T15:30:00+05:00').getTime());

            const t2 = { departure_date: '2026-09-02' };
            const ts2 = getTicketDepartureTimestamp(t2, '+05:00');
            assert.equal(ts2, new Date('2026-09-02T00:00:00+05:00').getTime());
        });

        it('3.3. Returns null for empty ticket or missing departure_date', () => {
            assert.equal(getTicketDepartureTimestamp(null), null);
            assert.equal(getTicketDepartureTimestamp({}), null);
        });
    });
});
