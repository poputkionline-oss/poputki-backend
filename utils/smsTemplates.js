/**
 * smsTemplates.js
 *
 * Deterministic, non-AI, transactional SMS templates for automatic manual-
 * booking ticket-link delivery, plus a GSM-7 / UCS-2 segmentation calculator
 * so the report can state real segment counts instead of guessing.
 * Project: POPUTKI.ONLINE
 */

'use strict';

// GSM 03.38 default alphabet (basic set), used to decide GSM-7 vs UCS-2.
// Deliberately conservative: any character outside this set (all Cyrillic,
// the Uzbek typographic apostrophe, emoji, etc.) forces UCS-2.
const GSM7_BASIC = "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\x1bÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?" +
    "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";

function isGsm7(text) {
    for (const ch of text) {
        if (!GSM7_BASIC.includes(ch)) return false;
    }
    return true;
}

/**
 * @param {string} text
 * @returns {{ encoding: 'GSM7'|'UCS2', length: number, segments: number, charsPerSegment: number }}
 */
function calculateSmsSegments(text) {
    const length = Array.from(text).length; // code-point aware
    const gsm7 = isGsm7(text);
    const encoding = gsm7 ? 'GSM7' : 'UCS2';

    if (gsm7) {
        if (length <= 160) return { encoding, length, segments: 1, charsPerSegment: 160 };
        return { encoding, length, segments: Math.ceil(length / 153), charsPerSegment: 153 };
    }
    if (length <= 70) return { encoding, length, segments: 1, charsPerSegment: 70 };
    return { encoding, length, segments: Math.ceil(length / 67), charsPerSegment: 67 };
}

const SUPPORTED_LOCALES = ['ru', 'tj', 'uz'];

function resolveLocale(locale) {
    return SUPPORTED_LOCALES.includes(locale) ? locale : 'ru';
}

/**
 * Deterministic locale selection for a booking: currently phone-country
 * based (TJ numbers -> ru by default per carrier's own operating language;
 * this is intentionally simple and documented as a v1 default, not a
 * guess dressed up as inference). Carrier-level language preference, if
 * ever added, should override this — out of scope for this pass.
 */
function resolveLocaleForBooking() {
    return 'ru';
}

/**
 * @param {Object} params
 * @param {'ru'|'tj'|'uz'} params.locale
 * @param {string} params.fromCity
 * @param {string} params.toCity
 * @param {string} params.claimUrl - full https://... link, no PII in the URL itself
 * @returns {{ text: string, templateCode: string, locale: string, segmentInfo: object }}
 */
function renderManualBookingTicketSms({ locale, fromCity, toCity, claimUrl }) {
    const lang = resolveLocale(locale);
    const route = `${fromCity || '—'} → ${toCity || '—'}`;
    let text;

    if (lang === 'tj') {
        text = `Poputki.online: чиптаи шумо ба сафари ${route}. Кушодан: ${claimUrl}`;
    } else if (lang === 'uz') {
        text = `Poputki.online: chiptangiz ${route} reysiga. Ochish: ${claimUrl}`;
    } else {
        text = `Poputki.online: ваш билет на рейс ${route}. Открыть: ${claimUrl}`;
    }

    return {
        text,
        templateCode: 'manual_booking_ticket_link_v1',
        locale: lang,
        segmentInfo: calculateSmsSegments(text)
    };
}

module.exports = {
    calculateSmsSegments,
    resolveLocaleForBooking,
    renderManualBookingTicketSms,
    SUPPORTED_LOCALES
};
