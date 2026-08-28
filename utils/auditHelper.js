/**
 * auditHelper.js — Unified Audit & Activity Logging for Carrier Panel
 * 
 * Guarantees:
 * - Immutable Append-Only: Log events are only inserted and queried.
 * - Strict Whitelist Sanitization: No passwords, hashes, JWTs, tokens, or PII leaks in diffs.
 * - Strict Actor Security: Actor is derived exclusively from verified JWT (carrierContext).
 * - Non-Blocking Operational Policy: Operational logging errors never crash main business flow.
 * - Tenant Isolation: carrier_id is mandatory on all log entries.
 * - Strict Action & Entity Validation: Only known taxonomies allowed.
 */

const AUDIT_ACTIONS = Object.freeze({
    // Booking Actions
    BOOKING_CREATED_MANUAL: 'booking_created_manual',
    BOOKING_UPDATED: 'booking_updated',
    BOOKING_CANCELLED: 'booking_cancelled',
    BOOKING_PAYMENT_EXPIRED: 'booking_payment_expired',
    BOARDING_STATUS_CHANGED: 'boarding_status_changed',

    // Ticket / Trip Actions
    TICKET_CREATED: 'ticket_created',
    TICKET_UPDATED: 'ticket_updated',
    TICKET_DUPLICATED: 'ticket_duplicated',
    TICKET_REVERSED: 'ticket_reversed',
    TICKET_DELETED: 'ticket_deleted',

    // Team / Member Actions
    MEMBER_ADDED: 'member_added',
    MEMBER_ROLE_CHANGED: 'member_role_changed',
    MEMBER_DEACTIVATED: 'member_deactivated',
    MEMBER_REACTIVATED: 'member_reactivated',
    DRIVER_ASSIGNMENT_CHANGED: 'driver_assignment_changed'
});

const AUDIT_ENTITY_TYPES = Object.freeze({
    BOOKING: 'booking',
    TICKET: 'ticket',
    MEMBER: 'member'
});

// Strict field whitelists for diffing (MEMBER contains ZERO PII: no phone, no name)
const WHITELIST_FIELDS = Object.freeze({
    [AUDIT_ENTITY_TYPES.BOOKING]: new Set([
        'seat_numbers', 'pickup_city', 'drop_off_city', 'status', 
        'boarding_status', 'passenger_count', 'total_price'
    ]),
    [AUDIT_ENTITY_TYPES.TICKET]: new Set([
        'from_city', 'to_city', 'from_address', 'to_address',
        'departure_date', 'departure_time', 'arrival_date', 'arrival_time',
        'price', 'premium_price', 'total_seats', 'status', 'bus_type'
    ]),
    [AUDIT_ENTITY_TYPES.MEMBER]: new Set([
        'role', 'is_active', 'assigned_ticket_ids'
    ])
});

// Forbidden field patterns (unconditional blacklist protection)
const FORBIDDEN_KEY_PATTERNS = [
    /password/i, /hash/i, /token/i, /jwt/i, /auth/i, /secret/i,
    /passengers_data/i, /docnumber/i, /card/i, /cvv/i, /key/i,
    /phone/i, /email/i, /passport/i
];

// Whitelist of allowed metadata keys
const ALLOWED_METADATA_KEYS = new Set([
    'channel', 'source', 'reason', 'seats_count', 'duration_minutes'
]);

/**
 * Checks if a property key is forbidden from ever being logged.
 */
function isForbiddenKey(key) {
    if (!key || typeof key !== 'string') return true;
    return FORBIDDEN_KEY_PATTERNS.some(p => p.test(key));
}

/**
 * Deep compares two values for diff detection.
 */
function isEqual(valA, valB) {
    if (valA === valB) return true;
    if (valA === null || valA === undefined || valB === null || valB === undefined) {
        return valA === valB;
    }
    if (typeof valA !== typeof valB) return false;

    if (Array.isArray(valA) && Array.isArray(valB)) {
        if (valA.length !== valB.length) return false;
        const sortedA = [...valA].sort();
        const sortedB = [...valB].sort();
        return JSON.stringify(sortedA) === JSON.stringify(sortedB);
    }

    if (typeof valA === 'object') {
        return JSON.stringify(valA) === JSON.stringify(valB);
    }

    return String(valA) === String(valB);
}

/**
 * Computes a sanitized, whitelist-only diff between old and new state.
 * 
 * @param {string} entityType - One of AUDIT_ENTITY_TYPES
 * @param {Object} [oldData] - Previous object state
 * @param {Object} [newData] - New object state
 * @returns {{ oldDiff: Object|null, newDiff: Object|null }}
 */
function computeSanitizedDiff(entityType, oldData, newData) {
    const allowedFields = WHITELIST_FIELDS[entityType] || new Set();
    const oldObj = (oldData && typeof oldData === 'object') ? oldData : {};
    const newObj = (newData && typeof newData === 'object') ? newData : {};

    const oldDiff = {};
    const newDiff = {};
    let hasChanges = false;

    // Collect all candidate keys from both objects
    const allKeys = new Set([...Object.keys(oldObj), ...Object.keys(newObj)]);

    for (const key of allKeys) {
        // Enforce strict whitelist and forbidden pattern check
        if (!allowedFields.has(key) || isForbiddenKey(key)) {
            continue;
        }

        const oldVal = oldObj[key];
        const newVal = newObj[key];

        if (!isEqual(oldVal, newVal)) {
            if (oldVal !== undefined) oldDiff[key] = oldVal;
            if (newVal !== undefined) newDiff[key] = newVal;
            hasChanges = true;
        }
    }

    return {
        oldDiff: hasChanges && Object.keys(oldDiff).length > 0 ? oldDiff : null,
        newDiff: hasChanges && Object.keys(newDiff).length > 0 ? newDiff : null
    };
}

/**
 * Sanitizes metadata using strict whitelist of allowed keys.
 */
function sanitizeMetadata(metadata) {
    if (!metadata || typeof metadata !== 'object') return null;
    const sanitized = {};
    for (const [k, v] of Object.entries(metadata)) {
        if (ALLOWED_METADATA_KEYS.has(k) && !isForbiddenKey(k)) {
            if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
                sanitized[k] = v;
            }
        }
    }
    return Object.keys(sanitized).length > 0 ? sanitized : null;
}

/**
 * Records a carrier panel activity event into public.carrier_activity_logs.
 * 
 * @param {Object} params
 * @param {Object} params.supabase - Supabase client instance
 * @param {Object} params.carrierContext - Authenticated req.carrier object
 * @param {string} params.action - One of AUDIT_ACTIONS
 * @param {string} params.entityType - One of AUDIT_ENTITY_TYPES
 * @param {string|number} [params.entityId] - Unique ID of the affected entity
 * @param {string} [params.entityLabel] - Human-readable identifier (e.g. "Рейс Душанбе → Худжанд #101")
 * @param {Object} [params.oldData] - Previous state before update
 * @param {Object} [params.newData] - New state after update
 * @param {Object} [params.metadata] - Extra safe contextual parameters
 * @returns {Promise<Object|null>} Inserted record or null on error
 */
async function logCarrierActivity({
    supabase,
    carrierContext,
    action,
    entityType,
    entityId,
    entityLabel,
    oldData,
    newData,
    metadata
}) {
    if (!carrierContext || (!carrierContext.carrier_id && !carrierContext.id)) {
        console.warn('[CarrierAudit Warning] Cannot log activity without valid carrierContext');
        return null;
    }

    // Action & Entity validation
    if (!Object.values(AUDIT_ACTIONS).includes(action)) {
        console.warn('[CarrierAudit Warning] Rejecting invalid action code:', action);
        return null;
    }

    if (!Object.values(AUDIT_ENTITY_TYPES).includes(entityType)) {
        console.warn('[CarrierAudit Warning] Rejecting invalid entityType:', entityType);
        return null;
    }

    const carrierId = carrierContext.carrier_id || carrierContext.id;
    const actorUserId = carrierContext.user_id || carrierContext.sub || carrierContext.id || 0;
    const actorRole = carrierContext.role || carrierContext.memberRole || 'owner';

    // Privacy-Safe Actor Name: Never fallback to phone number!
    let actorName = null;
    if (carrierContext.name && typeof carrierContext.name === 'string' && !/\d{5,}/.test(carrierContext.name)) {
        actorName = carrierContext.name.trim().substring(0, 100);
    } else {
        const roleTitles = { 
            owner: 'Владелец', 
            dispatcher: 'Диспетчер', 
            driver: 'Водитель', 
            accountant: 'Бухгалтер', 
            admin: 'Администратор' 
        };
        actorName = roleTitles[actorRole] || 'Сотрудник';
    }

    const { oldDiff, newDiff } = computeSanitizedDiff(entityType, oldData, newData);
    const cleanMeta = sanitizeMetadata(metadata);

    const logRow = {
        carrier_id: carrierId,
        actor_user_id: actorUserId,
        actor_role: actorRole,
        actor_name: actorName,
        action: action,
        entity_type: entityType,
        entity_id: entityId ? String(entityId) : null,
        entity_label: entityLabel ? String(entityLabel).substring(0, 200) : null,
        old_data: oldDiff,
        new_data: newDiff,
        metadata: cleanMeta,
        created_at: new Date().toISOString()
    };

    try {
        if (!supabase || typeof supabase.from !== 'function') {
            return logRow; // In test environment without active supabase instance
        }

        const { data, error } = await supabase
            .from('carrier_activity_logs')
            .insert([logRow])
            .select();

        if (error) {
            console.error('[CarrierAudit Error] Failed to insert activity log (carrierId: %s, action: %s):', carrierId, action, error.message);
            return null;
        }

        return data ? data[0] : logRow;
    } catch (err) {
        console.error('[CarrierAudit Error] Exception in logCarrierActivity (carrierId: %s, action: %s):', carrierId, action, err.message);
        return null; // Non-blocking: fail-safe
    }
}

module.exports = {
    AUDIT_ACTIONS,
    AUDIT_ENTITY_TYPES,
    WHITELIST_FIELDS,
    ALLOWED_METADATA_KEYS,
    computeSanitizedDiff,
    sanitizeMetadata,
    logCarrierActivity
};
