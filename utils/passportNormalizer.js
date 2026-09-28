/**
 * utils/passportNormalizer.js
 *
 * Unified Normalization Layer for POPUTKI.ONLINE AI Passport Scanner
 * Handles dates, sex/gender, country/citizenship, document numbers, and document types.
 * Converts raw AI/MRZ values into canonical forms before comparisons and form insertion.
 */

'use strict';

/**
 * Normalizes any date string into canonical YYYY-MM-DD.
 * Supports DD.MM.YYYY, DD-MM-YYYY, DD/MM/YYYY, YYYY-MM-DD, YYYY.MM.DD, YYYYMMDD.
 * @param {string|null} dateStr
 * @returns {string|null} Canonical YYYY-MM-DD or null if invalid
 */
function normalizeDate(dateStr) {
    if (!dateStr || typeof dateStr !== 'string') return null;

    const trimmed = dateStr.trim();
    if (!trimmed) return null;

    // YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
        return trimmed;
    }

    // YYYY.MM.DD or YYYY/MM/DD
    const isoMatch = trimmed.match(/^(\d{4})[./](\d{2})[./](\d{2})$/);
    if (isoMatch) {
        return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
    }

    // DD.MM.YYYY or DD-MM-YYYY or DD/MM/YYYY
    const dmyMatch = trimmed.match(/^(\d{2})[.-/](\d{2})[.-/](\d{4})$/);
    if (dmyMatch) {
        return `${dmyMatch[3]}-${dmyMatch[2]}-${dmyMatch[1]}`;
    }

    // YYYYMMDD
    if (/^\d{8}$/.test(trimmed)) {
        return `${trimmed.slice(0, 4)}-${trimmed.slice(4, 6)}-${trimmed.slice(6, 8)}`;
    }

    // Standard Date fallback parse
    const parsedDate = new Date(trimmed);
    if (!isNaN(parsedDate.getTime())) {
        const year = parsedDate.getFullYear();
        const month = String(parsedDate.getMonth() + 1).padStart(2, '0');
        const day = String(parsedDate.getDate()).padStart(2, '0');
        if (year > 1900 && year < 2100) {
            return `${year}-${month}-${day}`;
        }
    }

    return null;
}

/**
 * Normalizes sex/gender to canonical 'M' or 'F'.
 * @param {string|null} sexStr
 * @returns {'M'|'F'|null}
 */
function normalizeSex(sexStr) {
    if (!sexStr || typeof sexStr !== 'string') return null;

    const clean = sexStr.trim().toUpperCase();
    if (!clean) return null;

    // Male variations (Latin & Cyrillic)
    if (
        clean === 'M' ||
        clean === 'М' || // Cyrillic М
        clean === 'MALE' ||
        clean === 'МУЖ' ||
        clean === 'МУЖСКОЙ'
    ) {
        return 'M';
    }

    // Female variations (Latin & Cyrillic)
    if (
        clean === 'F' ||
        clean === 'Ф' ||
        clean === 'Ж' ||
        clean === 'FEMALE' ||
        clean === 'ЖЕН' ||
        clean === 'ЖЕНСКИЙ'
    ) {
        return 'F';
    }

    return null;
}

/**
 * Normalizes document number for accurate comparison.
 * Uppercases, strips spaces, hyphens, and filler '<' characters.
 * Does NOT alter letters to digits (O->0, I->1 are NOT auto-converted).
 * @param {string|null} docStr
 * @returns {string|null}
 */
function normalizeDocumentNumber(docStr) {
    if (!docStr || typeof docStr !== 'string') return null;

    const clean = docStr.replace(/[\s\-<]+/g, '').toUpperCase();
    return clean || null;
}

/**
 * Maps country codes / names to POPUTKI canonical citizenship values.
 * Canonical values: 'Таджикистан', 'Россия', 'Узбекистан', 'Казахстан', 'Кыргызстан', 'Туркменистан', 'Беларусь', 'Украина', 'Армения', 'Грузия', 'Другое'.
 * @param {string|null} countryStr
 * @returns {string} Canonical country string
 */
function normalizeCountry(countryStr) {
    if (!countryStr || typeof countryStr !== 'string') return 'Таджикистан';

    const clean = countryStr.trim().toUpperCase();
    if (!clean) return 'Таджикистан';

    // Tajikistan variations
    if (
        clean === 'TJK' ||
        clean === 'TJ' ||
        clean === 'TAJIKISTAN' ||
        clean === 'REPUBLIC OF TAJIKISTAN' ||
        clean.includes('ТАДЖИКИСТАН') ||
        clean.includes('ТОҶИКИСТОН')
    ) {
        return 'Таджикистан';
    }

    // Russia variations
    if (
        clean === 'RUS' ||
        clean === 'RU' ||
        clean === 'RUSSIA' ||
        clean === 'RUSSIAN FEDERATION' ||
        clean.includes('РОССИЯ') ||
        clean.includes('РОССИЙСКАЯ')
    ) {
        return 'Россия';
    }

    // Uzbekistan variations
    if (
        clean === 'UZB' ||
        clean === 'UZ' ||
        clean === 'UZBEKISTAN' ||
        clean === 'REPUBLIC OF UZBEKISTAN' ||
        clean.includes('УЗБЕКИСТАН') ||
        clean.includes('ЎЗБЕКИСТОН')
    ) {
        return 'Узбекистан';
    }

    // Kazakhstan variations
    if (
        clean === 'KAZ' ||
        clean === 'KZ' ||
        clean === 'KAZAKHSTAN' ||
        clean === 'REPUBLIC OF KAZAKHSTAN' ||
        clean.includes('КАЗАХСТАН')
    ) {
        return 'Казахстан';
    }

    // Kyrgyzstan variations
    if (
        clean === 'KGZ' ||
        clean === 'KG' ||
        clean === 'KYRGYZSTAN' ||
        clean === 'KYRGYZ REPUBLIC' ||
        clean.includes('КЫРГЫЗСТАН') ||
        clean.includes('КИРГИЗИЯ')
    ) {
        return 'Кыргызстан';
    }

    // Turkmenistan variations
    if (
        clean === 'TKM' ||
        clean === 'TM' ||
        clean === 'TURKMENISTAN' ||
        clean.includes('ТУРКМЕНИСТАН')
    ) {
        return 'Туркменистан';
    }

    // Belarus variations
    if (
        clean === 'BLR' ||
        clean === 'BY' ||
        clean === 'BELARUS' ||
        clean.includes('БЕЛАРУСЬ') ||
        clean.includes('БЕЛОРУССИЯ')
    ) {
        return 'Беларусь';
    }

    // Ukraine variations
    if (
        clean === 'UKR' ||
        clean === 'UA' ||
        clean === 'UKRAINE' ||
        clean.includes('УКРАИНА')
    ) {
        return 'Украина';
    }

    // Armenia variations
    if (
        clean === 'ARM' ||
        clean === 'AM' ||
        clean === 'ARMENIA' ||
        clean.includes('АРМЕНИЯ')
    ) {
        return 'Армения';
    }

    // Georgia variations
    if (
        clean === 'GEO' ||
        clean === 'GE' ||
        clean === 'GEORGIA' ||
        clean.includes('ГРУЗИЯ')
    ) {
        return 'Грузия';
    }

    return 'Другое';
}

/**
 * Normalizes document type classification.
 * @param {string|null} typeStr
 * @returns {'passport'|'id_card'|'internal_passport'|'residence_permit'|'unknown'}
 */
function normalizeDocumentType(typeStr) {
    if (!typeStr || typeof typeStr !== 'string') return 'passport';

    const clean = typeStr.trim().toLowerCase();
    if (!clean) return 'passport';

    if (clean.includes('id') || clean.includes('карта') || clean.includes('card')) {
        return 'id_card';
    }

    if (clean.includes('внутренний') || clean.includes('internal')) {
        return 'internal_passport';
    }

    if (clean.includes('residence') || clean.includes('вид на жительство')) {
        return 'residence_permit';
    }

    return 'passport';
}

module.exports = {
    normalizeDate,
    normalizeSex,
    normalizeDocumentNumber,
    normalizeCountry,
    normalizeDocumentType
};
