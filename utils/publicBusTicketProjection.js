/**
 * utils/publicBusTicketProjection.js
 *
 * Security hotfix V2.0A — single source of truth for what the UNAUTHENTICATED
 * bus trip endpoints (GET /api/bus-tickets, GET /api/bus-tickets/:id) may return.
 *
 * Rules:
 *  - ALLOWLIST ONLY. Public DTOs are built field-by-field. A raw DB row is never
 *    spread into a response, so a column added to `bus_tickets` later is NOT
 *    exposed until someone adds it here on purpose.
 *  - Booking rows (bus_ticket_bookings) never leave the server. Only derived
 *    aggregates (seat numbers, counts) are returned.
 *  - Passenger data (names, phones, passengers_data, documents, DOB, citizenship),
 *    payment fields (payment_link, payment_order_id, invoice_uuid), carrier notes,
 *    commission/carrier accounting and group-leader contacts are never selected
 *    for public use.
 */

'use strict';

const { isSeatLockedByBooking } = require('./paymentExpirationHelper');
const { buildPublicBusDetails } = require('./publicBusHelper');

// Columns the public SEARCH/LIST endpoint may select from bus_tickets.
// Deliberately excluded: operator_id, bus_id, status, created_at, poll_completed_at,
// group_leader_name/phone/whatsapp.
const PUBLIC_TRIP_LIST_COLUMNS = [
    'id', 'transport_company',
    'from_city', 'from_address', 'to_city', 'to_address',
    'departure_date', 'departure_time', 'arrival_date', 'arrival_time',
    'duration_minutes', 'price', 'premium_price',
    'total_seats',
    // reserved_seats is kept ONLY for compatibility: SearchResultsView computes
    // `total_seats - reserved_seats.length`. It holds seat numbers only (no PII).
    'reserved_seats',
    'bus_type', 'floor1_seats', 'floor2_seats', 'photos',
    'passenger_comments', 'intermediate_stops',
    // Needed server-side (not returned): status filtering and master-bus lookup.
    'bus_id'
].join(', ');

// Columns the public DETAILS endpoint may select. Adds operator_id (used by the
// public CarrierReviews widget) and the operator contact join handled separately.
const PUBLIC_TRIP_DETAILS_COLUMNS = PUBLIC_TRIP_LIST_COLUMNS + ', status, operator_id';

function parseJsonArray(value) {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value || '[]');
            return Array.isArray(parsed) ? parsed : [];
        } catch (_) {
            return [];
        }
    }
    return [];
}

function toHHMM(time) {
    return time ? String(time).substring(0, 5) : time;
}

function normalizeStops(stops) {
    return parseJsonArray(stops)
        .filter(s => s && typeof s === 'object')
        .map(s => ({ ...s, time: s.time ? String(s.time).substring(0, 5) : s.time }));
}

/**
 * Seat numbers (never booking rows) for a trip.
 *
 * Canonical server-side seat occupancy:
 *   - confirmedSeats: seats of bookings with status === 'confirmed'.
 *   - lockedSeats:    confirmed + pending_payment bookings whose hold is still
 *                     active (the exact predicate POST /api/bus-ticket-bookings
 *                     uses to reject a conflicting seat). Expired holds and
 *                     cancelled bookings never lock a seat.
 *
 * `bookedSeats` in the public details response is `confirmedSeats`, which
 * preserves the pre-hotfix behaviour of this endpoint (it only ever counted
 * confirmed bookings). `lockedSeats` is exposed for the follow-up that aligns
 * display with the booking rule — see the hotfix report.
 *
 * @param {Array} bookings rows with at least { seat_numbers, status, hold_expires_at, created_at }
 * @param {Date}  now
 * @returns {{ confirmedSeats: Array, lockedSeats: Array }}
 */
function computeSeatOccupancy(bookings, now = new Date()) {
    const confirmed = new Set();
    const locked = new Set();
    (Array.isArray(bookings) ? bookings : []).forEach(b => {
        const seats = parseJsonArray(b && b.seat_numbers);
        if (b && b.status === 'confirmed') seats.forEach(s => confirmed.add(s));
        if (isSeatLockedByBooking(b, now)) seats.forEach(s => locked.add(s));
    });
    return { confirmedSeats: [...confirmed], lockedSeats: [...locked] };
}

// Mirrors the existing premium-seat rule (front BusBookingView / POST booking):
// front-row seats on the 2nd floor, plus table seats on a double-decker.
function computePremiumSeats(busType) {
    const base = [1, 2, 3, 4];
    return busType === 'double' ? [...base, 69, 70, 71, 72, 73, 74, 75, 76] : base;
}

// Fields shared by summary and details, built one by one (allowlist).
function pickCommonTripFields(row) {
    return {
        id: row.id,
        transport_company: row.transport_company,
        from_city: row.from_city,
        from_address: row.from_address,
        to_city: row.to_city,
        to_address: row.to_address,
        departure_date: row.departure_date,
        departure_time: toHHMM(row.departure_time),
        arrival_date: row.arrival_date,
        arrival_time: toHHMM(row.arrival_time),
        duration_minutes: row.duration_minutes,
        price: row.price,
        premium_price: row.premium_price,
        total_seats: row.total_seats,
        bus_type: row.bus_type,
        floor1_seats: row.floor1_seats,
        floor2_seats: row.floor2_seats,
        photos: row.photos,
        passenger_comments: row.passenger_comments,
        intermediate_stops: normalizeStops(row.intermediate_stops)
    };
}

/**
 * Public trip summary (search/list).
 * @param {Object} row bus_tickets row selected with PUBLIC_TRIP_LIST_COLUMNS
 * @param {Object|null} busMaster carrier_buses row (public-safe columns)
 */
function toPublicBusTripSummary(row, busMaster = null) {
    const reservedSeats = parseJsonArray(row.reserved_seats);
    const total = Number(row.total_seats) || 0;
    return {
        ...pickCommonTripFields(row),
        bus: buildPublicBusDetails(row, busMaster),
        reserved_seats: reservedSeats,
        availableSeatsCount: Math.max(0, total - reservedSeats.length)
    };
}

/**
 * Public trip details.
 * @param {Object} row bus_tickets row selected with PUBLIC_TRIP_DETAILS_COLUMNS
 * @param {Object} ctx
 * @param {Object|null} ctx.busMaster
 * @param {Array}  ctx.confirmedSeats  seat numbers of confirmed bookings (no rows)
 * @param {Object|null} ctx.operator   { phone, service_fee_percent } of the carrier
 * @param {Object|null} ctx.seatGenders only for an authenticated passenger; otherwise omitted
 */
function toPublicBusTripDetails(row, ctx = {}) {
    const bookedSeats = Array.isArray(ctx.confirmedSeats) ? ctx.confirmedSeats : [];
    const total = Number(row.total_seats) || 0;
    const operator = ctx.operator || null;

    const dto = {
        ...pickCommonTripFields(row),
        operator_id: row.operator_id,
        bus: buildPublicBusDetails(row, ctx.busMaster || null),
        // Existing passenger-facing carrier contact (BusTicketDetailsView "contact carrier").
        operator_phone: operator ? operator.phone : undefined,
        service_fee_percent: operator && operator.service_fee_percent != null
            ? operator.service_fee_percent
            : 10,
        bookedSeats,
        availableSeatsCount: Math.max(0, total - bookedSeats.length),
        premiumSeats: computePremiumSeats(row.bus_type)
    };

    if (ctx.seatGenders && typeof ctx.seatGenders === 'object') {
        dto.seatGenders = ctx.seatGenders;
    }
    return dto;
}

module.exports = {
    PUBLIC_TRIP_LIST_COLUMNS,
    PUBLIC_TRIP_DETAILS_COLUMNS,
    computeSeatOccupancy,
    computePremiumSeats,
    toPublicBusTripSummary,
    toPublicBusTripDetails
};
