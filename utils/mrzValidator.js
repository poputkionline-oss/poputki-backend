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

const {
    normalizeDate,
    normalizeSex,
    normalizeDocumentNumber,
    normalizeCountry,
    compareSurnames
} = require('./passportNormalizer');

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
 * Converts YYMMDD MRZ date to YYYY-MM-DD using canonical normalizer.
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

    return normalizeDate(`${fullYear}-${mm}-${dd}`);
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
    const docNumber = normalizeDocumentNumber(docNumRaw);

    const nationality = normalizeCountry(l2.slice(10, 13).replace(/</g, ''));

    const birthDateRaw = l2.slice(13, 19);
    const birthDateCheckDigit = parseInt(l2.slice(19, 20), 10);
    const birthDateValid = !isNaN(birthDateCheckDigit) && calculateCheckDigit(birthDateRaw) === birthDateCheckDigit;
    const birthDate = parseMrzDate(birthDateRaw);

    const sexRaw = l2.slice(20, 21);
    const sex = normalizeSex(sexRaw);

    const expiryDateRaw = l2.slice(21, 27);
    const expiryDateCheckDigit = parseInt(l2.slice(27, 28), 10);
    const expiryDateValid = !isNaN(expiryDateCheckDigit) && calculateCheckDigit(expiryDateRaw) === expiryDateCheckDigit;
    const expiryDate = parseMrzDate(expiryDateRaw);

    const optionalDataRaw = l2.slice(28, 42);

    // Composite check digit over positions 0..9 + 13..20 + 21..43
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
    const docNumber = normalizeDocumentNumber(docNumRaw);

    const birthDateRaw = l2.slice(0, 6);
    const birthDateCheckDigit = parseInt(l2.slice(6, 7), 10);
    const birthDateValid = !isNaN(birthDateCheckDigit) && calculateCheckDigit(birthDateRaw) === birthDateCheckDigit;
    const birthDate = parseMrzDate(birthDateRaw);

    const sexRaw = l2.slice(7, 8);
    const sex = normalizeSex(sexRaw);

    const expiryDateRaw = l2.slice(8, 14);
    const expiryDateCheckDigit = parseInt(l2.slice(14, 15), 10);
    const expiryDateValid = !isNaN(expiryDateCheckDigit) && calculateCheckDigit(expiryDateRaw) === expiryDateCheckDigit;
    const expiryDate = parseMrzDate(expiryDateRaw);

    const nationality = normalizeCountry(l2.slice(15, 18).replace(/</g, ''));

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
 * Does NOT artificially pad truncated lines into valid-looking MRZ.
 * @param {string[]} rawLines
 * @returns {Object|null}
 */
function validateMrz(rawLines) {
    if (!Array.isArray(rawLines)) return null;

    const lines = rawLines.map(sanitizeMrzLine).filter(l => l.length > 0);
    if (lines.length === 0) return null;

    // 1. Check TD1 if 3 lines available (~30 chars each)
    if (lines.length >= 3) {
        const l0 = lines[0];
        const l1 = lines[1];
        const l2 = lines[2];

        if (l0.length >= 28 && l0.length <= 32 &&
            l1.length >= 28 && l1.length <= 32 &&
            l2.length >= 28 && l2.length <= 32) {
            const p0 = l0.padEnd(30, '<');
            const p1 = l1.padEnd(30, '<');
            const p2 = l2.padEnd(30, '<');
            try {
                const td1 = parseTD1(p0, p1, p2);
                if (td1 && td1.valid) {
                    td1.status = 'MRZ_VALID';
                    td1.error_class = null;
                    return td1;
                }
            } catch (e) {}
        }
    }

    // 2. Check TD3 on any contiguous 2-line pair (~44 chars each)
    if (lines.length >= 2) {
        for (let i = 0; i <= lines.length - 2; i++) {
            const l0 = lines[i];
            const l1 = lines[i + 1];

            if (l0.length >= 40 && l1.length >= 40) {
                const p0 = l0.padEnd(44, '<');
                const p1 = l1.padEnd(44, '<');
                try {
                    const td3 = parseTD3(p0, p1);
                    if (td3 && td3.valid) {
                        td3.status = 'MRZ_VALID';
                        td3.error_class = null;
                        return td3;
                    }
                } catch (e) {}
            }
        }
    }

    // 3. Fallback: if no candidate passed checksum, evaluate primary format for status reporting
    if (lines.length >= 3 && lines[0].length <= 34) {
        const l0 = lines[0];
        const l1 = lines[1];
        const l2 = lines[2];
        if (l0.length < 28 || l1.length < 28 || l2.length < 28) {
            return {
                format: 'TD1',
                valid: false,
                status: 'MRZ_INCOMPLETE',
                error_class: 'MRZ_LINE_LENGTH_ERROR',
                message: 'Машиночитаемая строка (MRZ) неполная или обрезана'
            };
        }
        try {
            const td1 = parseTD1(l0.padEnd(30, '<'), l1.padEnd(30, '<'), l2.padEnd(30, '<'));
            td1.status = 'MRZ_CHECKSUM_FAILED';
            td1.error_class = 'CHECKSUM_IMPLEMENTATION_ERROR';
            return td1;
        } catch (e) {}
    }

    if (lines.length >= 2) {
        const l0 = lines[0];
        const l1 = lines[1];
        if (l0.length < 40 || l1.length < 40) {
            return {
                format: 'TD3',
                valid: false,
                status: 'MRZ_INCOMPLETE',
                error_class: 'MRZ_LINE_LENGTH_ERROR',
                message: 'Машиночитаемая строка (MRZ) неполная или обрезана'
            };
        }
        try {
            const td3 = parseTD3(l0.padEnd(44, '<'), l1.padEnd(44, '<'));
            td3.status = 'MRZ_CHECKSUM_FAILED';
            td3.error_class = 'CHECKSUM_IMPLEMENTATION_ERROR';
            return td3;
        } catch (e) {}
    }

    return {
        format: 'UNKNOWN',
        valid: false,
        status: 'MRZ_FORMAT_DETECTION_ERROR',
        error_class: 'MRZ_FORMAT_DETECTION_ERROR',
        message: 'Неизвестный формат или длина строк MRZ'
    };
}

/**
 * Compares Visual Zone data extracted by AI with MRZ validated data.
 * Emits derived field conflicts ONLY when MRZ itself is deterministically valid (valid === true).
 * Handles cross-script surname comparisons (Cyrillic vs Latin).
 * @param {Object} visualZone
 * @param {Object} mrzParsed
 * @returns {string[]} conflicts
 */
function crossCheckVisualAndMrz(visualZone, mrzParsed) {
    const conflicts = [];
    if (!visualZone || !mrzParsed) return conflicts;

    // PREVENT WARNING CASCADE:
    // Field-level MRZ conflicts MUST ONLY be generated when MRZ is deterministically valid (mrzParsed.valid === true)
    if (mrzParsed.valid !== true) {
        return [];
    }

    // Compare Document Number (Normalized)
    if (visualZone.document_number && mrzParsed.document_number) {
        const vDoc = normalizeDocumentNumber(visualZone.document_number);
        const mDoc = normalizeDocumentNumber(mrzParsed.document_number);
        if (vDoc && mDoc && vDoc !== mDoc) {
            conflicts.push('Номер документа в паспорте и в строке MRZ отличается. Проверьте номер.');
        }
    }

    // Compare Birth Date (Canonical YYYY-MM-DD)
    if (visualZone.birth_date && mrzParsed.birth_date) {
        const vDate = normalizeDate(visualZone.birth_date);
        const mDate = normalizeDate(mrzParsed.birth_date);
        if (vDate && mDate && vDate !== mDate) {
            conflicts.push('Дата рождения в документе и в строке MRZ отличается. Проверьте дату рождения.');
        }
    }

    // Compare Sex (Canonical 'M' / 'F')
    if (visualZone.sex && mrzParsed.sex) {
        const vSex = normalizeSex(visualZone.sex);
        const mSex = normalizeSex(mrzParsed.sex);
        if (vSex && mSex && vSex !== mSex) {
            conflicts.push('Указание пола в документе и в строке MRZ отличается. Проверьте выбранный пол.');
        }
    }

    // Compare Surname (Cross-script transliteration aware)
    if (visualZone.surname && mrzParsed.surname) {
        const surnameMatch = compareSurnames(visualZone.surname, mrzParsed.surname);
        if (surnameMatch === 'MISMATCH') {
            conflicts.push('Написание фамилии в тексте документа и в строке MRZ отличается.');
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
