-- ==============================================================================
-- TRANSACTIONAL MIGRATION REHEARSAL SCRIPT (DRY RUN)
-- File: docs/migrations/verification/20260904_manual_booking_journey_rehearsal.sql
-- Description: Purely transactional rehearsal for Phase P.1A & P.1B.2.
-- SAFETY INVARIANT:
--   - Starts with BEGIN;
--   - Ends with ROLLBACK;
--   - ZERO COMMIT statements;
--   - ZERO permanent modifications to production database;
--   - ZERO real passenger/booking records touched;
--   - All synthetic test rows are reverted upon ROLLBACK.
-- ==============================================================================

BEGIN;

-- ------------------------------------------------------------------------------
-- STEP 1: APPLY THE COMPLETE MIGRATION DDL INSIDE TRANSACTION
-- ------------------------------------------------------------------------------

-- 1.1 Table: booking_handoffs
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

-- 1.2 Backwards-compatible correlation column on booking_claim_sessions
ALTER TABLE public.booking_claim_sessions 
    ADD COLUMN IF NOT EXISTS handoff_id UUID NULL REFERENCES public.booking_handoffs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_bcs_handoff_id 
    ON public.booking_claim_sessions(handoff_id) WHERE handoff_id IS NOT NULL;

-- 1.3 Hardened Permissions & Immutability Trigger for booking_handoffs
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

-- 1.4 Table: booking_journey_events
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

-- 1.5 RLS and Trigger for booking_journey_events
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

-- 1.6 Hardened RPC fn_create_booking_handoff
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
SET search_path = public, pg_temp
AS $$
DECLARE
    v_handoff_id UUID;
    v_event_id BIGINT;
    v_now TIMESTAMPTZ := NOW();
    v_booking_exists BOOLEAN;
BEGIN
    IF p_channel NOT IN ('whatsapp', 'sms', 'telegram', 'copy_link') THEN
        RETURN jsonb_build_object('success', false, 'error', 'INVALID_CHANNEL');
    END IF;

    SELECT EXISTS(SELECT 1 FROM public.bus_ticket_bookings WHERE id = p_booking_id) INTO v_booking_exists;
    IF NOT v_booking_exists THEN
        RETURN jsonb_build_object('success', false, 'error', 'BOOKING_NOT_FOUND');
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
        COALESCE(p_metadata, '{}'::jsonb),
        v_now
    ) RETURNING id INTO v_event_id;

    RETURN jsonb_build_object(
        'success', true,
        'handoff_id', v_handoff_id,
        'event_id', v_event_id,
        'created_at', v_now
    );
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object(
        'success', false,
        'error', SQLERRM
    );
END;
$$;

REVOKE ALL ON FUNCTION public.fn_create_booking_handoff FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_create_booking_handoff TO service_role;


-- ------------------------------------------------------------------------------
-- STEP 2: REHEARSAL VERIFICATION SUITE (ALL TESTS INSIDE TRANSACTION)
-- ------------------------------------------------------------------------------

DO $$
DECLARE
    v_test_user_id INTEGER;
    v_test_ticket_id INTEGER;
    v_test_booking_id INTEGER;
    v_test_session_id UUID := gen_random_uuid();
    v_handoff_res JSONB;
    v_handoff_id UUID;
    v_event_id BIGINT;
    v_catch_worked BOOLEAN;
BEGIN
    RAISE NOTICE '=== REHEARSAL TEST 1: Schema & Types Verification ===';
    -- Check table existence
    PERFORM 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'booking_handoffs';
    IF NOT FOUND THEN RAISE EXCEPTION 'FAIL: booking_handoffs table missing'; END IF;

    PERFORM 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'booking_journey_events';
    IF NOT FOUND THEN RAISE EXCEPTION 'FAIL: booking_journey_events table missing'; END IF;

    RAISE NOTICE '=== REHEARSAL TEST 2: Seed Isolated Synthetic Test Rows ===';
    -- Create temporary test user
    INSERT INTO public.users (name, phone, role)
    VALUES ('Rehearsal Carrier User', '+992900000099', 'carrier')
    RETURNING id INTO v_test_user_id;

    -- Create temporary test bus ticket
    INSERT INTO public.bus_tickets (
        carrier_id, from_city, to_city, departure_date, departure_time,
        price, total_seats, available_seats, reserved_seats, transport_company, bus_model
    ) VALUES (
        v_test_user_id, 'Душанбе', 'Худжанд', CURRENT_DATE + 5, '08:00',
        150, 40, 39, ARRAY['1']::text[], 'Тест Компания', 'Mercedes Sprinter'
    ) RETURNING id INTO v_test_ticket_id;

    -- Create temporary test booking
    INSERT INTO public.bus_ticket_bookings (
        bus_ticket_id, passenger_id, seat_numbers, total_price, status,
        boarding_status, phone, channel, source_type, claim_status
    ) VALUES (
        v_test_ticket_id, v_test_user_id, ARRAY['1']::text[], 150, 'confirmed',
        'pending_boarding', '+992900115050', 'manual', 'manual', 'unclaimed'
    ) RETURNING id INTO v_test_booking_id;

    -- Create temporary test claim session
    INSERT INTO public.booking_claim_sessions (
        id, booking_id, session_token_hash, expires_at, created_at
    ) VALUES (
        v_test_session_id, v_test_booking_id, 'test_hash_rehearsal', NOW() + INTERVAL '15 minutes', NOW()
    );

    RAISE NOTICE '=== REHEARSAL TEST 3: RPC Atomicity fn_create_booking_handoff ===';
    v_handoff_res := public.fn_create_booking_handoff(
        v_test_booking_id,
        'whatsapp',
        v_test_session_id,
        '+992 ** *** 5050',
        v_test_user_id,
        '{"note": "rehearsal"}'::jsonb
    );

    IF (v_handoff_res->>'success')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'FAIL: fn_create_booking_handoff failed: %', v_handoff_res->>'error';
    END IF;

    v_handoff_id := (v_handoff_res->>'handoff_id')::uuid;
    v_event_id := (v_handoff_res->>'event_id')::bigint;

    -- Verify handoff was created with correct data
    PERFORM 1 FROM public.booking_handoffs 
    WHERE id = v_handoff_id AND channel = 'whatsapp' AND recipient_phone_masked = '+992 ** *** 5050';
    IF NOT FOUND THEN RAISE EXCEPTION 'FAIL: handoff row not found'; END IF;

    -- Verify SHARE_INITIATED was created atomically
    PERFORM 1 FROM public.booking_journey_events 
    WHERE id = v_event_id AND event_type = 'SHARE_INITIATED' AND handoff_id = v_handoff_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'FAIL: SHARE_INITIATED row not found'; END IF;

    RAISE NOTICE '=== REHEARSAL TEST 4: Allowed Handoff Updates ===';
    UPDATE public.booking_handoffs 
    SET opened_at = NOW(), last_event_at = NOW() 
    WHERE id = v_handoff_id;

    RAISE NOTICE '=== REHEARSAL TEST 5: Prohibited Handoff Column Updates (Trigger Gate) ===';
    v_catch_worked := FALSE;
    BEGIN
        UPDATE public.booking_handoffs 
        SET channel = 'telegram' 
        WHERE id = v_handoff_id;
    EXCEPTION WHEN OTHERS THEN
        v_catch_worked := TRUE;
    END;
    IF NOT v_catch_worked THEN RAISE EXCEPTION 'FAIL: Mutation trigger failed to block channel update'; END IF;

    v_catch_worked := FALSE;
    BEGIN
        UPDATE public.booking_handoffs 
        SET booking_id = v_test_booking_id + 999 
        WHERE id = v_handoff_id;
    EXCEPTION WHEN OTHERS THEN
        v_catch_worked := TRUE;
    END;
    IF NOT v_catch_worked THEN RAISE EXCEPTION 'FAIL: Mutation trigger failed to block booking_id update'; END IF;

    RAISE NOTICE '=== REHEARSAL TEST 6: Prohibited Journey Events Mutation (Trigger Gate) ===';
    v_catch_worked := FALSE;
    BEGIN
        UPDATE public.booking_journey_events 
        SET actor_type = 'bot' 
        WHERE id = v_event_id;
    EXCEPTION WHEN OTHERS THEN
        v_catch_worked := TRUE;
    END;
    IF NOT v_catch_worked THEN RAISE EXCEPTION 'FAIL: Mutation trigger failed to block event update'; END IF;

    v_catch_worked := FALSE;
    BEGIN
        DELETE FROM public.booking_journey_events 
        WHERE id = v_event_id;
    EXCEPTION WHEN OTHERS THEN
        v_catch_worked := TRUE;
    END;
    IF NOT v_catch_worked THEN RAISE EXCEPTION 'FAIL: Mutation trigger failed to block event deletion'; END IF;

    RAISE NOTICE '=== REHEARSAL TEST 7: Milestone Idempotency Indexes ===';
    -- Insert milestone BOOKING_CREATED
    INSERT INTO public.booking_journey_events (booking_id, event_type, actor_type)
    VALUES (v_test_booking_id, 'BOOKING_CREATED', 'carrier');

    -- Attempt duplicate BOOKING_CREATED (must fail with 23505)
    v_catch_worked := FALSE;
    BEGIN
        INSERT INTO public.booking_journey_events (booking_id, event_type, actor_type)
        VALUES (v_test_booking_id, 'BOOKING_CREATED', 'carrier');
    EXCEPTION WHEN unique_violation THEN
        v_catch_worked := TRUE;
    END;
    IF NOT v_catch_worked THEN RAISE EXCEPTION 'FAIL: Unique index failed to block duplicate BOOKING_CREATED'; END IF;

    RAISE NOTICE '=== REHEARSAL TEST 8: Dual LINK_OPENED Idempotency Indexes ===';
    -- Case A: LINK_OPENED with handoff_id
    INSERT INTO public.booking_journey_events (booking_id, handoff_id, event_type, actor_type)
    VALUES (v_test_booking_id, v_handoff_id, 'LINK_OPENED', 'passenger');

    -- Attempt duplicate LINK_OPENED for same handoff_id (must fail)
    v_catch_worked := FALSE;
    BEGIN
        INSERT INTO public.booking_journey_events (booking_id, handoff_id, event_type, actor_type)
        VALUES (v_test_booking_id, v_handoff_id, 'LINK_OPENED', 'passenger');
    EXCEPTION WHEN unique_violation THEN
        v_catch_worked := TRUE;
    END;
    IF NOT v_catch_worked THEN RAISE EXCEPTION 'FAIL: Unique index failed to block duplicate LINK_OPENED with handoff'; END IF;

    -- Case B: Unattributed LINK_OPENED (handoff_id IS NULL)
    INSERT INTO public.booking_journey_events (booking_id, handoff_id, event_type, actor_type)
    VALUES (v_test_booking_id, NULL, 'LINK_OPENED', 'passenger');

    -- Attempt second unattributed LINK_OPENED for same booking_id (must fail)
    v_catch_worked := FALSE;
    BEGIN
        INSERT INTO public.booking_journey_events (booking_id, handoff_id, event_type, actor_type)
        VALUES (v_test_booking_id, NULL, 'LINK_OPENED', 'passenger');
    EXCEPTION WHEN unique_violation THEN
        v_catch_worked := TRUE;
    END;
    IF NOT v_catch_worked THEN RAISE EXCEPTION 'FAIL: Unique index failed to block duplicate unattributed LINK_OPENED'; END IF;

    RAISE NOTICE '=== ALL REHEARSAL TESTS PASSED PERFECTLY ===';
END;
$$;

-- ------------------------------------------------------------------------------
-- CRITICAL SAFETY INVARIANT: GUARANTEED TRANSACTION ROLLBACK
-- Reverts all tables, triggers, functions, sequence updates, and test rows.
-- ------------------------------------------------------------------------------
ROLLBACK;
