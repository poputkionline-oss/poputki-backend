/**
 * utils/labbayKnowledgeHelper.js
 *
 * Labbay Dynamic Knowledge Base integration — query parsing, route
 * classification (international vs. domestic) and answer formatting for
 * international bus trips only.
 *
 * Scope: read-only. Never touches `rides` (carpool) search or bookings.
 * Seat availability is never computed here — it is delegated to
 * `calculateTripFillStats` in `utils/dashboardHelper.js`, the same function
 * the carrier dashboard uses, so this module cannot drift from it.
 */

'use strict';

const MAX_QUERY_LENGTH = 500;
const MAX_CONTENT_BYTES = 50 * 1024; // Labbay hard limit
const MAX_RESULTS = 10;
const CURRENCY_LABEL = 'сомони'; // Same fixed unit used platform-wide (no currency column exists)

// -------------------------------------------------------------------------
// City classification (international vs. domestic)
// -------------------------------------------------------------------------
//
// bus_tickets.from_city / to_city are free-text, carrier-entered strings.
// There is no country/is_international column anywhere in the schema. Two
// signals are used, both grounded in how city names actually appear in this
// codebase's own data (see tests/phase_fleet_bus_replacement.test.js):
//
//   1. An explicit "(XX)" country-code suffix on the city name, e.g.
//      "Худжанд (TJ)", "Нижневартовск (РФ)" — highest confidence, literal.
//   2. A small reference list of Tajikistan cities vs. common foreign
//      destinations on this platform's routes (Russia / Kazakhstan /
//      Kyrgyzstan / Uzbekistan), for names with no suffix.
//
// A route is only ever reported as international when classification is
// confident. Anything unrecognized is excluded rather than guessed — this
// endpoint must never invent or mislabel a route.
//
// NOTE for maintainers: this is a heuristic, not a source of truth. If the
// product needs precise classification, add a real `country` column (e.g.
// on `cities`, or a `bus_tickets.is_international` flag) and replace this
// module's lookup with that column.

const COUNTRY_SUFFIX_RE = /\(([A-ZА-Я]{2,3})\)\s*$/i;

const TAJIKISTAN_CITIES = new Set([
    'душанбе', 'худжанд', 'куляб', 'кулоб', 'бохтар', 'курган-тюбе', 'курган тюбе',
    'истаравшан', 'пенджикент', 'пенжикент', 'турсунзаде', 'вахдат', 'гиссар', 'гисор',
    'канибадам', 'исфара', 'хорог', 'нурек', 'яван', 'шаартуз', 'дангара', 'пяндж',
    'восе', 'фархор', 'джиликуль', 'рудаки', 'варзоб', 'таджикабад', 'тавильдара',
    'муминабад', 'ховалинг', 'шурообод', 'носир хисрав', 'носир-хисрав'
]);

// Common non-Tajik destinations on Poputki's bus routes (labor-migration
// corridors to/from Russia, Kazakhstan, Kyrgyzstan, Uzbekistan).
const FOREIGN_CITIES = new Set([
    // Russia
    'москва', 'санкт-петербург', 'казань', 'екатеринбург', 'новосибирск',
    'нижневартовск', 'сургут', 'уфа', 'самара', 'челябинск', 'пермь', 'тюмень',
    'омск', 'красноярск', 'краснодар', 'ростов-на-дону', 'ростов на дону',
    'волгоград', 'воронеж', 'саратов', 'тольятти',
    // Kazakhstan
    'алматы', 'астана', 'нур-султан', 'шымкент',
    // Kyrgyzstan
    'бишкек', 'ош',
    // Uzbekistan
    'ташкент', 'самарканд', 'бухара', 'андижан', 'фергана'
]);

const COUNTRY_CODE_TO_TJ = new Set(['tj', 'тj', 'тж']); // "TJ" (Latin) is the expected spelling

function normalizeText(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/ё/g, 'е')
        .trim();
}

function stripCountrySuffix(cityRaw) {
    return normalizeText(cityRaw).replace(COUNTRY_SUFFIX_RE, '').trim();
}

/**
 * Classifies a single city name as 'tj' (Tajikistan), 'foreign', or null
 * (unrecognized — classification not confident enough to use).
 */
function classifyCity(cityRaw) {
    const norm = normalizeText(cityRaw);
    const suffixMatch = norm.match(COUNTRY_SUFFIX_RE);
    const baseName = stripCountrySuffix(norm);

    if (suffixMatch) {
        const code = suffixMatch[1].toLowerCase();
        return COUNTRY_CODE_TO_TJ.has(code) ? 'tj' : 'foreign';
    }

    if (TAJIKISTAN_CITIES.has(baseName)) return 'tj';
    if (FOREIGN_CITIES.has(baseName)) return 'foreign';
    return null;
}

/**
 * Returns true only when the route is confidently international: at least
 * one endpoint is a recognized foreign city and no endpoint is unrecognized
 * as "definitely foreign" while contradicting the other. Unrecognized
 * endpoints never get classified as international by assumption.
 */
function isConfidentInternationalRoute(fromCity, toCity) {
    const fromClass = classifyCity(fromCity);
    const toClass = classifyCity(toCity);

    if (fromClass === 'foreign' || toClass === 'foreign') {
        // At least one side confidently foreign. Reject only if the other
        // side is confidently foreign from the SAME country pairing check
        // isn't needed here — Poputki has no purely-foreign-to-foreign
        // routes, so one confident foreign endpoint is sufficient.
        return true;
    }

    return false;
}

// -------------------------------------------------------------------------
// Query parsing: extract mentioned cities and a departure date
// -------------------------------------------------------------------------

function normalizeQuery(query) {
    return normalizeText(query).replace(/[^a-zа-я0-9\s.\/-]+/gi, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Lax "stem" of a city name for matching inflected Russian forms
 * (Худжанд / Худжанда / Худжанде / Худжанду) without full morphology.
 */
function cityStem(cityName) {
    const clean = stripCountrySuffix(cityName).replace(/[^a-zа-я\s-]/gi, '');
    if (clean.length <= 4) return clean;
    return clean.slice(0, clean.length - 2);
}

/**
 * Finds which known cities (from the `cities` table, type='bus') are
 * mentioned in the customer's free-text query.
 *
 * @param {string} query
 * @param {Array<{name: string}>} knownCities
 * @returns {string[]} matched canonical city names (as stored), deduped
 */
function findMentionedCities(query, knownCities) {
    const nq = normalizeQuery(query);
    if (!nq) return [];

    const matches = [];
    const seen = new Set();

    for (const city of knownCities || []) {
        if (!city || !city.name) continue;
        const stem = cityStem(city.name);
        if (stem.length < 3) continue;
        if (nq.includes(stem) && !seen.has(city.name)) {
            seen.add(city.name);
            matches.push(city.name);
        }
    }

    return matches;
}

const MONTHS_RU = {
    'январ': 1, 'феврал': 2, 'март': 3, 'апрел': 4, 'ма': 5, 'июн': 6,
    'июл': 7, 'август': 8, 'сентябр': 9, 'октябр': 10, 'ноябр': 11, 'декабр': 12
};

function pad2(n) {
    return String(n).padStart(2, '0');
}

/**
 * Attempts to extract a single ISO (YYYY-MM-DD) departure date mentioned in
 * the query. Returns null if none found with reasonable confidence.
 *
 * @param {string} query
 * @param {string} todayIso business-local "today" (YYYY-MM-DD)
 */
function extractDate(query, todayIso) {
    const nq = normalizeQuery(query);
    if (!nq) return null;

    const [todayY, todayM, todayD] = todayIso.split('-').map(Number);
    const today = new Date(Date.UTC(todayY, todayM - 1, todayD));

    if (/\bсегодня\b/.test(nq)) return todayIso;
    if (/\bзавтра\b/.test(nq)) {
        const d = new Date(today); d.setUTCDate(d.getUTCDate() + 1);
        return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
    }
    if (/послезавтра/.test(nq)) {
        const d = new Date(today); d.setUTCDate(d.getUTCDate() + 2);
        return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
    }

    // ISO: 2026-10-05
    let m = nq.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/);
    if (m) {
        const [, y, mo, d] = m;
        if (Number(mo) >= 1 && Number(mo) <= 12 && Number(d) >= 1 && Number(d) <= 31) {
            return `${y}-${pad2(mo)}-${pad2(d)}`;
        }
    }

    // dd.mm[.yyyy] or dd/mm[/yyyy]
    m = nq.match(/\b(\d{1,2})[.\/](\d{1,2})(?:[.\/](\d{2,4}))?\b/);
    if (m) {
        const [, d, mo, yRaw] = m;
        if (Number(mo) >= 1 && Number(mo) <= 12 && Number(d) >= 1 && Number(d) <= 31) {
            let year = yRaw ? Number(yRaw) : today.getUTCFullYear();
            if (yRaw && yRaw.length === 2) year += 2000;
            if (!yRaw) {
                // No year given: assume the next occurrence (this year, or
                // next year if that date already passed).
                const candidate = new Date(Date.UTC(year, Number(mo) - 1, Number(d)));
                if (candidate < today) year += 1;
            }
            return `${year}-${pad2(mo)}-${pad2(d)}`;
        }
    }

    // "5 октября" / "12 ноября 2026"
    m = nq.match(/\b(\d{1,2})\s+([а-я]+)(?:\s+(20\d{2}))?\b/);
    if (m) {
        const [, d, monthWord, yRaw] = m;
        const monthEntry = Object.keys(MONTHS_RU).find(stem => monthWord.startsWith(stem));
        if (monthEntry) {
            const mo = MONTHS_RU[monthEntry];
            let year = yRaw ? Number(yRaw) : today.getUTCFullYear();
            if (!yRaw) {
                const candidate = new Date(Date.UTC(year, mo - 1, Number(d)));
                if (candidate < today) year += 1;
            }
            return `${year}-${pad2(mo)}-${pad2(d)}`;
        }
    }

    return null;
}

/**
 * Parses a customer query into a route intent.
 *
 * @returns {{cities: string[], date: string|null, missing: string[]}}
 */
function parseIntent(query, knownCities, todayIso) {
    const cities = findMentionedCities(query, knownCities);
    const date = extractDate(query, todayIso);

    const missing = [];
    if (cities.length === 0) missing.push('направление (город отправления или назначения)');
    if (!date) missing.push('дата поездки');

    return { cities, date, missing };
}

// -------------------------------------------------------------------------
// Answer formatting
// -------------------------------------------------------------------------

function formatDateHuman(isoDate) {
    const [y, m, d] = isoDate.split('-');
    return `${d}.${m}.${y}`;
}

function formatTripLine(ticket, freeSeats, bookingBaseUrl) {
    const time = ticket.departure_time ? String(ticket.departure_time).slice(0, 5) : '';
    const dateHuman = formatDateHuman(ticket.departure_date);
    const seatsPart = freeSeats > 0
        ? `свободных мест: ${freeSeats} (на момент проверки, окончательно место подтверждается при оформлении брони)`
        : 'свободных мест нет';
    const priceStr = ticket.price != null ? `${ticket.price} ${CURRENCY_LABEL}` : 'цена уточняется';

    let line = `${ticket.from_city} → ${ticket.to_city}, ${dateHuman}, отправление ${time}, цена ${priceStr}, ${seatsPart}`;

    if (freeSeats > 0 && bookingBaseUrl) {
        line += `. Забронировать: ${bookingBaseUrl}/bus-ticket/${ticket.id}`;
    }

    return line;
}

function buildClarifyingQuestion(missing) {
    return `Уточните, пожалуйста: ${missing.join(' и ')}, чтобы я мог проверить международные автобусные рейсы.`;
}

function buildNoResultsMessage(cities, date) {
    const routePart = cities.length > 0 ? `по направлению «${cities.join(', ')}»` : 'по вашему запросу';
    const datePart = date ? ` на ${formatDateHuman(date)}` : '';
    return `Международных автобусных рейсов ${routePart}${datePart} не найдено.`;
}

function truncateToByteLimit(text, maxBytes) {
    if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
    let end = maxBytes;
    let buf = Buffer.from(text, 'utf8').subarray(0, end);
    // Avoid cutting a multi-byte UTF-8 character in half.
    while (end > 0 && (buf[buf.length - 1] & 0xc0) === 0x80) {
        end -= 1;
        buf = Buffer.from(text, 'utf8').subarray(0, end);
    }
    return buf.toString('utf8');
}

/**
 * Whether a bus_tickets row's from_city/to_city plausibly corresponds to
 * any of the cities the customer mentioned (same lax stem-matching used to
 * parse the query in the first place, so results stay consistent with what
 * triggered the search).
 *
 * @param {{from_city: string, to_city: string}} ticket
 * @param {string[]} mentionedCities canonical city names from parseIntent()
 */
function routeMatchesCities(ticket, mentionedCities) {
    if (!mentionedCities || mentionedCities.length === 0) return false;
    const from = normalizeQuery(ticket.from_city || '');
    const to = normalizeQuery(ticket.to_city || '');

    return mentionedCities.some(city => {
        const stem = cityStem(city);
        if (stem.length < 3) return false;
        return from.includes(stem) || to.includes(stem);
    });
}

module.exports = {
    MAX_QUERY_LENGTH,
    MAX_CONTENT_BYTES,
    MAX_RESULTS,
    CURRENCY_LABEL,
    classifyCity,
    isConfidentInternationalRoute,
    findMentionedCities,
    extractDate,
    parseIntent,
    routeMatchesCities,
    formatTripLine,
    formatDateHuman,
    buildClarifyingQuestion,
    buildNoResultsMessage,
    truncateToByteLimit
};
