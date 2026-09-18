-- ==============================================================================
-- Migration: 20260918143630_fix_bus_trip_notification_outbox_recipient_key.sql
-- Description: Corrective migration for 20260906_bus_trip_change_outbox.sql.
--              Does NOT modify that migration.
--
-- NOT APPLIED TO PRODUCTION. Prepared and verified locally only, per
-- instructions: "Production, Supabase, флаги, push и deploy не трогать."
-- (The base migration this corrects, 20260906_bus_trip_change_outbox.sql,
-- is itself still marked "NOT APPLIED TO PRODUCTION" and does not appear
-- in supabase/migrations/ — so as of this file, the affected table and
-- function do not exist in production either. This corrective migration
-- must still be applied strictly after 20260906_bus_trip_change_outbox.sql,
-- in the same order, whenever that pair is eventually promoted.)
--
-- Finding (read-only audit, prior turn): bus_ticket_notification_outbox's
-- original uniqueness key was UNIQUE (event_id, booking_id, channel) — it
-- does not include the recipient at all. routes/busAdmin.js's PUT
-- /tickets/:id handler inserts ONE outbox row per RECIPIENT of a booking
-- (the legacy claimed_by_user_id/passenger_id owner, PLUS one row per
-- active booking_followers row), all sharing the same event_id+booking_id+
-- channel='telegram' for a single trip-change event. Because the original
-- constraint's grain does not include the recipient, and the INSERT loop
-- used `ON CONFLICT (event_id, booking_id, channel) DO NOTHING`, only the
-- FIRST outbox row inserted per booking per event survived — every
-- subsequent recipient (a follower, or the legacy owner if a follower's
-- row happened to insert first) was silently dropped, contradicting the
-- code's own explicit intent (comment in routes/busAdmin.js: "Each
-- follower gets their OWN outbox row... can never block any other
-- recipient").
--
-- Fix: add a NOT NULL, deterministic `recipient_key` generated column and
-- widen the unique constraint to include it. recipient_user_id itself is
-- nullable (an unclaimed manual booking with no linked user account still
-- gets exactly one legacy outbox row, with recipient_user_id NULL) — using
-- a nullable column directly in a UNIQUE constraint would let Postgres
-- treat every NULL as distinct from every other NULL, silently permitting
-- unlimited duplicate legacy rows for the same (event_id, booking_id,
-- channel) once a bug or retry elsewhere re-introduced them. recipient_key
-- collapses that case to a single deterministic, NOT NULL value
-- ('legacy:<booking_id>') instead, while every follower row's recipient_key
-- is simply its NOT NULL recipient_user_id (booking_followers.user_id
-- itself is NOT NULL, so a follower's recipient_key is never the 'legacy:'
-- form). Per booking+event, the JS caller only ever produces at most one
-- outbox entry with a null recipient_user_id (the single legacy owner
-- slot) and at most one entry per distinct follower user_id (deduplicated
-- against the legacy recipient and against each other in
-- utils/notificationRecipientDedup.js before the entries are ever built),
-- so this key is exactly as fine-grained as the real recipient set — no
-- finer, no coarser.
--
-- Backfill note: the OLD constraint UNIQUE (event_id, booking_id, channel)
-- was already at least as strict as the new one (it is a strict superset
-- match on strictly fewer columns), so no two existing rows can ever
-- collide once the new column is added — there is nothing to de-duplicate
-- before adding the new, more specific constraint. This migration is safe
-- to run against a table that already holds rows.
-- ==============================================================================

BEGIN;

-- ------------------------------------------------------------------------
-- 1. Add a deterministic, NOT NULL recipient key and re-key the uniqueness
--    constraint on it.
-- ------------------------------------------------------------------------
ALTER TABLE public.bus_ticket_notification_outbox
    ADD COLUMN IF NOT EXISTS recipient_key TEXT
    GENERATED ALWAYS AS (
        COALESCE(recipient_user_id::text, 'legacy:' || booking_id::text)
    ) STORED;

COMMENT ON COLUMN public.bus_ticket_notification_outbox.recipient_key IS
    'Deterministic, NOT NULL stand-in for the nullable recipient_user_id, '
    'used only as the fine-grained arm of the uniqueness constraint below. '
    'Never read or written directly by application code.';

ALTER TABLE public.bus_ticket_notification_outbox
    DROP CONSTRAINT IF EXISTS uq_bus_ticket_notif_outbox_event_booking_channel;

ALTER TABLE public.bus_ticket_notification_outbox
    ADD CONSTRAINT uq_bus_ticket_notif_outbox_event_booking_channel_recipient
    UNIQUE (event_id, booking_id, channel, recipient_key);

-- ------------------------------------------------------------------------
-- 2. Re-point fn_atomic_bus_trip_update's outbox insert at the new,
--    recipient-aware constraint. Function body is otherwise byte-for-byte
--    identical to the one in 20260906_bus_trip_change_outbox.sql — only
--    the ON CONFLICT target on the final INSERT inside the outbox loop
--    changed (was: ON CONFLICT (event_id, booking_id, channel); now:
--    ON CONFLICT ON CONSTRAINT uq_bus_ticket_notif_outbox_event_booking_channel_recipient).
-- ------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_atomic_bus_trip_update(
    p_ticket_id INTEGER,
    p_operator_id INTEGER,
    p_update_data JSONB,
    p_seat_remap JSONB, -- [{"booking_id": 10, "seat_mappings": [{"old_seat": 5, "new_seat": 15}]}]
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
    v_departure_time := COALESCE(p_update_data->>'departure_time', v_ticket.departure_time, '00:00:00');
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
    IF p_seat_remap IS NOT NULL AND jsonb_array_length(p_seat_remap) > 0 THEN
        FOR v_remap_item IN SELECT * FROM jsonb_array_elements(p_seat_remap)
        LOOP
            v_b_id := (v_remap_item->>'booking_id')::integer;
            v_seat_mappings := v_remap_item->'seat_mappings';
            v_new_seats := '{}';

            -- Lock booking
            SELECT seat_numbers INTO v_current_seats
            FROM public.bus_ticket_bookings
            WHERE id = v_b_id AND bus_ticket_id = p_ticket_id
            FOR UPDATE;

            IF v_current_seats IS NULL THEN
                RETURN jsonb_build_object('success', false, 'error', 'BOOKING_NOT_FOUND', 'booking_id', v_b_id);
            END IF;

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

            UPDATE public.bus_ticket_bookings
            SET seat_numbers = v_new_seats
            WHERE id = v_b_id AND bus_ticket_id = p_ticket_id;
        END LOOP;

        -- Synchronize reserved_seats from all active bookings after remap
        SELECT COALESCE(ARRAY(
            SELECT DISTINCT unnest(seat_numbers)
            FROM public.bus_ticket_bookings
            WHERE bus_ticket_id = p_ticket_id
              AND (
                  status = 'confirmed'
                  OR (status = 'pending_payment' AND (hold_expires_at IS NULL OR hold_expires_at > v_now_instant))
              )
            ORDER BY 1
        ), '{}') INTO v_sync_reserved_seats;
    END IF;

    -- 7. Update bus_tickets fields
    UPDATE public.bus_tickets
    SET
        departure_date = v_departure_date,
        departure_time = v_departure_time,
        arrival_date = COALESCE((p_update_data->>'arrival_date')::date, arrival_date),
        arrival_time = COALESCE(p_update_data->>'arrival_time', arrival_time),
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
            THEN v_sync_reserved_seats
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
    -- ON CONFLICT target changed from (event_id, booking_id, channel) to the
    -- new, recipient-aware constraint — see uq_bus_ticket_notif_outbox_event_
    -- booking_channel_recipient above. This is the only functional change in
    -- this function versus 20260906_bus_trip_change_outbox.sql: previously,
    -- inserting more than one outbox row for the same (event, booking,
    -- channel) — e.g. a legacy owner row and a follower row for the same
    -- trip-change event — silently dropped every row after the first.
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
-- -- Restore fn_atomic_bus_trip_update's outbox insert to the pre-fix
-- -- conflict target (re-introduces the recipient fan-out collision bug —
-- -- only use this to revert if the fix itself is found to be unsafe).
-- CREATE OR REPLACE FUNCTION public.fn_atomic_bus_trip_update( ... )
--   -- ... identical body to 20260906_bus_trip_change_outbox.sql's version,
--   -- i.e. the one line
--   --   ON CONFLICT ON CONSTRAINT uq_bus_ticket_notif_outbox_event_booking_channel_recipient DO NOTHING;
--   -- reverted back to
--   --   ON CONFLICT (event_id, booking_id, channel) DO NOTHING;
--   -- (Full original body preserved verbatim in
--   -- docs/migrations/20260906_bus_trip_change_outbox.sql — copy it back in.)
--
-- ALTER TABLE public.bus_ticket_notification_outbox
--     DROP CONSTRAINT IF EXISTS uq_bus_ticket_notif_outbox_event_booking_channel_recipient;
--
-- ALTER TABLE public.bus_ticket_notification_outbox
--     ADD CONSTRAINT uq_bus_ticket_notif_outbox_event_booking_channel
--     UNIQUE (event_id, booking_id, channel);
--     -- NOTE: this will FAIL with a uniqueness violation if, since the fix
--     -- was applied, any booking+event legitimately accumulated more than
--     -- one outbox row (i.e. the fix already did its job for a real trip
--     -- change) — that data loss is exactly what the fix exists to
--     -- prevent, so rolling back after real traffic requires first
--     -- deciding, row by row, which extra rows to delete. Rolling back
--     -- before any real trip-change traffic has occurred is unconditionally
--     -- safe.
--
-- ALTER TABLE public.bus_ticket_notification_outbox
--     DROP COLUMN IF EXISTS recipient_key;
--
-- COMMIT;
-- ==============================================================================
