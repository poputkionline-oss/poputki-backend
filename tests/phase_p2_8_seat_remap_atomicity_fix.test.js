/**
 * tests/phase_p2_8_seat_remap_atomicity_fix.test.js
 *
 * PHASE P.2.8 — HARDEN ATOMIC BUS TRIP UPDATE SEAT REMAP
 *
 * P.2.7 flagged, but deliberately left unfixed (out of its scope), a
 * separate bug in fn_atomic_bus_trip_update's seat-remap branch:
 * bus_ticket_bookings.seat_numbers is `character varying(100) NOT NULL`
 * holding a JSON-bracket string ("[1]", "[1,2]"), never a native Postgres
 * array ("{1,2}") — production read-only audit confirmed this format for
 * all 164 live rows, no malformed/legacy values currently exist. Reading
 * it into an INTEGER[] variable, or writing an INTEGER[] value back into
 * it, throws "malformed array literal" the moment any real
 * BUS_SEAT_REMAP_REQUIRED submission reaches the function — reproduced
 * locally with a trip-75-shaped fixture (bus A -> bus B requiring remap,
 * 5 confirmed bookings, seats 1/2/3/4/30).
 *
 * Fixing that alone, however, would have exposed a SECOND, more serious
 * bug found while validating the fix: the original remap loop applied
 * each booking's UPDATE immediately after validating it, so a later
 * booking's invalid/duplicate seat triggered a RETURN (not an exception)
 * that left EARLIER bookings' already-applied seat changes committed —
 * a genuine atomicity violation. Proven locally with a real change
 * (1->10, 2->11, 3->12 on the first three bookings) followed by an
 * invalid seat on the fourth: the first three bookings' seat_numbers
 * persisted despite the RPC reporting overall failure. Both are fixed
 * together in supabase/migrations/20260921203500_fix_bus_trip_update_
 * time_type_mismatches.sql (updated in place from its P.2.7 version, per
 * this phase's explicit instruction to extend the not-yet-released
 * migration rather than create a competing one) via a two-pass
 * validate-then-apply restructure.
 *
 * Same technique as tests/phase_p2_7_atomic_update_time_type_fix.test.js:
 * a real local Postgres 16 instance, the actual migration-sourced
 * function body, production-shaped fixtures — no JS-level reimplementation
 * of the RPC's SQL behavior. Skips cleanly if no local Postgres is
 * reachable (not a regression, matches this repo's other environment-
 * gated suites).
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const DB_NAME = 'p2_8_test_seatremap';
const MIGRATION_REL_PATH = 'supabase/migrations/20260921203500_fix_bus_trip_update_time_type_mismatches.sql';

const SCHEMA_SQL = `
CREATE TABLE public.bus_tickets (
    id INTEGER PRIMARY KEY, operator_id INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'active',
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
    seat_numbers VARCHAR(100) NOT NULL, total_price INTEGER, hold_expires_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW()
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

// Trip-75-shaped: bus A (id=5, double, 78 seats) -> bus B (id=9, single, 15
// seats, requires remap since seat 30 > 15), 5 confirmed bookings on
// seats 1/2/3/4/30, price 840.
const FIXTURE_SQL = `
INSERT INTO public.bus_tickets (id, operator_id, status, from_city, to_city, from_address, to_address, departure_date, departure_time, arrival_date, arrival_time, duration_minutes, price, premium_price, bus_type, total_seats, floor1_seats, floor2_seats, bus_id, reserved_seats, intermediate_stops, photos)
VALUES (75, 11, 'active', 'Худжанд (TJ)', 'Нижневартовск (РФ)', 'addr1', 'addr2', '2026-09-23', '18:00:00', '2026-09-26', '18:00:00', 4320, 840, NULL, 'double', 78, 22, 56, 5, '[1,2,3,4,30]'::jsonb, '[]'::jsonb, '[]'::jsonb);
INSERT INTO public.bus_ticket_bookings (id, bus_ticket_id, status, seat_numbers, total_price, hold_expires_at, created_at) VALUES
(456, 75, 'confirmed', '[1]', 840, NULL, NOW()),
(459, 75, 'confirmed', '[2]', 840, NULL, NOW()),
(460, 75, 'confirmed', '[3]', 840, NULL, NOW()),
(461, 75, 'confirmed', '[4]', 840, NULL, NOW()),
(462, 75, 'confirmed', '[30]', 840, NULL, NOW());
`;

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

const PSQL_MODE = detectPsql();
const SKIP_REASON = PSQL_MODE ? false : 'no local Postgres reachable via psql in this environment — not a regression, this suite requires a real local Postgres instance';

function runSql(db, sql, { allowError = false } = {}) {
    const args = db ? ['-d', db, '-v', 'ON_ERROR_STOP=1'] : ['-v', 'ON_ERROR_STOP=1'];
    try {
        if (PSQL_MODE === 'su-postgres') {
            const escaped = sql.replace(/'/g, `'\\''`);
            return execFileSync('su', ['postgres', '-c', `psql ${args.join(' ')} -c '${escaped}'`], { encoding: 'utf8', timeout: 20000 });
        }
        return execFileSync('psql', [...args, '-c', sql], { encoding: 'utf8', timeout: 20000 });
    } catch (e) {
        if (allowError) return String(e.stdout || '') + String(e.stderr || '') + String(e.message || '');
        throw e;
    }
}

function runFile(db, filePath) {
    const args = ['-d', db, '-v', 'ON_ERROR_STOP=1', '-f', filePath];
    if (PSQL_MODE === 'su-postgres') {
        return execFileSync('su', ['postgres', '-c', `psql ${args.join(' ')}`], { encoding: 'utf8', timeout: 20000 });
    }
    return execFileSync('psql', args, { encoding: 'utf8', timeout: 20000 });
}

function dropDb(name) {
    try { runSql(null, `DROP DATABASE IF EXISTS ${name};`); } catch (_) { /* best-effort */ }
}
function createDb(name) {
    runSql(null, `CREATE DATABASE ${name};`);
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

function setupFixedDb(name, { schema = SCHEMA_SQL, fixture = FIXTURE_SQL } = {}) {
    dropDb(name);
    createDb(name);
    runSql(name, schema);
    runSql(name, extractFunctionBody(MIGRATION_REL_PATH));
    if (fixture) runSql(name, fixture);
}

function call(name, updateData, seatRemap, eventData, idempotencyKey) {
    const sql = `SELECT public.fn_atomic_bus_trip_update(75, 11, '${JSON.stringify({ ...updateData, idempotency_key: idempotencyKey })}'::jsonb, '${JSON.stringify(seatRemap)}'::jsonb, '${JSON.stringify({ ...eventData, idempotency_key: idempotencyKey })}'::jsonb, '[]'::jsonb);`;
    return runSql(name, sql);
}

function bookings(name) {
    return runSql(name, "SELECT id, seat_numbers, total_price, status FROM bus_ticket_bookings WHERE bus_ticket_id=75 ORDER BY id;");
}
function ticket(name) {
    return runSql(name, "SELECT bus_id, price, reserved_seats FROM bus_tickets WHERE id=75;");
}

const EVT = { changed_by: 11, change_type: 'bus_replacement' };
const NEW_BUS = { bus_id: 9, bus_type: 'single', total_seats: 15, departure_time: '18:00' };

describe('Phase P.2.8 — fn_atomic_bus_trip_update seat-remap storage format + atomicity (real Postgres)', () => {
    it('0. STATIC PROOF: the migration file was extended in place (P.2.7 fixes + P.2.8 fixes both present)', () => {
        const src = extractFunctionBody(MIGRATION_REL_PATH);
        assert.ok(src.includes("v_ticket.departure_time::text"), 'P.2.7 time fix must still be present');
        assert.ok(src.includes('jsonb_array_elements_text(v_current_seats_raw::jsonb)'), 'P.2.8 storage-format fix must be present');
        assert.ok(src.includes('v_planned_updates'), 'P.2.8 two-pass atomicity fix must be present');
        assert.ok(src.includes('MALFORMED_SEAT_DATA'), 'P.2.8 fail-closed error must be present');
    });

    it('A: [1] -> [10] single-seat remap on a single-booking trip', { skip: SKIP_REASON }, () => {
        setupFixedDb(DB_NAME);
        try {
            runSql(DB_NAME, 'DELETE FROM bus_ticket_bookings WHERE id IN (459,460,461,462);');
            const res = call(DB_NAME, NEW_BUS, [{ booking_id: 456, seat_mappings: [{ old_seat: 1, new_seat: 10 }] }], EVT, 'a-single');
            assert.match(res, /"success": ?true/);
            assert.match(bookings(DB_NAME), /\[10\]/);
        } finally { dropDb(DB_NAME); }
    });

    it('B: [1,2] -> [10,11] multi-seat remap on one booking', { skip: SKIP_REASON }, () => {
        setupFixedDb(DB_NAME);
        try {
            runSql(DB_NAME, "UPDATE bus_ticket_bookings SET seat_numbers='[1,2]' WHERE id=456; DELETE FROM bus_ticket_bookings WHERE id IN (459,460,461,462);");
            const res = call(DB_NAME, NEW_BUS, [{ booking_id: 456, seat_mappings: [{ old_seat: 1, new_seat: 10 }, { old_seat: 2, new_seat: 11 }] }], EVT, 'b-multi');
            assert.match(res, /"success": ?true/);
            assert.match(bookings(DB_NAME), /\[10, 11\]/);
        } finally { dropDb(DB_NAME); }
    });

    it('C: NULL seat_numbers (structurally impossible in production — NOT NULL — but the function must still fail closed if it ever occurred)', { skip: SKIP_REASON }, () => {
        const relaxedSchema = SCHEMA_SQL.replace('seat_numbers VARCHAR(100) NOT NULL,', 'seat_numbers VARCHAR(100),');
        setupFixedDb(DB_NAME, { schema: relaxedSchema });
        try {
            runSql(DB_NAME, 'UPDATE bus_ticket_bookings SET seat_numbers=NULL WHERE id=456;');
            const res = call(DB_NAME, NEW_BUS, [{ booking_id: 456, seat_mappings: [{ old_seat: 1, new_seat: 1 }] }], EVT, 'c-null');
            assert.match(res, /"success": ?false/, 'must never silently succeed on a NULL seat_numbers value');
            const after = bookings(DB_NAME);
            assert.doesNotMatch(after, /\[1\][^,]*confirmed[\s\S]*456/, 'sanity: no misleading success indicator');
        } finally { dropDb(DB_NAME); }
    });

    it('D: [] empty-seat booking is a valid no-op remap entry, other bookings remap normally', { skip: SKIP_REASON }, () => {
        setupFixedDb(DB_NAME);
        try {
            runSql(DB_NAME, "UPDATE bus_ticket_bookings SET seat_numbers='[]' WHERE id=456;");
            const res = call(DB_NAME, NEW_BUS, [
                { booking_id: 456, seat_mappings: [] },
                { booking_id: 459, seat_mappings: [{ old_seat: 2, new_seat: 2 }] },
                { booking_id: 460, seat_mappings: [{ old_seat: 3, new_seat: 3 }] },
                { booking_id: 461, seat_mappings: [{ old_seat: 4, new_seat: 4 }] },
                { booking_id: 462, seat_mappings: [{ old_seat: 30, new_seat: 5 }] }
            ], EVT, 'd-empty');
            assert.match(res, /"success": ?true/);
            const after = bookings(DB_NAME);
            assert.match(after, /456 \| \[\]/);
            assert.match(after, /462 \| \[5\]/);
        } finally { dropDb(DB_NAME); }
    });

    it('E: duplicate target seat -> DUPLICATE_SEAT_ASSIGNMENT, zero mutation', { skip: SKIP_REASON }, () => {
        setupFixedDb(DB_NAME);
        try {
            const res = call(DB_NAME, NEW_BUS, [
                { booking_id: 456, seat_mappings: [{ old_seat: 1, new_seat: 5 }] },
                { booking_id: 459, seat_mappings: [{ old_seat: 2, new_seat: 5 }] },
                { booking_id: 460, seat_mappings: [{ old_seat: 3, new_seat: 3 }] },
                { booking_id: 461, seat_mappings: [{ old_seat: 4, new_seat: 4 }] },
                { booking_id: 462, seat_mappings: [{ old_seat: 30, new_seat: 6 }] }
            ], EVT, 'e-dup');
            assert.match(res, /"error": ?"DUPLICATE_SEAT_ASSIGNMENT"/);
            assert.match(bookings(DB_NAME), /456 \| \[1\][\s\S]*459 \| \[2\][\s\S]*462 \| \[30\]/);
            assert.match(ticket(DB_NAME), /^\s*5 \|\s*840/m);
        } finally { dropDb(DB_NAME); }
    });

    it('F: target seat outside new-bus capacity -> INVALID_SEAT_NUMBER, zero mutation', { skip: SKIP_REASON }, () => {
        setupFixedDb(DB_NAME);
        try {
            const res = call(DB_NAME, NEW_BUS, [
                { booking_id: 456, seat_mappings: [{ old_seat: 1, new_seat: 1 }] },
                { booking_id: 459, seat_mappings: [{ old_seat: 2, new_seat: 2 }] },
                { booking_id: 460, seat_mappings: [{ old_seat: 3, new_seat: 3 }] },
                { booking_id: 461, seat_mappings: [{ old_seat: 4, new_seat: 4 }] },
                { booking_id: 462, seat_mappings: [{ old_seat: 30, new_seat: 99 }] }
            ], EVT, 'f-capacity');
            assert.match(res, /"error": ?"INVALID_SEAT_NUMBER"/);
            assert.match(bookings(DB_NAME), /462 \| \[30\]/);
        } finally { dropDb(DB_NAME); }
    });

    it('G: missing booking_id -> BOOKING_NOT_FOUND', { skip: SKIP_REASON }, () => {
        setupFixedDb(DB_NAME);
        try {
            const res = call(DB_NAME, NEW_BUS, [{ booking_id: 999999, seat_mappings: [{ old_seat: 1, new_seat: 1 }] }], EVT, 'g-missing');
            assert.match(res, /"error": ?"BOOKING_NOT_FOUND"/);
        } finally { dropDb(DB_NAME); }
    });

    it('H: booking belongs to another trip -> BOOKING_NOT_FOUND (cross-trip protection)', { skip: SKIP_REASON }, () => {
        setupFixedDb(DB_NAME);
        try {
            runSql(DB_NAME, "INSERT INTO bus_tickets (id, operator_id, status, from_city, to_city, from_address, to_address, departure_date, departure_time, total_seats, price, bus_type, bus_id) VALUES (76, 11, 'active', 'A','B','x','y','2027-01-01','10:00:00', 40, 500, 'single', NULL);");
            runSql(DB_NAME, "INSERT INTO bus_ticket_bookings (id, bus_ticket_id, status, seat_numbers, total_price) VALUES (999, 76, 'confirmed', '[1]', 500);");
            const res = call(DB_NAME, NEW_BUS, [{ booking_id: 999, seat_mappings: [{ old_seat: 1, new_seat: 1 }] }], EVT, 'h-crosstrip');
            assert.match(res, /"error": ?"BOOKING_NOT_FOUND"/);
        } finally { dropDb(DB_NAME); }
    });

    it('I: booking belongs to another carrier\'s trip -> BOOKING_NOT_FOUND (cross-tenant protection)', { skip: SKIP_REASON }, () => {
        setupFixedDb(DB_NAME);
        try {
            runSql(DB_NAME, "INSERT INTO bus_tickets (id, operator_id, status, from_city, to_city, from_address, to_address, departure_date, departure_time, total_seats, price, bus_type, bus_id) VALUES (77, 22, 'active', 'A','B','x','y','2027-01-01','10:00:00', 40, 500, 'single', NULL);");
            runSql(DB_NAME, "INSERT INTO bus_ticket_bookings (id, bus_ticket_id, status, seat_numbers, total_price) VALUES (998, 77, 'confirmed', '[1]', 500);");
            const res = call(DB_NAME, NEW_BUS, [{ booking_id: 998, seat_mappings: [{ old_seat: 1, new_seat: 1 }] }], EVT, 'i-crosstenant');
            assert.match(res, /"error": ?"BOOKING_NOT_FOUND"/);
        } finally { dropDb(DB_NAME); }
    });

    it('J: malformed legacy seat_numbers -> MALFORMED_SEAT_DATA, zero mutation (fail closed, never guessed)', { skip: SKIP_REASON }, () => {
        setupFixedDb(DB_NAME);
        try {
            runSql(DB_NAME, "UPDATE bus_ticket_bookings SET seat_numbers='not-json' WHERE id=456;");
            const res = call(DB_NAME, NEW_BUS, [
                { booking_id: 456, seat_mappings: [{ old_seat: 1, new_seat: 1 }] },
                { booking_id: 459, seat_mappings: [{ old_seat: 2, new_seat: 2 }] },
                { booking_id: 460, seat_mappings: [{ old_seat: 3, new_seat: 3 }] },
                { booking_id: 461, seat_mappings: [{ old_seat: 4, new_seat: 4 }] },
                { booking_id: 462, seat_mappings: [{ old_seat: 30, new_seat: 5 }] }
            ], EVT, 'j-malformed');
            assert.match(res, /"error": ?"MALFORMED_SEAT_DATA"/);
            assert.match(res, /"booking_id": ?456/);
            assert.match(bookings(DB_NAME), /456 \| not-json/, 'the malformed value itself must be left untouched, never coerced');
            assert.match(ticket(DB_NAME), /^\s*5 \|\s*840/m, 'trip must remain on the original bus/price');
        } finally { dropDb(DB_NAME); }
    });

    it('K: partial failure (4th of 5 bookings invalid) -> full rollback, the FIRST THREE bookings\' already-applied writes are also undone', { skip: SKIP_REASON }, () => {
        setupFixedDb(DB_NAME);
        try {
            // Real, detectable changes for the first three (1->10, 2->11,
            // 3->12) so a leak would be observable, not masked by a no-op
            // old==new mapping.
            const res = call(DB_NAME, NEW_BUS, [
                { booking_id: 456, seat_mappings: [{ old_seat: 1, new_seat: 10 }] },
                { booking_id: 459, seat_mappings: [{ old_seat: 2, new_seat: 11 }] },
                { booking_id: 460, seat_mappings: [{ old_seat: 3, new_seat: 12 }] },
                { booking_id: 461, seat_mappings: [{ old_seat: 4, new_seat: 99 }] }, // invalid: > 15 capacity
                { booking_id: 462, seat_mappings: [{ old_seat: 30, new_seat: 5 }] }
            ], EVT, 'k-fullrollback');
            assert.match(res, /"error": ?"INVALID_SEAT_NUMBER"/);
            const after = bookings(DB_NAME);
            assert.match(after, /456 \| \[1\]/, 'booking 456 must NOT show the leaked [10] — this is the atomicity bug this phase fixes');
            assert.match(after, /459 \| \[2\]/, 'booking 459 must NOT show the leaked [11]');
            assert.match(after, /460 \| \[3\]/, 'booking 460 must NOT show the leaked [12]');
            assert.match(after, /462 \| \[30\]/);
            assert.match(ticket(DB_NAME), /^\s*5 \|\s*840/m);
        } finally { dropDb(DB_NAME); }
    });

    it('L+M+N: full 5-booking remap succeeds; booking prices and statuses are preserved', { skip: SKIP_REASON }, () => {
        setupFixedDb(DB_NAME);
        try {
            const res = call(DB_NAME, NEW_BUS, [
                { booking_id: 456, seat_mappings: [{ old_seat: 1, new_seat: 1 }] },
                { booking_id: 459, seat_mappings: [{ old_seat: 2, new_seat: 2 }] },
                { booking_id: 460, seat_mappings: [{ old_seat: 3, new_seat: 3 }] },
                { booking_id: 461, seat_mappings: [{ old_seat: 4, new_seat: 4 }] },
                { booking_id: 462, seat_mappings: [{ old_seat: 30, new_seat: 5 }] }
            ], EVT, 'l-full');
            assert.match(res, /"success": ?true/);
            const after = bookings(DB_NAME);
            for (const id of [456, 459, 460, 461, 462]) {
                assert.match(after, new RegExp(`${id} \\| \\[\\d+\\]\\s*\\|\\s*840\\s*\\|\\s*confirmed`), `booking ${id} price/status must be unchanged`);
            }
            assert.match(ticket(DB_NAME), /^\s*9 \|\s*840 \| \[1, 2, 3, 4, 5\]/m);
        } finally { dropDb(DB_NAME); }
    });

    it('O: price 840 -> 700 simultaneously with bus replacement + remap; booking prices still immutable', { skip: SKIP_REASON }, () => {
        setupFixedDb(DB_NAME);
        try {
            const res = call(DB_NAME, { ...NEW_BUS, price: 700 }, [
                { booking_id: 456, seat_mappings: [{ old_seat: 1, new_seat: 1 }] },
                { booking_id: 459, seat_mappings: [{ old_seat: 2, new_seat: 2 }] },
                { booking_id: 460, seat_mappings: [{ old_seat: 3, new_seat: 3 }] },
                { booking_id: 461, seat_mappings: [{ old_seat: 4, new_seat: 4 }] },
                { booking_id: 462, seat_mappings: [{ old_seat: 30, new_seat: 5 }] }
            ], EVT, 'o-priceplus');
            assert.match(res, /"success": ?true/);
            assert.match(ticket(DB_NAME), /^\s*9 \|\s*700/m);
            const after = bookings(DB_NAME);
            for (const id of [456, 459, 460, 461, 462]) {
                assert.match(after, new RegExp(`${id} \\| \\[\\d+\\]\\s*\\|\\s*840`), `booking ${id} price must remain 840 — no historical repricing`);
            }
        } finally { dropDb(DB_NAME); }
    });

    it('P: schedule-conflict protection stays outside the RPC (static check)', () => {
        const rpcSrc = extractFunctionBody(MIGRATION_REL_PATH);
        assert.ok(!rpcSrc.includes('checkBusScheduleConflict'), 'the RPC itself must never call checkBusScheduleConflict — that check belongs to routes/busAdmin.js (P.2.6)');
        const adminSrc = fs.readFileSync(path.resolve(__dirname, '../routes/busAdmin.js'), 'utf8');
        assert.ok(adminSrc.includes('await checkBusScheduleConflict('), 'routes/busAdmin.js must still call it before ever reaching the RPC');
    });

    it('Q: P.2.7\'s no-remap NULL -> Fleet bus assignment (with simultaneous price change) still succeeds after the P.2.8 seat-remap changes', { skip: SKIP_REASON }, () => {
        const p27Fixture = `
            INSERT INTO public.bus_tickets (id, operator_id, status, from_city, to_city, from_address, to_address, departure_date, departure_time, arrival_date, arrival_time, duration_minutes, price, premium_price, bus_type, total_seats, floor1_seats, floor2_seats, bus_id, reserved_seats, intermediate_stops, photos)
            VALUES (75, 11, 'active', 'Худжанд (TJ)', 'Нижневартовск (РФ)', 'addr1', 'addr2', '2026-09-23', '18:00:00', '2026-09-26', '18:00:00', 4320, 840, NULL, 'double', 78, 22, 56, NULL, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb);
            INSERT INTO public.bus_ticket_bookings (id, bus_ticket_id, status, seat_numbers, total_price, hold_expires_at, created_at) VALUES
            (456, 75, 'confirmed', '[1]', 840, NULL, NOW()),
            (459, 75, 'confirmed', '[2]', 840, NULL, NOW()),
            (460, 75, 'confirmed', '[3]', 840, NULL, NOW()),
            (461, 75, 'confirmed', '[4]', 840, NULL, NOW()),
            (462, 75, 'confirmed', '[30]', 840, NULL, NOW());
        `;
        setupFixedDb(DB_NAME, { fixture: p27Fixture });
        try {
            const res = call(DB_NAME, { bus_id: 1, bus_type: 'double', total_seats: 78, floor1_seats: 22, floor2_seats: 56, price: 700, departure_time: '18:00' }, [], { changed_by: 11, change_type: 'schedule_update' }, 'q-p27-recheck');
            assert.match(res, /"success": ?true/);
            assert.match(ticket(DB_NAME), /^\s*1 \|\s*700/m);
            const after = bookings(DB_NAME);
            for (const id of [456, 459, 460, 461, 462]) {
                assert.match(after, new RegExp(`${id} \\| \\[\\d+\\]\\s*\\|\\s*840`), `booking ${id} price must remain 840`);
            }
        } finally { dropDb(DB_NAME); }
    });
});
