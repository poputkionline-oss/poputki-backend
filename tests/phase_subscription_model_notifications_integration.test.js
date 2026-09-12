/**
 * phase_subscription_model_notifications_integration.test.js
 *
 * POPUTKI.ONLINE — Manual Booking Telegram Subscription Model, trip-change
 * notification fan-out integration (routes/busAdmin.js trip-edit handler).
 *
 * The trip-edit endpoint (PUT /api/bus-admin/bus-tickets/:id or similar —
 * hundreds of lines, Cloudinary/RPC/atomic-update dependencies) is already
 * tested in this repo (tests/phase_bus_trip_edit_notifications.test.js) by
 * extracting and re-testing its logic rather than driving the live route
 * end-to-end — the same convention is followed here: the real
 * buildNotificationCandidates()/dedupeNotificationRecipients() functions
 * (not a reimplementation) are exercised with realistic booking/follower
 * fixtures matching exactly what busAdmin.js constructs, plus source-level
 * checks confirming the integration point itself (gating, dedup-skip,
 * unsubscribed-exclusion) is wired the way these behavioral tests assume.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildNotificationCandidates } = require('../utils/notificationRecipientDedup');
const { processTripChangeOutbox } = require('../utils/tripChangeNotificationService');

const busAdminSource = fs.readFileSync(path.resolve(__dirname, '../routes/busAdmin.js'), 'utf-8');

describe('Trip-change notifications — 0/1/2 followers scenarios (real buildNotificationCandidates)', () => {
    it('0 followers: only the existing claimed_by_user_id/passenger_id recipient is notified (unchanged behavior)', () => {
        const booking = { claimed_by_user_id: 5, passenger_id: 1 };
        const candidates = buildNotificationCandidates(booking, []);
        assert.deepEqual(candidates.map(c => c.userId), [5]);
    });

    it('1 follower, distinct from the booking owner: both are notified, once each', () => {
        const booking = { claimed_by_user_id: 5, passenger_id: 1 };
        const followers = [{ user_id: 8, notifications_enabled: true }];
        const candidates = buildNotificationCandidates(booking, followers);
        assert.deepEqual(candidates.map(c => c.userId).sort(), [5, 8]);
    });

    it('2 followers, both distinct from the booking owner: all three notified, once each', () => {
        const booking = { claimed_by_user_id: 5, passenger_id: 1 };
        const followers = [
            { user_id: 8, notifications_enabled: true },
            { user_id: 9, notifications_enabled: true }
        ];
        const candidates = buildNotificationCandidates(booking, followers);
        assert.deepEqual(candidates.map(c => c.userId).sort(), [5, 8, 9]);
    });

    it('a follower who IS the claimed_by_user_id is not double-notified (dedup)', () => {
        const booking = { claimed_by_user_id: 5, passenger_id: 1 };
        const followers = [{ user_id: 5, notifications_enabled: true }];
        const candidates = buildNotificationCandidates(booking, followers);
        assert.equal(candidates.filter(c => c.userId === 5).length, 1);
    });

    it('an unsubscribed follower is never a candidate at all (the busAdmin.js query already filters unsubscribed_at IS NULL before this function runs)', () => {
        // busAdmin.js only ever passes ACTIVE followers into
        // buildNotificationCandidates (it filters at the query, not here) —
        // this test proves the function itself also excludes anyone marked
        // notifications_enabled:false, as a second layer of the same rule.
        const booking = { claimed_by_user_id: 5, passenger_id: 1 };
        const followers = [{ user_id: 8, notifications_enabled: false }];
        const candidates = buildNotificationCandidates(booking, followers);
        assert.deepEqual(candidates.map(c => c.userId), [5]);
    });

    it('manual booking with no claimed owner (unclaimed) still notifies its followers', () => {
        const booking = { claimed_by_user_id: null, passenger_id: null };
        const followers = [{ user_id: 8, notifications_enabled: true }, { user_id: 9, notifications_enabled: true }];
        const candidates = buildNotificationCandidates(booking, followers);
        assert.deepEqual(candidates.map(c => c.userId).sort(), [8, 9]);
    });
});

describe('routes/busAdmin.js trip-edit — integration wiring (source-level)', () => {
    const tripEditSection = busAdminSource.slice(
        busAdminSource.indexOf('// 6. Gather passenger Telegram IDs'),
        busAdminSource.indexOf('const finalIdempotencyKey')
    );

    it('booking_followers is only queried when the feature flag is enabled', () => {
        assert.match(tripEditSection, /MANUAL_BOOKING_SUBSCRIPTION_MODEL_ENABLED\s*===\s*'true'/);
        // The flag check must appear BEFORE the booking_followers query, not after
        const flagIndex = tripEditSection.indexOf("MANUAL_BOOKING_SUBSCRIPTION_MODEL_ENABLED === 'true'");
        const queryIndex = tripEditSection.indexOf("from('booking_followers')");
        assert.ok(flagIndex > -1 && queryIndex > -1 && flagIndex < queryIndex);
    });

    it('the booking_followers query filters unsubscribed_at IS NULL (unsubscribe immediately excludes)', () => {
        assert.match(tripEditSection, /from\('booking_followers'\)[\s\S]*?\.is\('unsubscribed_at',\s*null\)/);
    });

    it('followers failing to load never throws — caught and logged as non-fatal, existing recipients unaffected', () => {
        assert.match(tripEditSection, /catch\s*\(followerErr\)/);
        assert.ok(tripEditSection.includes('non-fatal'));
    });

    it('the existing claimed_by_user_id || passenger_id recipient line is untouched', () => {
        assert.match(tripEditSection, /const effectiveUserId = b\.claimed_by_user_id \|\| b\.passenger_id;/);
    });

    it('dedup: a follower candidate matching effectiveUserId is skipped before pushing an outbox row', () => {
        const loopSection = busAdminSource.slice(
            busAdminSource.indexOf('const bookingFollowers = followersByBookingId'),
            busAdminSource.indexOf('const finalIdempotencyKey')
        );
        assert.match(loopSection, /if\s*\(String\(candidate\.userId\)\s*===\s*String\(effectiveUserId\)\)\s*continue;/);
    });

    it('uses the real buildNotificationCandidates helper, not a local reimplementation', () => {
        assert.ok(busAdminSource.includes("require('../utils/notificationRecipientDedup')"));
        assert.ok(busAdminSource.includes('buildNotificationCandidates('));
    });

    it('each follower gets its own independent outbox row (one failure cannot block another recipient — inherited from the existing per-row processTripChangeOutbox loop)', () => {
        const loopSection = busAdminSource.slice(
            busAdminSource.indexOf('const bookingFollowers = followersByBookingId'),
            busAdminSource.indexOf('const finalIdempotencyKey')
        );
        assert.match(loopSection, /outboxEntries\.push\(\{/);
    });
});

describe('Feature flag = false — trip-edit notification fan-out fully reverts to pre-existing behavior', () => {
    it('followersByBookingId is initialized empty and never populated when the flag check fails', () => {
        const block = busAdminSource.slice(
            busAdminSource.indexOf('const followersByBookingId = {};'),
            busAdminSource.indexOf('const uniqueUserIds')
        );
        assert.match(block, /const followersByBookingId = \{\};/);
        assert.match(block, /if\s*\(process\.env\.MANUAL_BOOKING_SUBSCRIPTION_MODEL_ENABLED === 'true'\)\s*\{/);
    });

    it('buildNotificationCandidates called with an empty followers array reproduces the exact pre-existing single-recipient behavior', () => {
        const booking = { claimed_by_user_id: null, passenger_id: 1 };
        const candidates = buildNotificationCandidates(booking, []);
        assert.deepEqual(candidates.map(c => c.userId), [1]);
    });
});

describe('End-to-end delivery isolation: one recipient\'s outbox row failing never blocks another\'s (real processTripChangeOutbox, not a reimplementation)', () => {
    it('a malformed-payload row (the online-claim owner, say) is marked failed while a follower\'s valid row in the SAME batch is still delivered', async () => {
        // Two outbox rows for the same trip-change event, exactly as
        // routes/busAdmin.js's trip-edit handler would produce: one row
        // whose payload is missing everything processTripChangeOutbox needs
        // to render a message (simulating any real-world prep failure —
        // corrupt payload, missing trip/booking data, etc.), and one
        // follower row with a normal, valid payload.
        const rows = [
            { id: 501, booking_id: 900, recipient_user_id: 5, recipient_telegram_id: 111, status: 'pending', payload: {} },
            { id: 502, booking_id: 900, recipient_user_id: 8, recipient_telegram_id: 222, status: 'pending', payload: { text: 'Изменения в вашем рейсе' } }
        ];
        const updates = [];
        const fakeClient = {
            from() {
                return {
                    select() { return { eq() { return { limit: () => Promise.resolve({ data: rows, error: null }) }; } }; },
                    update(patch) {
                        return { eq(_field, id) { updates.push({ id, patch }); return Promise.resolve({ error: null }); } };
                    }
                };
            }
        };

        const stats = await processTripChangeOutbox({ supabaseClient: fakeClient, batchSize: 10, dryRun: true });

        assert.equal(stats.failed, 1, 'the malformed row must fail on its own');
        assert.equal(stats.sent, 1, 'the follower\'s valid row must still succeed, unaffected by the other row\'s failure');

        const row501Update = updates.find(u => u.id === 501);
        const row502Update = updates.find(u => u.id === 502);
        assert.equal(row501Update.patch.status, 'failed');
        assert.equal(row502Update.patch.status, 'sent');
    });
});
