/**
 * busHelper.js — Domain logic, validation, amenities and helpers for Carrier Fleet
 */

const supabase = require('../db');

const CANONICAL_AMENITIES = Object.freeze([
    'wifi',
    'ac',
    'usb',
    'power_220v',
    'wc',
    'tv',
    'kitchen',
    'blanket',
    'reclining_seats',
    'luggage'
]);

const VALID_BUS_TYPES = Object.freeze(['single', 'double']);
const VALID_BUS_STATUSES = Object.freeze(['active', 'maintenance', 'inactive', 'archived']);

/**
 * Normalizes a license plate for uniqueness checks
 * e.g. "01 777 TJ 01" -> "01777TJ01"
 */
function normalizePlate(plate) {
    if (!plate || typeof plate !== 'string') return '';
    return plate.toUpperCase().replace(/\s+/g, '').trim();
}

/**
 * Sanitizes and filters amenities array against canonical allow-list
 */
function sanitizeAmenities(amenities) {
    if (!Array.isArray(amenities)) return [];
    const set = new Set();
    amenities.forEach(item => {
        if (typeof item === 'string') {
            const clean = item.trim().toLowerCase();
            if (CANONICAL_AMENITIES.includes(clean)) {
                set.add(clean);
            }
        }
    });
    return Array.from(set);
}

/**
 * Sanitizes and validates photos array
 */
function sanitizePhotos(photos) {
    if (!Array.isArray(photos)) return [];
    if (photos.length > 20) {
        throw new Error('Количество фотографий не может превышать 20');
    }
    const clean = [];
    for (const p of photos) {
        if (!p || typeof p !== 'object') continue;
        if (!p.url || typeof p.url !== 'string' || !p.public_id || typeof p.public_id !== 'string') {
            throw new Error('Некорректный объект фотографии: url и public_id обязательны');
        }
        clean.push({
            url: p.url.trim(),
            public_id: p.public_id.trim(),
            is_main: Boolean(p.is_main)
        });
    }
    return clean;
}

/**
 * Validates bus payload for insert or update
 * @param {Object} data
 * @param {Object} options
 * @param {boolean} options.isUpdate
 * @returns {{ valid: boolean, error?: string, sanitizedData?: Object }}
 */
function validateBusPayload(data, { isUpdate = false } = {}) {
    if (!data || typeof data !== 'object') {
        return { valid: false, error: 'Тело запроса должно быть объектом' };
    }

    const {
        name,
        brand,
        model,
        license_plate,
        vin,
        year_built,
        color,
        bus_type,
        total_seats,
        floor1_seats,
        floor2_seats,
        photos,
        amenities,
        status,
        notes
    } = data;

    // Required fields on creation
    if (!isUpdate) {
        if (!name || typeof name !== 'string' || !name.trim()) {
            return { valid: false, error: 'Название автобуса обязательно' };
        }
        if (!brand || typeof brand !== 'string' || !brand.trim()) {
            return { valid: false, error: 'Марка автобуса обязательна' };
        }
        if (!model || typeof model !== 'string' || !model.trim()) {
            return { valid: false, error: 'Модель автобуса обязательна' };
        }
        if (!license_plate || typeof license_plate !== 'string' || !license_plate.trim()) {
            return { valid: false, error: 'Госномер обязателен' };
        }
        if (!bus_type || !VALID_BUS_TYPES.includes(bus_type)) {
            return { valid: false, error: 'Недопустимый тип автобуса. Допустимы: single, double' };
        }
        if (total_seats === undefined || total_seats === null || isNaN(Number(total_seats)) || Number(total_seats) <= 0) {
            return { valid: false, error: 'Количество мест должно быть положительным числом' };
        }
    }

    // Validation when field is present
    if (name !== undefined && (typeof name !== 'string' || !name.trim() || name.trim().length > 100)) {
        return { valid: false, error: 'Название автобуса должно быть от 1 до 100 символов' };
    }

    if (brand !== undefined && (typeof brand !== 'string' || !brand.trim() || brand.trim().length > 50)) {
        return { valid: false, error: 'Марка автобуса должна быть от 1 до 50 символов' };
    }

    if (model !== undefined && (typeof model !== 'string' || !model.trim() || model.trim().length > 80)) {
        return { valid: false, error: 'Модель автобуса должна быть от 1 до 80 символов' };
    }

    if (license_plate !== undefined && (typeof license_plate !== 'string' || !license_plate.trim() || license_plate.trim().length > 30)) {
        return { valid: false, error: 'Госномер должен быть от 1 до 30 символов' };
    }

    if (bus_type !== undefined && !VALID_BUS_TYPES.includes(bus_type)) {
        return { valid: false, error: 'Недопустимый тип автобуса. Допустимы: single, double' };
    }

    if (status !== undefined && !VALID_BUS_STATUSES.includes(status)) {
        return { valid: false, error: 'Недопустимый статус автобуса. Допустимы: active, maintenance, inactive, archived' };
    }

    if (year_built !== undefined && year_built !== null && year_built !== '') {
        const y = Number(year_built);
        if (isNaN(y) || y < 1950 || y > 2100) {
            return { valid: false, error: 'Год выпуска должен быть между 1950 и 2100' };
        }
    }

    const type = bus_type !== undefined ? bus_type : (data.bus_type || 'single');
    const totSeats = total_seats !== undefined ? Number(total_seats) : undefined;
    const f1 = (floor1_seats !== undefined && floor1_seats !== null && floor1_seats !== '') ? Number(floor1_seats) : null;
    const f2 = (floor2_seats !== undefined && floor2_seats !== null && floor2_seats !== '') ? Number(floor2_seats) : null;

    if (totSeats !== undefined && (isNaN(totSeats) || totSeats <= 0 || totSeats > 150)) {
        return { valid: false, error: 'Количество мест должно быть положительным числом (до 150)' };
    }

    if (type === 'double') {
        if (!isUpdate || (floor1_seats !== undefined && floor2_seats !== undefined)) {
            if (!f1 || f1 <= 0 || !f2 || f2 <= 0) {
                return { valid: false, error: 'Для двухэтажного автобуса необходимо указать места 1-го и 2-го этажей' };
            }
            if (totSeats !== undefined && (f1 + f2 !== totSeats)) {
                return { valid: false, error: `Сумма мест 1-го и 2-го этажей (${f1} + ${f2} = ${f1 + f2}) должна быть равна общему количеству мест (${totSeats})` };
            }
        }
    }

    let sanitizedPhotos = [];
    try {
        if (photos !== undefined) {
            sanitizedPhotos = sanitizePhotos(photos);
        }
    } catch (e) {
        return { valid: false, error: e.message };
    }

    const sanitizedData = {};
    if (name !== undefined) sanitizedData.name = name.trim();
    if (brand !== undefined) sanitizedData.brand = brand.trim();
    if (model !== undefined) sanitizedData.model = model.trim();
    if (license_plate !== undefined) sanitizedData.license_plate = license_plate.trim();
    if (vin !== undefined) sanitizedData.vin = vin ? String(vin).trim().substring(0, 50) : null;
    if (year_built !== undefined) sanitizedData.year_built = (year_built !== null && year_built !== '') ? Number(year_built) : null;
    if (color !== undefined) sanitizedData.color = color ? String(color).trim().substring(0, 30) : null;
    if (bus_type !== undefined) sanitizedData.bus_type = bus_type;
    if (total_seats !== undefined) sanitizedData.total_seats = Number(total_seats);
    if (bus_type === 'single') {
        sanitizedData.floor1_seats = null;
        sanitizedData.floor2_seats = null;
    } else if (bus_type === 'double') {
        if (floor1_seats !== undefined) sanitizedData.floor1_seats = f1;
        if (floor2_seats !== undefined) sanitizedData.floor2_seats = f2;
    }
    if (photos !== undefined) sanitizedData.photos = sanitizedPhotos;
    if (amenities !== undefined) sanitizedData.amenities = sanitizeAmenities(amenities);
    if (status !== undefined) sanitizedData.status = status;
    if (notes !== undefined) sanitizedData.notes = notes ? String(notes).trim().substring(0, 1000) : null;

    return { valid: true, sanitizedData };
}

/**
 * Checks if a non-archived bus with the same normalized license plate already exists for this carrier
 */
async function checkDuplicatePlate(supabaseClient, carrierId, licensePlate, excludeBusId = null) {
    if (!licensePlate) return false;
    const normalized = normalizePlate(licensePlate);
    if (!normalized) return false;

    let query = supabaseClient
        .from('carrier_buses')
        .select('id, license_plate, status')
        .eq('carrier_id', carrierId)
        .neq('status', 'archived');

    if (excludeBusId) {
        query = query.neq('id', excludeBusId);
    }

    const { data: existingBuses, error } = await query;
    if (error || !existingBuses) return false;

    return existingBuses.some(b => normalizePlate(b.license_plate) === normalized);
}

/**
 * Verify carrier ownership and availability of a bus
 * @param {Object} carrier - req.carrier
 * @param {number|string} busId - Bus ID
 * @param {Object} options
 * @param {boolean} [options.allowArchived=false]
/**
 * Verifies carrier ownership and active status of a bus
 * @param {Object|number|string} carrier
 * @param {number|string} busId
 * @param {Object} options
 * @param {boolean} options.allowArchived
 * @param {Object} options.client
 * @returns {Promise<Object|null>} Bus object if valid and accessible, null otherwise
 */
async function verifyBusAccess(carrier, busId, { allowArchived = false, client = null } = {}) {
    if (!carrier || !busId) return null;
    const carrierId = typeof carrier === 'number' || typeof carrier === 'string'
        ? carrier
        : (carrier.carrier_id || carrier.id);
    if (!carrierId) return null;

    const db = client || supabase;
    const { data: bus, error } = await db
        .from('carrier_buses')
        .select('*')
        .eq('id', busId)
        .maybeSingle();

    if (error || !bus) return null;

    // Tenant Isolation
    if (parseInt(bus.carrier_id, 10) !== parseInt(carrierId, 10)) {
        return null;
    }

    // Archived Check
    if (!allowArchived && bus.status === 'archived') {
        return null;
    }

    return bus;
}

/**
 * Checks if a bus has active/future tickets (used for warning before archive)
 */
async function getBusActiveTickets(supabaseClient, carrierId, busId) {
    if (!busId) return [];
    const now = new Date();
    const currentDate = now.toISOString().split('T')[0];

    const { data: tickets, error } = await supabaseClient
        .from('bus_tickets')
        .select('id, from_city, to_city, departure_date, departure_time, status')
        .eq('operator_id', carrierId)
        .eq('bus_id', busId)
        .eq('status', 'active')
        .gte('departure_date', currentDate);

    if (error || !tickets) return [];
    return tickets;
}

/**
 * Detects schedule conflicts for a bus on given dates and times
 * Non-blocking check: returns list of conflicting active tickets without passenger PII
 */
async function checkBusScheduleConflict(supabaseClient, carrierId, busId, departureDate, departureTime, arrivalDate, arrivalTime, excludeTicketId = null) {
    if (!busId || !departureDate) return [];

    let query = supabaseClient
        .from('bus_tickets')
        .select('id, from_city, to_city, departure_date, departure_time, arrival_date, arrival_time')
        .eq('operator_id', carrierId)
        .eq('bus_id', busId)
        .eq('status', 'active');

    if (excludeTicketId) {
        query = query.neq('id', excludeTicketId);
    }

    const { data: activeTickets, error } = await query;

    if (error || !activeTickets || activeTickets.length === 0) return [];

    const proposedStart = new Date(`${departureDate}T${departureTime || '00:00:00'}`).getTime();
    const arrDate = arrivalDate || departureDate;
    const arrTime = arrivalTime || departureTime || '23:59:59';
    const proposedEnd = new Date(`${arrDate}T${arrTime}`).getTime();

    if (isNaN(proposedStart) || isNaN(proposedEnd)) return [];

    const conflicts = [];
    for (const t of activeTickets) {
        if (!t.departure_date) continue;
        const existStart = new Date(`${t.departure_date}T${t.departure_time || '00:00:00'}`).getTime();
        const existArrDate = t.arrival_date || t.departure_date;
        const existArrTime = t.arrival_time || t.departure_time || '23:59:59';
        const existEnd = new Date(`${existArrDate}T${existArrTime}`).getTime();

        if (isNaN(existStart) || isNaN(existEnd)) continue;

        // Interval overlap: ProposedStart < ExistEnd AND ProposedEnd > ExistStart
        if (proposedStart < existEnd && proposedEnd > existStart) {
            conflicts.push({
                ticket_id: t.id,
                from_city: t.from_city,
                to_city: t.to_city,
                departure_date: t.departure_date,
                departure_time: t.departure_time,
                arrival_date: t.arrival_date,
                arrival_time: t.arrival_time
            });
        }
    }

    return conflicts;
}

/**
 * Calculates floor number (1, 2, or null) for a given seat number
 * Canonical layout:
 * - Single deck: Floor 1 (seats 1..total_seats)
 * - Double deck: Floor 2 (seats 1..floor2_seats), Floor 1 (seats floor2_seats + 1..floor2_seats + floor1_seats)
 */
function getSeatFloor(seatNumber, busType, floor1Seats, floor2Seats, totalSeats) {
    const seat = Number(seatNumber);
    if (isNaN(seat) || seat <= 0) return null;

    if (busType === 'double') {
        const f2 = Number(floor2Seats) || 0;
        const f1 = Number(floor1Seats) || 0;
        if (seat <= f2) {
            return 2;
        } else if (seat <= f2 + f1) {
            return 1;
        }
        return null;
    }

    // Single deck
    const max = Number(totalSeats) || 0;
    if (seat <= max) {
        return 1;
    }
    return null;
}

/**
 * Validates bus replacement on an existing trip.
 * Enforces:
 * - Tenant isolation
 * - Bus active status
 * - Existing bookings protection (confirmed + non-expired pending_payment)
 * - Reserved seats bounds against new bus capacity
 * - Schedule conflict detection with self-trip exclusion
 * - Re-snapshots vehicle capacity and media from master
 *
 * @param {Object} supabaseClient
 * @param {Object} carrierContext
 * @param {number|string} ticketId
 * @param {number|string|null} newBusId
 * @param {Object} options
 * @param {boolean} options.allowConflict
 * @returns {Promise<{ valid: boolean, status?: number, error?: string, message?: string, conflicts?: Array, snapshot?: Object, oldTicket?: Object, newBus?: Object, reservedSeatCount?: number, incompatibleSeats?: Array, noOp?: boolean }>}
 */
async function validateBusReplacement(supabaseClient, carrierContext, ticketId, newBusId, { allowConflict = false } = {}) {
    if (!ticketId) {
        return { valid: false, status: 400, error: 'TICKET_ID_REQUIRED', message: 'ID рейса обязателен' };
    }

    const carrierId = carrierContext.carrier_id;

    // 1. Fetch current ticket
    const { data: oldTicket, error: tErr } = await supabaseClient
        .from('bus_tickets')
        .select('*')
        .eq('id', ticketId)
        .maybeSingle();

    if (tErr || !oldTicket) {
        return { valid: false, status: 404, error: 'TICKET_NOT_FOUND', message: 'Рейс не найден' };
    }

    if (parseInt(oldTicket.operator_id, 10) !== parseInt(carrierId, 10)) {
        return { valid: false, status: 403, error: 'ACCESS_DENIED', message: 'Рейс не принадлежит вашему аккаунту перевозчика' };
    }

    // 2. Unassign policy: if oldTicket already has bus_id, unassign to null is forbidden
    if (oldTicket.bus_id && (newBusId === null || newBusId === undefined || newBusId === '')) {
        return { valid: false, status: 400, error: 'BUS_UNASSIGN_FORBIDDEN', message: 'Отвязка назначенного автобуса от рейса запрещена' };
    }

    // If newBusId is null/empty and oldTicket had no bus_id, no replacement needed
    if (!newBusId) {
        return { valid: true, noOp: true, oldTicket };
    }

    // If newBusId equals current oldTicket.bus_id, no replacement needed
    if (oldTicket.bus_id && parseInt(oldTicket.bus_id, 10) === parseInt(newBusId, 10)) {
        return { valid: true, noOp: true, oldTicket };
    }

    // 3. Verify new bus ownership & existence
    const newBus = await verifyBusAccess(carrierContext, newBusId, { client: supabaseClient });
    if (!newBus) {
        return { valid: false, status: 403, error: 'BUS_NOT_FOUND', message: 'Выбранный автобус не найден или не принадлежит вашей компании' };
    }

    if (newBus.status !== 'active') {
        return {
            valid: false,
            status: 409,
            error: 'BUS_NOT_AVAILABLE',
            message: `Автобус недоступен для назначения (текущий статус: ${newBus.status})`
        };
    }

    if (!newBus.total_seats || Number(newBus.total_seats) <= 0) {
        return { valid: false, status: 400, error: 'INVALID_BUS_CAPACITY', message: 'У выбранного автобуса некорректная вместимость' };
    }

    // 4. Check active bookings: replacement is only allowed if activeBookingCount === 0
    const { data: bookings, error: bErr } = await supabaseClient
        .from('bus_ticket_bookings')
        .select('seat_numbers, status, created_at, hold_expires_at')
        .eq('bus_ticket_id', ticketId);

    if (bErr) throw bErr;

    const now = new Date();
    let activeBookingCount = 0;
    for (const b of (bookings || [])) {
        if (b.status === 'confirmed') {
            activeBookingCount++;
        } else if (b.status === 'pending_payment') {
            const expiresAt = b.hold_expires_at ? new Date(b.hold_expires_at) : new Date(new Date(b.created_at).getTime() + 30 * 60 * 1000);
            if (expiresAt > now) {
                activeBookingCount++;
            }
        }
    }

    if (activeBookingCount > 0) {
        return {
            valid: false,
            status: 409,
            error: 'BUS_REPLACEMENT_HAS_BOOKINGS',
            message: 'Автобус нельзя заменить, пока на рейсе есть активные бронирования.',
            activeBookingCount
        };
    }

    // 5. Check schedule conflict on other active trips of this bus (excluding current ticketId)
    const conflicts = await checkBusScheduleConflict(
        supabaseClient,
        carrierId,
        newBus.id,
        oldTicket.departure_date,
        oldTicket.departure_time,
        oldTicket.arrival_date,
        oldTicket.arrival_time,
        ticketId
    );

    if (conflicts.length > 0 && !allowConflict) {
        return {
            valid: false,
            status: 409,
            error: 'BUS_SCHEDULE_CONFLICT',
            message: 'Обнаружен конфликт расписания для выбранного автобуса',
            conflicts
        };
    }

    // 6. Build fresh snapshot from master bus
    const snapshot = {
        bus_id: newBus.id,
        bus_type: newBus.bus_type || 'single',
        total_seats: Number(newBus.total_seats),
        floor1_seats: newBus.bus_type === 'double' ? Number(newBus.floor1_seats) : null,
        floor2_seats: newBus.bus_type === 'double' ? Number(newBus.floor2_seats) : null,
        photos: sanitizePhotos(newBus.photos || [])
    };

    return {
        valid: true,
        snapshot,
        oldTicket,
        newBus,
        activeBookingCount: 0
    };
}

module.exports = {
    CANONICAL_AMENITIES,
    VALID_BUS_TYPES,
    VALID_BUS_STATUSES,
    normalizePlate,
    sanitizeAmenities,
    sanitizePhotos,
    validateBusPayload,
    checkDuplicatePlate,
    verifyBusAccess,
    getBusActiveTickets,
    checkBusScheduleConflict,
    validateBusReplacement,
    getSeatFloor
};
