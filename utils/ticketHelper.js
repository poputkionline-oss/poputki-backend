/**
 * ticketHelper.js — Projection, Formatting, and Security for Passenger Tickets V1
 * 
 * POPUTKI.ONLINE
 */

const crypto = require('crypto');
const { buildPublicBusDetails } = require('./publicBusHelper');

const SECRET_SALT = process.env.JWT_SECRET || 'poputki-ticket-salt-secure-v1';

/**
 * Generates a secure, non-guessable HMAC verification token for a booking.
 * Format: <booking_id>-<32 hex chars> (128-bit truncated HMAC-SHA256)
 * Uses domain-separated payload: ticket:v1:<booking_id>
 * 
 * @param {number|string} bookingId - Numeric booking ID
 * @returns {string} Safe opaque verification token
 */
function generateTicketVerificationToken(bookingId) {
    if (!bookingId || !/^\d+$/.test(String(bookingId))) return '';
    const raw = `ticket:v1:${bookingId}`;
    const hash = crypto.createHmac('sha256', SECRET_SALT).update(raw).digest('hex');
    const signature = hash.substring(0, 32);
    return `${bookingId}-${signature}`;
}

/**
 * Verifies if a given public token matches the booking.
 * Uses timing-safe constant-time comparison against 32-hex HMAC signature.
 * 
 * @param {string} token - Token to verify
 * @param {number|string} bookingId
 * @returns {boolean}
 */
function verifyTicketToken(token, bookingId) {
    if (!token || typeof token !== 'string' || !bookingId) return false;
    const match = token.trim().match(/^(\d+)-([a-f0-9]{32})$/);
    if (!match) return false;

    const tokenBookingId = match[1];
    const tokenSignature = match[2];

    if (String(tokenBookingId) !== String(bookingId)) return false;

    const expectedToken = generateTicketVerificationToken(bookingId);
    if (!expectedToken) return false;

    const expectedSignature = expectedToken.split('-')[1];
    if (!expectedSignature || tokenSignature.length !== expectedSignature.length) return false;

    try {
        return crypto.timingSafeEqual(
            Buffer.from(tokenSignature, 'utf-8'),
            Buffer.from(expectedSignature, 'utf-8')
        );
    } catch {
        return false;
    }
}

/**
 * Extracts booking ID from verification token with strict validation.
 * @param {string} token 
 * @returns {number|null}
 */
function extractBookingIdFromToken(token) {
    if (!token || typeof token !== 'string') return null;
    const match = token.trim().match(/^(\d+)-[a-f0-9]{32}$/);
    if (!match) return null;
    const id = parseInt(match[1], 10);
    return isNaN(id) ? null : id;
}

/**
 * Formats a clean, standard human-readable Ticket Number.
 * Format: POP-000139
 * 
 * @param {number|string} bookingId
 * @returns {string}
 */
function formatTicketNumber(bookingId) {
    if (!bookingId) return 'POP-000000';
    return `POP-${String(bookingId).padStart(6, '0')}`;
}

/**
 * Builds a sanitized, authoritative Ticket Projection Object.
 * 
 * @param {Object} booking - Row from bus_ticket_bookings
 * @param {Object} ticket - Row from bus_tickets
 * @param {Object|null} busMaster - Row from carrier_buses (or null for legacy)
 * @param {Object} options - Projection options (e.g. isPublic, baseUrl)
 * @returns {Object} Canonical ticket projection
 */
function buildPassengerTicketProjection(booking, ticket, busMaster = null, options = {}) {
    if (!booking || !ticket) return null;

    const bookingId = booking.id;
    const token = generateTicketVerificationToken(bookingId, booking.created_at || '');
    const baseUrl = options.baseUrl || 'https://www.poputki.online';
    const verifyUrl = `${baseUrl}/ticket/${token}`;

    // Normalize seats
    let seats = [];
    try {
        seats = typeof booking.seat_numbers === 'string' 
            ? JSON.parse(booking.seat_numbers || '[]') 
            : (booking.seat_numbers || []);
        if (!Array.isArray(seats)) seats = seats ? [seats] : [];
    } catch {
        seats = [];
    }

    // Normalize passenger data list
    let passengersData = [];
    try {
        passengersData = typeof booking.passengers_data === 'string'
            ? JSON.parse(booking.passengers_data || '[]')
            : (booking.passengers_data || []);
        if (!Array.isArray(passengersData)) passengersData = [];
    } catch {
        passengersData = [];
    }

    // Primary passenger name
    let primaryPassengerName = booking.passenger_name || '';
    if (!primaryPassengerName && passengersData.length > 0) {
        const p0 = passengersData[0];
        primaryPassengerName = [p0.lastName, p0.firstName, p0.middleName].filter(Boolean).join(' ').trim();
    }
    if (!primaryPassengerName && booking.users && booking.users.name) {
        primaryPassengerName = booking.users.name;
    }
    if (!primaryPassengerName) {
        primaryPassengerName = 'Пассажир';
    }

    // Pricing Breakdown
    const totalPrice = Number(booking.total_price || 0);
    const isManual = booking.channel === 'manual' || booking.source_type === 'manual';
    const commRate = Number(booking.commission_rate ?? (isManual ? 0 : 10));
    
    // Paid amount logic:
    // For online confirmed bookings, the platform fee (commission_amount) was paid online via SmartPay.
    // The rest (carrier_amount) is payable to the driver/carrier.
    // For manual bookings, paid online is 0, full amount is payable to carrier.
    let paidAmount = 0;
    if (booking.status === 'confirmed') {
        if (isManual) {
            paidAmount = 0; // Driver handles full cash/transfer directly
        } else {
            paidAmount = Number(booking.commission_amount ?? Math.round(totalPrice * (commRate / 100)));
        }
    } else {
        paidAmount = 0;
    }

    const remainingAmount = Math.max(0, totalPrice - paidAmount);

    // Bus vehicle projection
    let vehicle = null;
    if (busMaster) {
        vehicle = buildPublicBusDetails(ticket, busMaster);
    } else {
        // Safe legacy fallback without Fleet vehicle
        vehicle = {
            id: null,
            brand: null,
            model: ticket.bus_model || null,
            license_plate: null,
            bus_type: ticket.bus_type || 'single',
            total_seats: Number(ticket.total_seats) || 53,
            photos: Array.isArray(ticket.photos) ? ticket.photos : []
        };
    }

    // Format departure/arrival time strings
    const departureTime = ticket.departure_time ? ticket.departure_time.substring(0, 5) : '';
    const arrivalTime = ticket.arrival_time ? ticket.arrival_time.substring(0, 5) : '';

    // Boarding status human label
    const boardingStatus = booking.boarding_status || 'pending_boarding';
    let boardingLabel = 'Ожидает посадки';
    if (boardingStatus === 'boarded') boardingLabel = 'Пассажир сел';
    else if (boardingStatus === 'no_show') boardingLabel = 'Не явился';

    // Booking status human label
    let statusLabel = 'Подтвержден';
    if (booking.status === 'pending_payment') statusLabel = 'Ожидает оплаты';
    else if (booking.status === 'cancelled') statusLabel = 'Отменен';
    else if (booking.status === 'conflict_refund_needed') statusLabel = 'Требуется возврат';

    // Detailed per-seat passengers list (for multi-seat bookings)
    const passengerItems = [];
    if (passengersData.length > 0) {
        passengersData.forEach((p, idx) => {
            const seatNum = seats[idx] !== undefined ? seats[idx] : (p.seatNumber || p.seat || '—');
            const fullName = [p.lastName, p.firstName, p.middleName].filter(Boolean).join(' ').trim() || primaryPassengerName;
            const item = {
                index: idx + 1,
                seat: seatNum,
                seatInt: Number(seatNum) || 999,
                name: fullName
            };
            if (!options.isPublic) {
                item.gender = p.gender === 'male' ? 'Муж.' : (p.gender === 'female' ? 'Жен.' : '—');
                item.docType = p.docType || 'Документ';
                item.docNumber = p.docNumber || '—';
            }
            passengerItems.push(item);
        });
    } else {
        // Fallback for bookings without detailed passengers_data
        seats.forEach((seatNum, idx) => {
            const item = {
                index: idx + 1,
                seat: seatNum,
                seatInt: Number(seatNum) || 999,
                name: primaryPassengerName
            };
            if (!options.isPublic) {
                item.gender = '—';
                item.docType = 'Документ';
                item.docNumber = '—';
            }
            passengerItems.push(item);
        });
    }

    return {
        brand: 'POPUTKI.ONLINE',
        ticketNumber: formatTicketNumber(bookingId),
        bookingId: bookingId,
        verificationToken: token,
        verificationUrl: verifyUrl,
        
        status: booking.status,
        statusLabel: statusLabel,
        isValid: booking.status === 'confirmed',
        isPendingPayment: booking.status === 'pending_payment',
        isCancelled: booking.status === 'cancelled',

        boardingStatus: boardingStatus,
        boardingLabel: boardingLabel,
        boardedAt: booking.boarded_at || null,

        // Route & Schedule
        route: {
            fromCity: ticket.from_city,
            toCity: ticket.to_city,
            fromAddress: ticket.from_address || null,
            toAddress: ticket.to_address || null,
            pickupCity: booking.pickup_city || ticket.from_city,
            dropOffCity: booking.drop_off_city || ticket.to_city,
            departureDate: ticket.departure_date,
            departureTime: departureTime,
            arrivalDate: ticket.arrival_date || ticket.departure_date,
            arrivalTime: arrivalTime,
            durationMinutes: ticket.duration_minutes || null,
            intermediateStops: Array.isArray(ticket.intermediate_stops) 
                ? ticket.intermediate_stops 
                : (typeof ticket.intermediate_stops === 'string' ? JSON.parse(ticket.intermediate_stops || '[]') : [])
        },

        // Passenger Info
        passenger: {
            primaryName: primaryPassengerName,
            passengerCount: seats.length || 1,
            seats: seats,
            seatNumbersDisplay: seats.join(', '),
            items: passengerItems
        },

        // Bus Info
        bus: vehicle,

        // Payment Info
        payment: {
            currency: 'сомони',
            currencyShort: 'сом',
            totalPrice: totalPrice,
            paidAmount: paidAmount,
            remainingAmount: remainingAmount,
            isManual: isManual,
            paymentChannel: booking.channel || 'web'
        },

        // Carrier Info (Safe public subset)
        carrier: {
            companyName: ticket.transport_company || 'Перевозчик POPUTKI.ONLINE',
            operatorPhone: options.includeCarrierPhone ? (ticket.operator?.phone || null) : null
        },

        createdAt: booking.created_at
    };
}

/**
 * Builds a sorted list of confirmed passenger tickets for bulk printing a trip.
 * Sorts strictly by seat number.
 * 
 * @param {Object} ticket - Bus ticket row
 * @param {Array} bookings - Array of booking rows for this ticket
 * @param {Object|null} busMaster - Fleet vehicle master or null
 * @returns {Array} List of individual printable ticket projections sorted by seat
 */
function buildTripPrintManifest(ticket, bookings, busMaster = null) {
    if (!ticket || !Array.isArray(bookings)) return [];

    // Filter confirmed only (exclude cancelled, expired pending)
    const confirmedBookings = bookings.filter(b => b.status === 'confirmed');

    const ticketList = [];

    confirmedBookings.forEach(booking => {
        const proj = buildPassengerTicketProjection(booking, ticket, busMaster);
        if (proj) {
            ticketList.push(proj);
        }
    });

    // Sort tickets primarily by the lowest seat number in the booking
    ticketList.sort((a, b) => {
        const seatA = (a.passenger.seats && a.passenger.seats.length > 0) ? Number(a.passenger.seats[0]) : 999;
        const seatB = (b.passenger.seats && b.passenger.seats.length > 0) ? Number(b.passenger.seats[0]) : 999;
        return seatA - seatB;
    });

    return ticketList;
}

module.exports = {
    generateTicketVerificationToken,
    verifyTicketToken,
    extractBookingIdFromToken,
    formatTicketNumber,
    buildPassengerTicketProjection,
    buildTripPrintManifest
};
