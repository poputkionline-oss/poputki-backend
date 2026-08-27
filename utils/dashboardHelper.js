/**
 * dashboardHelper.js — Server-side aggregation and metrics calculation for Carrier Owner Dashboard
 * Phase: P1.4 Owner Dashboard (Hardened & Performance-Optimized)
 */

/**
 * Calculates current business local date in YYYY-MM-DD format and local time HH:mm (Asia/Dushanbe UTC+5).
 */
function getBusinessLocalDate(timeZone = 'Asia/Dushanbe') {
    try {
        const d = new Date();
        const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
        const y = parts.find(p => p.type === 'year').value;
        const m = parts.find(p => p.type === 'month').value;
        const day = parts.find(p => p.type === 'day').value;
        return `${y}-${m}-${day}`;
    } catch (e) {
        const d = new Date(Date.now() + 5 * 3600 * 1000);
        return d.toISOString().slice(0, 10);
    }
}

/**
 * Calculates current business local time in HH:mm format (Asia/Dushanbe UTC+5).
 */
function getBusinessLocalTime(timeZone = 'Asia/Dushanbe') {
    try {
        const d = new Date();
        return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
    } catch (e) {
        const d = new Date(Date.now() + 5 * 3600 * 1000);
        return d.toISOString().slice(11, 16);
    }
}

/**
 * Robust, production-grade passenger count calculation without double-counting.
 */
function getBookingPassengerCount(booking) {
    if (!booking) return 0;

    // 1. Explicit positive passenger_count field
    const directCount = Number(booking.passenger_count);
    if (!isNaN(directCount) && directCount > 0) {
        return directCount;
    }

    // 2. Length of seat_numbers array
    if (Array.isArray(booking.seat_numbers) && booking.seat_numbers.length > 0) {
        const validSeats = booking.seat_numbers.filter(s => s !== null && s !== undefined && String(s).trim() !== '');
        if (validSeats.length > 0) return validSeats.length;
    }

    // 3. Length of passengers_data
    if (Array.isArray(booking.passengers_data) && booking.passengers_data.length > 0) {
        return booking.passengers_data.length;
    }
    if (typeof booking.passengers_data === 'string' && booking.passengers_data.trim().startsWith('[')) {
        try {
            const parsed = JSON.parse(booking.passengers_data);
            if (Array.isArray(parsed) && parsed.length > 0) return parsed.length;
        } catch (e) {
            // Ignore parse errors
        }
    }

    // 4. Default fallback for valid single booking record
    return 1;
}

/**
 * Robustly extracts an array of seat numbers from arrays, JSON strings, or numbers.
 */
function extractSeatNumbers(seatNumbers) {
    if (Array.isArray(seatNumbers)) return seatNumbers;
    if (typeof seatNumbers === 'string') {
        const trimmed = seatNumbers.trim();
        if (trimmed.startsWith('[')) {
            try {
                const parsed = JSON.parse(trimmed);
                if (Array.isArray(parsed)) return parsed;
            } catch (e) {}
        }
        if (trimmed !== '') return [trimmed];
    }
    if (typeof seatNumbers === 'number') return [seatNumbers];
    return [];
}

/**
 * Normalizes seat number to string representation for unique set deduplication ("12" === 12).
 */
function normalizeSeat(seat) {
    if (seat === null || seat === undefined) return null;
    const str = String(seat).trim();
    return str === '' ? null : str;
}

/**
 * Classifies booking into 'online', 'manual', or 'unknown'.
 */
function classifyBookingSource(channel, sourceType) {
    const raw = String(channel || sourceType || '').toLowerCase().trim();
    if (!raw) return 'unknown';
    if (raw === 'web' || raw === 'telegram' || raw === 'platform' || raw === 'carrier_link' || raw === 'partner_link') {
        return 'online';
    }
    if (raw === 'manual' || raw === 'carrier' || raw === 'cash' || raw === 'dispatcher' || raw === 'driver') {
        return 'manual';
    }
    return 'unknown';
}

/**
 * Calculates unique booked seats and fill rate for a trip.
 */
function calculateTripFillStats(ticket, bookings = []) {
    const capacity = Number(ticket.total_seats) || 53;
    const activeBookings = (bookings || []).filter(b => String(b.bus_ticket_id) === String(ticket.id) && b.status !== 'cancelled');

    // Collect unique booked seats from non-cancelled bookings
    const uniqueSeats = new Set();
    const confirmedSeats = new Set();
    const heldSeats = new Set();

    let totalPassengers = 0; // Confirmed passengers only
    let confirmedCount = 0;
    let pendingPaymentCount = 0;
    let pendingPaymentPassengers = 0;
    let boardedCount = 0;
    let pendingBoardingCount = 0;
    let noShowCount = 0;

    for (const b of activeBookings) {
        const isConfirmed = b.status === 'confirmed';
        const isPending = b.status === 'pending_payment';
        const pCount = getBookingPassengerCount(b);

        if (isConfirmed) {
            confirmedCount++;
            totalPassengers += pCount;

            if (b.boarding_status === 'boarded') boardedCount++;
            else if (b.boarding_status === 'no_show') noShowCount++;
            else pendingBoardingCount++;
        } else if (isPending) {
            pendingPaymentCount++;
            pendingPaymentPassengers += pCount;
        }

        // Seats normalization (handles array, JSON string "[70]", or single number)
        const seats = extractSeatNumbers(b.seat_numbers);
        for (const s of seats) {
            const norm = normalizeSeat(s);
            if (norm !== null) {
                uniqueSeats.add(norm);
                if (isConfirmed) confirmedSeats.add(norm);
                if (isPending) heldSeats.add(norm);
            }
        }
    }

    const bookedSeats = uniqueSeats.size;
    const confirmedSeatsCount = confirmedSeats.size;
    const heldSeatsCount = heldSeats.size;
    const freeSeats = Math.max(0, capacity - bookedSeats);
    const fillRate = capacity > 0 ? Math.min(100, Math.round((bookedSeats / capacity) * 1000) / 10) : 0;

    return {
        capacity,
        booked_seats: bookedSeats,
        occupied_or_held_seats: bookedSeats,
        confirmed_seats: confirmedSeatsCount,
        held_seats: heldSeatsCount,
        free_seats: freeSeats,
        fill_rate: fillRate,
        passengers_count: totalPassengers, // Confirmed passengers only
        confirmed_bookings: confirmedCount,
        pending_payment_count: pendingPaymentCount,
        pending_payment_passengers: pendingPaymentPassengers,
        boarded_count: boardedCount,
        pending_boarding_count: pendingBoardingCount,
        no_show_count: noShowCount
    };

}

/**
 * Aggregates summary KPI for Today's operations.
 */
function buildTodaySummary(todayTickets = [], todayBookings = []) {
    let totalCapacity = 0;
    let totalBookedSeats = 0;
    let totalPassengers = 0;

    let confirmedBookings = 0;
    let pendingPaymentBookings = 0;
    let pendingPaymentPassengers = 0;
    let cancelledBookings = 0;

    let onlineConfirmed = 0;
    let manualConfirmed = 0;
    let unknownConfirmed = 0;

    let grossAmount = 0;
    let serviceCommission = 0;
    let carrierAmount = 0;
    let pendingPaymentGross = 0;

    let boardedPassengers = 0;
    let pendingBoardingPassengers = 0;
    let noShowPassengers = 0;

    // Per-ticket fill stats
    for (const ticket of todayTickets) {
        const ticketBookings = todayBookings.filter(b => String(b.bus_ticket_id) === String(ticket.id));
        const stats = calculateTripFillStats(ticket, ticketBookings);
        totalCapacity += stats.capacity;
        totalBookedSeats += stats.booked_seats;
    }

    // Per-booking accounting and status aggregation
    for (const b of todayBookings) {
        const pCount = getBookingPassengerCount(b);

        if (b.status === 'confirmed') {
            confirmedBookings++;
            totalPassengers += pCount;

            const gross = Number(b.total_price || 0);
            const comm = Number(b.commission_amount || 0);
            const net = b.carrier_amount !== undefined && b.carrier_amount !== null 
                ? Number(b.carrier_amount) 
                : (gross - comm);

            grossAmount += gross;
            serviceCommission += comm;
            carrierAmount += net;

            const source = classifyBookingSource(b.channel, b.source_type);
            if (source === 'online') onlineConfirmed++;
            else if (source === 'manual') manualConfirmed++;
            else unknownConfirmed++;

            if (b.boarding_status === 'boarded') boardedPassengers += pCount;
            else if (b.boarding_status === 'no_show') noShowPassengers += pCount;
            else pendingBoardingPassengers += pCount;

        } else if (b.status === 'pending_payment') {
            pendingPaymentBookings++;
            pendingPaymentGross += Number(b.total_price || 0);
            pendingPaymentPassengers += pCount;
        } else if (b.status === 'cancelled') {
            cancelledBookings++;
        }
    }

    const freeSeats = Math.max(0, totalCapacity - totalBookedSeats);
    const avgFillRate = totalCapacity > 0 ? Math.min(100, Math.round((totalBookedSeats / totalCapacity) * 1000) / 10) : 0;
    const onlineDenominator = onlineConfirmed + manualConfirmed;
    const onlineShare = onlineDenominator > 0 ? Math.round((onlineConfirmed / onlineDenominator) * 1000) / 10 : 0;

    return {
        trips_count: todayTickets.length,
        capacity: totalCapacity,
        booked_seats: totalBookedSeats,
        free_seats: freeSeats,
        fill_rate: avgFillRate,
        passengers_count: totalPassengers,

        confirmed_bookings: confirmedBookings,
        pending_payment: pendingPaymentBookings,
        pending_payment_passengers: pendingPaymentPassengers,
        cancelled: cancelledBookings,

        online_bookings: onlineConfirmed,
        manual_bookings: manualConfirmed,
        unknown_bookings: unknownConfirmed,
        online_share: onlineShare,

        gross_amount: grossAmount,
        service_commission: serviceCommission,
        carrier_amount: carrierAmount,
        pending_payment_gross: pendingPaymentGross,
        pending_payment_amount: pendingPaymentGross,

        boarded: boardedPassengers,
        pending_boarding: pendingBoardingPassengers,
        no_show: noShowPassengers,

        boarding: {
            boarded: boardedPassengers,
            pending_boarding: pendingBoardingPassengers,
            no_show: noShowPassengers
        }
    };
}


/**
 * Detects attention items based on deterministic business rules.
 */
function detectAttentionItems(todayTickets = [], upcomingTickets = [], allRelevantBookings = [], activeDrivers = []) {
    const attention = [];
    const now = Date.now();
    const thirtyMinutesMs = 30 * 60 * 1000;

    // Normalizing assigned_ticket_ids to strings for type-safety ("123" === 123)
    const assignedTicketIds = new Set();
    for (const driver of (activeDrivers || [])) {
        if (driver.is_active && Array.isArray(driver.assigned_ticket_ids)) {
            for (const tid of driver.assigned_ticket_ids) {
                if (tid !== null && tid !== undefined) {
                    assignedTicketIds.add(String(tid).trim());
                }
            }
        }
    }

    // 1. Stale pending payments (> 30 min) on relevant active trips
    const stalePending = allRelevantBookings.filter(b => 
        b.status === 'pending_payment' && 
        b.created_at && 
        new Date(b.created_at).getTime() <= (now - thirtyMinutesMs)
    );

    if (stalePending.length > 0) {
        attention.push({
            id: 'stale_pending_payments',
            type: 'CRITICAL',
            icon: '⏳',
            title: `Неоплаченные бронирования (${stalePending.length})`,
            message: `${stalePending.length} бронь(и) ожидают оплаты более 30 минут. Места временно заблокированы.`,
            action_url: '/bus-admin?tab=bookings&status=pending_payment',
            count: stalePending.length
        });
    }

    // 2. Upcoming trips without assigned driver
    const tripsNear = [...todayTickets, ...upcomingTickets.slice(0, 5)];
    const uniqueTripsNear = Array.from(new Map(tripsNear.map(t => [String(t.id), t])).values());

    const unassignedTrips = uniqueTripsNear.filter(t => !assignedTicketIds.has(String(t.id)));
    if (unassignedTrips.length > 0) {
        attention.push({
            id: 'unassigned_drivers',
            type: 'WARNING',
            icon: '👤',
            title: `Рейсы без назначенного водителя (${unassignedTrips.length})`,
            message: `На ближайшие рейсы (${unassignedTrips.map(t => `#${t.id}`).join(', ')}) еще не назначен водитель для проведения посадки.`,
            action_url: '/bus-admin?tab=team',
            count: unassignedTrips.length
        });
    }

    // 3. Today's trips with pending boarding
    const todayTicketIds = new Set(todayTickets.map(t => String(t.id)));
    const todayPendingBoarding = allRelevantBookings.filter(b => 
        todayTicketIds.has(String(b.bus_ticket_id)) && 
        b.status === 'confirmed' && 
        (!b.boarding_status || b.boarding_status === 'pending_boarding')
    );

    if (todayTickets.length > 0 && todayPendingBoarding.length > 0) {
        attention.push({
            id: 'today_pending_boarding',
            type: 'INFO',
            icon: '🚪',
            title: `Ожидают посадки сегодня (${todayPendingBoarding.length})`,
            message: `${todayPendingBoarding.length} пассажир(ов) на сегодняшние рейсы еще не прошли регистрацию на посадке.`,
            action_url: '/bus-admin?tab=boarding',
            count: todayPendingBoarding.length
        });
    }

    // 4. No-show passengers detected today
    const todayNoShows = allRelevantBookings.filter(b => 
        todayTicketIds.has(String(b.bus_ticket_id)) && 
        b.boarding_status === 'no_show'
    );

    if (todayNoShows.length > 0) {
        attention.push({
            id: 'today_no_shows',
            type: 'WARNING',
            icon: '⚠️',
            title: `Зафиксирована неявка пассажиров (${todayNoShows.length})`,
            message: `${todayNoShows.length} пассажир(ов) отмечены как "Не явился" на сегодняшних рейсах.`,
            action_url: '/bus-admin?tab=boarding',
            count: todayNoShows.length
        });
    }

    return attention;
}

/**
 * Builds list of upcoming active trips with operational stats and type-safe driver mapping.
 */
function buildUpcomingTripsList(upcomingTickets = [], allBookings = [], activeDrivers = []) {
    const assignedTicketIds = new Set();
    for (const driver of (activeDrivers || [])) {
        if (driver.is_active && Array.isArray(driver.assigned_ticket_ids)) {
            for (const tid of driver.assigned_ticket_ids) {
                if (tid !== null && tid !== undefined) {
                    assignedTicketIds.add(String(tid).trim());
                }
            }
        }
    }

    return (upcomingTickets || []).slice(0, 10).map(t => {
        const ticketBookings = allBookings.filter(b => String(b.bus_ticket_id) === String(t.id));
        const stats = calculateTripFillStats(t, ticketBookings);

        return {
            id: t.id,
            departure_date: t.departure_date,
            departure_time: t.departure_time,
            from_city: t.from_city,
            to_city: t.to_city,
            from_address: t.from_address || '',
            to_address: t.to_address || '',
            bus_type: t.bus_type || 'single',
            price: t.price,
            premium_price: t.premium_price,
            capacity: stats.capacity,
            booked_seats: stats.booked_seats,
            free_seats: stats.free_seats,
            fill_rate: stats.fill_rate,
            confirmed_bookings: stats.confirmed_bookings,
            pending_payment_count: stats.pending_payment_count,
            boarded_count: stats.boarded_count,
            pending_boarding_count: stats.pending_boarding_count,
            no_show_count: stats.no_show_count,
            has_assigned_driver: assignedTicketIds.has(String(t.id).trim())
        };
    });
}

module.exports = {
    getBusinessLocalDate,
    getBusinessLocalTime,
    getBookingPassengerCount,
    normalizeSeat,
    classifyBookingSource,
    calculateTripFillStats,
    buildTodaySummary,
    detectAttentionItems,
    buildUpcomingTripsList
};
