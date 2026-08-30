/**
 * phoneHelper.js
 * 
 * Shared Phone Normalization and Validation Utilities
 * Project: POPUTKI.ONLINE
 */

/**
 * Normalizes a phone number into canonical international E.164 string format.
 * Strips whitespace, dashes, parentheses, dots.
 * 
 * @param {string|null|undefined} rawPhone
 * @returns {string|null} Canonical normalized string (e.g. '+992927925051') or null if empty/placeholder
 */
function normalizePhone(rawPhone) {
    if (!rawPhone) return null;
    let s = String(rawPhone).trim();
    
    // Ignore placeholder strings
    if (s === '' || s === '-' || s === '—' || s === '–' || s.toLowerCase() === 'null' || s.toLowerCase() === 'undefined') {
        return null;
    }

    // Strip common formatting punctuation
    s = s.replace(/[\s\(\)\-\.]/g, '');
    if (!s) return null;

    // Check if it contains invalid non-numeric chars (except leading +)
    if (!/^\+?\d+$/.test(s)) {
        return null;
    }

    // Standardize leading digits
    if (s.startsWith('8') && s.length === 11) {
        s = '+7' + s.substring(1);
    } else if (s.startsWith('992') && !s.startsWith('+')) {
        s = '+' + s;
    } else if (s.startsWith('7') && !s.startsWith('+')) {
        s = '+' + s;
    } else if (s.startsWith('998') && !s.startsWith('+')) {
        s = '+' + s;
    } else if (!s.startsWith('+')) {
        s = '+' + s;
    }

    // Enforce international length (minimum 8 digits, maximum 16 chars with +)
    if (s.length < 9 || s.length > 16) {
        return null;
    }

    return s;
}

/**
 * Checks if raw input is a valid phone format or valid empty.
 * 
 * @param {string|null|undefined} rawPhone
 * @param {boolean} [allowEmpty=true]
 * @returns {boolean}
 */
function isValidPhone(rawPhone, allowEmpty = true) {
    if (rawPhone === null || rawPhone === undefined || rawPhone === '') {
        return allowEmpty;
    }
    const s = String(rawPhone).trim();
    if (s === '-' || s === '—' || s === '–') {
        return allowEmpty;
    }
    const norm = normalizePhone(s);
    return norm !== null;
}

/**
 * Cleans phone for database storage.
 * Returns null if missing/placeholder, normalized phone if valid, or null if invalid.
 * 
 * @param {string|null|undefined} rawPhone
 * @returns {string|null}
 */
function cleanPhoneForStorage(rawPhone) {
    const norm = normalizePhone(rawPhone);
    return norm || null;
}

/**
 * Safely masks a phone number for logging / audit display.
 * 
 * @param {string|null|undefined} phone
 * @returns {string}
 */
function maskPhone(phone) {
    if (!phone) return 'N/A';
    const clean = String(phone).trim();
    if (clean.length < 6) return '***';
    const start = clean.slice(0, 4);
    const end = clean.slice(-3);
    const middleCount = Math.max(3, clean.length - 7);
    return start + '*'.repeat(middleCount) + end;
}

module.exports = {
    normalizePhone,
    isValidPhone,
    cleanPhoneForStorage,
    maskPhone
};
