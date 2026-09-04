-- ==============================================================================
-- STAGING MIGRATION & VERIFICATION SCRIPT
-- File: docs/migrations/staging/01_staging_manual_booking_journey_rehearsal.sql
-- Target Environment: Staging Supabase / Database Branch
-- Description: Applies Phase P.1A & P.1B.2 migration and runs full verification suite.
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. APPLY TARGET MIGRATION
-- ------------------------------------------------------------------------------

-- Table: booking_handoffs
CREATE TABLE IF NOT EXISTS public.booking_handoffs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id INTEGER NOT NULL REFERENCES public.bus_ticket_bookings(id) ON DELETE CASCADE,
    claim_session_id UUID NULL REFERENCES public.booking_claim_sessions(id) ON DELETE SET NULL,
    channel TEXT NOT NULL CHECK (channel IN ('whatsapp', 'sms', 'telegram', 'copy_link')),
    recipient_phone_masked TEXT NULL,
    initiated_by_user_id INTEGER NULL REFERENCES public.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    opened_at TIMESTAMPTZ NULL,
    last_event_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS idx_booking_handoffs_booking_created 
    ON public.booking_handoffs(booking_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_booking_handoffs_channel 
    ON public.booking_handoffs(channel);

CREATE INDEX IF NOT EXISTS idx_booking_handoffs_claim_session 
    ON public.booking_handoffs(claim_session_id);

-- Backwards-compatible correlation column on booking_claim_sessions
ALTER TABLE public.booking_claim_sessions 
    ADD COLUMN IF NOT EXISTS handoff_id UUID NULL REFERENCES public.booking_handoffs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_bcs_handoff_id 
    ON public.booking_claim_sessions(handoff_id) WHERE handoff_id IS NOT NULL;

-- Hardened Permissions & Immutability Trigger for booking_handoffs
ALTER TABLE public.booking_handoffs ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.booking_handoffs FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.booking_handoffs TO service_role;
GRANT UPDATE (opened_at, last_event_at) ON public.booking_handoffs TO service_role;

CREATE OR REPLACE FUNCTION public.prevent_booking_handoff_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    IF (NEW.id IS DISTINCT FROM OLD.id) OR
       (NEW.booking_id IS DISTINCT FROM OLD.booking_id) OR
       (NEW.claim_session_id IS DISTINCT FROM OLD.claim_session_id) OR
       (NEW.channel IS DISTINCT FROM OLD.channel) OR
       (NEW.recipient_phone_masked IS DISTINCT FROM OLD.recipient_phone_masked) OR
       (NEW.initiated_by_user_id IS DISTINCT FROM OLD.initiated_by_user_id) OR
       (NEW.created_at IS DISTINCT FROM OLD.created_at) THEN
        RAISE EXCEPTION 'Only opened_at and last_event_at can be modified on booking_handoffs rows.';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_booking_handoff_mutation ON public.booking_handoffs;
CREATE TRIGGER trg_prevent_booking_handoff_mutation
    BEFORE UPDATE ON public.booking_handoffs
    FOR EACH ROW
    EXECUTE FUNCTION public.prevent_booking_handoff_mutation();

-- Table: booking_journey_events
CREATE TABLE IF NOT EXISTS public.booking_journey_events (
    id BIGSERIAL PRIMARY KEY,
    booking_id INTEGER NOT NULL REFERENCES public.bus_ticket_bookings(id) ON DELETE CASCADE,
    handoff_id UUID NULL REFERENCES public.booking_handoffs(id) ON DELETE SET NULL,
    session_id UUID NULL REFERENCES public.booking_claim_sessions(id) ON DELETE SET NULL,
    event_type TEXT NOT NULL CHECK (event_type IN (
        'BOOKING_CREATED',
        'SHARE_INITIATED',
        'LINK_OPENED',
        'TELEGRAM_CTA_CLICKED',
        'TELEGRAM_BOT_STARTED',
        'PHONE_SHARE_REQUESTED',
        'PHONE_SHARED',
        'PHONE_VERIFIED',
        'PHONE_MISMATCH',
        'CLAIM_REQUEST_CREATED',
        'CLAIM_COMPLETED',
        'BOOKING_LINKED_TO_USER',
        'ACTIVATION_COMPLETED'
    )),
    channel TEXT NULL CHECK (channel IN ('whatsapp', 'sms', 'telegram', 'copy_link')),
    actor_type TEXT NOT NULL CHECK (actor_type IN ('carrier', 'passenger', 'bot', 'system')),
    actor_id TEXT NULL,
    recipient_phone_masked TEXT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bje_booking_created 
    ON public.booking_journey_events(booking_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_bje_handoff_id 
    ON public.booking_journey_events(handoff_id);

CREATE INDEX IF NOT EXISTS idx_bje_event_type 
    ON public.booking_journey_events(event_type, created_at DESC);

-- Partial unique indexes
CREATE UNIQUE INDEX IF NOT EXISTS idx_bje_single_booking_created 
    ON public.booking_journey_events(booking_id) 
    WHERE event_type = 'BOOKING_CREATED';

CREATE UNIQUE INDEX IF NOT EXISTS idx_bje_single_claim_completed 
    ON public.booking_journey_events(booking_id) 
    WHERE event_type = 'CLAIM_COMPLETED';

CREATE UNIQUE INDEX IF NOT EXISTS idx_bje_single_booking_linked 
    ON public.booking_journey_events(booking_id) 
    WHERE event_type = 'BOOKING_LINKED_TO_USER';

CREATE UNIQUE INDEX IF NOT EXISTS idx_bje_single_activation_completed 
    ON public.booking_journey_events(booking_id) 
    WHERE event_type = 'ACTIVATION_COMPLETED';

CREATE UNIQUE INDEX IF NOT EXISTS idx_bje_single_share_initiated 
    ON public.booking_journey_events(handoff_id) 
    WHERE event_type = 'SHARE_INITIATED' AND handoff_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_bje_single_link_opened_with_handoff 
    ON public.booking_journey_events(handoff_id) 
    WHERE event_type = 'LINK_OPENED' AND handoff_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_bje_single_link_opened_unattributed 
    ON public.booking_journey_events(booking_id) 
    WHERE event_type = 'LINK_OPENED' AND handoff_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_bje_single_bot_started 
    ON public.booking_journey_events(session_id) 
    WHERE event_type = 'TELEGRAM_BOT_STARTED' AND session_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_bje_single_phone_requested 
    ON public.booking_journey_events(session_id) 
    WHERE event_type = 'PHONE_SHARE_REQUESTED' AND session_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_bje_single_phone_shared 
    ON public.booking_journey_events(session_id) 
    WHERE event_type = 'PHONE_SHARED' AND session_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_bje_single_phone_outcome 
    ON public.booking_journey_events(session_id) 
    WHERE event_type IN ('PHONE_VERIFIED', 'PHONE_MISMATCH') AND session_id IS NOT NULL;

-- RLS and Trigger for booking_journey_events
ALTER TABLE public.booking_journey_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.booking_journey_events FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.booking_journey_events TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.booking_journey_events_id_seq TO service_role;

CREATE OR REPLACE FUNCTION public.prevent_journey_event_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    RAISE EXCEPTION 'booking_journey_events rows are immutable. UPDATE and DELETE are prohibited.';
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_journey_event_mutation ON public.booking_journey_events;
CREATE TRIGGER trg_prevent_journey_event_mutation
    BEFORE UPDATE OR DELETE ON public.booking_journey_events
    FOR EACH ROW
    EXECUTE FUNCTION public.prevent_journey_event_mutation();

-- Hardened Atomic RPC function
CREATE OR REPLACE FUNCTION public.fn_create_booking_handoff(
    p_booking_id INTEGER,
    p_channel TEXT,
    p_claim_session_id UUID DEFAULT NULL,
    p_recipient_phone_masked TEXT DEFAULT NULL,
    p_initiated_by_user_id INTEGER DEFAULT NULL,
    p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v_handoff_id UUID;
    v_event_id BIGINT;
    v_now TIMESTAMPTZ := pg_catalog.now();
    v_booking_exists BOOLEAN;
BEGIN
    IF p_channel NOT IN ('whatsapp', 'sms', 'telegram', 'copy_link') THEN
        RETURN pg_catalog.jsonb_build_object('success', false, 'error', 'INVALID_CHANNEL');
    END IF;

    SELECT EXISTS(SELECT 1 FROM public.bus_ticket_bookings WHERE id = p_booking_id) INTO v_booking_exists;
    IF NOT v_booking_exists THEN
        RETURN pg_catalog.jsonb_build_object('success', false, 'error', 'BOOKING_NOT_FOUND');
    END IF;

    INSERT INTO public.booking_handoffs (
        booking_id,
        claim_session_id,
        channel,
        recipient_phone_masked,
        initiated_by_user_id,
        created_at,
        last_event_at
    ) VALUES (
        p_booking_id,
        p_claim_session_id,
        p_channel,
        p_recipient_phone_masked,
        p_initiated_by_user_id,
        v_now,
        v_now
    ) RETURNING id INTO v_handoff_id;

    INSERT INTO public.booking_journey_events (
        booking_id,
        handoff_id,
        session_id,
        event_type,
        channel,
        actor_type,
        actor_id,
        recipient_phone_masked,
        metadata,
        created_at
    ) VALUES (
        p_booking_id,
        v_handoff_id,
        p_claim_session_id,
        'SHARE_INITIATED',
        p_channel,
        'carrier',
        p_initiated_by_user_id::text,
        p_recipient_phone_masked,
        pg_catalog.coalesce(p_metadata, '{}'::jsonb),
        v_now
    ) RETURNING id INTO v_event_id;

    RETURN pg_catalog.jsonb_build_object(
        'success', true,
        'handoff_id', v_handoff_id,
        'event_id', v_event_id,
        'created_at', v_now
    );
EXCEPTION WHEN OTHERS THEN
    RETURN pg_catalog.jsonb_build_object(
        'success', false,
        'error', SQLERRM
    );
END;
$$;

REVOKE ALL ON FUNCTION public.fn_create_booking_handoff FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_create_booking_handoff TO service_role;


-- ------------------------------------------------------------------------------
-- 2. VERIFICATION EXECUTION IN STAGING
-- ------------------------------------------------------------------------------

DO $$
DECLARE
    v_carrier_id INTEGER;
    v_ticket_id INTEGER;
    v_booking_id INTEGER;
    v_session_id UUID := gen_random_uuid();
    v_handoff_res JSONB;
    v_handoff_id UUID;
    v_event_id BIGINT;
    v_blocked BOOLEAN;
BEGIN
    RAISE NOTICE '>>> Running Staging Verification Suite...';

    -- 2.1 Seed Staging Test Entity
    INSERT INTO public.users (name, phone, role)
    VALUES ('Staging Test Carrier', '+992900000001', 'carrier')
    RETURNING id INTO v_carrier_id;

    INSERT INTO public.bus_tickets (
        carrier_id, from_city, to_city, departure_date, departure_time,
        price, total_seats, available_seats, reserved_seats, transport_company, bus_model
    ) VALUES (
        v_carrier_id, 'Душанбе', 'Худжанд', CURRENT_DATE + 3, '09:00',
        150, 40, 39, ARRAY['1']::text[], 'Фароз', 'Setra'
    ) RETURNING id INTO v_ticket_id;

    INSERT INTO public.bus_ticket_bookings (
        bus_ticket_id, passenger_id, seat_numbers, total_price, status,
        boarding_status, phone, channel, source_type, claim_status
    ) VALUES (
        v_ticket_id, v_carrier_id, ARRAY['1']::text[], 150, 'confirmed',
        'pending_boarding', '+992900115050', 'manual', 'manual', 'unclaimed'
    ) RETURNING id INTO v_booking_id;

    INSERT INTO public.booking_claim_sessions (
        id, booking_id, session_token_hash, expires_at, created_at
    ) VALUES (
        v_session_id, v_booking_id, 'staging_hash_val', NOW() + INTERVAL '15 minutes', NOW()
    );

    -- 2.2 Test RPC Atomicity
    v_handoff_res := public.fn_create_booking_handoff(
        v_booking_id,
        'whatsapp',
        v_session_id,
        '+992 ** *** 5050',
        v_carrier_id,
        '{"note": "staging"}'::jsonb
    );

    IF (v_handoff_res->>'success')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'Staging Fail: fn_create_booking_handoff error: %', v_handoff_res->>'error';
    END IF;

    v_handoff_id := (v_handoff_res->>'handoff_id')::uuid;
    v_event_id := (v_handoff_res->>'event_id')::bigint;

    -- 2.3 Test Allowed Updates
    UPDATE public.booking_handoffs 
    SET opened_at = NOW(), last_event_at = NOW() 
    WHERE id = v_handoff_id;

    -- 2.4 Test Blocked Column Updates
    v_blocked := FALSE;
    BEGIN
        UPDATE public.booking_handoffs SET channel = 'telegram' WHERE id = v_handoff_id;
    EXCEPTION WHEN OTHERS THEN v_blocked := TRUE; END;
    IF NOT v_blocked THEN RAISE EXCEPTION 'Staging Fail: channel mutation was not blocked'; END IF;

    -- 2.5 Test Blocked Event Mutation
    v_blocked := FALSE;
    BEGIN
        UPDATE public.booking_journey_events SET actor_type = 'bot' WHERE id = v_event_id;
    EXCEPTION WHEN OTHERS THEN v_blocked := TRUE; END;
    IF NOT v_blocked THEN RAISE EXCEPTION 'Staging Fail: event mutation was not blocked'; END IF;

    -- 2.6 Test Milestone Idempotency
    INSERT INTO public.booking_journey_events (booking_id, event_type, actor_type)
    VALUES (v_booking_id, 'BOOKING_CREATED', 'carrier');

    v_blocked := FALSE;
    BEGIN
        INSERT INTO public.booking_journey_events (booking_id, event_type, actor_type)
        VALUES (v_booking_id, 'BOOKING_CREATED', 'carrier');
    EXCEPTION WHEN unique_violation THEN v_blocked := TRUE; END;
    IF NOT v_blocked THEN RAISE EXCEPTION 'Staging Fail: duplicate BOOKING_CREATED was not blocked'; END IF;

    -- 2.7 Test Dual LINK_OPENED Idempotency
    INSERT INTO public.booking_journey_events (booking_id, handoff_id, event_type, actor_type)
    VALUES (v_booking_id, v_handoff_id, 'LINK_OPENED', 'passenger');

    v_blocked := FALSE;
    BEGIN
        INSERT INTO public.booking_journey_events (booking_id, handoff_id, event_type, actor_type)
        VALUES (v_booking_id, v_handoff_id, 'LINK_OPENED', 'passenger');
    EXCEPTION WHEN unique_violation THEN v_blocked := TRUE; END;
    IF NOT v_blocked THEN RAISE EXCEPTION 'Staging Fail: duplicate LINK_OPENED with handoff was not blocked'; END IF;

    -- Unattributed LINK_OPENED
    INSERT INTO public.booking_journey_events (booking_id, handoff_id, event_type, actor_type)
    VALUES (v_booking_id, NULL, 'LINK_OPENED', 'passenger');

    v_blocked := FALSE;
    BEGIN
        INSERT INTO public.booking_journey_events (booking_id, handoff_id, event_type, actor_type)
        VALUES (v_booking_id, NULL, 'LINK_OPENED', 'passenger');
    EXCEPTION WHEN unique_violation THEN v_blocked := TRUE; END;
    IF NOT v_blocked THEN RAISE EXCEPTION 'Staging Fail: duplicate unattributed LINK_OPENED was not blocked'; END IF;

    RAISE NOTICE '>>> ALL STAGING VERIFICATIONS PASSED SUCCESSFULLY!';
END;
$$;
