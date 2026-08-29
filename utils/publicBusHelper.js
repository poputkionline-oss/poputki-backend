/**
 * Public Bus Projection Helper for Passenger APIs.
 * 
 * Strict Security & Privacy Guarantees:
 * - NEVER exposes sensitive internal carrier data: VIN, private notes, carrier_id,
 *   internal fleet name, audit records, or created_at/updated_at timestamps.
 * - Enforces immutable TRIP SNAPSHOT for capacity, floor distribution, and photos.
 * - Extracts only passenger-safe vehicle descriptors from master record (brand, model, license_plate, amenities, year_built, color).
 * - Graceful fail-closed: returns null if ticket or busMaster is absent, preventing API 500 errors.
 */

const AMENITY_LABELS = {
    wifi: 'Wi-Fi',
    ac: 'Кондиционер',
    usb: 'USB',
    power_220v: 'Розетки 220V',
    wc: 'Туалет',
    tv: 'Телевизор',
    kitchen: 'Мини-кухня',
    blanket: 'Одеяла',
    reclining_seats: 'Откидные кресла',
    luggage: 'Багажное отделение'
};

const ALLOWED_AMENITIES = new Set(Object.keys(AMENITY_LABELS));

/**
 * Builds a sanitized, passenger-safe projection of bus information.
 * 
 * @param {Object} ticket - Row from bus_tickets table (immutable snapshot)
 * @param {Object|null} busMaster - Row from carrier_buses table (master record)
 * @returns {Object|null} Passenger-safe bus projection or null
 */
function buildPublicBusDetails(ticket, busMaster) {
    if (!ticket || !busMaster) return null;

    // Filter master amenities against allow-list
    const rawAmenities = Array.isArray(busMaster.amenities) ? busMaster.amenities : [];
    const validAmenities = rawAmenities.filter(a => typeof a === 'string' && ALLOWED_AMENITIES.has(a));

    // Normalize snapshot photos
    let snapshotPhotos = [];
    if (Array.isArray(ticket.photos)) {
        snapshotPhotos = ticket.photos.filter(p => p && typeof p === 'object' && p.url);
    }

    return {
        id: busMaster.id,
        brand: busMaster.brand || null,
        model: busMaster.model || null,
        license_plate: busMaster.license_plate || null,
        bus_type: ticket.bus_type || 'single',
        total_seats: Number(ticket.total_seats) || 53,
        floor1_seats: ticket.bus_type === 'double' ? (Number(ticket.floor1_seats) || null) : null,
        floor2_seats: ticket.bus_type === 'double' ? (Number(ticket.floor2_seats) || null) : null,
        photos: snapshotPhotos,
        amenities: validAmenities,
        year_built: busMaster.year_built ? Number(busMaster.year_built) : null,
        color: busMaster.color || null
    };
}

module.exports = {
    AMENITY_LABELS,
    ALLOWED_AMENITIES,
    buildPublicBusDetails
};
