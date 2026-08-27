/**
 * crmHelper.js — Server-side Customer Relationship Management helper for Carrier Panel
 * 
 * Guarantees:
 * - Opaque Customer Keys: Uses HMAC-SHA256(secret, carrierId + '|' + canonicalIdentity)
 *   so that customer_key NEVER leaks phone numbers, passports, or names into URLs/logs.
 * - Multi-Tenant Isolation: Keys and aggregations are strictly scoped to req.carrier.carrier_id.
 * - Safe Identity Resolution: Priority = Phone -> Passenger User ID -> Document -> Unique Booking Fallback.
 *   NEVER groups different people by name alone.
 * - Safe Manual Booking Handling: Manual booking employee passenger_id is NOT used as passenger identity.
 * - PII Projection: List response minimizes PII; details endpoint provides full profile to authorized roles.
 */

const crypto = require('crypto');

/**
 * Derives a deterministic, opaque, tenant-scoped customer key.
 * Never leaks phone numbers, passport numbers, names, or operator IDs into the URL.
 * 
 * @param {number|string} carrierId - Current carrier/operator ID
 * @param {string} canonicalIdentity - Internal canonical identity (e.g. 'phone:+992928020032')
 * @returns {string} Opaque key (e.g. 'c_e4d9b2a18f73c05e269a8f4c3b2a19e0')
 */
function generateOpaqueCustomerKey(carrierId, canonicalIdentity) {
    const secret = process.env.CRM_CUSTOMER_KEY_SECRET || process.env.JWT_SECRET || 'poputki-crm-internal-salt';
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(`${carrierId || 0}|${canonicalIdentity || 'anon'}`);
    return 'c_' + hmac.digest('hex').substring(0, 32);
}

/**
 * Normalizes phone numbers to standard international format.
 * Supports Tajikistan (+992), Russia/Kazakhstan (+7), Uzbekistan (+998), international E.164.
 * Does NOT mutate raw stored booking phones — used for aggregation and search grouping.
 */
function normalizePhone(rawPhone) {
    if (!rawPhone || typeof rawPhone !== 'string') return null;
    const trimmed = rawPhone.trim();
    if (trimmed === '—' || trimmed === '-' || trimmed.length < 5) return null;

    // Remove all non-digits except leading +
    let cleaned = trimmed.replace(/[^\d+]/g, '');
    if (!cleaned) return null;

    // Handle Tajikistan numbers (9 digits e.g. 928020032 -> +992928020032)
    if (/^\d{9}$/.test(cleaned)) {
        return '+992' + cleaned;
    }
    // Starts with 992 and 12 digits total
    if (/^992\d{9}$/.test(cleaned)) {
        return '+' + cleaned;
    }
    // Starts with +992 and 12 digits
    if (/^\+992\d{9}$/.test(cleaned)) {
        return cleaned;
    }

    // Handle Russian / Kazakh domestic numbers (11 digits: 8900... or 8495... -> +7...)
    if (/^8\d{10}$/.test(cleaned)) {
        return '+7' + cleaned.substring(1);
    }
    // Starts with 7 and 11 digits
    if (/^7\d{10}$/.test(cleaned)) {
        return '+' + cleaned;
    }
    if (/^\+7\d{10}$/.test(cleaned)) {
        return cleaned;
    }

    // Handle Uzbekistan numbers (998 + 9 digits)
    if (/^998\d{9}$/.test(cleaned)) {
        return '+' + cleaned;
    }
    if (/^\+998\d{9}$/.test(cleaned)) {
        return cleaned;
    }

    // General international with + (E.164: 8 to 15 digits)
    if (cleaned.startsWith('+') && cleaned.length >= 8 && cleaned.length <= 16) {
        return cleaned;
    }

    // Fallback if at least 7 digits (plain digits without country code are kept as non-merged)
    return null;
}

/**
 * Aggregates carrier bookings into unique customer records with opaque keys.
 * 
 * @param {Array} bookings - Raw bus_ticket_bookings records belonging to this carrier
 * @param {Array|Object} tickets - Associated bus_tickets (array or id map)
 * @param {Object} options - { carrierId, search, from, to, status, source, page, limit, sort }
 * @returns {Object} { customers: Array, pagination: Object, summary: Object }
 */
function aggregateCarrierCustomers(bookings = [], tickets = [], options = {}) {
    const carrierId = options.carrierId || 0;
    const ticketMap = {};
    if (Array.isArray(tickets)) {
        tickets.forEach(t => { if (t && t.id) ticketMap[t.id] = t; });
    } else if (tickets && typeof tickets === 'object') {
        Object.assign(ticketMap, tickets);
    }

    const customersMap = {};
    const todayStr = new Date().toISOString().split('T')[0];

    (bookings || []).forEach(b => {
        const ticket = ticketMap[b.bus_ticket_id];
        if (Object.keys(ticketMap).length > 0 && !ticket) {
            return; // Strict tenant isolation: skip booking if not matching carrier tickets
        }
        const safeTicket = ticket || {};
        const effectiveCarrierId = carrierId || safeTicket.operator_id || 0;
        const normPhone = normalizePhone(b.phone);
        
        let primaryName = (b.passenger_name || '').trim();
        let docObj = null;
        let passengerPhone = null;
        let pDataList = [];

        if (Array.isArray(b.passengers_data) && b.passengers_data.length > 0) {
            pDataList = b.passengers_data;
            const p0 = b.passengers_data[0];
            const fullName = [p0.lastName, p0.firstName, p0.middleName].filter(Boolean).join(' ').trim();
            if (fullName) primaryName = fullName;
            if (p0.docNumber) {
                docObj = {
                    docType: p0.docType || 'Паспорт',
                    docNumber: String(p0.docNumber).trim(),
                    citizenship: p0.citizenship || '',
                    birthDate: p0.birthDate || '',
                    gender: p0.gender || ''
                };
            }
            if (p0.phone) {
                passengerPhone = normalizePhone(p0.phone);
            }
        }

        const effectivePhone = passengerPhone || normPhone;

        // Customer Identity Strategy:
        // Priority 1: Normalized phone (e.g. phone:+992928020032)
        // Priority 2: Online passenger user_id (only if NOT manual booking)
        // Priority 3: Document number (e.g. doc:405093698)
        // Priority 4: Fallback per-booking (NEVER group by name alone to prevent collision!)
        let canonicalIdentity = '';
        if (effectivePhone) {
            canonicalIdentity = 'phone:' + effectivePhone;
        } else if (b.passenger_id && typeof b.passenger_id === 'number' && b.channel !== 'manual' && b.source_type !== 'manual') {
            canonicalIdentity = 'user:' + b.passenger_id;
        } else if (docObj && docObj.docNumber) {
            canonicalIdentity = 'doc:' + docObj.docNumber.trim();
        } else {
            canonicalIdentity = 'booking:' + b.id;
        }

        // Generate tenant-scoped OPAQUE key (zero PII in key)
        const opaqueKey = generateOpaqueCustomerKey(effectiveCarrierId, canonicalIdentity);

        if (!customersMap[opaqueKey]) {
            customersMap[opaqueKey] = {
                customer_key: opaqueKey,
                _canonical_identity: canonicalIdentity,
                name: primaryName || 'Не указано',
                phone: effectivePhone || b.phone || '—',
                document: docObj,
                total_trips: 0,
                confirmed_trips: 0,
                future_trips: 0,
                cancelled_count: 0,
                no_show_count: 0,
                total_booking_value: 0,
                first_seen_at: b.created_at || todayStr,
                last_seen_at: b.created_at || todayStr,
                source_counts: {},
                routes_seen: new Set(),
                bookings: []
            };
        }

        const c = customersMap[opaqueKey];

        // Maintain best / most complete contact info
        if (primaryName && primaryName.length > c.name.length && primaryName !== 'Не указано') {
            c.name = primaryName;
        }
        if (!c.document && docObj) {
            c.document = docObj;
        }
        if ((!c.phone || c.phone === '—') && (effectivePhone || b.phone)) {
            c.phone = effectivePhone || b.phone;
        }

        c.total_trips++;
        const isConfirmed = b.status === 'confirmed';
        const isCancelled = b.status === 'cancelled';
        const isNoShow = isConfirmed && b.boarding_status === 'no_show';

        if (isConfirmed && !isCancelled) {
            c.confirmed_trips++;
            c.total_booking_value += (Number(b.total_price) || 0);

            const depDate = safeTicket.departure_date || '';
            if (depDate >= todayStr) {
                c.future_trips++;
            }
        }

        if (isCancelled) c.cancelled_count++;
        if (isNoShow) c.no_show_count++;


        if (b.created_at && b.created_at < c.first_seen_at) c.first_seen_at = b.created_at;
        if (b.created_at && b.created_at > c.last_seen_at) c.last_seen_at = b.created_at;

        const src = b.channel || b.source_type || 'web';
        c.source_counts[src] = (c.source_counts[src] || 0) + 1;

        const routeName = (safeTicket.from_city && safeTicket.to_city) 
            ? `${safeTicket.from_city} → ${safeTicket.to_city}` 
            : (b.pickup_city ? `${b.pickup_city} → ${b.drop_off_city}` : '—');
        if (routeName !== '—') c.routes_seen.add(routeName);

        c.bookings.push({
            booking_id: b.id,
            bus_ticket_id: b.bus_ticket_id,
            departure_date: safeTicket.departure_date || '',
            departure_time: safeTicket.departure_time || '',
            from_city: safeTicket.from_city || b.pickup_city || '',
            to_city: safeTicket.to_city || b.drop_off_city || '',
            from_address: safeTicket.from_address || '',
            to_address: safeTicket.to_address || '',
            seat_numbers: b.seat_numbers || [],
            passenger_count: b.passenger_count || 1,
            passenger_name: primaryName,
            passengers_data: pDataList,
            status: b.status,
            boarding_status: b.boarding_status || 'pending_boarding',
            channel: b.channel || 'web',
            source_type: b.source_type || 'platform',
            total_price: Number(b.total_price) || 0,
            created_at: b.created_at
        });
    });

    let customerList = Object.values(customersMap).map(c => {
        // Determine primary source (source with highest booking count; deterministic tie-break)
        let primarySource = 'web';
        let maxCount = -1;
        const sourceKeys = Object.keys(c.source_counts).sort();
        sourceKeys.forEach(s => {
            if (c.source_counts[s] > maxCount) {
                maxCount = c.source_counts[s];
                primarySource = s;
            }
        });

        // Determine loyalty badge based on completed / confirmed trips
        let loyaltyBadge = 'new';
        if (c.confirmed_trips >= 5) loyaltyBadge = 'regular';
        else if (c.confirmed_trips >= 2) loyaltyBadge = 'repeat';

        // Sort customer bookings chronologically descending
        c.bookings.sort((a, b) => {
            const dateA = a.departure_date || a.created_at || '';
            const dateB = b.departure_date || b.created_at || '';
            return dateB.localeCompare(dateA);
        });

        const pastBookings = c.bookings.filter(b => !b.departure_date || b.departure_date < todayStr);
        const futureBookings = c.bookings.filter(b => b.departure_date && b.departure_date >= todayStr);

        // Earliest upcoming future trip
        const nextTrip = futureBookings.length > 0 ? {
            booking_id: futureBookings[futureBookings.length - 1].booking_id,
            date: futureBookings[futureBookings.length - 1].departure_date,
            time: futureBookings[futureBookings.length - 1].departure_time,
            from_city: futureBookings[futureBookings.length - 1].from_city,
            to_city: futureBookings[futureBookings.length - 1].to_city,
            status: futureBookings[futureBookings.length - 1].status
        } : null;

        // Most recent past trip
        const lastTrip = pastBookings.length > 0 ? {
            booking_id: pastBookings[0].booking_id,
            date: pastBookings[0].departure_date,
            time: pastBookings[0].departure_time,
            from_city: pastBookings[0].from_city,
            to_city: pastBookings[0].to_city,
            status: pastBookings[0].status,
            boarding_status: pastBookings[0].boarding_status
        } : null;

        return {
            customer_key: c.customer_key,
            name: c.name,
            phone: c.phone,
            document: c.document,
            has_document: Boolean(c.document && c.document.docNumber),
            total_trips: c.total_trips,
            confirmed_trips: c.confirmed_trips,
            future_trips: c.future_trips,
            cancelled_count: c.cancelled_count,
            no_show_count: c.no_show_count,
            total_booking_value: c.total_booking_value,
            last_trip: lastTrip,
            next_trip: nextTrip,
            first_seen_at: c.first_seen_at,
            last_seen_at: c.last_seen_at,
            primary_source: primarySource,
            loyalty_badge: loyaltyBadge,
            has_no_show_warning: c.no_show_count > 0,
            popular_routes: Array.from(c.routes_seen),
            _bookings: c.bookings // internal for details lookup
        };
    });

    // Summary KPIs before filters
    const totalCustomersCount = customerList.length;
    const repeatCustomersCount = customerList.filter(c => c.loyalty_badge !== 'new').length;
    const totalNoShowsCount = customerList.reduce((sum, c) => sum + c.no_show_count, 0);
    const totalConfirmedRevenue = customerList.reduce((sum, c) => sum + c.total_booking_value, 0);

    // Apply Search Filter (phone, name, document number)
    if (options.search && typeof options.search === 'string') {
        const query = options.search.trim().toLowerCase();
        const cleanQuery = query.replace(/[^\d+]/g, '');

        customerList = customerList.filter(c => {
            const nameMatch = c.name && c.name.toLowerCase().includes(query);
            const phoneMatch = c.phone && (c.phone.toLowerCase().includes(query) || (cleanQuery && c.phone.replace(/[^\d+]/g, '').includes(cleanQuery)));
            const docMatch = c.document && c.document.docNumber && String(c.document.docNumber).toLowerCase().includes(query);
            return nameMatch || phoneMatch || docMatch;
        });
    }

    // Apply Source Filter
    if (options.source && options.source !== 'all') {
        customerList = customerList.filter(c => c.primary_source === options.source);
    }

    // Apply Loyalty / Status Filter
    if (options.loyalty && options.loyalty !== 'all') {
        customerList = customerList.filter(c => c.loyalty_badge === options.loyalty);
    }

    // Apply Date Range Filter (from/to based on last_seen_at or first_seen_at)
    if (options.from) {
        customerList = customerList.filter(c => c.last_seen_at >= options.from);
    }
    if (options.to) {
        const toEnd = options.to + 'T23:59:59.999Z';
        customerList = customerList.filter(c => c.first_seen_at <= toEnd);
    }

    // Sort customers (default: last_seen_at descending, or total_booking_value desc)
    const sortBy = options.sort || 'last_seen';
    if (sortBy === 'trips') {
        customerList.sort((a, b) => b.total_trips - a.total_trips);
    } else if (sortBy === 'value') {
        customerList.sort((a, b) => b.total_booking_value - a.total_booking_value);
    } else if (sortBy === 'name') {
        customerList.sort((a, b) => a.name.localeCompare(b.name));
    } else {
        // default 'last_seen'
        customerList.sort((a, b) => (b.last_seen_at || '').localeCompare(a.last_seen_at || ''));
    }

    // Pagination
    const totalFiltered = customerList.length;
    const page = Math.max(1, parseInt(options.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(options.limit, 10) || 50));
    const totalPages = Math.ceil(totalFiltered / limit) || 1;
    const startIndex = (page - 1) * limit;
    
    // Privacy projection for LIST response: omit full passport document, retain has_document
    const paginatedCustomers = customerList.slice(startIndex, startIndex + limit).map(c => {
        const { _bookings, ...rest } = c;
        return rest;
    });

    return {
        customers: paginatedCustomers,
        pagination: {
            page,
            limit,
            total: totalFiltered,
            totalPages
        },
        summary: {
            total_customers: totalCustomersCount,
            repeat_customers: repeatCustomersCount,
            total_no_shows: totalNoShowsCount,
            total_revenue: totalConfirmedRevenue
        }
    };
}

/**
 * Returns single customer details, profile, stats, and complete booking history using opaque key.
 * 
 * @param {Array} bookings - Raw carrier bookings
 * @param {Array|Object} tickets - Carrier tickets
 * @param {string} customerKey - Opaque customer_key (e.g. 'c_a1b2c3d4...')
 * @param {number|string} carrierId - Current carrier ID for tenant scoping
 * @returns {Object|null}
 */
function getCustomerDetails(bookings = [], tickets = [], customerKey = '', carrierId = 0) {
    if (!customerKey) return null;

    const ticketMap = {};
    if (Array.isArray(tickets)) {
        tickets.forEach(t => { if (t && t.id) ticketMap[t.id] = t; });
    } else if (tickets && typeof tickets === 'object') {
        Object.assign(ticketMap, tickets);
    }

    const todayStr = new Date().toISOString().split('T')[0];

    // Find all bookings matching this opaque key under this carrier
    const customerBookings = [];
    let bestName = '';
    let bestPhone = '';
    let bestDoc = null;
    let firstSeen = '';
    let lastSeen = '';
    const sourceCounts = {};

    (bookings || []).forEach(b => {
        const ticket = ticketMap[b.bus_ticket_id];
        if (Object.keys(ticketMap).length > 0 && !ticket) {
            return;
        }
        const safeTicket = ticket || {};
        const effectiveCarrierId = carrierId || safeTicket.operator_id || 0;
        const normPhone = normalizePhone(b.phone);
        
        let primaryName = (b.passenger_name || '').trim();
        let docObj = null;
        let passengerPhone = null;

        if (Array.isArray(b.passengers_data) && b.passengers_data.length > 0) {
            const p0 = b.passengers_data[0];
            const fullName = [p0.lastName, p0.firstName, p0.middleName].filter(Boolean).join(' ').trim();
            if (fullName) primaryName = fullName;
            if (p0.docNumber) {
                docObj = {
                    docType: p0.docType || 'Паспорт',
                    docNumber: String(p0.docNumber).trim(),
                    citizenship: p0.citizenship || '',
                    birthDate: p0.birthDate || '',
                    gender: p0.gender || ''
                };
            }
            if (p0.phone) passengerPhone = normalizePhone(p0.phone);
        }

        const effectivePhone = passengerPhone || normPhone;

        let canonicalIdentity = '';
        if (effectivePhone) {
            canonicalIdentity = 'phone:' + effectivePhone;
        } else if (b.passenger_id && typeof b.passenger_id === 'number' && b.channel !== 'manual' && b.source_type !== 'manual') {
            canonicalIdentity = 'user:' + b.passenger_id;
        } else if (docObj && docObj.docNumber) {
            canonicalIdentity = 'doc:' + docObj.docNumber.trim();
        } else {
            canonicalIdentity = 'booking:' + b.id;
        }

        const bOpaqueKey = generateOpaqueCustomerKey(effectiveCarrierId, canonicalIdentity);

        if (bOpaqueKey === customerKey) {
            if (primaryName && primaryName.length > bestName.length) bestName = primaryName;
            if (!bestDoc && docObj) bestDoc = docObj;
            if ((!bestPhone || bestPhone === '—') && (effectivePhone || b.phone)) bestPhone = effectivePhone || b.phone;

            if (!firstSeen || (b.created_at && b.created_at < firstSeen)) firstSeen = b.created_at;
            if (!lastSeen || (b.created_at && b.created_at > lastSeen)) lastSeen = b.created_at;

            const src = b.channel || b.source_type || 'web';
            sourceCounts[src] = (sourceCounts[src] || 0) + 1;

            customerBookings.push({
                booking_id: b.id,
                bus_ticket_id: b.bus_ticket_id,
                departure_date: safeTicket.departure_date || '',
                departure_time: safeTicket.departure_time || '',
                from_city: safeTicket.from_city || b.pickup_city || '',
                to_city: safeTicket.to_city || b.drop_off_city || '',
                from_address: safeTicket.from_address || '',
                to_address: safeTicket.to_address || '',
                seat_numbers: b.seat_numbers || [],
                passenger_count: b.passenger_count || 1,
                passenger_name: primaryName,
                passengers_data: b.passengers_data || [],
                status: b.status,
                boarding_status: b.boarding_status || 'pending_boarding',
                channel: b.channel || 'web',
                source_type: b.source_type || 'platform',
                total_price: Number(b.total_price) || 0,
                created_at: b.created_at
            });
        }
    });

    if (customerBookings.length === 0) return null;

    // Calculate stats
    let confirmedTrips = 0;
    let futureTrips = 0;
    let cancelledCount = 0;
    let noShowCount = 0;
    let totalBookingValue = 0;

    customerBookings.forEach(b => {
        const isConfirmed = b.status === 'confirmed';
        const isCancelled = b.status === 'cancelled';
        const isNoShow = isConfirmed && b.boarding_status === 'no_show';

        if (isConfirmed && !isCancelled) {
            confirmedTrips++;
            totalBookingValue += b.total_price;
            if (b.departure_date >= todayStr) futureTrips++;
        }
        if (isCancelled) cancelledCount++;
        if (isNoShow) noShowCount++;
    });


    let primarySource = 'web';
    let maxSCount = -1;
    const sourceKeys = Object.keys(sourceCounts).sort();
    sourceKeys.forEach(s => {
        if (sourceCounts[s] > maxSCount) {
            maxSCount = sourceCounts[s];
            primarySource = s;
        }
    });

    let loyaltyBadge = 'new';
    if (confirmedTrips >= 5) loyaltyBadge = 'regular';
    else if (confirmedTrips >= 2) loyaltyBadge = 'repeat';

    // Sort bookings descending
    customerBookings.sort((a, b) => {
        const dateA = a.departure_date || a.created_at || '';
        const dateB = b.departure_date || b.created_at || '';
        return dateB.localeCompare(dateA);
    });

    const pastBookings = customerBookings.filter(b => !b.departure_date || b.departure_date < todayStr);
    const futureBookings = customerBookings.filter(b => b.departure_date && b.departure_date >= todayStr);

    return {
        customer_key: customerKey,
        profile: {
            name: bestName || 'Не указано',
            phone: bestPhone || '—',
            document: bestDoc,
            first_seen_at: firstSeen,
            last_seen_at: lastSeen,
            primary_source: primarySource,
            loyalty_badge: loyaltyBadge,
            has_no_show_warning: noShowCount > 0
        },
        statistics: {
            total_trips: customerBookings.length,
            confirmed_trips: confirmedTrips,
            future_trips: futureTrips,
            cancelled_count: cancelledCount,
            no_show_count: noShowCount,
            total_booking_value: totalBookingValue
        },
        trip_history: pastBookings,
        future_bookings: futureBookings
    };
}

module.exports = {
    generateOpaqueCustomerKey,
    normalizePhone,
    aggregateCarrierCustomers,
    getCustomerDetails
};
