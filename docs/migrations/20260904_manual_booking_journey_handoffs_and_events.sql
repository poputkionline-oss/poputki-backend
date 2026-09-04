-- ==============================================================================
-- Migration: 20260904_manual_booking_journey_handoffs_and_events.sql
-- Description: Phase P.1A & P.1B.2 — Hardened Manual Booking Journey Engine
-- Target Tables: public.booking_handoffs, public.booking_journey_events
-- Target Extension: public.booking_claim_sessions(handoff_id)
-- Target Functions: public.fn_create_booking_handoff, 
--                   public.prevent_journey_event_mutation,
--                   public.prevent_booking_handoff_mutation
-- Verified Types:
--   - bus_ticket_bookings.id: INTEGER (int4)
--   - booking_claim_sessions.id: UUID
--   - users.id: INTEGER (int4)
-- Project: POPUTKI.ONLINE
-- ==============================================================================

-- 1. Table: booking_handoffs (tracks each distinct ticket-share attempt)
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

-- Performance indexes for booking_handoffs
CREATE INDEX IF NOT EXISTS idx_booking_handoffs_booking_created 
    ON public.booking_handoffs(booking_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_booking_handoffs_channel 
    ON public.booking_handoffs(channel);

CREATE INDEX IF NOT EXISTS idx_booking_handoffs_claim_session 
    ON public.booking_handoffs(claim_session_id);

-- Optional backwards-compatible correlation on booking_claim_sessions
ALTER TABLE public.booking_claim_sessions 
    ADD COLUMN IF NOT EXISTS handoff_id UUID NULL REFERENCES public.booking_handoffs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_bcs_handoff_id 
    ON public.booking_claim_sessions(handoff_id) WHERE handoff_id IS NOT NULL;

-- 2. Hardened Permissions & Immutability Trigger for booking_handoffs
ALTER TABLE public.booking_handoffs ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.booking_handoffs FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.booking_handoffs TO service_role;
GRANT UPDATE (opened_at, last_event_at) ON public.booking_handoffs TO service_role;

-- Trigger: Enforces immutability of business columns in booking_handoffs
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


-- 3. Table: booking_journey_events (append-only event stream of passenger journey)
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

-- Performance indexes for booking_journey_events
CREATE INDEX IF NOT EXISTS idx_bje_booking_created 
    ON public.booking_journey_events(booking_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_bje_handoff_id 
    ON public.booking_journey_events(handoff_id);

CREATE INDEX IF NOT EXISTS idx_bje_event_type 
    ON public.booking_journey_events(event_type, created_at DESC);

-- Partial unique indexes for milestone & stage idempotency
-- A. Milestone: max 1 event per booking_id
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

-- B. Handoff-scoped idempotency: max 1 per handoff_id
CREATE UNIQUE INDEX IF NOT EXISTS idx_bje_single_share_initiated 
    ON public.booking_journey_events(handoff_id) 
    WHERE event_type = 'SHARE_INITIATED' AND handoff_id IS NOT NULL;

-- C. LINK_OPENED Dual Idempotency (Case A: with handoff_id, Case B: unattributed without handoff_id)
CREATE UNIQUE INDEX IF NOT EXISTS idx_bje_single_link_opened_with_handoff 
    ON public.booking_journey_events(handoff_id) 
    WHERE event_type = 'LINK_OPENED' AND handoff_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_bje_single_link_opened_unattributed 
    ON public.booking_journey_events(booking_id) 
    WHERE event_type = 'LINK_OPENED' AND handoff_id IS NULL;

-- D. Session-scoped idempotency: max 1 per session_id
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

-- RLS: Server-side service-role only
ALTER TABLE public.booking_journey_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.booking_journey_events FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.booking_journey_events TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.booking_journey_events_id_seq TO service_role;

-- 4. Database-level immutability enforcement: Prevent UPDATE or DELETE on events
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


-- 5. Hardened Atomic PostgreSQL function: Create handoff and SHARE_INITIATED event together
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
    -- Strict parameter validation
    IF p_channel NOT IN ('whatsapp', 'sms', 'telegram', 'copy_link') THEN
        RETURN pg_catalog.jsonb_build_object('success', false, 'error', 'INVALID_CHANNEL');
    END IF;

    -- Validate booking existence
    SELECT EXISTS(SELECT 1 FROM public.bus_ticket_bookings WHERE id = p_booking_id) INTO v_booking_exists;
    IF NOT v_booking_exists THEN
        RETURN pg_catalog.jsonb_build_object('success', false, 'error', 'BOOKING_NOT_FOUND');
    END IF;

    -- 1. Insert handoff record
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

    -- 2. Insert corresponding SHARE_INITIATED event atomically
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

-- Comments
COMMENT ON TABLE public.booking_handoffs IS 'Records each distinct ticket share attempt to a passenger or contact';
COMMENT ON TABLE public.booking_journey_events IS 'Append-only audit log of manual booking passenger activation lifecycle';
COMMENT ON FUNCTION public.fn_create_booking_handoff IS 'Atomically inserts a booking_handoffs record and corresponding SHARE_INITIATED event';
