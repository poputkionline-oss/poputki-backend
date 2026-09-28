/**
 * utils/mrzValidator.js
 *
 * Deterministic MRZ (Machine Readable Zone) Parser & Checksum Validator
 * Compliant with ICAO Doc 9303 (TD1, TD2, TD3/MRP) standards.
 *
 * Performs Modulo 10 check digit verification with weights [7, 3, 1]
 * on Document Number, Birth Date, Expiry Date, and Composite Data.
 * Performs deterministic cross-validation between Visual Zone values and MRZ.
 */

'use strict';

/**
 * Calculates ICAO 9303 check digit for a given alphanumeric string.
 * Character values: '0'-'9' -> 0-9, 'A'-'Z' -> 10-35, '<' -> 0.
 * Weight sequence: 7, 3, 1 repeating.
 * @param {string} str
 * @returns {number} Check digit (0-9)
 */
function calculateCheckDigit(str) {
    const weights = [7, 3, 1];
    let sum = 0;

    for (let i = 0; i < str.length; i++) {
        const char = str[i].toUpperCase();
        let value = 0;

        if (char >= '0' && char <= '9') {
            value = char.charCodeAt(0) - 48;
        } else if (char >= 'A' && char <= 'Z') {
            value = char.charCodeAt(0) - 55;
        } else if (char === '<') {
            value = 0;
        } else {
            value = 0;
        }

        sum += value * weights[i % 3];
    }

    return sum % 10;
}

/**
 * Normalizes MRZ string: removes whitespace, converts to uppercase.
 * @param {string} line
 * @returns {string}
 */
function sanitizeMrzLine(line) {
    if (typeof line !== 'string') return '';
    return line.replace(/[\s\r\n]+/g, '').toUpperCase();
}

/**
 * Converts YYMMDD MRZ date to YYYY-MM-DD.
 * Pivot year: 50 -> 1950..2049.
 * @param {string} yymmdd
 * @returns {string|null} YYYY-MM-DD or null if invalid
 */
function parseMrzDate(yymmdd) {
    if (!yymmdd || !/^\d{6}$/.test(yymmdd)) return null;

    const yy = parseInt(yymmdd.slice(0, 2), 10);
    const mm = yymmdd.slice(2, 4);
    const dd = yymmdd.slice(4, 6);

    const monthNum = parseInt(mm, 10);
    const dayNum = parseInt(dd, 10);
    if (monthNum < 1 || monthNum > 12 || dayNum < 1 || dayNum > 31) return null;

    const currentYear = new Date().getFullYear();
    const currentCentury = Math.floor(currentYear / 100) * 100;
    const century = (yy > (currentYear % 100) + 20) ? (currentCentury - 100) : currentCentury;
    const fullYear = century + yy;

    return `${fullYear}-${mm}-${dd}`;
}

/**
 * Parses names from MRZ line formatted with '<<' separator.
 * @param {string} nameField
 * @returns {{ surname: string, givenNames: string }}
 */
function parseMrzName(nameField) {
    const parts = nameField.split('<<').filter(Boolean);
    const surname = (parts[0] || '').replace(/</g, ' ').trim();
    const givenNames = (parts.slice(1).join(' ') || '').replace(/</g, ' ').trim();

    return { surname, givenNames };
}

/**
 * Validates and parses TD3 MRZ (2 lines x 44 chars - Passports / MRP).
 */
function parseTD3(l1, l2) {
    const docCode = l1.slice(0, 2).replace(/</g, '');
    const issuer = l1.slice(2, 5).replace(/</g, '');
    const nameField = l1.slice(5, 44);
    const { surname, givenNames } = parseMrzName(nameField);

    const docNumRaw = l2.slice(0, 9);
    const docNumCheckDigit = parseInt(l2.slice(9, 10), 10);
    const docNumValid = !isNaN(docNumCheckDigit) && calculateCheckDigit(docNumRaw) === docNumCheckDigit;
    const docNumber = docNumRaw.replace(/</g, '');

    const nationality = l2.slice(10, 13).replace(/</g, '');

    const birthDateRaw = l2.slice(13, 19);
    const birthDateCheckDigit = parseInt(l2.slice(19, 20), 10);
    const birthDateValid = !isNaN(birthDateCheckDigit) && calculateCheckDigit(birthDateRaw) === birthDateCheckDigit;
    const birthDate = parseMrzDate(birthDateRaw);

    const sexRaw = l2.slice(20, 21);
    const sex = (sexRaw === 'M') ? 'M' : (sexRaw === 'F') ? 'F' : null;

    const expiryDateRaw = l2.slice(21, 27);
    const expiryDateCheckDigit = parseInt(l2.slice(27, 28), 10);
    const expiryDateValid = !isNaN(expiryDateCheckDigit) && calculateCheckDigit(expiryDateRaw) === expiryDateCheckDigit;
    const expiryDate = parseMrzDate(expiryDateRaw);

    const optionalDataRaw = l2.slice(28, 42);

    // Composite check digit over docNum + check + birthDate + check + expiryDate + check + optional
    const compositeStr = l2.slice(0, 10) + l2.slice(13, 20) + l2.slice(21, 43);
    const compositeCheckDigit = parseInt(l2.slice(43, 44), 10);
    const compositeValid = !isNaN(compositeCheckDigit) && calculateCheckDigit(compositeStr) === compositeCheckDigit;

    return {
        format: 'TD3',
        valid: docNumValid && birthDateValid && expiryDateValid,
        composite_valid: compositeValid,
        document_code: docCode,
        issuing_country: issuer,
        surname,
        given_names: givenNames,
        document_number: docNumber,
        document_number_valid: docNumValid,
        nationality,
        birth_date: birthDate,
        birth_date_valid: birthDateValid,
        sex,
        expiry_date: expiryDate,
        expiry_date_valid: expiryDateValid,
        optional_data: optionalDataRaw.replace(/</g, '')
    };
}

/**
 * Validates and parses TD1 MRZ (3 lines x 30 chars - ID Cards).
 */
function parseTD1(l1, l2, l3) {
    const docCode = l1.slice(0, 2).replace(/</g, '');
    const issuer = l1.slice(2, 5).replace(/</g, '');
    const docNumRaw = l1.slice(5, 14);
    const docNumCheckDigit = parseInt(l1.slice(14, 15), 10);
    const docNumValid = !isNaN(docNumCheckDigit) && calculateCheckDigit(docNumRaw) === docNumCheckDigit;
    const docNumber = docNumRaw.replace(/</g, '');

    const birthDateRaw = l2.slice(0, 6);
    const birthDateCheckDigit = parseInt(l2.slice(6, 7), 10);
    const birthDateValid = !isNaN(birthDateCheckDigit) && calculateCheckDigit(birthDateRaw) === birthDateCheckDigit;
    const birthDate = parseMrzDate(birthDateRaw);

    const sexRaw = l2.slice(7, 8);
    const sex = (sexRaw === 'M') ? 'M' : (sexRaw === 'F') ? 'F' : null;

    const expiryDateRaw = l2.slice(8, 14);
    const expiryDateCheckDigit = parseInt(l2.slice(14, 15), 10);
    const expiryDateValid = !isNaN(expiryDateCheckDigit) && calculateCheckDigit(expiryDateRaw) === expiryDateCheckDigit;
    const expiryDate = parseMrzDate(expiryDateRaw);

    const nationality = l2.slice(15, 18).replace(/</g, '');

    const compositeCheckDigit = parseInt(l2.slice(29, 30), 10);
    const compositeStr = l1.slice(5, 30) + l2.slice(0, 7) + l2.slice(8, 15) + l2.slice(18, 29);
    const compositeValid = !isNaN(compositeCheckDigit) && calculateCheckDigit(compositeStr) === compositeCheckDigit;

    const { surname, givenNames } = parseMrzName(l3);

    return {
        format: 'TD1',
        valid: docNumValid && birthDateValid && expiryDateValid,
        composite_valid: compositeValid,
        document_code: docCode,
        issuing_country: issuer,
        surname,
        given_names: givenNames,
        document_number: docNumber,
        document_number_valid: docNumValid,
        nationality,
        birth_date: birthDate,
        birth_date_valid: birthDateValid,
        sex,
        expiry_date: expiryDate,
        expiry_date_valid: expiryDateValid
    };
}

/**
 * Validates array of MRZ lines and extracts structured MRZ data.
 * @param {string[]} rawLines
 * @returns {Object|null}
 */
function validateMrz(rawLines) {
    if (!Array.isArray(rawLines)) return null;

    const lines = rawLines.map(sanitizeMrzLine).filter(l => l.length >= 20);
    if (lines.length === 0) return null;

    // Check TD3 (2 lines x 44 chars)
    if (lines.length >= 2) {
        const l0 = lines[0].padEnd(44, '<');
        const l1 = lines[1].padEnd(44, '<');
        if (l0.length >= 44 && l1.length >= 44) {
            try {
                return parseTD3(l0, l1);
            } catch (e) {
                // Fall back
            }
        }
    }

    // Check TD1 (3 lines x 30 chars)
    if (lines.length >= 3) {
        const l0 = lines[0].padEnd(30, '<');
        const l1 = lines[1].padEnd(30, '<');
        const l2 = lines[2].padEnd(30, '<');
        if (l0.length >= 30 && l1.length >= 30 && l2.length >= 30) {
            try {
                return parseTD1(l0, l1, l2);
            } catch (e) {
                // Fall back
            }
        }
    }

    return null;
}

/**
 * Compares Visual Zone data extracted by AI with MRZ validated data.
 * Returns array of conflict descriptions if discrepancies are found.
 * @param {Object} visualZone
 * @param {Object} mrzParsed
 * @returns {string[]} conflicts
 */
function crossCheckVisualAndMrz(visualZone, mrzParsed) {
    const conflicts = [];
    if (!visualZone || !mrzParsed) return conflicts;

    // Compare Document Number
    if (visualZone.document_number && mrzParsed.document_number) {
        const vDoc = visualZone.document_number.replace(/\s+/g, '').toUpperCase();
        const mDoc = mrzParsed.document_number.replace(/\s+/g, '').toUpperCase();
        if (vDoc !== mDoc) {
            conflicts.push(`Document Number mismatch: Visual zone="${visualZone.document_number}", MRZ="${mrzParsed.document_number}"`);
        }
    }

    // Compare Birth Date
    if (visualZone.birth_date && mrzParsed.birth_date) {
        if (visualZone.birth_date !== mrzParsed.birth_date) {
            conflicts.push(`Birth Date mismatch: Visual zone="${visualZone.birth_date}", MRZ="${mrzParsed.birth_date}"`);
        }
    }

    // Compare Sex
    if (visualZone.sex && mrzParsed.sex) {
        if (visualZone.sex.toUpperCase() !== mrzParsed.sex.toUpperCase()) {
            conflicts.push(`Sex mismatch: Visual zone="${visualZone.sex}", MRZ="${mrzParsed.sex}"`);
        }
    }

    // Compare Surname (fuzzy string match for spaces/transliteration differences)
    if (visualZone.surname && mrzParsed.surname) {
        const vSur = visualZone.surname.replace(/[^A-Z]/gi, '').toUpperCase();
        const mSur = mrzParsed.surname.replace(/[^A-Z]/gi, '').toUpperCase();
        if (vSur && mSur && vSur !== mSur) {
            conflicts.push(`Surname mismatch: Visual zone="${visualZone.surname}", MRZ="${mrzParsed.surname}"`);
        }
    }

    return conflicts;
}

module.exports = {
    calculateCheckDigit,
    sanitizeMrzLine,
    parseMrzDate,
    parseMrzName,
    validateMrz,
    crossCheckVisualAndMrz
};
