/**
 * phase_claim_landing_seat_display_hotfix.test.js
 *
 * POPUTKI.ONLINE — /t/:token claim landing "Мест: 1" display hotfix.
 *
 * Root cause (owner-confirmed live audit): bus_ticket_bookings.seat_numbers
 * is declared TEXT[] in the schema baseline doc, but the live column is
 * actually varchar (schema drift) — Supabase/PostgREST hands routes/claims.js
 * back the JSON-array text it was stored as (e.g. "[78]"), not a real array.
 * The claim landing page then displayed the separately-persisted
 * passenger_count column (itself just a frozen seat_numbers.length taken at
 * booking time) instead of the actual seat numbers.
 *
 * This suite tests routes/claims.js's parseSeatNumbers() directly (exported
 * for testing — see routes/claims.js bottom) rather than driving the full
 * preview-trip/bot-open HTTP routes: both endpoints' resolveClaimSession()
 * chain requires a live-shaped booking_claim_sessions/bus_ticket_bookings
 * fixture with matching token hashes, which exercises claimHelper.js (already
 * covered by tests/phase_e_booking_claim.test.js) rather than this hotfix's
 * actual change. Source-level checks below confirm both endpoints call the
 * same tested function; not just the presence of the function elsewhere.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { parseSeatNumbers } = require('../routes/claims');

describe('CLAIM LANDING SEAT DISPLAY HOTFIX — parseSeatNumbers()', () => {
    it('1. native array passes through unchanged', () => {
        assert.deepEqual(parseSeatNumbers([78]), [78]);
        assert.deepEqual(parseSeatNumbers([12, 13]), [12, 13]);
        assert.deepEqual(parseSeatNumbers([]), []);
    });

    it('2. JSON-string single seat "[78]" parses to [78]', () => {
        assert.deepEqual(parseSeatNumbers('[78]'), [78]);
    });

    it('3. JSON-string multiple seats "[12,13]" parses to [12, 13]', () => {
        assert.deepEqual(parseSeatNumbers('[12,13]'), [12, 13]);
    });

    it('4. JSON-string empty array "[]" parses to []', () => {
        assert.deepEqual(parseSeatNumbers('[]'), []);
    });

    it('5. NULL/undefined returns [] without throwing', () => {
        assert.deepEqual(parseSeatNumbers(null), []);
        assert.deepEqual(parseSeatNumbers(undefined), []);
    });

    it('6. empty string returns [] without throwing', () => {
        assert.deepEqual(parseSeatNumbers(''), []);
    });

    it('7. malformed JSON returns [] without throwing (never bubbles a parse error)', () => {
        assert.deepEqual(parseSeatNumbers('[78'), []);
        assert.deepEqual(parseSeatNumbers('not json at all'), []);
        assert.deepEqual(parseSeatNumbers('{"broken"'), []);
    });

    it('8. JSON object or scalar (not an array) returns []', () => {
        assert.deepEqual(parseSeatNumbers('{"seat": 78}'), []);
        assert.deepEqual(parseSeatNumbers('78'), []); // valid JSON scalar, not an array
        assert.deepEqual(parseSeatNumbers(78), []);   // raw number, not array/string
        assert.deepEqual(parseSeatNumbers({ seat: 78 }), []); // raw object
    });

    it('9. never throws for any input shape (fail-safe contract)', () => {
        const inputs = [null, undefined, '', '[78]', '[12,13]', '[]', '[78', 'not json', '{"a":1}', 78, {}, [], [78], true, NaN];
        for (const input of inputs) {
            assert.doesNotThrow(() => parseSeatNumbers(input));
        }
    });
});

describe('CLAIM LANDING SEAT DISPLAY HOTFIX — both claim endpoints wired to parseSeatNumbers()', () => {
    const claimsSource = readFileSync(path.resolve(__dirname, '../routes/claims.js'), 'utf-8');

    it('10. POST /api/claims/preview-trip builds seatNumbers via parseSeatNumbers(), never the raw column', () => {
        const previewTripBlock = claimsSource.slice(
            claimsSource.indexOf("router.post('/preview-trip'"),
            claimsSource.indexOf("router.post('/bot/open'")
        );
        assert.match(previewTripBlock, /seatNumbers:\s*parseSeatNumbers\(booking\.seat_numbers\)/);
        assert.ok(!/seatNumbers:\s*booking\.seat_numbers[,\s]/.test(previewTripBlock));
    });

    it("11. POST /api/claims/bot/open builds seatNumbers via parseSeatNumbers(), never the raw column", () => {
        const botOpenBlock = claimsSource.slice(
            claimsSource.indexOf("router.post('/bot/open'"),
            claimsSource.indexOf("router.post('/bot/verify-and-claim'")
        );
        assert.match(botOpenBlock, /seatNumbers:\s*parseSeatNumbers\(booking\.seat_numbers\)/);
        assert.ok(!/seatNumbers:\s*booking\.seat_numbers[,\s]/.test(botOpenBlock));
    });

    it('12. no other trip-building block in claims.js still assigns the raw column to seatNumbers', () => {
        const rawAssignments = claimsSource.match(/seatNumbers:\s*booking\.seat_numbers\b(?!\s*\))/g) || [];
        assert.equal(rawAssignments.length, 0, 'found a seatNumbers field still bypassing parseSeatNumbers()');
    });
});
