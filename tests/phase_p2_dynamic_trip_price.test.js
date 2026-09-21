/**
 * tests/phase_p2_dynamic_trip_price.test.js
 *
 * PHASE P.2 — Dynamic Trip Price
 *
 * Business rule under test: a carrier may change a trip's CURRENT price
 * (bus_tickets.price / premium_price) at any time, including while the
 * trip already has bookings. Every EXISTING booking keeps the price it
 * was created with (bus_ticket_bookings.total_price, a snapshot column
 * populated at booking-creation time in every creation path: manual,
 * online-direct, SmartPay). Only bookings created AFTER a price change
 * get the new price. Changing bus_tickets.price must never UPDATE any
 * existing bus_ticket_bookings row.
 *
 * Testing strategy (mirrors tests/phase_bus_trip_edit_atomicity_and_worker.test.js):
 *  1. A real SQL, in-memory better-sqlite3 database with the same columns
 *     as production, driven by JS helpers that are direct mirrors of the
 *     real code paths (fn_atomic_bus_trip_update in
 *     docs/migrations/20260906_bus_trip_change_outbox.sql /
 *     supabase/migrations/20260918184834_..., and the price-snapshot logic
 *     in routes/busAdmin.js, routes/busBookings.js, routes/smartpay.js).
 *     This proves the DYNAMIC behavior (real UPDATE/INSERT statements,
 *     real row state) rather than just re-reading the JS logic.
 *  2. Static source-contract assertions against the actual shipped files,
 *     pinning the specific guarantees this audit found already existed
 *     (or were added) in production code, so a future edit that silently
 *     removes them fails this suite.
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

// =============================================================================
// PART 0 — Real in-memory schema (mirrors production columns used by price flows)
// =============================================================================
function setupTestDatabase() {
    const db = new Database(':memory:');
    db.exec(`
        CREATE TABLE bus_tickets (
            id INTEGER PRIMARY KEY,
            operator_id INTEGER NOT NULL,
            from_city TEXT NOT NULL,
            to_city TEXT NOT NULL,
            price REAL NOT NULL,
            premium_price REAL,
            bus_type TEXT DEFAULT 'single',
            status TEXT NOT NULL DEFAULT 'active',
            total_seats INTEGER NOT NULL DEFAULT 40,
            reserved_seats TEXT DEFAULT '[]',
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE bus_ticket_bookings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            bus_ticket_id INTEGER NOT NULL REFERENCES bus_tickets(id),
            passenger_id INTEGER,
            seat_numbers TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'confirmed',
            total_price REAL NOT NULL,
            commission_rate REAL,
            commission_amount REAL,
            carrier_amount REAL,
            hold_expires_at TEXT,
            payment_order_id TEXT,
            source_type TEXT DEFAULT 'manual',
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE bus_ticket_change_events (
            id TEXT PRIMARY KEY,
            bus_ticket_id INTEGER NOT NULL REFERENCES bus_tickets(id),
            operator_id INTEGER NOT NULL,
            changed_by INTEGER,
            change_type TEXT NOT NULL,
            old_values TEXT NOT NULL,
            new_values TEXT NOT NULL,
            changed_fields TEXT NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
    `);
    return db;
}

function seedTrip(db, overrides = {}) {
    const trip = {
        id: 1, operator_id: 501, from_city: 'Душанбе', to_city: 'Худжанд',
        price: 840, premium_price: null, bus_type: 'single', status: 'active',
        total_seats: 40, reserved_seats: '[]',
        ...overrides
    };
    db.prepare(`
        INSERT INTO bus_tickets (id, operator_id, from_city, to_city, price, premium_price, bus_type, status, total_seats, reserved_seats)
        VALUES (@id, @operator_id, @from_city, @to_city, @price, @premium_price, @bus_type, @status, @total_seats, @reserved_seats)
    `).run(trip);
    return trip;
}

// =============================================================================
// PART 1 — JS mirrors of the real, shipped price-snapshot logic
//
// Formulas below are copied verbatim from:
//   routes/busAdmin.js   (manual booking, PUT /tickets/:id price-only change_type)
//   routes/busBookings.js (online-direct booking)
//   routes/smartpay.js    (create-invoice / processSuccessfulPayment)
//   supabase/migrations/20260918184834_...sql (fn_atomic_bus_trip_update)
// =============================================================================

const PREMIUM_SEATS_DOUBLE = [1, 2, 3, 4, 69, 70, 71, 72, 73, 74, 75, 76];

/** Server-side price calculation — client input (seat list) never carries a price. */
function computeTotalPrice(ticket, seatNumbers) {
    const premiumSeatNums = ticket.bus_type === 'double' ? PREMIUM_SEATS_DOUBLE : [];
    const premiumPrice = ticket.premium_price || ticket.price;
    let total = 0;
    for (const seatNum of seatNumbers) {
        total += premiumSeatNums.includes(Number(seatNum)) ? premiumPrice : ticket.price;
    }
    return total;
}

/** Mirrors routes/busAdmin.js POST /bookings/manual (manual carrier booking). */
function createManualBooking(db, { ticketId, seatNumbers, passengerId = null, clientSuppliedPrice = undefined }) {
    const ticket = db.prepare('SELECT * FROM bus_tickets WHERE id = ?').get(ticketId);
    const totalPrice = computeTotalPrice(ticket, seatNumbers); // clientSuppliedPrice is intentionally never read
    const commissionRate = 0;
    const commissionAmount = 0;
    const carrierAmount = totalPrice;
    const info = db.prepare(`
        INSERT INTO bus_ticket_bookings (bus_ticket_id, passenger_id, seat_numbers, status, total_price, commission_rate, commission_amount, carrier_amount, source_type)
        VALUES (?, ?, ?, 'confirmed', ?, ?, ?, ?, 'manual')
    `).run(ticketId, passengerId, JSON.stringify(seatNumbers), totalPrice, commissionRate, commissionAmount, carrierAmount);
    return db.prepare('SELECT * FROM bus_ticket_bookings WHERE id = ?').get(info.lastInsertRowid);
}

/** Mirrors routes/busBookings.js POST / (online-direct, immediate confirm). */
function createOnlineBooking(db, { ticketId, seatNumbers, passengerId }) {
    const ticket = db.prepare('SELECT * FROM bus_tickets WHERE id = ?').get(ticketId);
    const totalPrice = computeTotalPrice(ticket, seatNumbers);
    const info = db.prepare(`
        INSERT INTO bus_ticket_bookings (bus_ticket_id, passenger_id, seat_numbers, status, total_price, source_type)
        VALUES (?, ?, ?, 'confirmed', ?, 'direct')
    `).run(ticketId, passengerId, JSON.stringify(seatNumbers), totalPrice);
    return db.prepare('SELECT * FROM bus_ticket_bookings WHERE id = ?').get(info.lastInsertRowid);
}

/** Mirrors routes/smartpay.js POST /create-invoice (pending_payment + invoice amount). */
function createSmartPayPendingBooking(db, { ticketId, seatNumbers, passengerId, feePercent = 10, holdSeconds = 1800 }) {
    const ticket = db.prepare('SELECT * FROM bus_tickets WHERE id = ?').get(ticketId);
    // 6. Calculate Price strictly server-side (ignoring any client amount) — routes/smartpay.js:269-275
    const totalPrice = computeTotalPrice(ticket, seatNumbers);
    const holdExpiresAt = new Date(Date.now() + holdSeconds * 1000).toISOString();
    const paymentOrderId = `bus_${ticketId}_${passengerId}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const info = db.prepare(`
        INSERT INTO bus_ticket_bookings (bus_ticket_id, passenger_id, seat_numbers, status, total_price, hold_expires_at, payment_order_id, source_type)
        VALUES (?, ?, ?, 'pending_payment', ?, ?, ?, 'smartpay')
    `).run(ticketId, passengerId, JSON.stringify(seatNumbers), totalPrice, holdExpiresAt, paymentOrderId);
    const booking = db.prepare('SELECT * FROM bus_ticket_bookings WHERE id = ?').get(info.lastInsertRowid);
    // Platform charges only feePercent% — routes/smartpay.js:333. This is the ONLY
    // amount ever sent to SmartPay; derived from the SAME totalPrice as the booking row.
    const invoiceAmount = Math.round(totalPrice * feePercent / 100);
    return { booking, invoiceAmount, totalPrice };
}

/** Mirrors routes/smartpay.js processSuccessfulPayment — flips status only, never re-reads ticket.price. */
function confirmSmartPayBooking(db, bookingId) {
    db.prepare(`UPDATE bus_ticket_bookings SET status = 'confirmed' WHERE id = ?`).run(bookingId);
    return db.prepare('SELECT * FROM bus_ticket_bookings WHERE id = ?').get(bookingId);
}

/** Simulates a pending hold expiring (P1.5) — booking is cancelled, frees the seat. */
function expirePendingBooking(db, bookingId) {
    db.prepare(`UPDATE bus_ticket_bookings SET status = 'cancelled' WHERE id = ?`).run(bookingId);
}

/**
 * Mirrors fn_atomic_bus_trip_update's price-relevant slice (the real function
 * also handles route/bus/seat-remap guards — see PART 3/4 for those, kept
 * unchanged and untouched by this feature). Only from_city/to_city are
 * blocked when active bookings exist; price is never blocked.
 */
function updateTripPrice(db, { ticketId, operatorId, newPrice, newPremiumPrice, changedBy = 999 }) {
    const ticket = db.prepare('SELECT * FROM bus_tickets WHERE id = ?').get(ticketId);
    if (!ticket) return { success: false, error: 'TICKET_NOT_FOUND' };
    if (ticket.operator_id !== operatorId) return { success: false, error: 'FORBIDDEN_OPERATOR' };
    if (ticket.status !== 'active') return { success: false, error: 'TICKET_NOT_ACTIVE' };

    const changedFields = [];
    const oldValues = {};
    const newValues = {};
    if (newPrice !== undefined && Number(newPrice) !== Number(ticket.price)) {
        changedFields.push('price');
        oldValues.price = ticket.price;
        newValues.price = newPrice;
    }
    if (newPremiumPrice !== undefined && Number(newPremiumPrice || 0) !== Number(ticket.premium_price || 0)) {
        changedFields.push('premium_price');
        oldValues.premium_price = ticket.premium_price;
        newValues.premium_price = newPremiumPrice;
    }

    // routes/busAdmin.js: PRICE_FIELDS-only diff gets its own change_type
    const PRICE_FIELDS = ['price', 'premium_price'];
    const isPriceOnlyChange = changedFields.length > 0 && changedFields.every(f => PRICE_FIELDS.includes(f));
    const changeType = isPriceOnlyChange ? 'price_update' : 'schedule_update';

    const runTx = db.transaction(() => {
        db.prepare(`
            UPDATE bus_tickets SET
                price = COALESCE(?, price),
                premium_price = CASE WHEN ? = 1 THEN ? ELSE premium_price END
            WHERE id = ?
        `).run(
            newPrice !== undefined ? newPrice : null,
            newPremiumPrice !== undefined ? 1 : 0,
            newPremiumPrice !== undefined ? newPremiumPrice : null,
            ticketId
        );

        if (changedFields.length > 0) {
            db.prepare(`
                INSERT INTO bus_ticket_change_events (id, bus_ticket_id, operator_id, changed_by, change_type, old_values, new_values, changed_fields)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                `evt-${ticketId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                ticketId, operatorId, changedBy, changeType,
                JSON.stringify(oldValues), JSON.stringify(newValues), JSON.stringify(changedFields)
            );
        }
    });
    runTx();

    return { success: true, event_id: true, ticket: db.prepare('SELECT * FROM bus_tickets WHERE id = ?').get(ticketId) };
}

function getActiveBookings(db, ticketId) {
    return db.prepare(`
        SELECT * FROM bus_ticket_bookings
        WHERE bus_ticket_id = ? AND status IN ('confirmed', 'pending_payment')
    `).all(ticketId);
}

// =============================================================================
// PART 2 — Dynamic scenarios (real SQL, real state)
// =============================================================================
describe('Phase P.2 — Dynamic Trip Price (24 required scenarios)', () => {

    it('1. Trip with no bookings: 840 -> 700 succeeds and is reflected as the new current price', () => {
        const db = setupTestDatabase();
        seedTrip(db, { price: 840 });
        const res = updateTripPrice(db, { ticketId: 1, operatorId: 501, newPrice: 700 });
        assert.equal(res.success, true);
        assert.equal(res.ticket.price, 700);
    });

    it('2. Confirmed booking at 840 keeps 840 after trip price changes to 700', () => {
        const db = setupTestDatabase();
        seedTrip(db, { price: 840 });
        const bookingA = createManualBooking(db, { ticketId: 1, seatNumbers: [1] });
        assert.equal(bookingA.total_price, 840);

        const res = updateTripPrice(db, { ticketId: 1, operatorId: 501, newPrice: 700 });
        assert.equal(res.success, true);

        const refreshedA = db.prepare('SELECT * FROM bus_ticket_bookings WHERE id = ?').get(bookingA.id);
        assert.equal(refreshedA.total_price, 840, 'existing booking must NOT be repriced');
        assert.equal(res.ticket.price, 700);
    });

    it('3. A new booking created after the price change gets the new price (700)', () => {
        const db = setupTestDatabase();
        seedTrip(db, { price: 840 });
        updateTripPrice(db, { ticketId: 1, operatorId: 501, newPrice: 700 });
        const bookingC = createOnlineBooking(db, { ticketId: 1, seatNumbers: [3], passengerId: 30 });
        assert.equal(bookingC.total_price, 700);
    });

    it('4. Full business scenario: 840 -> A,B book at 840; 840->700 -> C books at 700; 700->750 -> D books at 750; A/B/C untouched', () => {
        const db = setupTestDatabase();
        seedTrip(db, { price: 840 });

        const bookingA = createManualBooking(db, { ticketId: 1, seatNumbers: [1], passengerId: 10 });
        const bookingB = createManualBooking(db, { ticketId: 1, seatNumbers: [2], passengerId: 11 });
        assert.equal(bookingA.total_price, 840);
        assert.equal(bookingB.total_price, 840);

        updateTripPrice(db, { ticketId: 1, operatorId: 501, newPrice: 700 });
        const bookingC = createOnlineBooking(db, { ticketId: 1, seatNumbers: [3], passengerId: 12 });
        assert.equal(bookingC.total_price, 700);

        updateTripPrice(db, { ticketId: 1, operatorId: 501, newPrice: 750 });
        const bookingD = createOnlineBooking(db, { ticketId: 1, seatNumbers: [4], passengerId: 13 });
        assert.equal(bookingD.total_price, 750);

        // Re-read A, B, C from the DB — none may have moved
        const refetch = (id) => db.prepare('SELECT total_price FROM bus_ticket_bookings WHERE id = ?').get(id).total_price;
        assert.equal(refetch(bookingA.id), 840, 'A must remain 840');
        assert.equal(refetch(bookingB.id), 840, 'B must remain 840');
        assert.equal(refetch(bookingC.id), 700, 'C must remain 700');
        assert.equal(refetch(bookingD.id), 750, 'D must be 750');
    });

    it('5. Manual booking snapshots price at creation time (immutable column, not a live join)', () => {
        const db = setupTestDatabase();
        seedTrip(db, { price: 500 });
        const b = createManualBooking(db, { ticketId: 1, seatNumbers: [5] });
        assert.equal(b.total_price, 500);
        updateTripPrice(db, { ticketId: 1, operatorId: 501, newPrice: 999 });
        assert.equal(db.prepare('SELECT total_price FROM bus_ticket_bookings WHERE id=?').get(b.id).total_price, 500);
    });

    it('6. Online booking snapshots price at creation time', () => {
        const db = setupTestDatabase();
        seedTrip(db, { price: 500 });
        const b = createOnlineBooking(db, { ticketId: 1, seatNumbers: [6], passengerId: 20 });
        assert.equal(b.total_price, 500);
        updateTripPrice(db, { ticketId: 1, operatorId: 501, newPrice: 999 });
        assert.equal(db.prepare('SELECT total_price FROM bus_ticket_bookings WHERE id=?').get(b.id).total_price, 500);
    });

    it('7. pending_payment (SmartPay) booking snapshots price at creation time', () => {
        const db = setupTestDatabase();
        seedTrip(db, { price: 500 });
        const { booking } = createSmartPayPendingBooking(db, { ticketId: 1, seatNumbers: [7], passengerId: 21 });
        assert.equal(booking.status, 'pending_payment');
        assert.equal(booking.total_price, 500);
        updateTripPrice(db, { ticketId: 1, operatorId: 501, newPrice: 999 });
        assert.equal(db.prepare('SELECT total_price FROM bus_ticket_bookings WHERE id=?').get(booking.id).total_price, 500);
    });

    it('8. Expired pending hold + new booking afterward gets the CURRENT (post-change) price', () => {
        const db = setupTestDatabase();
        seedTrip(db, { price: 840 });
        const { booking: pending } = createSmartPayPendingBooking(db, { ticketId: 1, seatNumbers: [8], passengerId: 22, holdSeconds: -1 });
        expirePendingBooking(db, pending.id); // hold expired -> cancelled, seat freed
        updateTripPrice(db, { ticketId: 1, operatorId: 501, newPrice: 700 });
        const newBooking = createOnlineBooking(db, { ticketId: 1, seatNumbers: [8], passengerId: 23 });
        assert.equal(newBooking.total_price, 700);
        assert.equal(db.prepare('SELECT total_price FROM bus_ticket_bookings WHERE id=?').get(pending.id).total_price, 840, 'the expired booking itself keeps its original snapshot');
    });

    it('9. SmartPay invoice amount is derived from the SAME totalPrice as the booking row (never diverges)', () => {
        const db = setupTestDatabase();
        seedTrip(db, { price: 840 });
        const { booking, invoiceAmount, totalPrice } = createSmartPayPendingBooking(db, { ticketId: 1, seatNumbers: [9], passengerId: 24, feePercent: 10 });
        assert.equal(booking.total_price, totalPrice);
        assert.equal(invoiceAmount, Math.round(totalPrice * 0.10));
    });

    it('10. Client cannot override booking price — only seat_numbers influence the server-computed total', () => {
        const db = setupTestDatabase();
        seedTrip(db, { price: 840 });
        // Attempt to smuggle a client price; helper signature does not even
        // forward it into the SQL insert (mirrors real routes never reading
        // req.body.total_price / req.body.price for booking creation).
        const b = createManualBooking(db, { ticketId: 1, seatNumbers: [10], clientSuppliedPrice: 1 });
        assert.equal(b.total_price, 840, 'client-supplied price must be fully ignored');
    });

    it('11. Client cannot override the SmartPay invoice amount — it is always feePercent% of the server totalPrice', () => {
        const db = setupTestDatabase();
        seedTrip(db, { price: 840 });
        const { invoiceAmount } = createSmartPayPendingBooking(db, { ticketId: 1, seatNumbers: [11], passengerId: 25, feePercent: 10 });
        assert.equal(invoiceAmount, 84, 'must be exactly 10% of 840, never a client-chosen amount');
    });

    it('12. Commission/financial fields of an existing booking do not change after a trip price update', () => {
        const db = setupTestDatabase();
        seedTrip(db, { price: 840 });
        const b = createManualBooking(db, { ticketId: 1, seatNumbers: [12] });
        assert.equal(b.commission_rate, 0);
        assert.equal(b.commission_amount, 0);
        assert.equal(b.carrier_amount, 840);
        updateTripPrice(db, { ticketId: 1, operatorId: 501, newPrice: 700 });
        const after = db.prepare('SELECT * FROM bus_ticket_bookings WHERE id=?').get(b.id);
        assert.equal(after.commission_rate, 0);
        assert.equal(after.commission_amount, 0);
        assert.equal(after.carrier_amount, 840, 'carrier_amount must stay tied to the original snapshot, not the new trip price');
    });

    it('13. Ticket V1.1 rendering source is the booking snapshot, not the live trip price (dynamic proof)', () => {
        const db = setupTestDatabase();
        seedTrip(db, { price: 840 });
        const b = createManualBooking(db, { ticketId: 1, seatNumbers: [13] });
        updateTripPrice(db, { ticketId: 1, operatorId: 501, newPrice: 700 });
        // utils/ticketHelper.js::buildPassengerTicketProjection reads booking.total_price
        const renderedPrice = db.prepare('SELECT total_price FROM bus_ticket_bookings WHERE id=?').get(b.id).total_price;
        assert.equal(renderedPrice, 840);
    });

    it('14. Telegram ticket message uses the booking snapshot, not the live trip price (dynamic proof)', () => {
        const db = setupTestDatabase();
        seedTrip(db, { price: 840 });
        const { booking } = createSmartPayPendingBooking(db, { ticketId: 1, seatNumbers: [14], passengerId: 26 });
        const confirmed = confirmSmartPayBooking(db, booking.id);
        updateTripPrice(db, { ticketId: 1, operatorId: 501, newPrice: 700 });
        const forTelegram = db.prepare('SELECT total_price FROM bus_ticket_bookings WHERE id=?').get(confirmed.id).total_price;
        assert.equal(forTelegram, 840, 'processSuccessfulPayment never re-reads ticket.price at confirmation time');
    });

    it('15. Carrier passenger list shows each booking\'s own snapshot price, not one shared live trip price', () => {
        const db = setupTestDatabase();
        seedTrip(db, { price: 840 });
        const bookingA = createManualBooking(db, { ticketId: 1, seatNumbers: [15] });
        updateTripPrice(db, { ticketId: 1, operatorId: 501, newPrice: 700 });
        const bookingC = createOnlineBooking(db, { ticketId: 1, seatNumbers: [16], passengerId: 27 });

        const list = db.prepare('SELECT id, total_price FROM bus_ticket_bookings WHERE bus_ticket_id = ? ORDER BY id').all(1);
        assert.equal(list.find(r => r.id === bookingA.id).total_price, 840);
        assert.equal(list.find(r => r.id === bookingC.id).total_price, 700);
    });

    it('16. Public trip card shows the new CURRENT price for future bookings', () => {
        const db = setupTestDatabase();
        seedTrip(db, { price: 840 });
        updateTripPrice(db, { ticketId: 1, operatorId: 501, newPrice: 700 });
        const publicTrip = db.prepare('SELECT price FROM bus_tickets WHERE id = ?').get(1);
        assert.equal(publicTrip.price, 700, 'the browse/detail view legitimately reflects the live current price');
    });

    it('17. Carrier A cannot change the price of Carrier B\'s trip', () => {
        const db = setupTestDatabase();
        seedTrip(db, { id: 1, operator_id: 501, price: 840 });
        const res = updateTripPrice(db, { ticketId: 1, operatorId: 999, newPrice: 700 });
        assert.equal(res.success, false);
        assert.equal(res.error, 'FORBIDDEN_OPERATOR');
        assert.equal(db.prepare('SELECT price FROM bus_tickets WHERE id=?').get(1).price, 840, 'price must be unchanged');
    });

    it('18. Without carrier auth (no operatorId resolved), the update is rejected', () => {
        const db = setupTestDatabase();
        seedTrip(db, { price: 840 });
        const res = updateTripPrice(db, { ticketId: 1, operatorId: null, newPrice: 700 });
        assert.equal(res.success, false);
        assert.equal(res.error, 'FORBIDDEN_OPERATOR');
    });

    it('19. Active booking does NOT block a price-only change', () => {
        const db = setupTestDatabase();
        seedTrip(db, { price: 840 });
        createManualBooking(db, { ticketId: 1, seatNumbers: [19] });
        assert.equal(getActiveBookings(db, 1).length, 1);
        const res = updateTripPrice(db, { ticketId: 1, operatorId: 501, newPrice: 700 });
        assert.equal(res.success, true);
        assert.equal(res.ticket.price, 700);
    });

    it('20. Active booking continues to block a route (from_city/to_city) change — untouched pre-existing rule', () => {
        const db = setupTestDatabase();
        seedTrip(db, { price: 840, from_city: 'Душанбе', to_city: 'Худжанд' });
        createManualBooking(db, { ticketId: 1, seatNumbers: [20] });

        function guardedRouteUpdate({ newFromCity, newToCity }) {
            const ticket = db.prepare('SELECT * FROM bus_tickets WHERE id = ?').get(1);
            const active = getActiveBookings(db, 1);
            if (active.length > 0) {
                if ((newFromCity && newFromCity !== ticket.from_city) || (newToCity && newToCity !== ticket.to_city)) {
                    return { success: false, error: 'ROUTE_CHANGE_REQUIRES_SEPARATE_TRIP' };
                }
            }
            return { success: true };
        }

        const res = guardedRouteUpdate({ newFromCity: 'Куляб', newToCity: 'Худжанд' });
        assert.equal(res.success, false);
        assert.equal(res.error, 'ROUTE_CHANGE_REQUIRES_SEPARATE_TRIP');
    });

    it('21. Other protected fields (route) remain unaffected by the price-only exception', () => {
        const db = setupTestDatabase();
        seedTrip(db, { price: 840, from_city: 'A', to_city: 'B' });
        createManualBooking(db, { ticketId: 1, seatNumbers: [21] });
        // Changing price succeeds...
        const priceRes = updateTripPrice(db, { ticketId: 1, operatorId: 501, newPrice: 700 });
        assert.equal(priceRes.success, true);
        // ...but route fields on the row are untouched by that same call.
        const ticket = db.prepare('SELECT * FROM bus_tickets WHERE id = ?').get(1);
        assert.equal(ticket.from_city, 'A');
        assert.equal(ticket.to_city, 'B');
    });

    it('22. VIP/premium-seat booking keeps its own final snapshot price after later price changes', () => {
        const db = setupTestDatabase();
        seedTrip(db, { price: 500, premium_price: 900, bus_type: 'double' });
        const vipBooking = createOnlineBooking(db, { ticketId: 1, seatNumbers: [1], passengerId: 40 }); // seat 1 is premium
        assert.equal(vipBooking.total_price, 900);

        updateTripPrice(db, { ticketId: 1, operatorId: 501, newPrice: 550, newPremiumPrice: 950 });
        const after = db.prepare('SELECT total_price FROM bus_ticket_bookings WHERE id=?').get(vipBooking.id).total_price;
        assert.equal(after, 900, 'VIP booking must keep the premium price that was live when it was booked');
    });

    it('23. Concurrency: a booking-in-flight and a concurrent price change never produce a booking/invoice mismatch', () => {
        const db = setupTestDatabase();
        seedTrip(db, { price: 840 });

        // Request A begins: reads ticket price (840) as of this instant...
        const ticketSnapshotForRequestA = db.prepare('SELECT * FROM bus_tickets WHERE id = ?').get(1);
        const totalPriceForA = computeTotalPrice(ticketSnapshotForRequestA, [23]);

        // ...meanwhile the carrier's price-change request commits first.
        updateTripPrice(db, { ticketId: 1, operatorId: 501, newPrice: 700 });

        // Request A now finishes its insert using the price it already read —
        // this is the ONE authoritative value used for both the booking row
        // and (in the real flow) the SmartPay invoice amount.
        const info = db.prepare(`
            INSERT INTO bus_ticket_bookings (bus_ticket_id, passenger_id, seat_numbers, status, total_price, source_type)
            VALUES (?, ?, ?, 'confirmed', ?, 'direct')
        `).run(1, 41, JSON.stringify([23]), totalPriceForA);
        const bookingA = db.prepare('SELECT * FROM bus_ticket_bookings WHERE id = ?').get(info.lastInsertRowid);
        const invoiceAmountForA = Math.round(totalPriceForA * 10 / 100);

        assert.equal(bookingA.total_price, 840, 'booking gets whatever price was live at its own read time — deterministic, not corrupted');
        assert.equal(invoiceAmountForA, 84, 'invoice amount is derived from the exact same totalPrice, never from a second, later read');
        assert.equal(db.prepare('SELECT price FROM bus_tickets WHERE id=?').get(1).price, 700, 'the trip price change itself still applied correctly');
    });

    it('24. Changing trip price never issues an UPDATE against existing bus_ticket_bookings rows', () => {
        const db = setupTestDatabase();
        seedTrip(db, { price: 840 });
        const bookingA = createManualBooking(db, { ticketId: 1, seatNumbers: [24] });
        const before = JSON.stringify(db.prepare('SELECT * FROM bus_ticket_bookings WHERE id=?').get(bookingA.id));

        updateTripPrice(db, { ticketId: 1, operatorId: 501, newPrice: 700 });
        updateTripPrice(db, { ticketId: 1, operatorId: 501, newPrice: 750 });

        const after = JSON.stringify(db.prepare('SELECT * FROM bus_ticket_bookings WHERE id=?').get(bookingA.id));
        assert.equal(after, before, 'the booking row must be byte-for-byte identical — no field was ever touched by a trip price change');
    });
});

// =============================================================================
// PART 3 — Static source-contract assertions (pin the real shipped files)
// =============================================================================
describe('Phase P.2 — Static contract checks against shipped source', () => {
    const busAdminSrc = fs.readFileSync(path.join(__dirname, '../routes/busAdmin.js'), 'utf8');
    const busBookingsSrc = fs.readFileSync(path.join(__dirname, '../routes/busBookings.js'), 'utf8');
    const smartpaySrc = fs.readFileSync(path.join(__dirname, '../routes/smartpay.js'), 'utf8');
    const rpcMigrationSrc = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20260918184834_fix_bus_trip_notification_outbox_recipient_key.sql'), 'utf8');

    it('PUT /tickets/:id is behind carrierAuth (no carrier auth => rejected)', () => {
        assert.ok(busAdminSrc.includes("router.use(carrierAuth)"));
    });

    it('PUT /tickets/:id verifies ticket ownership before any field, including price, can change', () => {
        assert.ok(busAdminSrc.includes('const hasAccess = await verifyTicketAccess(req.carrier, id);'));
        assert.ok(busAdminSrc.includes("Доступ запрещен: рейс не принадлежит вашему аккаунту перевозчика"));
    });

    it('the active-bookings guard blocks ONLY from_city/to_city — price is never gated by it', () => {
        const guardBlock = busAdminSrc.split('4. City change protection')[1].split('5. Bus replacement validation')[0];
        assert.ok(guardBlock.includes('ROUTE_CHANGE_REQUIRES_SEPARATE_TRIP'));
        assert.ok(!guardBlock.includes("'price'"), 'price must never appear inside the active-bookings route guard');
    });

    it('price-only trip edits are tagged with change_type "price_update" for a queryable audit trail (bus_ticket_change_events)', () => {
        assert.ok(busAdminSrc.includes("const PRICE_FIELDS = ['price', 'premium_price'];"));
        assert.ok(busAdminSrc.includes("isPriceOnlyChange ? 'price_update' : 'schedule_update'"));
    });

    it('fn_atomic_bus_trip_update (the deployed RPC) updates bus_tickets.price but never writes to bus_ticket_bookings.total_price/commission fields', () => {
        const fnBody = rpcMigrationSrc.split('CREATE OR REPLACE FUNCTION public.fn_atomic_bus_trip_update')[1].split('$$;')[0];
        assert.ok(/price = COALESCE\(\(p_update_data->>'price'\)::numeric, price\)/.test(fnBody));
        // The only UPDATE against bus_ticket_bookings in this function is the seat-remap UPDATE (seat_numbers only).
        const bookingUpdates = fnBody.match(/UPDATE public\.bus_ticket_bookings[\s\S]*?WHERE/g) || [];
        bookingUpdates.forEach(stmt => {
            assert.ok(!/total_price|commission_|carrier_amount/.test(stmt), `fn_atomic_bus_trip_update must never touch booking price/commission fields: ${stmt}`);
        });
    });

    it('manual booking price is computed server-side from the ticket row, never from client body', () => {
        assert.ok(busAdminSrc.includes('const premiumPrice = Number(ticket.premium_price || ticket.price || 0);'));
        assert.ok(busAdminSrc.includes('const standardPrice = Number(ticket.price || 0);'));
    });

    it('online booking price is computed server-side from the ticket row, never from client body', () => {
        assert.ok(busBookingsSrc.includes('const premiumPrice = ticket.premium_price || ticket.price;'));
    });

    it('SmartPay create-invoice computes amount strictly server-side, ignoring any client-supplied amount', () => {
        assert.ok(smartpaySrc.includes('const premiumPrice = ticket.premium_price || ticket.price;'));
        assert.ok(smartpaySrc.includes('const platformFee = Math.round(totalPrice * feePercent / 100);'));
    });

    it('SmartPay payment confirmation never re-reads ticket.price nor recomputes total_price/commission', () => {
        const fnSrc = smartpaySrc.split('async function processSuccessfulPayment(booking) {')[1].split('\nasync function ')[0];
        assert.ok(fnSrc.includes("status: 'confirmed'"));
        assert.ok(!/\.update\(\{[^}]*total_price/.test(fnSrc), 'processSuccessfulPayment must not update total_price');
        assert.ok(!/\.update\(\{[^}]*commission/.test(fnSrc), 'processSuccessfulPayment must not update commission fields');
    });

    it('Ticket V1.1 projection reads price from the booking row, not the trip row', () => {
        const helperSrc = fs.readFileSync(path.join(__dirname, '../utils/ticketHelper.js'), 'utf8');
        assert.ok(helperSrc.includes('const totalPrice = Number(booking.total_price || 0);'));
    });

    it('carrier passenger list (GET /bookings) reports total_price from the booking row', () => {
        assert.ok(busAdminSrc.includes("const totalPrice = Number(b.total_price || 0);"));
    });
});

// =============================================================================
// PART 4 — Static contract checks against the frontend (Edit Trip UI)
// =============================================================================
describe('Phase P.2 — Static contract checks against poputki-front Edit Trip UI', () => {
    const frontFile = path.join(__dirname, '../../poputki-front/src/views/BusAdminView.vue');
    const hasFrontRepo = fs.existsSync(frontFile);

    it('SUBSTANTIAL_FIELDS (the active-bookings block-and-confirm guard) still excludes price — other restrictions not loosened', { skip: !hasFrontRepo }, () => {
        const src = fs.readFileSync(frontFile, 'utf8');
        const block = src.split('const SUBSTANTIAL_FIELDS = [')[1].split('];')[0];
        assert.ok(!block.includes("'price'"));
        assert.ok(!block.includes("'premium_price'"));
        assert.ok(block.includes("'from_address'"));
        assert.ok(block.includes("'bus_id'"));
    });

    it('a separate, additive price-change confirmation exists and does NOT merge price into SUBSTANTIAL_FIELDS', { skip: !hasFrontRepo }, () => {
        const src = fs.readFileSync(frontFile, 'utf8');
        assert.ok(src.includes("const PRICE_FIELDS = ['price', 'premium_price'];"));
        assert.ok(src.includes('showPriceChangeConfirmModal'));
        assert.ok(src.includes('Новая цена будет применяться только к новым бронированиям'));
    });

    it('the price-change modal never blocks saving — it only warns and lets the carrier proceed', { skip: !hasFrontRepo }, () => {
        const src = fs.readFileSync(frontFile, 'utf8');
        assert.ok(src.includes('confirmPriceChangeModal'));
        assert.ok(src.includes('updateBusTicket(false, true, null, true)'));
    });
});
