/**
 * phase_subscription_model_notification_dedup.test.js
 *
 * POPUTKI.ONLINE — recipient deduplication across passenger_id /
 * claimed_by_user_id / booking_followers, ahead of Phase 7's trip-change
 * notification fan-out integration (not yet wired into
 * utils/tripChangeNotificationService.js — see module doc comment).
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { dedupeNotificationRecipients, buildNotificationCandidates } = require('../utils/notificationRecipientDedup');

describe('dedupeNotificationRecipients', () => {
    it('same user_id via claimed_by_user_id AND booking_followers -> notified once', () => {
        const result = dedupeNotificationRecipients([
            { userId: 5, source: 'claimed_by_user_id' },
            { userId: 5, source: 'booking_followers' }
        ]);
        assert.equal(result.length, 1);
        assert.equal(result[0].userId, 5);
        assert.equal(result[0].source, 'claimed_by_user_id'); // first-seen wins
    });

    it('distinct users are all kept', () => {
        const result = dedupeNotificationRecipients([
            { userId: 2, source: 'passenger_id' },
            { userId: 3, source: 'booking_followers' },
            { userId: 4, source: 'booking_followers' }
        ]);
        assert.equal(result.length, 3);
    });

    it('numeric and string forms of the same id are treated as one user', () => {
        const result = dedupeNotificationRecipients([
            { userId: 7, source: 'passenger_id' },
            { userId: '7', source: 'booking_followers' }
        ]);
        assert.equal(result.length, 1);
    });

    it('null/undefined userId entries are dropped, never throw', () => {
        const result = dedupeNotificationRecipients([
            { userId: null, source: 'x' },
            { userId: undefined, source: 'y' },
            { userId: 1, source: 'passenger_id' }
        ]);
        assert.equal(result.length, 1);
    });

    it('non-array input returns [] rather than throwing', () => {
        assert.deepEqual(dedupeNotificationRecipients(null), []);
        assert.deepEqual(dedupeNotificationRecipients(undefined), []);
        assert.deepEqual(dedupeNotificationRecipients('not an array'), []);
    });
});

describe('buildNotificationCandidates', () => {
    it('a booking with claimed_by_user_id AND an unrelated follower notifies both, once each', () => {
        const booking = { claimed_by_user_id: 5, passenger_id: 1 };
        const followers = [{ user_id: 3, notifications_enabled: true }];
        const result = buildNotificationCandidates(booking, followers);
        const ids = result.map(r => r.userId).sort();
        assert.deepEqual(ids, [1, 3, 5]);
    });

    it('a follower who disabled notifications is excluded entirely', () => {
        const booking = { claimed_by_user_id: null, passenger_id: 1 };
        const followers = [{ user_id: 3, notifications_enabled: false }];
        const result = buildNotificationCandidates(booking, followers);
        assert.deepEqual(result.map(r => r.userId), [1]);
    });

    it('the same person as both claimed_by_user_id and a follower is notified exactly once', () => {
        const booking = { claimed_by_user_id: 9, passenger_id: 1 };
        const followers = [{ user_id: 9, notifications_enabled: true }];
        const result = buildNotificationCandidates(booking, followers);
        assert.equal(result.filter(r => r.userId === 9).length, 1);
    });

    it('manual booking with no claimed_by_user_id and no passenger yields only followers', () => {
        const booking = { claimed_by_user_id: null, passenger_id: null };
        const followers = [{ user_id: 2, notifications_enabled: true }, { user_id: 3, notifications_enabled: true }];
        const result = buildNotificationCandidates(booking, followers);
        assert.deepEqual(result.map(r => r.userId).sort(), [2, 3]);
    });
});
