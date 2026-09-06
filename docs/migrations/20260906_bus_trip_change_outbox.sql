-- ==============================================================================
-- Migration: 20260906_bus_trip_change_outbox.sql
-- Description: Safe Bus Trip Schedule & Vehicle Changes with Passenger Notification Outbox
-- Project: POPUTKI.ONLINE
--
-- NOT APPLIED TO PRODUCTION. Prepared locally per instructions:
-- "миграции можно подготовить локально, но запрещено применять к production"
-- ==============================================================================

BEGIN;

-- 1. Bus Ticket Change Events (Audit & History of Trip Modifications)
CREATE TABLE IF NOT EXISTS public.bus_ticket_change_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bus_ticket_id INTEGER NOT NULL REFERENCES public.bus_tickets(id) ON DELETE CASCADE,
    operator_id INTEGER NOT NULL,
    changed_by INTEGER NULL REFERENCES public.users(id) ON DELETE SET NULL,
    change_type TEXT NOT NULL DEFAULT 'schedule_or_bus_update',
    old_values JSONB NOT NULL DEFAULT '{}'::jsonb,
    new_values JSONB NOT NULL DEFAULT '{}'::jsonb,
    changed_fields TEXT[] NOT NULL DEFAULT '{}',
    idempotency_key TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_bus_ticket_change_events_operator_ticket_key UNIQUE (operator_id, bus_ticket_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_bus_ticket_change_events_ticket_id 
    ON public.bus_ticket_change_events(bus_ticket_id);
CREATE INDEX IF NOT EXISTS idx_bus_ticket_change_events_operator_id 
    ON public.bus_ticket_change_events(operator_id);
CREATE INDEX IF NOT EXISTS idx_bus_ticket_change_events_created_at 
    ON public.bus_ticket_change_events(created_at);

ALTER TABLE public.bus_ticket_change_events ENABLE ROW LEVEL SECURITY;

-- Operator tenant isolation: carrier sees only their own trips' change events
CREATE POLICY p_bus_ticket_change_events_carrier_select
    ON public.bus_ticket_change_events
    FOR SELECT
    TO authenticated
    USING (
        operator_id IN (
            SELECT carrier_id FROM public.carrier_members WHERE user_id::text = (SELECT auth.uid()::text)
        )
    );

REVOKE ALL ON TABLE public.bus_ticket_change_events FROM PUBLIC, anon;
GRANT SELECT ON TABLE public.bus_ticket_change_events TO authenticated;
GRANT ALL ON TABLE public.bus_ticket_change_events TO service_role;


-- 2. Bus Ticket Notification Outbox (Transactional Outbox for Passenger Telegram Updates)
CREATE TABLE IF NOT EXISTS public.bus_ticket_notification_outbox (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id UUID NOT NULL REFERENCES public.bus_ticket_change_events(id) ON DELETE CASCADE,
    booking_id INTEGER NOT NULL REFERENCES public.bus_ticket_bookings(id) ON DELETE CASCADE,
    recipient_user_id INTEGER NULL REFERENCES public.users(id) ON DELETE SET NULL,
    recipient_telegram_id BIGINT NULL,
    channel TEXT NOT NULL DEFAULT 'telegram' CHECK (channel IN ('telegram', 'sms', 'manual')),
    language TEXT NOT NULL DEFAULT 'ru' CHECK (language IN ('ru', 'tj', 'uz')),
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'sent', 'failed', 'unreachable')),
    attempt_count INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 5,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    sent_at TIMESTAMPTZ NULL,
    last_error_code TEXT NULL,
    processing_token TEXT NULL,
    processing_started_at TIMESTAMPTZ NULL,
    lease_expires_at TIMESTAMPTZ NULL,
    telegram_message_id BIGINT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_bus_ticket_notif_outbox_event_booking_channel UNIQUE (event_id, booking_id, channel)
);

CREATE INDEX IF NOT EXISTS idx_bus_ticket_notif_outbox_status_claim 
    ON public.bus_ticket_notification_outbox(status, next_attempt_at) 
    WHERE status IN ('pending', 'processing');

CREATE INDEX IF NOT EXISTS idx_bus_ticket_notif_outbox_booking_id 
    ON public.bus_ticket_notification_outbox(booking_id);

CREATE INDEX IF NOT EXISTS idx_bus_ticket_notif_outbox_event_id 
    ON public.bus_ticket_notification_outbox(event_id);

ALTER TABLE public.bus_ticket_notification_outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.bus_ticket_notification_outbox FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.bus_ticket_notification_outbox TO service_role;


-- 3. Atomic RPC for Seat Remapping & Bus Update
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
            ) ON CONFLICT (event_id, booking_id, channel) DO NOTHING;
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


-- 4. Atomic Outbox Claim Function with FOR UPDATE SKIP LOCKED
CREATE OR REPLACE FUNCTION public.fn_claim_bus_trip_notification_batch(
    p_batch_size INTEGER DEFAULT 10,
    p_worker_token TEXT DEFAULT gen_random_uuid()::text,
    p_lease_seconds INTEGER DEFAULT 60
)
RETURNS TABLE (
    outbox_id UUID,
    event_id UUID,
    booking_id INTEGER,
    recipient_user_id INTEGER,
    recipient_telegram_id BIGINT,
    channel TEXT,
    language TEXT,
    payload JSONB,
    attempt_count INTEGER,
    processing_token TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_now TIMESTAMPTZ := NOW();
    v_lease_expiry TIMESTAMPTZ := v_now + (p_lease_seconds || ' seconds')::interval;
BEGIN
    RETURN QUERY
    WITH candidate_records AS (
        SELECT bno.id
        FROM public.bus_ticket_notification_outbox bno
        WHERE bno.channel = 'telegram'
          AND (
              (bno.status = 'pending' AND bno.next_attempt_at <= v_now)
              OR (bno.status = 'processing' AND bno.lease_expires_at < v_now)
          )
        ORDER BY bno.created_at ASC
        LIMIT p_batch_size
        FOR UPDATE SKIP LOCKED
    ),
    claimed_records AS (
        UPDATE public.bus_ticket_notification_outbox o
        SET
            status = 'processing',
            processing_token = p_worker_token,
            processing_started_at = v_now,
            lease_expires_at = v_lease_expiry,
            attempt_count = o.attempt_count + 1
        FROM candidate_records c
        WHERE o.id = c.id
        RETURNING
            o.id,
            o.event_id,
            o.booking_id,
            o.recipient_user_id,
            o.recipient_telegram_id,
            o.channel,
            o.language,
            o.payload,
            o.attempt_count,
            o.processing_token
    )
    SELECT
        cr.id AS outbox_id,
        cr.event_id,
        cr.booking_id,
        cr.recipient_user_id,
        cr.recipient_telegram_id,
        cr.channel,
        cr.language,
        cr.payload,
        cr.attempt_count,
        cr.processing_token
    FROM claimed_records cr;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_claim_bus_trip_notification_batch FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_claim_bus_trip_notification_batch TO service_role;

COMMIT;
