-- ==============================================================================
-- Migration: 20260921203500_fix_bus_trip_update_time_type_mismatches.sql
-- Description: Corrective migration for fn_atomic_bus_trip_update
--              (as last defined in
--              20260918184834_fix_bus_trip_notification_outbox_recipient_key.sql).
--              Does NOT modify that migration.
--
-- NOT YET APPLIED TO PRODUCTION. Prepared and verified locally only
-- (real Postgres 16, production-shaped fixtures) per Phase P.2.7's and
-- Phase P.2.8's explicit read-only/no-deploy constraints. This file was
-- first created in Phase P.2.7 (time/jsonb type-mismatch fix only) and
-- was UPDATED in place by Phase P.2.8 to add the seat-remap storage-
-- format and atomicity fixes below, per P.2.8's explicit instruction to
-- extend this not-yet-released migration rather than create a second,
-- competing one. See git history for the P.2.7-only version if needed —
-- nothing here was force-rewritten, a new P.2.8 commit sits on top of
-- the P.2.7 commit that first introduced this file.
--
-- ==============================================================================
-- PART 1 (Phase P.2.7) — text/time/jsonb COALESCE/CASE type mismatches
-- ==============================================================================
--
-- ROOT CAUSE: a production smoke test on trip id=75 (bus_id NULL -> Fleet
-- bus id=1, price 840 -> 700, 5 confirmed bookings) returned the
-- controlled frontend error "Не удалось атомарно обновить рейс." —
-- routes/busAdmin.js's PUT /tickets/:id surfaces this exact message
-- whenever fn_atomic_bus_trip_update's RPC call returns an error (see
-- routes/busAdmin.js, `if (rpcError) { ... TRIP_UPDATE_ATOMIC_FAILED ... }`).
--
-- Read-only production Postgres logs (postgres_logs, 2026-09-21 20:32:06
-- UTC, exact request window) captured the real underlying error:
--
--   ERROR: 42804: COALESCE types text and time without time zone cannot
--   be matched
--
-- fn_atomic_bus_trip_update's body assigns:
--   v_departure_time := COALESCE(p_update_data->>'departure_time',
--                                 v_ticket.departure_time, '00:00:00');
-- p_update_data->>'departure_time' is `text` (JSONB text extraction);
-- v_ticket.departure_time is `time without time zone` (bus_tickets.
-- departure_time's real column type — confirmed via information_schema).
-- Postgres has no implicit cast unifying text and time in a COALESCE, so
-- this line throws 42804 on EVERY call that reaches it — i.e. every trip
-- update, since routes/busAdmin.js's updateBusTicket() always sends
-- departure_time. This was never observed before Phase P.2.7 only because
-- two earlier, independent bugs (fixed in P.2.5 and P.2.6 respectively —
-- an unguarded service-role client throw, and a missing
-- checkBusScheduleConflict import) prevented ANY bus-replacement request
-- from ever reaching this RPC call in the first place. Once those two
-- were fixed, this pre-existing SQL bug became reachable for the first
-- time and immediately surfaced.
--
-- The identical COALESCE(text, time)/CASE(jsonb, integer[]) type-mismatch
-- pattern existed at two more places in the SAME function body, both of
-- which would abort the SAME request (Postgres validates a PL/pgSQL
-- statement's expression types when that statement first executes,
-- independent of which runtime branch/value is actually used):
--   1. `arrival_time = COALESCE(p_update_data->>'arrival_time',
--      arrival_time)` in the UPDATE ... SET list — same text/time clash
--      against the bare column reference.
--   2. `reserved_seats = CASE WHEN ... THEN v_sync_reserved_seats ELSE
--      reserved_seats END` — v_sync_reserved_seats is INTEGER[] but
--      bus_tickets.reserved_seats is jsonb; "CASE types jsonb and
--      integer[] cannot be matched".
-- All three are fixed together below — fixing only the first would still
-- leave every trip update failing at the second (arrival_time) or third
-- (reserved_seats) line, proven locally by fixing them one at a time
-- against a real Postgres 16 instance before combining all three.
--
-- Fix: cast time values to text (departure_time, arrival_time) so all
-- COALESCE arguments share one type, casting the final result back to
-- `::time` for the column assignment; wrap the seat-remap-synced seat
-- array in to_jsonb(...) so both CASE branches are jsonb. No semantic
-- change: same values, same precision (`time::text` renders "HH:MI:SS",
-- unchanged by the existing `substring(...,1,8)`), same seat numbers.
--
-- ==============================================================================
-- PART 2 (Phase P.2.8) — seat-remap storage format + atomicity
-- ==============================================================================
--
-- Flagged by P.2.7 as a separate, out-of-scope, not-yet-reached bug and
-- fully diagnosed and fixed here. Production read-only audit
-- (information_schema + a sample of live rows) confirmed:
--   - bus_ticket_bookings.seat_numbers is `character varying(100) NOT
--     NULL`, holding a JSON-bracket-style string ("[1]", "[1,2]", ...) —
--     never a native Postgres array (which uses "{1,2}" syntax).
--   - All 164 production rows at audit time matched that JSON-array
--     shape exactly (no malformed/empty/legacy values currently exist).
--
-- BUG 1 (storage format): the seat-remap branch did
--   SELECT seat_numbers INTO v_current_seats FROM bus_ticket_bookings ...
-- where v_current_seats is declared INTEGER[] — Postgres's native array
-- input parser expects "{1}" syntax, not "[1]", and throws "malformed
-- array literal" the moment any real BUS_SEAT_REMAP_REQUIRED submission
-- reaches this function. Reproduced locally against a trip-75-shaped
-- fixture (bus A -> bus B requiring remap, 5 confirmed bookings, seats
-- 1/2/3/4/30). The write-back (`SET seat_numbers = v_new_seats`, an
-- INTEGER[] assigned to the varchar column) and the reserved_seats sync
-- (`unnest(seat_numbers)`, calling unnest() on a varchar) have the exact
-- same problem and would each independently abort the same request.
--
-- FIX: every read of seat_numbers now parses it explicitly through jsonb
-- (jsonb_array_elements_text), and every write converts back to the same
-- JSON-bracket text format (matching how routes/busAdmin.js's own
-- JSON.parse(seat_numbers) already reads this column) — never a native
-- array cast in either direction. A value that is not valid JSON, or not
-- a JSON array of integers, fails closed with a new controlled
-- MALFORMED_SEAT_DATA error (booking_id included) — never silently
-- guessed, coerced, or dropped from the reserved-seats sync.
--
-- BUG 2 (atomicity — found while fixing bug 1, not present in the
-- reported failure, but real and definitely in scope): the original
-- remap loop validated ONE booking's seat mappings and immediately
-- issued that booking's UPDATE before moving to the next remap_item. An
-- invalid or duplicate seat on a LATER booking triggered a controlled
-- RETURN of an error payload — but a RETURN is not an exception, so it
-- does not roll back the UPDATEs earlier loop iterations already issued
-- within the same top-level call. Proven locally: a 5-booking remap with
-- an invalid seat on the 4th booking left the first three genuinely
-- remapped in the database (and reported unaffected, but un-audited)
-- despite the RPC reporting overall failure. This was unreachable in
-- production only because BUG 1's "malformed array literal" exception
-- aborted every remap attempt before any booking's mapping could ever be
-- validated — fixing BUG 1 alone, without this, would have exposed BUG 2
-- as a new, silent partial-mutation failure mode.
--
-- FIX: the remap loop is now two passes. PASS 1 validates every
-- remap_item (booking exists, seat count matches, every seat in-capacity
-- and non-duplicate) and only accumulates the planned new seat arrays —
-- it writes nothing. PASS 2 applies every write, and only runs once
-- every item in PASS 1 has validated successfully. Any failure during
-- PASS 1 now returns before a single row has been touched, restoring the
-- atomicity the function's name promises.
-- ==============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_atomic_bus_trip_update(
    p_ticket_id INTEGER,
    p_operator_id INTEGER,
    p_update_data JSONB, -- [{"booking_id": 10, "seat_mappings": [{"old_seat": 5, "new_seat": 15}]}]
    p_seat_remap JSONB,
    p_event_data JSONB,
    p_outbox_entries JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_ticket RECORD;
    v_remap_item JSONB;
    v_b_id INTEGER;
    v_seat_mappings JSONB;
    v_mapping_item JSONB;
    v_new_seats INTEGER[];
    v_current_seats INTEGER[];
    v_current_seats_raw VARCHAR;
    v_sync_seats_raw VARCHAR;
    v_sync_booking_id INTEGER;
    v_planned_updates JSONB := '[]'::jsonb;
    v_planned_item JSONB;
    v_old_seat INTEGER;
    v_new_seat INTEGER;
    v_event_id UUID;
    v_outbox_item JSONB;
    v_existing_event RECORD;
    v_idempotency_key TEXT;
    v_active_bookings_count INTEGER;
    v_all_assigned_seats INTEGER[] := '{}';
    v_total_seats INTEGER;
    v_sync_reserved_seats INTEGER[];
    v_now_instant TIMESTAMPTZ := NOW();
    v_departure_date DATE;
    v_departure_time TEXT;
    v_departure_instant TIMESTAMPTZ;
BEGIN
    v_idempotency_key := p_event_data->>'idempotency_key';

    -- 1. Check idempotency in scope (operator_id, bus_ticket_id, idempotency_key)
    IF v_idempotency_key IS NOT NULL THEN
        SELECT id, bus_ticket_id INTO v_existing_event
        FROM public.bus_ticket_change_events
        WHERE operator_id = p_operator_id
          AND bus_ticket_id = p_ticket_id
          AND idempotency_key = v_idempotency_key;

        IF v_existing_event.id IS NOT NULL THEN
            RETURN jsonb_build_object(
                'success', true,
                'idempotent_replay', true,
                'event_id', v_existing_event.id,
                'ticket_id', p_ticket_id
            );
        END IF;
    END IF;

    -- 2. Lock ticket row FOR UPDATE
    SELECT id, operator_id, status, from_city, to_city, departure_date, departure_time, total_seats, bus_id
    INTO v_ticket
    FROM public.bus_tickets
    WHERE id = p_ticket_id
    FOR UPDATE;

    IF v_ticket.id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'TICKET_NOT_FOUND');
    END IF;

    -- 2.1 Re-check idempotency under ticket lock (prevents concurrent race between transactions serialized on FOR UPDATE)
    IF v_idempotency_key IS NOT NULL THEN
        SELECT id, bus_ticket_id INTO v_existing_event
        FROM public.bus_ticket_change_events
        WHERE operator_id = p_operator_id
          AND bus_ticket_id = p_ticket_id
          AND idempotency_key = v_idempotency_key;

        IF v_existing_event.id IS NOT NULL THEN
            RETURN jsonb_build_object(
                'success', true,
                'idempotent_replay', true,
                'event_id', v_existing_event.id,
                'ticket_id', p_ticket_id
            );
        END IF;
    END IF;

    IF v_ticket.operator_id != p_operator_id THEN
        RETURN jsonb_build_object('success', false, 'error', 'FORBIDDEN_OPERATOR');
    END IF;

    IF v_ticket.status != 'active' THEN
        RETURN jsonb_build_object('success', false, 'error', 'TICKET_NOT_ACTIVE');
    END IF;

    -- 3. Check departure not in the past
    v_departure_date := COALESCE((p_update_data->>'departure_date')::date, v_ticket.departure_date);
    -- P.2.7 FIX: v_ticket.departure_time is `time without time zone`; cast
    -- it to text so it unifies with the other two (already-text) COALESCE
    -- arguments.
    v_departure_time := COALESCE(p_update_data->>'departure_time', v_ticket.departure_time::text, '00:00:00');
    v_departure_instant := (v_departure_date || ' ' || substring(v_departure_time from 1 for 8) || '+05:00')::timestamptz;

    IF v_departure_instant <= v_now_instant THEN
        RETURN jsonb_build_object('success', false, 'error', 'DEPARTURE_CANNOT_BE_IN_PAST');
    END IF;

    -- 4. Check active bookings with lock
    SELECT COUNT(*) INTO v_active_bookings_count
    FROM public.bus_ticket_bookings
    WHERE bus_ticket_id = p_ticket_id
      AND (
          status = 'confirmed'
          OR (status = 'pending_payment' AND (hold_expires_at IS NULL OR hold_expires_at > v_now_instant))
      );

    -- 5. Primary route protection if active bookings exist
    IF v_active_bookings_count > 0 THEN
        IF p_update_data ? 'from_city' AND (p_update_data->>'from_city') != v_ticket.from_city THEN
            RETURN jsonb_build_object('success', false, 'error', 'ROUTE_CHANGE_REQUIRES_SEPARATE_TRIP');
        END IF;
        IF p_update_data ? 'to_city' AND (p_update_data->>'to_city') != v_ticket.to_city THEN
            RETURN jsonb_build_object('success', false, 'error', 'ROUTE_CHANGE_REQUIRES_SEPARATE_TRIP');
        END IF;
    END IF;

    v_total_seats := COALESCE((p_update_data->>'total_seats')::integer, v_ticket.total_seats);

    -- 6. Apply group seat remapping if provided
    --
    -- P.2.8 FIX (storage format + atomicity) — see migration header PART 2
    -- for the full writeup. seat_numbers is `character varying` holding a
    -- JSON-bracket string, never a native Postgres array; every read goes
    -- through jsonb_array_elements_text and every write through a proper
    -- jsonb array cast to text, failing closed with MALFORMED_SEAT_DATA on
    -- anything that isn't valid JSON. All writes are deferred to a second
    -- pass so a failure anywhere in validation leaves every booking
    -- untouched.
    IF p_seat_remap IS NOT NULL AND jsonb_array_length(p_seat_remap) > 0 THEN
        -- PASS 1: validate everything, write nothing yet.
        FOR v_remap_item IN SELECT * FROM jsonb_array_elements(p_seat_remap)
        LOOP
            v_b_id := (v_remap_item->>'booking_id')::integer;
            v_seat_mappings := v_remap_item->'seat_mappings';
            v_new_seats := '{}';

            -- Lock booking now (even though its write is deferred) so a
            -- concurrent remap on the same booking can't interleave
            -- between this validation pass and PASS 2's apply.
            SELECT seat_numbers INTO v_current_seats_raw
            FROM public.bus_ticket_bookings
            WHERE id = v_b_id AND bus_ticket_id = p_ticket_id
            FOR UPDATE;

            IF v_current_seats_raw IS NULL THEN
                RETURN jsonb_build_object('success', false, 'error', 'BOOKING_NOT_FOUND', 'booking_id', v_b_id);
            END IF;

            BEGIN
                v_current_seats := ARRAY(
                    SELECT (elem)::integer
                    FROM jsonb_array_elements_text(v_current_seats_raw::jsonb) AS elem
                );
            EXCEPTION WHEN OTHERS THEN
                RETURN jsonb_build_object('success', false, 'error', 'MALFORMED_SEAT_DATA', 'booking_id', v_b_id);
            END;

            IF jsonb_array_length(v_seat_mappings) != cardinality(v_current_seats) THEN
                RETURN jsonb_build_object('success', false, 'error', 'SEAT_COUNT_MISMATCH', 'booking_id', v_b_id);
            END IF;

            FOR v_mapping_item IN SELECT * FROM jsonb_array_elements(v_seat_mappings)
            LOOP
                v_old_seat := (v_mapping_item->>'old_seat')::integer;
                v_new_seat := (v_mapping_item->>'new_seat')::integer;

                IF v_new_seat <= 0 OR v_new_seat > v_total_seats THEN
                    RETURN jsonb_build_object('success', false, 'error', 'INVALID_SEAT_NUMBER', 'seat', v_new_seat);
                END IF;

                IF v_new_seat = ANY(v_all_assigned_seats) THEN
                    RETURN jsonb_build_object('success', false, 'error', 'DUPLICATE_SEAT_ASSIGNMENT', 'seat', v_new_seat);
                END IF;

                v_all_assigned_seats := array_append(v_all_assigned_seats, v_new_seat);
                v_new_seats := array_append(v_new_seats, v_new_seat);
            END LOOP;

            -- Record the planned write; do NOT apply it yet.
            v_planned_updates := v_planned_updates || jsonb_build_array(
                jsonb_build_object('booking_id', v_b_id, 'new_seats', to_jsonb(v_new_seats))
            );
        END LOOP;

        -- PASS 2: every remap_item validated — now, and only now, apply
        -- every write. new_seats is already a proper JSON array
        -- (to_jsonb of an INTEGER[] renders "[1,2]"), so casting it to
        -- text writes back in the exact same JSON-bracket format the
        -- column already stores, never the native array literal syntax
        -- "{1,2}".
        FOR v_planned_item IN SELECT * FROM jsonb_array_elements(v_planned_updates)
        LOOP
            UPDATE public.bus_ticket_bookings
            SET seat_numbers = (v_planned_item->'new_seats')::text
            WHERE id = (v_planned_item->>'booking_id')::integer AND bus_ticket_id = p_ticket_id;
        END LOOP;

        -- Synchronize reserved_seats from all active bookings after remap.
        -- Iterate and parse each booking's JSON-text seat_numbers
        -- explicitly (the original `unnest(seat_numbers)` treated the
        -- varchar column as a native array and would itself fail with
        -- "function unnest(character varying) does not exist"). Fails
        -- closed with the offending booking_id on any malformed value —
        -- never silently drops a booking's seats from the sync.
        v_sync_reserved_seats := '{}';
        FOR v_sync_booking_id, v_sync_seats_raw IN
            SELECT id, seat_numbers
            FROM public.bus_ticket_bookings
            WHERE bus_ticket_id = p_ticket_id
              AND (
                  status = 'confirmed'
                  OR (status = 'pending_payment' AND (hold_expires_at IS NULL OR hold_expires_at > v_now_instant))
              )
        LOOP
            BEGIN
                v_sync_reserved_seats := v_sync_reserved_seats || ARRAY(
                    SELECT (elem)::integer
                    FROM jsonb_array_elements_text(v_sync_seats_raw::jsonb) AS elem
                );
            EXCEPTION WHEN OTHERS THEN
                RETURN jsonb_build_object('success', false, 'error', 'MALFORMED_SEAT_DATA', 'booking_id', v_sync_booking_id);
            END;
        END LOOP;
        SELECT COALESCE(ARRAY(SELECT DISTINCT unnest(v_sync_reserved_seats) ORDER BY 1), '{}') INTO v_sync_reserved_seats;
    END IF;

    -- 7. Update bus_tickets fields
    UPDATE public.bus_tickets
    SET
        departure_date = v_departure_date,
        -- P.2.7 FIX: v_departure_time is now TEXT (see above); cast back
        -- to `time` for the column assignment.
        departure_time = v_departure_time::time,
        arrival_date = COALESCE((p_update_data->>'arrival_date')::date, arrival_date),
        -- P.2.7 FIX: same text/time clash as departure_time above — the
        -- bare `arrival_time` column reference in this UPDATE ... SET
        -- context is `time without time zone`; cast it to text for
        -- COALESCE, then the overall result back to `::time`.
        arrival_time = COALESCE(p_update_data->>'arrival_time', arrival_time::text)::time,
        duration_minutes = COALESCE((p_update_data->>'duration_minutes')::integer, duration_minutes),
        from_address = COALESCE(p_update_data->>'from_address', from_address),
        to_address = COALESCE(p_update_data->>'to_address', to_address),
        intermediate_stops = CASE WHEN p_update_data ? 'intermediate_stops' THEN p_update_data->'intermediate_stops' ELSE intermediate_stops END,
        bus_id = CASE WHEN p_update_data ? 'bus_id' THEN (p_update_data->>'bus_id')::integer ELSE bus_id END,
        bus_type = COALESCE(p_update_data->>'bus_type', bus_type),
        total_seats = v_total_seats,
        floor1_seats = CASE WHEN p_update_data ? 'floor1_seats' THEN (p_update_data->>'floor1_seats')::integer ELSE floor1_seats END,
        floor2_seats = CASE WHEN p_update_data ? 'floor2_seats' THEN (p_update_data->>'floor2_seats')::integer ELSE floor2_seats END,
        price = COALESCE((p_update_data->>'price')::numeric, price),
        premium_price = CASE WHEN p_update_data ? 'premium_price' THEN (p_update_data->>'premium_price')::numeric ELSE premium_price END,
        passenger_comments = COALESCE(p_update_data->>'passenger_comments', passenger_comments),
        photos = CASE WHEN p_update_data ? 'photos' THEN p_update_data->'photos' ELSE photos END,
        group_leader_name = CASE WHEN p_update_data ? 'group_leader_name' THEN p_update_data->>'group_leader_name' ELSE group_leader_name END,
        group_leader_phone = CASE WHEN p_update_data ? 'group_leader_phone' THEN p_update_data->>'group_leader_phone' ELSE group_leader_phone END,
        group_leader_whatsapp = CASE WHEN p_update_data ? 'group_leader_whatsapp' THEN p_update_data->>'group_leader_whatsapp' ELSE group_leader_whatsapp END,
        reserved_seats = CASE
            WHEN p_seat_remap IS NOT NULL AND jsonb_array_length(p_seat_remap) > 0
            -- P.2.7 FIX: bus_tickets.reserved_seats is jsonb, but
            -- v_sync_reserved_seats is INTEGER[] — wrap it so both CASE
            -- branches share the jsonb type.
            THEN to_jsonb(v_sync_reserved_seats)
            ELSE reserved_seats
        END
    WHERE id = p_ticket_id;

    -- 8. Record immutable change event
    INSERT INTO public.bus_ticket_change_events (
        bus_ticket_id,
        operator_id,
        changed_by,
        change_type,
        old_values,
        new_values,
        changed_fields,
        idempotency_key
    ) VALUES (
        p_ticket_id,
        p_operator_id,
        (p_event_data->>'changed_by')::integer,
        COALESCE(p_event_data->>'change_type', 'schedule_or_bus_update'),
        p_event_data->'old_values',
        p_event_data->'new_values',
        ARRAY(SELECT jsonb_array_elements_text(p_event_data->'changed_fields')),
        v_idempotency_key
    )
    ON CONFLICT (operator_id, bus_ticket_id, idempotency_key) DO NOTHING
    RETURNING id INTO v_event_id;

    IF v_event_id IS NULL AND v_idempotency_key IS NOT NULL THEN
        SELECT id INTO v_event_id
        FROM public.bus_ticket_change_events
        WHERE operator_id = p_operator_id
          AND bus_ticket_id = p_ticket_id
          AND idempotency_key = v_idempotency_key;

        RETURN jsonb_build_object(
            'success', true,
            'idempotent_replay', true,
            'event_id', v_event_id,
            'ticket_id', p_ticket_id
        );
    END IF;

    -- Atomic Carrier Activity Audit Log (dual-write within same transaction)
    BEGIN
        INSERT INTO public.carrier_activity_logs (
            carrier_id,
            actor_user_id,
            actor_role,
            actor_name,
            action,
            entity_type,
            entity_id,
            entity_label,
            old_data,
            new_data,
            metadata,
            created_at
        ) VALUES (
            p_operator_id,
            COALESCE((p_event_data->>'changed_by')::integer, 0),
            COALESCE(p_event_data->>'actor_role', 'owner'),
            COALESCE(p_event_data->>'actor_name', 'Сотрудник'),
            'ticket_updated',
            'ticket',
            p_ticket_id::text,
            'Рейс #' || p_ticket_id,
            COALESCE(p_event_data->'old_values', '{}'::jsonb),
            COALESCE(p_event_data->'new_values', '{}'::jsonb),
            jsonb_build_object('source', 'atomic_trip_update', 'idempotency_key', v_idempotency_key),
            v_now_instant
        );
    EXCEPTION WHEN undefined_table THEN
        -- carrier_activity_logs does not exist in minimal environments, non-fatal
        NULL;
    END;

    -- 9. Insert notification outbox records
    IF p_outbox_entries IS NOT NULL AND jsonb_array_length(p_outbox_entries) > 0 THEN
        FOR v_outbox_item IN SELECT * FROM jsonb_array_elements(p_outbox_entries)
        LOOP
            INSERT INTO public.bus_ticket_notification_outbox (
                event_id,
                booking_id,
                recipient_user_id,
                recipient_telegram_id,
                channel,
                language,
                payload,
                status
            ) VALUES (
                v_event_id,
                (v_outbox_item->>'booking_id')::integer,
                (v_outbox_item->>'recipient_user_id')::integer,
                (v_outbox_item->>'recipient_telegram_id')::bigint,
                COALESCE(v_outbox_item->>'channel', 'telegram'),
                COALESCE(v_outbox_item->>'language', 'ru'),
                v_outbox_item->'payload',
                COALESCE(v_outbox_item->>'status', 'pending')
            ) ON CONFLICT ON CONSTRAINT uq_bus_ticket_notif_outbox_event_booking_channel_recipient DO NOTHING;
        END LOOP;
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'event_id', v_event_id,
        'ticket_id', p_ticket_id
    );
END;
$$;

REVOKE ALL ON FUNCTION public.fn_atomic_bus_trip_update FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_atomic_bus_trip_update TO service_role;

COMMIT;

-- ==============================================================================
-- Rollback Instructions:
-- BEGIN;
--
-- -- Restore fn_atomic_bus_trip_update to its pre-P.2.7/P.2.8 body
-- -- (re-introduces the three text/time/jsonb type mismatches AND the
-- -- seat-remap storage-format/atomicity bugs documented above — this
-- -- function would then fail 42804 on every trip update, and
-- -- "malformed array literal" on every seat remap, again). Full original
-- -- body preserved verbatim in
-- -- supabase/migrations/20260918184834_fix_bus_trip_notification_outbox_recipient_key.sql
-- -- — copy its CREATE OR REPLACE FUNCTION block back in.
--
-- COMMIT;
-- ==============================================================================
