/**
 * tests/phase_p1g3a_addendum_telegram_attribution.test.js
 *
 * PHASE P.1G.3A ADDENDUM — Telegram Mini App attribution tier
 *
 * The bot's /start button now opens the Mini App directly on the bus search
 * screen. For that visit's LANDING_VIEWED/session to record source_platform
 * 'telegram' instead of 'direct' (no new MINI_APP_OPENED event, per scope),
 * the frontend sends a client-asserted is_telegram_webapp flag and the real
 * resolveAttribution() uses it only when no stronger signal (referral link,
 * tracked link, verified referrer, UTM) already resolved one.
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { resolveAttribution } = require('../services/acquisition/attributionResolver');

describe('Phase P.1G.3A ADDENDUM — resolveAttribution() Telegram Mini App tier', () => {
    it('records source_platform=telegram when isTelegramWebApp is true and nothing else resolved', async () => {
        const attribution = await resolveAttribution({ isTelegramWebApp: true });
        assert.equal(attribution.source_platform, 'telegram');
        assert.equal(attribution.source_medium, 'messenger');
        assert.equal(attribution.attribution_type, 'direct_organic');
        assert.equal(attribution.is_direct, false);
    });

    it('falls back to plain direct when isTelegramWebApp is false/absent and nothing else resolved', async () => {
        const withFalse = await resolveAttribution({ isTelegramWebApp: false });
        assert.equal(withFalse.source_platform, 'direct');
        assert.equal(withFalse.is_direct, true);

        const withAbsent = await resolveAttribution({});
        assert.equal(withAbsent.source_platform, 'direct');
    });

    it('a real UTM signal takes priority over isTelegramWebApp (UTM is more specific)', async () => {
        const attribution = await resolveAttribution({
            isTelegramWebApp: true,
            utm: { utm_source: 'instagram', utm_medium: 'paid_social' }
        });
        assert.equal(attribution.source_platform, 'instagram');
        assert.equal(attribution.attribution_confidence, 'unverified_utm');
    });

    it('only a strict boolean true triggers the tier - a truthy string does not, since callers must coerce with === true', async () => {
        const attribution = await resolveAttribution({ isTelegramWebApp: 'true' });
        assert.equal(attribution.source_platform, 'direct', 'resolveAttribution itself does not loosely coerce - callers (routes/acquisition.js) are responsible for the === true coercion from request bodies');
    });
});
