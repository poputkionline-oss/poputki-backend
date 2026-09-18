/**
 * tests/phase_bus_trip_outbox_recipient_fanout_fix.test.js
 *
 * POPUTKI.ONLINE — corrective migration
 * docs/migrations/20260918143630_fix_bus_trip_notification_outbox_recipient_key.sql
 * for docs/migrations/20260906_bus_trip_change_outbox.sql.
 *
 * Read-only audit finding (prior turn): bus_ticket_notification_outbox's
 * original UNIQUE (event_id, booking_id, channel) constraint does not
 * include the recipient. routes/busAdmin.js's PUT /tickets/:id inserts one
 * outbox row per RECIPIENT of a booking (the legacy claimed_by_user_id/
 * passenger_id owner, plus one row per active booking_followers row), all
 * sharing the same event_id+booking_id+channel for a single trip-change
 * event — so the old `ON CONFLICT (event_id, booking_id, channel) DO
 * NOTHING` silently dropped every recipient after the first.
 *
 * This suite mirrors that INSERT loop's real Postgres behavior in
 * better-sqlite3 (same technique as
 * tests/phase_bus_trip_edit_atomicity_and_worker.test.js), using the same
 * GENERATED ALWAYS AS (...) STORED + multi-column UNIQUE + ON CONFLICT
 * mechanics the real migration uses — SQLite and Postgres agree on both
 * generated-column and NULL-in-UNIQUE semantics, so this is a faithful
 * mirror, not just an approximation. The authoritative check is a separate,
 * direct psql run against real PostgreSQL 16 (see the audit report); this
 * suite exists so the regression stays covered by `node --test` going
 * forward.
 *
 * Also covers requirement #6: renderTripChangeMessage() gains a dedicated
 * line when bus_id/bus_type changes (previously changedFields tracked the
 * change but no template branch ever rendered it).
 */

const test = require('node:test');
const { describe, it } = test;
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-key-poputki-hmac-2026-secure';
process.env.FRONTEND_URL = process.env.FRONTEND_URL || 'https://www.poputki.online';

const { renderTripChangeMessage } = require('../utils/tripChangeNotificationService');

// =============================================================================
// SQLite mirror of bus_ticket_notification_outbox post-fix, and of the
// relevant slice of fn_atomic_bus_trip_update's outbox insert loop.
// =============================================================================
function setupOutboxDb() {
    const db = new Database(':memory:');
    db.exec(`
        CREATE TABLE bus_ticket_change_events (
            id TEXT PRIMARY KEY,
            idempotency_key TEXT UNIQUE
        );

        CREATE TABLE bus_ticket_notification_outbox (
            id TEXT PRIMARY KEY,
            event_id TEXT NOT NULL REFERENCES bus_ticket_change_events(id),
            booking_id INTEGER NOT NULL,
            recipient_user_id INTEGER,
            recipient_telegram_id INTEGER,
            channel TEXT NOT NULL DEFAULT 'telegram',
            payload TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            -- Mirrors: GENERATED ALWAYS AS (COALESCE(recipient_user_id::text, 'legacy:' || booking_id::text)) STORED
            recipient_key TEXT GENERATED ALWAYS AS (
                COALESCE(recipient_user_id, 'legacy:' || booking_id)
            ) STORED,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            -- Mirrors: uq_bus_ticket_notif_outbox_event_booking_channel_recipient
            UNIQUE (event_id, booking_id, channel, recipient_key)
        );
    `);
    return db;
}

/**
 * Mirrors fn_atomic_bus_trip_update's step 9 (outbox insert loop), post-fix:
 * one INSERT per outbox entry, ON CONFLICT on the new recipient-aware key.
 */
function insertOutboxEntries(db, eventId, entries) {
    const stmt = db.prepare(`
        INSERT INTO bus_ticket_notification_outbox
            (id, event_id, booking_id, recipient_user_id, recipient_telegram_id, channel, payload, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (event_id, booking_id, channel, recipient_key) DO NOTHING
    `);
    entries.forEach((e, i) => {
        stmt.run(
            `outbox-${eventId}-${i}-${Math.random()}`,
            eventId,
            e.booking_id,
            e.recipient_user_id ?? null,
            e.recipient_telegram_id ?? null,
            e.channel || 'telegram',
            JSON.stringify(e.payload || {}),
            e.status || 'pending'
        );
    });
}

function survivingRows(db, eventId) {
    return db.prepare('SELECT recipient_user_id, recipient_key, payload FROM bus_ticket_notification_outbox WHERE event_id = ? ORDER BY recipient_key').all(eventId)
        .map(r => ({ ...r, payload: JSON.parse(r.payload) }));
}

describe('bus_ticket_notification_outbox recipient fan-out fix', () => {

    it('1. legacy owner + one follower on the same event -> TWO independent rows (was: only the first survived)', () => {
        const db = setupOutboxDb();
        db.prepare('INSERT INTO bus_ticket_change_events (id) VALUES (?)').run('evt-1');

        insertOutboxEntries(db, 'evt-1', [
            { booking_id: 900, recipient_user_id: 1, recipient_telegram_id: 111, payload: { who: 'owner' } },
            { booking_id: 900, recipient_user_id: 2, recipient_telegram_id: 222, payload: { who: 'followerA' } }
        ]);

        const rows = survivingRows(db, 'evt-1');
        assert.equal(rows.length, 2, 'both the legacy owner and the follower must have their own outbox row');
        assert.deepEqual(rows.map(r => r.payload.who).sort(), ['followerA', 'owner']);
    });

    it('2. two followers (no claimed legacy owner) on the same event -> TWO independent rows, legacy slot allowed to be null-recipient once', () => {
        const db = setupOutboxDb();
        db.prepare('INSERT INTO bus_ticket_change_events (id) VALUES (?)').run('evt-2');

        insertOutboxEntries(db, 'evt-2', [
            { booking_id: 901, recipient_user_id: null, recipient_telegram_id: null, payload: { who: 'legacy-unreachable' }, status: 'unreachable' },
            { booking_id: 901, recipient_user_id: 2, recipient_telegram_id: 222, payload: { who: 'followerA' } },
            { booking_id: 901, recipient_user_id: 3, recipient_telegram_id: 333, payload: { who: 'followerB' } }
        ]);

        const rows = survivingRows(db, 'evt-2');
        assert.equal(rows.length, 3, 'the null-recipient legacy slot and both followers must all survive');
        assert.deepEqual(rows.map(r => r.payload.who).sort(), ['followerA', 'followerB', 'legacy-unreachable']);
    });

    it('3. one user simultaneously owner and follower of the SAME booking -> ONE row survives (defense-in-depth if JS dedup were ever bypassed)', () => {
        const db = setupOutboxDb();
        db.prepare('INSERT INTO bus_ticket_change_events (id) VALUES (?)').run('evt-3');

        // In production this never happens because
        // utils/notificationRecipientDedup.js already collapses the two
        // slots into one entry before the RPC is ever called. This test
        // proves the DB-level constraint independently enforces the same
        // invariant if that JS dedup step were ever skipped or buggy.
        insertOutboxEntries(db, 'evt-3', [
            { booking_id: 900, recipient_user_id: 1, recipient_telegram_id: 111, payload: { who: 'owner-slot' } },
            { booking_id: 900, recipient_user_id: 1, recipient_telegram_id: 111, payload: { who: 'follower-slot-same-user' } }
        ]);

        const rows = survivingRows(db, 'evt-3');
        assert.equal(rows.length, 1, 'the same recipient must never get two outbox rows for one booking+event');
        assert.equal(rows[0].recipient_user_id, 1);
    });

    it('4. re-posting the same event/recipient pair is a no-op (idempotent requeue)', () => {
        const db = setupOutboxDb();
        db.prepare('INSERT INTO bus_ticket_change_events (id) VALUES (?)').run('evt-4');

        insertOutboxEntries(db, 'evt-4', [
            { booking_id: 900, recipient_user_id: 1, recipient_telegram_id: 111, payload: { who: 'owner', attempt: 1 } }
        ]);
        // Simulates a retried caller re-submitting the exact same
        // (event_id, booking_id, channel, recipient) tuple.
        insertOutboxEntries(db, 'evt-4', [
            { booking_id: 900, recipient_user_id: 1, recipient_telegram_id: 111, payload: { who: 'owner', attempt: 2 } }
        ]);

        const rows = survivingRows(db, 'evt-4');
        assert.equal(rows.length, 1, 'requeuing the same event+recipient must not create a duplicate row');
        assert.equal(rows[0].payload.attempt, 1, 'the original row must be kept, not overwritten by the replay');
    });

    it('5. a delivery failure recorded on one recipient row never touches another recipient row for the same event', () => {
        const db = setupOutboxDb();
        db.prepare('INSERT INTO bus_ticket_change_events (id) VALUES (?)').run('evt-5');

        insertOutboxEntries(db, 'evt-5', [
            { booking_id: 900, recipient_user_id: 1, recipient_telegram_id: 111, payload: { who: 'owner' } },
            { booking_id: 900, recipient_user_id: 2, recipient_telegram_id: 222, payload: { who: 'followerA' } }
        ]);

        // Independent per-row status transitions, exactly as the real
        // worker (fn_claim_bus_trip_notification_batch + per-row UPDATE)
        // would apply them — one row at a time, keyed by its own id.
        db.prepare(`UPDATE bus_ticket_notification_outbox SET status = 'sent' WHERE event_id = ? AND recipient_user_id = 1`).run('evt-5');
        db.prepare(`UPDATE bus_ticket_notification_outbox SET status = 'unreachable', payload = ? WHERE event_id = ? AND recipient_user_id = 2`)
            .run(JSON.stringify({ who: 'followerA', error: 'TELEGRAM_BOT_BLOCKED_BY_USER' }), 'evt-5');

        const statuses = db.prepare('SELECT recipient_user_id, status FROM bus_ticket_notification_outbox WHERE event_id = ? ORDER BY recipient_user_id').all('evt-5');
        assert.deepEqual(statuses, [
            { recipient_user_id: 1, status: 'sent' },
            { recipient_user_id: 2, status: 'unreachable' }
        ]);
    });
});

// =============================================================================
// Requirement #6: bus_id/bus_type change gets its own message line.
// =============================================================================
describe('renderTripChangeMessage() — vehicle (bus_id/bus_type) change text', () => {
    const trip = { from_city: 'Душанбе', to_city: 'Худжанд' };
    const booking = { id: 900, seat_numbers: [5] };

    it('1. RU: bus_type change produces a vehicle-changed line', () => {
        const rendered = renderTripChangeMessage({
            language: 'ru', trip, booking,
            changes: { changedFields: ['bus_type'], oldValues: { bus_type: 'single' }, newValues: { bus_type: 'double' } }
        });
        assert.match(rendered.text, /Автобус.*замен/i);
    });

    it('2. RU: bus_id change alone (bus_type unchanged) also produces the vehicle-changed line', () => {
        const rendered = renderTripChangeMessage({
            language: 'ru', trip, booking,
            changes: { changedFields: ['bus_id'], oldValues: { bus_id: 5 }, newValues: { bus_id: 9 } }
        });
        assert.match(rendered.text, /Автобус.*замен/i);
    });

    it('3. TJ: bus_type change produces a vehicle-changed line', () => {
        const rendered = renderTripChangeMessage({
            language: 'tj', trip, booking,
            changes: { changedFields: ['bus_type'], oldValues: {}, newValues: {} }
        });
        assert.match(rendered.text, /Автобус/);
    });

    it('4. UZ: bus_type change produces a vehicle-changed line', () => {
        const rendered = renderTripChangeMessage({
            language: 'uz', trip, booking,
            changes: { changedFields: ['bus_type'], oldValues: {}, newValues: {} }
        });
        assert.match(rendered.text, /Avtobus/);
    });

    it('5. No bus_id/bus_type in changedFields -> no vehicle line rendered', () => {
        const rendered = renderTripChangeMessage({
            language: 'ru', trip, booking,
            changes: { changedFields: ['departure_time'], oldValues: { departure_time: '08:00' }, newValues: { departure_time: '09:00' } }
        });
        assert.doesNotMatch(rendered.text, /Автобус/);
    });

    it('6. Vehicle line coexists with a date/time change line in the same message', () => {
        const rendered = renderTripChangeMessage({
            language: 'ru', trip, booking,
            changes: {
                changedFields: ['departure_time', 'bus_type'],
                oldValues: { departure_time: '08:00:00', bus_type: 'single' },
                newValues: { departure_time: '09:00:00', bus_type: 'double' }
            }
        });
        assert.match(rendered.text, /Дата и время/);
        assert.match(rendered.text, /Автобус/);
    });
});
