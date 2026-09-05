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
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
            SELECT carrier_id FROM public.carrier_users WHERE user_id = auth.uid()
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


-- 3. Atomic RPC for Seat Remapping & Bus Update (If DB-level atomic execution is invoked)
CREATE OR REPLACE FUNCTION public.fn_atomic_bus_trip_update(
    p_ticket_id INTEGER,
    p_operator_id INTEGER,
    p_update_data JSONB,
    p_seat_remap JSONB, -- e.g. [{"booking_id": 10, "new_seat_numbers": [14]}]
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
    v_new_seats JSONB;
    v_event_id UUID;
    v_outbox_item JSONB;
    v_existing_event RECORD;
    v_idempotency_key TEXT;
BEGIN
    v_idempotency_key := p_event_data->>'idempotency_key';

    -- Check idempotency
    IF v_idempotency_key IS NOT NULL THEN
        SELECT id INTO v_existing_event 
        FROM public.bus_ticket_change_events 
        WHERE idempotency_key = v_idempotency_key;

        IF v_existing_event.id IS NOT NULL THEN
            RETURN jsonb_build_object(
                'success', true,
                'idempotent_replay', true,
                'event_id', v_existing_event.id
            );
        END IF;
    END IF;

    -- Lock ticket
    SELECT id, operator_id, status, departure_date, departure_time
    INTO v_ticket
    FROM public.bus_tickets
    WHERE id = p_ticket_id
    FOR UPDATE;

    IF v_ticket.id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'TICKET_NOT_FOUND');
    END IF;

    IF v_ticket.operator_id != p_operator_id THEN
        RETURN jsonb_build_object('success', false, 'error', 'FORBIDDEN_OPERATOR');
    END IF;

    IF v_ticket.status != 'active' THEN
        RETURN jsonb_build_object('success', false, 'error', 'TICKET_NOT_ACTIVE');
    END IF;

    -- Update bus_tickets fields
    UPDATE public.bus_tickets
    SET
        departure_date = COALESCE((p_update_data->>'departure_date')::date, departure_date),
        departure_time = COALESCE(p_update_data->>'departure_time', departure_time),
        arrival_date = COALESCE((p_update_data->>'arrival_date')::date, arrival_date),
        arrival_time = COALESCE(p_update_data->>'arrival_time', arrival_time),
        duration_minutes = COALESCE((p_update_data->>'duration_minutes')::integer, duration_minutes),
        from_address = COALESCE(p_update_data->>'from_address', from_address),
        to_address = COALESCE(p_update_data->>'to_address', to_address),
        intermediate_stops = CASE WHEN p_update_data ? 'intermediate_stops' THEN p_update_data->'intermediate_stops' ELSE intermediate_stops END,
        bus_id = CASE WHEN p_update_data ? 'bus_id' THEN (p_update_data->>'bus_id')::integer ELSE bus_id END,
        bus_type = COALESCE(p_update_data->>'bus_type', bus_type),
        total_seats = COALESCE((p_update_data->>'total_seats')::integer, total_seats),
        floor1_seats = CASE WHEN p_update_data ? 'floor1_seats' THEN (p_update_data->>'floor1_seats')::integer ELSE floor1_seats END,
        floor2_seats = CASE WHEN p_update_data ? 'floor2_seats' THEN (p_update_data->>'floor2_seats')::integer ELSE floor2_seats END,
        price = COALESCE((p_update_data->>'price')::numeric, price),
        premium_price = CASE WHEN p_update_data ? 'premium_price' THEN (p_update_data->>'premium_price')::numeric ELSE premium_price END,
        passenger_comments = COALESCE(p_update_data->>'passenger_comments', passenger_comments),
        photos = CASE WHEN p_update_data ? 'photos' THEN p_update_data->'photos' ELSE photos END,
        group_leader_name = CASE WHEN p_update_data ? 'group_leader_name' THEN p_update_data->>'group_leader_name' ELSE group_leader_name END,
        group_leader_phone = CASE WHEN p_update_data ? 'group_leader_phone' THEN p_update_data->>'group_leader_phone' ELSE group_leader_phone END,
        group_leader_whatsapp = CASE WHEN p_update_data ? 'group_leader_whatsapp' THEN p_update_data->>'group_leader_whatsapp' ELSE group_leader_whatsapp END
    WHERE id = p_ticket_id;

    -- Apply seat remapping if provided
    IF p_seat_remap IS NOT NULL AND jsonb_array_length(p_seat_remap) > 0 THEN
        FOR v_remap_item IN SELECT * FROM jsonb_array_elements(p_seat_remap)
        LOOP
            v_b_id := (v_remap_item->>'booking_id')::integer;
            v_new_seats := v_remap_item->'new_seat_numbers';
            
            UPDATE public.bus_ticket_bookings
            SET seat_numbers = v_new_seats
            WHERE id = v_b_id AND bus_ticket_id = p_ticket_id;
        END LOOP;
    END IF;

    -- Record change event
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
    ) RETURNING id INTO v_event_id;

    -- Insert notification outbox records
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

COMMIT;
