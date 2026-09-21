/**
 * tests/phase_p2_7_atomic_update_time_type_fix.test.js
 *
 * PHASE P.2.7 — DIAGNOSE ATOMIC TRIP UPDATE FAILURE
 *
 * Root cause: fn_atomic_bus_trip_update (defined in
 * supabase/migrations/20260918184834_fix_bus_trip_notification_outbox_recipient_key.sql,
 * confirmed byte-identical to the live production function via read-only
 * introspection) contains three text/time/jsonb type mismatches that abort
 * EVERY trip update that reaches them — not specific to trip 75, price, or
 * bus assignment — Postgres validates COALESCE/CASE branch types when the
 * statement first executes, independent of which runtime value is chosen:
 *
 *   1. v_departure_time := COALESCE(p_update_data->>'departure_time',
 *        v_ticket.departure_time, '00:00:00')
 *      -- v_ticket.departure_time is `time without time zone`, the other
 *      -- two arguments are `text`. Real production error, captured via
 *      -- read-only postgres_logs during the actual failed smoke test on
 *      -- trip id=75 (2026-09-21 20:32:06 UTC):
 *      --   42804: COALESCE types text and time without time zone cannot
 *      --   be matched
 *   2. arrival_time = COALESCE(p_update_data->>'arrival_time', arrival_time)
 *      -- same clash, the bare column reference in the UPDATE ... SET list.
 *   3. reserved_seats = CASE WHEN ... THEN v_sync_reserved_seats ELSE
 *        reserved_seats END
 *      -- v_sync_reserved_seats is INTEGER[], bus_tickets.reserved_seats is
 *      -- jsonb: "CASE types jsonb and integer[] cannot be matched".
 *
 * This was unreachable until now because two independent, earlier bugs
 * (P.2.5's unguarded service-role client, P.2.6's missing
 * checkBusScheduleConflict import) prevented any bus-replacement request
 * from ever reaching this RPC call. Fixed together in
 * supabase/migrations/20260921203500_fix_bus_trip_update_time_type_mismatches.sql
 * (NOT applied to production by this phase — diagnostic + local-fix only).
 *
 * This suite proves BOTH halves against a REAL local Postgres 16 instance
 * (not a JS-level mock — this bug is a genuine SQL type-system error that
 * no JS-level fake of the RPC's contract could ever reproduce):
 *   (a) the ORIGINAL function body genuinely throws 42804 on a
 *       production-shaped trip-75 fixture (bus_id NULL -> Fleet bus,
 *       price 840 -> 700, 5 confirmed bookings, double-decker 78 seats);
 *   (b) the NEW migration's function body succeeds on the exact same
 *       fixture and call, correctly updates bus_id/price, and leaves all
 *       5 existing booking prices and seats untouched.
 *
 * Requires a local Postgres reachable via `psql` (peer auth as the
 * `postgres` OS role, or trust auth as the current user) — skips cleanly
 * with an explicit message if neither is available, exactly like this
 * repo's other environment-gated suites (e.g. phase_e48_6_smartpay_
 * hardening.test.js, which needs a real SUPABASE_URL). A skip here is
 * never a regression; it just means this environment cannot exercise a
 * real Postgres instance.
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const DB_NAME = 'p2_7_test_repro';
const SCHEMA_SQL = `
CREATE TABLE public.bus_tickets (
    id INTEGER PRIMARY KEY,
    operator_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    from_city TEXT, to_city TEXT, from_address TEXT, to_address TEXT,
    departure_date DATE, departure_time TIME WITHOUT TIME ZONE,
    arrival_date DATE, arrival_time TIME WITHOUT TIME ZONE,
    duration_minutes INTEGER, price INTEGER, premium_price INTEGER,
    bus_type TEXT, total_seats INTEGER, floor1_seats INTEGER, floor2_seats INTEGER,
    bus_id BIGINT, reserved_seats JSONB, intermediate_stops JSONB, photos JSONB,
    passenger_comments TEXT, group_leader_name TEXT, group_leader_phone TEXT, group_leader_whatsapp TEXT
);
CREATE TABLE public.bus_ticket_bookings (
    id INTEGER PRIMARY KEY, bus_ticket_id INTEGER NOT NULL, status TEXT NOT NULL,
    seat_numbers VARCHAR, total_price INTEGER, hold_expires_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE public.bus_ticket_change_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), bus_ticket_id INTEGER NOT NULL, operator_id INTEGER NOT NULL,
    changed_by INTEGER, change_type TEXT, old_values JSONB, new_values JSONB, changed_fields TEXT[],
    idempotency_key TEXT, created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (operator_id, bus_ticket_id, idempotency_key)
);
CREATE TABLE public.carrier_activity_logs (
    id SERIAL PRIMARY KEY, carrier_id INTEGER, actor_user_id INTEGER, actor_role TEXT, actor_name TEXT,
    action TEXT, entity_type TEXT, entity_id TEXT, entity_label TEXT, old_data JSONB, new_data JSONB,
    metadata JSONB, created_at TIMESTAMPTZ
);
CREATE TABLE public.bus_ticket_notification_outbox (
    id SERIAL PRIMARY KEY, event_id UUID, booking_id INTEGER, recipient_user_id INTEGER,
    recipient_telegram_id BIGINT, channel TEXT, language TEXT, payload JSONB, status TEXT,
    CONSTRAINT uq_bus_ticket_notif_outbox_event_booking_channel_recipient
        UNIQUE (event_id, booking_id, channel, recipient_user_id, recipient_telegram_id)
);
DO $$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF;
END $$;
`;

const FIXTURE_SQL = `
INSERT INTO public.bus_tickets (id, operator_id, status, from_city, to_city, from_address, to_address, departure_date, departure_time, arrival_date, arrival_time, duration_minutes, price, premium_price, bus_type, total_seats, floor1_seats, floor2_seats, bus_id, reserved_seats, intermediate_stops, photos)
VALUES (75, 11, 'active', 'Худжанд (TJ)', 'Нижневартовск (РФ)', 'addr1', 'addr2', '2026-09-23', '18:00:00', '2026-09-26', '18:00:00', 4320, 840, NULL, 'double', 78, 22, 56, NULL, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb);
INSERT INTO public.bus_ticket_bookings (id, bus_ticket_id, status, seat_numbers, total_price, hold_expires_at, created_at) VALUES
(456, 75, 'confirmed', '[1]', 840, NULL, NOW()),
(459, 75, 'confirmed', '[2]', 840, NULL, NOW()),
(460, 75, 'confirmed', '[4]', 840, NULL, NOW()),
(461, 75, 'confirmed', '[3]', 840, NULL, NOW()),
(462, 75, 'confirmed', '[30]', 840, NULL, NOW());
`;

function callSql(idempotencyKey) {
    return `SELECT public.fn_atomic_bus_trip_update(
        75, 11,
        '{"from_city":"Худжанд (TJ)","to_city":"Нижневартовск (РФ)","departure_date":"2026-09-23","departure_time":"18:00","arrival_date":"2026-09-26","arrival_time":"18:00","duration_minutes":4320,"price":700,"bus_type":"double","bus_id":1,"total_seats":78,"floor1_seats":22,"floor2_seats":56,"idempotency_key":"${idempotencyKey}"}'::jsonb,
        '[]'::jsonb,
        '{"changed_by":11,"change_type":"schedule_update","old_values":{"bus_id":null,"price":840},"new_values":{"bus_id":1,"price":700},"changed_fields":["bus_id","price"],"idempotency_key":"${idempotencyKey}","actor_role":"owner","actor_name":"Carrier Owner"}'::jsonb,
        '[]'::jsonb
    ) AS result;`;
}

function detectPsql() {
    try {
        execFileSync('su', ['postgres', '-c', 'psql -tAc "SELECT 1"'], { stdio: 'pipe', timeout: 5000 });
        return 'su-postgres';
    } catch (_) { /* fall through */ }
    try {
        execFileSync('psql', ['-tAc', 'SELECT 1'], { stdio: 'pipe', timeout: 5000 });
        return 'direct';
    } catch (_) { /* fall through */ }
    return null;
}

function runSql(db, sql) {
    const args = db ? ['-d', db, '-v', 'ON_ERROR_STOP=1'] : ['-v', 'ON_ERROR_STOP=1'];
    if (PSQL_MODE === 'su-postgres') {
        const escaped = sql.replace(/'/g, `'\\''`);
        return execFileSync('su', ['postgres', '-c', `psql ${args.join(' ')} -c '${escaped}'`], { encoding: 'utf8', timeout: 20000 });
    }
    return execFileSync('psql', [...args, '-c', sql], { encoding: 'utf8', timeout: 20000 });
}

function dropDb() {
    try {
        if (PSQL_MODE === 'su-postgres') {
            execFileSync('su', ['postgres', '-c', `psql -c 'DROP DATABASE IF EXISTS ${DB_NAME};'`], { stdio: 'pipe', timeout: 10000 });
        } else {
            execFileSync('psql', ['-c', `DROP DATABASE IF EXISTS ${DB_NAME};`], { stdio: 'pipe', timeout: 10000 });
        }
    } catch (_) { /* best-effort cleanup */ }
}

function createDb() {
    if (PSQL_MODE === 'su-postgres') {
        execFileSync('su', ['postgres', '-c', `psql -c 'CREATE DATABASE ${DB_NAME};'`], { stdio: 'pipe', timeout: 10000 });
    } else {
        execFileSync('psql', ['-c', `CREATE DATABASE ${DB_NAME};`], { stdio: 'pipe', timeout: 10000 });
    }
}

function extractFunctionBody(migrationRelPath) {
    const migPath = path.resolve(__dirname, '..', migrationRelPath);
    const src = fs.readFileSync(migPath, 'utf8');
    const start = src.indexOf('CREATE OR REPLACE FUNCTION public.fn_atomic_bus_trip_update');
    assert.ok(start >= 0, `${migrationRelPath} must define fn_atomic_bus_trip_update`);
    const end = src.indexOf('GRANT EXECUTE ON FUNCTION public.fn_atomic_bus_trip_update', start);
    assert.ok(end > start, `${migrationRelPath} must GRANT EXECUTE after the function body`);
    const revokeIdx = src.lastIndexOf('REVOKE ALL ON FUNCTION public.fn_atomic_bus_trip_update', end);
    return src.slice(start, revokeIdx >= 0 ? revokeIdx : end);
}

// Detected synchronously at module load (not inside a before() hook): the
// `it(...)` calls below register synchronously too, and node:test's `skip`
// option needs a concrete boolean/string at registration time, not a
// function evaluated later.
const PSQL_MODE = detectPsql();
const SKIP_REASON = PSQL_MODE ? false : 'no local Postgres reachable via psql in this environment (neither peer auth as the postgres OS role nor as the current user) — not a regression, this suite requires a real local Postgres instance';

describe('Phase P.2.7 — fn_atomic_bus_trip_update time/jsonb type-mismatch fix (real Postgres)', () => {
    it('A: the ORIGINAL (currently-live) function body throws 42804 on the exact trip-75-shaped production request', { skip: SKIP_REASON }, () => {
        dropDb();
        createDb();
        try {
            runSql(DB_NAME, SCHEMA_SQL);
            runSql(DB_NAME, extractFunctionBody('supabase/migrations/20260918184834_fix_bus_trip_notification_outbox_recipient_key.sql'));
            runSql(DB_NAME, FIXTURE_SQL);
            let threw = null;
            try {
                runSql(DB_NAME, callSql('p27-repro-a'));
            } catch (e) {
                threw = String(e.stdout || '') + String(e.stderr || '') + String(e.message || '');
            }
            assert.ok(threw, 'the original function must fail for this request — if it did not, the root cause is no longer reproducible and this test needs re-investigation');
            assert.match(threw, /COALESCE types text and time without time zone cannot be matched/);
            const ticketAfter = runSql(DB_NAME, 'SELECT bus_id, price FROM bus_tickets WHERE id=75;');
            assert.ok(/\|\s*840/.test(ticketAfter), 'no partial mutation: price must remain 840 after the failed attempt');
        } finally {
            dropDb();
        }
    });

    it('B: the FIXED migration succeeds on the identical request, updates bus_id+price, and preserves every existing booking price/seat', { skip: SKIP_REASON }, () => {
        dropDb();
        createDb();
        try {
            runSql(DB_NAME, SCHEMA_SQL);
            runSql(DB_NAME, extractFunctionBody('supabase/migrations/20260918184834_fix_bus_trip_notification_outbox_recipient_key.sql'));
            runSql(DB_NAME, extractFunctionBody('supabase/migrations/20260921203500_fix_bus_trip_update_time_type_mismatches.sql'));
            runSql(DB_NAME, FIXTURE_SQL);

            const result = runSql(DB_NAME, callSql('p27-repro-b'));
            assert.match(result, /"success": ?true/);

            const ticketAfter = runSql(DB_NAME, 'SELECT bus_id, price FROM bus_tickets WHERE id=75;');
            assert.match(ticketAfter, /\|\s*700/);
            assert.match(ticketAfter, /^\s*1\s*\|/m);

            const bookingsAfter = runSql(DB_NAME, 'SELECT total_price FROM bus_ticket_bookings WHERE bus_ticket_id=75;');
            const prices = bookingsAfter.match(/^\s*\d+\s*$/gm) || [];
            assert.equal(prices.length, 5, 'expected 5 booking price rows');
            prices.forEach(p => assert.equal(p.trim(), '840', 'every existing booking must keep its original price snapshot'));

            const seatsAfter = runSql(DB_NAME, "SELECT seat_numbers FROM bus_ticket_bookings WHERE bus_ticket_id=75 ORDER BY id;");
            assert.match(seatsAfter, /\[1\]/);
            assert.match(seatsAfter, /\[30\]/);
        } finally {
            dropDb();
        }
    });
});
