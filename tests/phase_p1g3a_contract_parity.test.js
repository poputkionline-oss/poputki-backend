/**
 * tests/phase_p1g3a_contract_parity.test.js
 *
 * PHASE P.1G.3A — Client/Backend Event Contract Parity
 *
 * Real behavioral contract test between the frontend's acquisitionService
 * (poputki-front/src/services/acquisitionService.js) and this backend's real
 * sanitizeProperties()/EVENT_ALLOWED_PROPERTIES (services/acquisition/
 * eventIngestionService.js) for all six client-emittable events:
 * LANDING_VIEWED, ROUTE_SEARCHED, TRIP_VIEWED, BOOKING_STARTED,
 * TELEGRAM_OPENED, SHARE_CLICKED.
 *
 * The frontend and backend are separate repositories/deployments with no
 * shared package, so this is not a single cross-repo test run — it is the
 * backend half of the contract, exercised against the REAL sanitizeProperties
 * function (not a reimplementation). The FIXTURES below are the literal wire
 * payloads the frontend's acquisitionService now sends after the P.1G.3A
 * property-naming fixes (BOOKING_STARTED, SHARE_CLICKED, TRIP_VIEWED,
 * TELEGRAM_OPENED, LANDING_VIEWED, ROUTE_SEARCHED) — see
 * poputki-front/tests/phase_p1g3a_frontend_hardening.test.js and
 * poputki-front/tests/phase_p1g3a_contract_parity.test.js for the matching
 * frontend-side proof (real acquisitionService calls captured against a
 * mocked outgoing request, asserting the same property names used here).
 * If either side's payload shape changes, both files must be updated
 * together — that is the actual maintenance cost of not sharing a package,
 * made visible instead of silently drifting.
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeProperties, scanForPiiKeys, ALLOWED_CLIENT_EVENTS } = require('../services/acquisition/eventIngestionService');

// The literal payloads the real (fixed) frontend acquisitionService sends on
// the wire for each event, as of Phase P.1G.3A.
const REAL_FRONTEND_PAYLOADS = {
    LANDING_VIEWED: { page_path: '/search' },
    ROUTE_SEARCHED: { from_city: 'Москва', to_city: 'Казань', departure_date: '2026-09-10' },
    TRIP_VIEWED: { trip_id: 4242 },
    BOOKING_STARTED: { trip_id: 4242 },
    TELEGRAM_OPENED: { target_channel: 'telegram_bot', handoff_point: 'web_to_telegram_cta' },
    SHARE_CLICKED: { share_channel: 'whatsapp', target_content: 'FRIEND2026' }
};

// The OLD (pre-P.1G.3A) broken property names each event used to send —
// kept here only to prove, with the real sanitizer, that they really were
// silently dropped (the concrete reason the frontend fix was necessary).
const HISTORICAL_BROKEN_PAYLOADS = {
    LANDING_VIEWED: { landing_path: '/search' },
    ROUTE_SEARCHED: { from_city_id: 'Москва', to_city_id: 'Казань', travel_date: '2026-09-10' },
    TRIP_VIEWED: { bus_ticket_id: 4242 },
    BOOKING_STARTED: { bus_ticket_id: 4242 },
    TELEGRAM_OPENED: { context: 'web_to_telegram_cta' },
    SHARE_CLICKED: { channel: 'whatsapp', referral_code: 'FRIEND2026' }
};

describe('Phase P.1G.3A — client/backend event contract parity', () => {
    for (const eventName of Object.keys(REAL_FRONTEND_PAYLOADS)) {
        describe(eventName, () => {
            it('is a recognized client-emittable event', () => {
                assert.ok(ALLOWED_CLIENT_EVENTS.has(eventName), `${eventName} must be in ALLOWED_CLIENT_EVENTS`);
            });

            it('every property the real frontend sends survives sanitizeProperties unchanged (backend does not drop required fields)', () => {
                const payload = REAL_FRONTEND_PAYLOADS[eventName];
                const sanitized = sanitizeProperties(eventName, payload);
                assert.deepEqual(sanitized, payload,
                    `sanitizeProperties(${eventName}, ...) must preserve every property the real frontend sends — got ${JSON.stringify(sanitized)}, expected ${JSON.stringify(payload)}`);
            });

            it('an unknown/unexpected property is stripped, never persisted (backend rejects unallowlisted fields)', () => {
                const payload = { ...REAL_FRONTEND_PAYLOADS[eventName], unexpected_extra_field: 'should-not-survive', another_bad_one: 12345 };
                const sanitized = sanitizeProperties(eventName, payload);
                assert.equal('unexpected_extra_field' in sanitized, false);
                assert.equal('another_bad_one' in sanitized, false);
                assert.deepEqual(sanitized, REAL_FRONTEND_PAYLOADS[eventName]);
            });

            it('the real frontend payload contains zero PII-shaped keys', () => {
                const piiKey = scanForPiiKeys(REAL_FRONTEND_PAYLOADS[eventName]);
                assert.equal(piiKey, null, `unexpected PII-shaped key found: ${piiKey}`);
            });

            it('historical regression proof: the OLD broken property names this event used to send are silently stripped to nothing', () => {
                const sanitized = sanitizeProperties(eventName, HISTORICAL_BROKEN_PAYLOADS[eventName]);
                assert.deepEqual(sanitized, {}, `expected the old broken payload shape to be fully stripped by the real allowlist for ${eventName}`);
            });
        });
    }

    it('BOOKING_STARTED and TRIP_VIEWED both key business meaning off the same allowlisted trip_id property', () => {
        assert.deepEqual(
            sanitizeProperties('BOOKING_STARTED', { trip_id: 999 }),
            sanitizeProperties('TRIP_VIEWED', { trip_id: 999 })
        );
    });

    it('TELEGRAM_OPENED never allowlists a raw token or a full URL-shaped property, even if the client tried to send one', () => {
        const sanitized = sanitizeProperties('TELEGRAM_OPENED', {
            target_channel: 'telegram_bot',
            handoff_point: 'web_to_telegram_cta',
            raw_token: 'w_secret_token_should_never_be_stored',
            telegram_deep_link: 'https://t.me/Poputkionline_bot?start=w_secret'
        });
        assert.deepEqual(sanitized, { target_channel: 'telegram_bot', handoff_point: 'web_to_telegram_cta' });
    });
});
