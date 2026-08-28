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
 * @returns {Promise<Object|null>} Bus object if valid and accessible, null otherwise
 */
async function verifyBusAccess(carrier, busId, { allowArchived = false } = {}) {
    if (!carrier || !busId) return null;
    const carrierId = carrier.carrier_id || carrier.id;
    if (!carrierId) return null;

    const { data: bus, error } = await supabase
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
async function checkBusScheduleConflict(supabaseClient, carrierId, busId, departureDate, departureTime, arrivalDate, arrivalTime) {
    if (!busId || !departureDate) return [];

    const { data: activeTickets, error } = await supabaseClient
        .from('bus_tickets')
        .select('id, from_city, to_city, departure_date, departure_time, arrival_date, arrival_time')
        .eq('operator_id', carrierId)
        .eq('bus_id', busId)
        .eq('status', 'active');

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
    checkBusScheduleConflict
};
