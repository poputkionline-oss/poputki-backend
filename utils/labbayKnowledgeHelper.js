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
 * Returns true only when the route is confidently international: one
 * endpoint recognized as Tajikistan and the other recognized as foreign.
 *
 * A single foreign-classified endpoint is NOT sufficient on its own — a
 * foreign→foreign pair (e.g. two Russian cities) is not evidence of a real
 * Poputki international route touching Tajikistan; it is at best a data
 * entry anomaly, and reporting it as "international" would be exactly the
 * kind of guess this endpoint must not make. Domestic (tj/tj) and any pair
 * involving an unrecognized endpoint are likewise excluded.
 */
function isConfidentInternationalRoute(fromCity, toCity) {
    const fromClass = classifyCity(fromCity);
    const toClass = classifyCity(toCity);

    return (fromClass === 'tj' && toClass === 'foreign') ||
        (fromClass === 'foreign' && toClass === 'tj');
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

const FROM_PREPOSITIONS = new Set(['из', 'от']);
const TO_PREPOSITIONS = new Set(['в', 'до', 'на']);

/**
 * The word immediately preceding a match at `index` in the normalized
 * query, used to detect a directional preposition ("из", "в", ...).
 */
function precedingWord(nq, index) {
    const before = nq.slice(0, index).trimEnd();
    const parts = before.split(' ');
    return parts[parts.length - 1] || '';
}

/**
 * Finds which known cities (from the `cities` table, type='bus') are
 * mentioned in the customer's free-text query, in the order they first
 * appear (NOT the order they happen to appear in `knownCities`, which is
 * unrelated to what the customer actually said and previously produced a
 * meaningless "first"/"second" for direction fallback). Each match also
 * carries a direction guess from a preposition immediately before it, if
 * any ("из"/"от" -> from, "в"/"до"/"на" -> to).
 *
 * @param {string} query
 * @param {Array<{name: string}>} knownCities
 * @returns {{name: string, index: number, direction: 'from'|'to'|null}[]}
 */
function findCityMentions(query, knownCities) {
    const nq = normalizeQuery(query);
    if (!nq) return [];

    const matches = [];
    const seen = new Set();

    for (const city of knownCities || []) {
        if (!city || !city.name || seen.has(city.name)) continue;
        const stem = cityStem(city.name);
        if (stem.length < 3) continue;
        const index = nq.indexOf(stem);
        if (index === -1) continue;

        seen.add(city.name);
        const word = precedingWord(nq, index);
        const direction = FROM_PREPOSITIONS.has(word) ? 'from' : (TO_PREPOSITIONS.has(word) ? 'to' : null);
        matches.push({ name: city.name, index, direction });
    }

    matches.sort((a, b) => a.index - b.index);
    return matches;
}

/**
 * Resolves the customer's query into a route intent: which city (if any) is
 * the origin, which is the destination, and the full set of mentioned
 * cities. Direction is taken from an explicit preposition where present;
 * with two or more cities and no preposition, the first-mentioned city is
 * assumed to be the origin (matches how routes are written everywhere else
 * in this codebase, "{from} -> {to}"). With only one recognized city and no
 * preposition, neither side is pinned — the caller matches either side.
 *
 * @returns {{from: string|null, to: string|null, cities: string[]}}
 */
function resolveRouteCities(query, knownCities) {
    const mentions = findCityMentions(query, knownCities);
    if (mentions.length === 0) return { from: null, to: null, cities: [] };

    const cities = mentions.map(m => m.name);

    if (mentions.length === 1) {
        const m = mentions[0];
        return {
            from: m.direction === 'from' ? m.name : null,
            to: m.direction === 'to' ? m.name : null,
            cities
        };
    }

    const fromMention = mentions.find(m => m.direction === 'from');
    const toMention = mentions.find(m => m.direction === 'to' && m !== fromMention);

    let from = fromMention ? fromMention.name : null;
    let to = toMention ? toMention.name : null;

    if (!from && !to) {
        from = mentions[0].name;
        to = mentions[1].name;
    } else if (from && !to) {
        const other = mentions.find(m => m.name !== from);
        to = other ? other.name : null;
    } else if (to && !from) {
        const other = mentions.find(m => m.name !== to);
        from = other ? other.name : null;
    }

    return { from, to, cities };
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
 * @returns {{from: string|null, to: string|null, cities: string[], date: string|null, missing: string[]}}
 */
function parseIntent(query, knownCities, todayIso) {
    const { from, to, cities } = resolveRouteCities(query, knownCities);
    const date = extractDate(query, todayIso);

    const missing = [];
    if (cities.length === 0) missing.push('направление (город отправления или назначения)');
    if (!date) missing.push('дата поездки');

    return { from, to, cities, date, missing };
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

function sideMatchesCity(sideText, cityName) {
    if (!cityName) return false;
    const stem = cityStem(cityName);
    return stem.length >= 3 && sideText.includes(stem);
}

/**
 * Whether a bus_tickets row matches the customer's resolved route intent.
 *
 * When a direction was resolved (from and/or to pinned — see
 * resolveRouteCities()), BOTH known sides must match their respective side
 * of the ticket: a query for "из Худжанда в Москву" must reject a reverse
 * Москва -> Худжанд ticket, and must reject a ticket that only matches one
 * of the two named cities (e.g. Худжанд -> Бишкек) — matching "any
 * mentioned city on any side" was the bug this replaces.
 *
 * Only when no direction could be resolved at all (a single, unprefixed
 * city mention) does this fall back to matching either side, since there
 * is genuinely only one known endpoint and no second city to be strict
 * against.
 *
 * @param {{from_city: string, to_city: string}} ticket
 * @param {{from: string|null, to: string|null, cities: string[]}} intent
 */
function routeMatchesIntent(ticket, intent) {
    const fromCity = normalizeQuery(ticket.from_city || '');
    const toCity = normalizeQuery(ticket.to_city || '');

    if (intent.from || intent.to) {
        const fromOk = intent.from ? sideMatchesCity(fromCity, intent.from) : true;
        const toOk = intent.to ? sideMatchesCity(toCity, intent.to) : true;
        return fromOk && toOk;
    }

    if (!intent.cities || intent.cities.length === 0) return false;
    return intent.cities.some(city =>
        sideMatchesCity(fromCity, city) || sideMatchesCity(toCity, city)
    );
}

/**
 * Whether a ticket's departure has already passed, given the platform's
 * single business-local ("today") reference — the same Asia/Dushanbe clock
 * used everywhere else (getBusinessLocalDate/getBusinessLocalTime in
 * utils/dashboardHelper.js), never a UTC calendar date or the server
 * process's own local timezone. Takes todayIso/nowLocalTime as plain
 * strings (not a Date) specifically so the day-boundary case — Asia/Dushanbe
 * is UTC+5, so it is already "tomorrow" there for roughly 5 hours before UTC
 * agrees — is deterministically testable without mocking wall-clock time.
 *
 * @param {{departure_date: string, departure_time: string}} ticket
 * @param {string} todayIso business-local "today", YYYY-MM-DD
 * @param {string} nowLocalTime business-local time-of-day, HH:mm
 */
function hasTicketAlreadyDeparted(ticket, todayIso, nowLocalTime) {
    if (!ticket.departure_date) return false;
    if (ticket.departure_date < todayIso) return true;
    if (ticket.departure_date > todayIso) return false;

    const depTime = String(ticket.departure_time || '').slice(0, 5);
    if (!depTime) return false;
    return depTime < nowLocalTime;
}

module.exports = {
    MAX_QUERY_LENGTH,
    MAX_CONTENT_BYTES,
    MAX_RESULTS,
    CURRENCY_LABEL,
    classifyCity,
    isConfidentInternationalRoute,
    findCityMentions,
    resolveRouteCities,
    extractDate,
    parseIntent,
    routeMatchesIntent,
    hasTicketAlreadyDeparted,
    formatTripLine,
    formatDateHuman,
    buildClarifyingQuestion,
    buildNoResultsMessage,
    truncateToByteLimit
};
