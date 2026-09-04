/**
 * tests/phase_e47_8_1_maintenance_auth_hardening.test.js
 *
 * PHASE E.47.8.1 — Maintenance Auth Hardening / Remove Public Header Dependency
 *
 * Originally verified a narrow exemption carving POST
 * /api/admin/maintenance/tick out of a global x-mana-man header check.
 * Superseded: a later commit ("security: remove legacy public header
 * authorization") removed the x-mana-man middleware from index.js entirely
 * (across backend, frontend, and mobile), confirmed via Phase P.1G.3's
 * recovery audit — there is no global header check left to test an
 * exemption against, so those tests were retired rather than kept passing
 * against a mechanism that no longer exists. adminAuth (X-Admin-Token /
 * ADMIN_SECRET_TOKEN) remains the endpoint's real authorization boundary,
 * exercised directly in tests/phase_e47_7_2_maintenance_tick.test.js and
 * tests/phase_e48_7_legacy_header_removal.test.js.
 *
 * What remains here: cross-cutting regression checks unrelated to the
 * retired auth mechanism, kept as a general safety net for this area.
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
    isTripEligibleForAutoComplete,
    isPostWatermarkTrip,
    AUTO_COMPLETE_WATERMARK_AT,
    AUTO_COMPLETE_GRACE_MS
} = require('../utils/tripCompletionHelper');
const { generateTicketVerificationToken } = require('../utils/ticketHelper');
const { evaluateAutoClaimEligibility } = require('../utils/claimHelper');
const { runMaintenanceTick } = require('../utils/maintenanceHelper');

describe('Phase E.47.8.1 — cross-cutting regressions unaffected', () => {
    it('H. maintenance dry_run is still provably mutation-free (unrelated to the auth change)', async () => {
        const trip = { id: 1, operator_id: 1, status: 'active', created_at: '2026-09-01T00:00:00.000Z', arrival_date: '2020-01-01', arrival_time: '00:00:00' };
        const mockDb = {
            from(table) {
                const builder = {
                    select: () => builder,
                    eq: () => builder,
                    then(resolve) {
                        if (table === 'bus_tickets') return resolve({ data: [trip], error: null });
                        return resolve({ data: [], error: null });
                    }
                };
                return builder;
            }
        };
        const result = await runMaintenanceTick({ dryRun: true, dbClient: mockDb });
        assert.strictEqual(result.tasks.auto_complete.dry_run, true);
        assert.strictEqual(trip.status, 'active', 'dry_run must never mutate');
    });

    it('I. watermark unchanged', () => {
        assert.strictEqual(AUTO_COMPLETE_WATERMARK_AT.toISOString(), '2026-08-15T00:00:00.000Z');
        assert.strictEqual(isPostWatermarkTrip({ created_at: '2026-08-06T17:31:56.000Z' }), false);
        assert.strictEqual(isPostWatermarkTrip({ created_at: '2026-08-29T10:20:00.000Z' }), true);
    });

    it('J. arrival + 12h grace unchanged', () => {
        assert.strictEqual(AUTO_COMPLETE_GRACE_MS, 12 * 60 * 60 * 1000);
        const trip = { status: 'active', created_at: '2026-09-01T00:00:00.000Z', arrival_date: '2026-09-01', arrival_time: '13:00:00' };
        const arrival = new Date('2026-09-01T08:00:00.000Z'); // 13:00 Asia/Dushanbe (UTC+5) -> 08:00 UTC
        const justBefore = new Date(arrival.getTime() + 12 * 3600 * 1000 - 1000);
        const justAfter = new Date(arrival.getTime() + 12 * 3600 * 1000 + 1000);
        assert.strictEqual(isTripEligibleForAutoComplete(trip, justBefore), false);
        assert.strictEqual(isTripEligibleForAutoComplete(trip, justAfter), true);
    });

    it('K. atomic RPC completion path unchanged (structural)', () => {
        const helperSource = fs.readFileSync(path.resolve(__dirname, '../utils/tripCompletionHelper.js'), 'utf8');
        assert.ok(helperSource.includes("db.rpc('fn_complete_bus_trip'"));
    });

    it('L. E45 unified verified-phone auto-claim unchanged', () => {
        const verifiedUser = { id: 1121, telegram_id: '99887766', phone: '+992900000000', name: 'Test Passenger' };
        const familyGroupBooking = {
            id: 504, status: 'confirmed', claim_status: null, claimed_by_user_id: null,
            phone: '+992900000000', contact_role: 'family_or_group'
        };
        const res = evaluateAutoClaimEligibility(familyGroupBooking, verifiedUser, {}, '99887766');
        assert.strictEqual(res.canAutoClaim, true);
        assert.strictEqual(res.method, 'known_user_phone_match');
    });

    it('M. QR scanner / Ticket V1.1 verification token derivation unchanged', () => {
        const a = generateTicketVerificationToken(72001);
        const b = generateTicketVerificationToken(72001);
        assert.strictEqual(a, b);
    });
});
