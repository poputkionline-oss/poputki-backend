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
    it('a booking with claimed_by_user_id AND an unrelated follower notifies both, once each (passenger_id is a fallback for the SAME owner slot, not a second recipient, when claimed_by_user_id is already set)', () => {
        const booking = { claimed_by_user_id: 5, passenger_id: 1 };
        const followers = [{ user_id: 3, notifications_enabled: true }];
        const result = buildNotificationCandidates(booking, followers);
        const ids = result.map(r => r.userId).sort();
        assert.deepEqual(ids, [3, 5]);
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

    it('passenger_id and claimed_by_user_id identical (same person): exactly one notification, not two', () => {
        const booking = { claimed_by_user_id: 7, passenger_id: 7 };
        const result = buildNotificationCandidates(booking, []);
        assert.deepEqual(result.map(r => r.userId), [7]);
    });

    it('passenger_id and claimed_by_user_id DIFFERENT: still exactly one notification — for this booking model passenger_id is never an independently legitimate second addressee once claimed_by_user_id is set (it is the carrier\'s own surrogate id at manual-booking creation time, not a second real person; claiming a booking is a full ownership handoff, not an addition) — never merge them by any other means (phone/name/role), simply never treat passenger_id as live once claimed_by_user_id exists', () => {
        const booking = { claimed_by_user_id: 5, passenger_id: 1 };
        const result = buildNotificationCandidates(booking, []);
        assert.deepEqual(result.map(r => r.userId), [5]);
        assert.equal(result.length, 1);
    });

    it('a follower who IS the passenger_id (booking not yet claimed): exactly one notification, not two', () => {
        const booking = { claimed_by_user_id: null, passenger_id: 4 };
        const followers = [{ user_id: 4, notifications_enabled: true }];
        const result = buildNotificationCandidates(booking, followers);
        assert.deepEqual(result.map(r => r.userId), [4]);
    });

    it('two DIFFERENT followers on an unclaimed booking with no passenger: both are notified, once each', () => {
        const booking = { claimed_by_user_id: null, passenger_id: null };
        const followers = [
            { user_id: 11, notifications_enabled: true },
            { user_id: 12, notifications_enabled: true }
        ];
        const result = buildNotificationCandidates(booking, followers);
        assert.deepEqual(result.map(r => r.userId).sort((a, b) => a - b), [11, 12]);
        assert.equal(result.length, 2, 'never collapsed into one — they are genuinely distinct people');
    });

    it('never merges two distinct followers by a shared/similar phone, name, or role — only exact userId equality dedups', () => {
        // role_declared/notes such as a matching phone or display name are
        // NOT inputs to this function at all — only user_id is compared.
        // Two different platform accounts that happen to share a phone
        // number (e.g. a family plan) must never be collapsed into one.
        const booking = { claimed_by_user_id: null, passenger_id: null };
        const followers = [
            { user_id: 21, notifications_enabled: true, role_declared: 'passenger' },
            { user_id: 22, notifications_enabled: true, role_declared: 'passenger' } // same declared role, different user
        ];
        const result = buildNotificationCandidates(booking, followers);
        assert.deepEqual(result.map(r => r.userId).sort((a, b) => a - b), [21, 22]);
    });
});
