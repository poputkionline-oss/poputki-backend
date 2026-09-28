/**
 * changedFieldsNormalization.js
 *
 * Bugfix (trip-78 / booking-487 audit): routes/busAdmin.js's PUT
 * /tickets/:id computed `changedFields` via a raw JSON.stringify(old) !==
 * JSON.stringify(new) comparison with zero normalization. That produces
 * false positives whenever the SAME value round-trips through a different
 * representation:
 *   - departure_time/arrival_time: Postgres `time` columns come back from
 *     PostgREST as "HH:MM:SS" while a partial update payload may carry
 *     "HH:MM" for the exact same instant.
 *   - nullable free-text fields (group_leader_name/phone/whatsapp,
 *     passenger_comments): null, undefined, "", and whitespace-only are
 *     all "no text entered" — not a real change.
 *
 * These helpers are pure and side-effect-free so they can be unit tested
 * directly, independent of the HTTP route that consumes them.
 */

const TIME_FIELDS = new Set(['departure_time', 'arrival_time']);
const NULLABLE_TEXT_FIELDS = new Set([
    'group_leader_name',
    'group_leader_phone',
    'group_leader_whatsapp',
    'passenger_comments'
]);

/**
 * Normalizes a time-of-day value to "HH:MM" for comparison purposes.
 * Returns null for empty/missing input, and the original string
 * (unmodified) if it doesn't look like a time at all — so a genuinely
 * malformed value still registers as different rather than being silently
 * swallowed.
 */
function normalizeTimeOfDay(value) {
    if (value === null || value === undefined) return null;
    const str = String(value).trim();
    if (str === '') return null;
    const match = str.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (!match) return str;
    const [, hh, mm] = match;
    return `${hh.padStart(2, '0')}:${mm}`;
}

/**
 * Normalizes a nullable free-text value for comparison: null, undefined,
 * "", and whitespace-only all collapse to "" (semantically empty).
 * Non-empty values are trimmed but otherwise compared as-is.
 */
function normalizeNullableText(value) {
    if (value === null || value === undefined) return '';
    return String(value).trim();
}

function normalizeFieldForComparison(key, value) {
    if (TIME_FIELDS.has(key)) return normalizeTimeOfDay(value);
    if (NULLABLE_TEXT_FIELDS.has(key)) return normalizeNullableText(value);
    return value;
}

/**
 * Computes the changed-fields diff between the existing ticket row and the
 * incoming update payload, applying field-specific normalization only
 * where it's needed (time-of-day fields, nullable text fields) and
 * leaving every other field's comparison semantics exactly as before
 * (raw JSON.stringify equality).
 *
 * @param {object} oldTicket - existing bus_tickets row
 * @param {object} updateData - allowlisted incoming update payload
 * @returns {{oldValues: object, newValues: object, changedFields: string[]}}
 */
function computeChangedFields(oldTicket, updateData) {
    const oldValues = {};
    const newValues = {};
    const changedFields = [];

    for (const [key, val] of Object.entries(updateData)) {
        const oldVal = oldTicket ? oldTicket[key] : undefined;
        const normalizedOld = normalizeFieldForComparison(key, oldVal);
        const normalizedNew = normalizeFieldForComparison(key, val);
        const isDifferent = JSON.stringify(normalizedOld) !== JSON.stringify(normalizedNew);
        if (isDifferent) {
            changedFields.push(key);
            oldValues[key] = oldVal;
            newValues[key] = val;
        }
    }

    return { oldValues, newValues, changedFields };
}

module.exports = {
    normalizeTimeOfDay,
    normalizeNullableText,
    normalizeFieldForComparison,
    computeChangedFields
};
