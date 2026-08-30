-- ==============================================================================
-- Migration: 20260831_claim_and_passenger_onboarding.sql
-- Description: Add claim sessions, claim requests, and atomic transactional claim functions
-- Project: POPUTKI.ONLINE
-- Target Tables: bus_ticket_bookings, booking_claim_sessions, booking_claim_requests
-- ==============================================================================

-- 1. Update claim_status check constraint safely on bus_ticket_bookings
DO $$
BEGIN
    ALTER TABLE public.bus_ticket_bookings DROP CONSTRAINT IF EXISTS chk_bus_bookings_claim_status;
    ALTER TABLE public.bus_ticket_bookings
    ADD CONSTRAINT chk_bus_bookings_claim_status
    CHECK (claim_status IN ('unclaimed', 'pending_verification', 'claimed', 'rejected'));
END $$;

-- 2. Create booking_claim_sessions with SHA-256 token hash storage
CREATE TABLE IF NOT EXISTS public.booking_claim_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id INTEGER NOT NULL REFERENCES public.bus_ticket_bookings(id) ON DELETE CASCADE,
    session_token_hash TEXT NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    opened_at TIMESTAMPTZ NULL,
    consumed_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for session lookup & TTL management
CREATE INDEX IF NOT EXISTS idx_claim_sessions_token_hash ON public.booking_claim_sessions(session_token_hash);
CREATE INDEX IF NOT EXISTS idx_claim_sessions_booking_id ON public.booking_claim_sessions(booking_id);
CREATE INDEX IF NOT EXISTS idx_claim_sessions_expires_at ON public.booking_claim_sessions(expires_at);

-- 3. Create booking_claim_requests with audit-safe ON DELETE SET NULL
CREATE TABLE IF NOT EXISTS public.booking_claim_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id INTEGER NOT NULL REFERENCES public.bus_ticket_bookings(id) ON DELETE CASCADE,
    requesting_user_id INTEGER NULL REFERENCES public.users(id) ON DELETE SET NULL,
    verification_method TEXT NOT NULL CHECK (verification_method IN ('telegram_contact', 'manual_review')),
    status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'superseded')),
    attempt_count INTEGER NOT NULL DEFAULT 1,
    failure_reason_code TEXT NULL,
    reviewed_by_user_id INTEGER NULL REFERENCES public.users(id) ON DELETE SET NULL,
    reviewed_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Partial unique index: only ONE active pending request per (booking_id, requesting_user_id)
-- Allows re-request after rejection without locking out the passenger
CREATE UNIQUE INDEX IF NOT EXISTS idx_claim_requests_pending_unique 
ON public.booking_claim_requests(booking_id, requesting_user_id) 
WHERE status = 'pending';

-- Query indexes
CREATE INDEX IF NOT EXISTS idx_claim_requests_booking_id ON public.booking_claim_requests(booking_id);
CREATE INDEX IF NOT EXISTS idx_claim_requests_user_id ON public.booking_claim_requests(requesting_user_id);
CREATE INDEX IF NOT EXISTS idx_claim_requests_status ON public.booking_claim_requests(status);

-- 4. Enable Row Level Security (Server-side privileged access only)
ALTER TABLE public.booking_claim_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.booking_claim_requests ENABLE ROW LEVEL SECURITY;

-- 5. Transactional PostgreSQL functions for atomic claim execution
CREATE OR REPLACE FUNCTION public.fn_claim_booking_auto(
    p_booking_id INTEGER,
    p_user_id INTEGER,
    p_session_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_updated_booking RECORD;
BEGIN
    -- Strict atomic lock & conditional update predicate
    UPDATE public.bus_ticket_bookings
    SET claim_status = 'claimed',
        claimed_by_user_id = p_user_id,
        claimed_at = NOW()
    WHERE id = p_booking_id
      AND status = 'confirmed'
      AND claim_status != 'claimed'
      AND claimed_by_user_id IS NULL
    RETURNING * INTO v_updated_booking;

    IF v_updated_booking.id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'BOOKING_INELIGIBLE_OR_ALREADY_CLAIMED');
    END IF;

    -- Mark session consumed if provided
    IF p_session_id IS NOT NULL THEN
        UPDATE public.booking_claim_sessions
        SET consumed_at = NOW()
        WHERE id = p_session_id;
    END IF;

    -- Supersede any other pending requests for this booking
    UPDATE public.booking_claim_requests
    SET status = 'superseded',
        failure_reason_code = 'SUPERSEDED_BY_AUTO_CLAIM'
    WHERE booking_id = p_booking_id
      AND status = 'pending';

    RETURN jsonb_build_object('success', true, 'booking_id', v_updated_booking.id);
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_review_claim_request(
    p_request_id UUID,
    p_carrier_user_id INTEGER,
    p_decision TEXT,
    p_reason TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_req RECORD;
    v_updated_booking RECORD;
BEGIN
    -- Lock pending request row
    SELECT * INTO v_req
    FROM public.booking_claim_requests
    WHERE id = p_request_id
      AND status = 'pending'
    FOR UPDATE;

    IF v_req.id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'REQUEST_NOT_FOUND_OR_ALREADY_REVIEWED');
    END IF;

    IF p_decision = 'approved' THEN
        -- Atomic claim transition
        UPDATE public.bus_ticket_bookings
        SET claim_status = 'claimed',
            claimed_by_user_id = v_req.requesting_user_id,
            claimed_at = NOW()
        WHERE id = v_req.booking_id
          AND status = 'confirmed'
          AND claim_status != 'claimed'
          AND claimed_by_user_id IS NULL
        RETURNING * INTO v_updated_booking;

        IF v_updated_booking.id IS NULL THEN
            -- Booking was cancelled or claimed concurrently
            UPDATE public.booking_claim_requests
            SET status = 'superseded',
                failure_reason_code = 'BOOKING_NO_LONGER_ELIGIBLE',
                reviewed_by_user_id = p_carrier_user_id,
                reviewed_at = NOW()
            WHERE id = p_request_id;

            RETURN jsonb_build_object('success', false, 'error', 'BOOKING_INELIGIBLE_OR_ALREADY_CLAIMED');
        END IF;

        -- Mark winning request approved
        UPDATE public.booking_claim_requests
        SET status = 'approved',
            reviewed_by_user_id = p_carrier_user_id,
            reviewed_at = NOW()
        WHERE id = p_request_id;

        -- Supersede all other pending requests for this booking
        UPDATE public.booking_claim_requests
        SET status = 'superseded',
            failure_reason_code = 'SUPERSEDED_BY_CARRIER_APPROVAL'
        WHERE booking_id = v_req.booking_id
          AND id != p_request_id
          AND status = 'pending';

        RETURN jsonb_build_object('success', true, 'status', 'approved');

    ELSIF p_decision = 'rejected' THEN
        -- Mark request rejected
        UPDATE public.booking_claim_requests
        SET status = 'rejected',
            failure_reason_code = COALESCE(p_reason, 'CARRIER_REJECTED'),
            reviewed_by_user_id = p_carrier_user_id,
            reviewed_at = NOW()
        WHERE id = p_request_id;

        -- Restore booking claim_status to unclaimed IF no other pending requests exist
        IF NOT EXISTS (
            SELECT 1 FROM public.booking_claim_requests 
            WHERE booking_id = v_req.booking_id AND status = 'pending'
        ) THEN
            UPDATE public.bus_ticket_bookings
            SET claim_status = 'unclaimed'
            WHERE id = v_req.booking_id
              AND claim_status = 'pending_verification'
              AND claimed_by_user_id IS NULL;
        END IF;

        RETURN jsonb_build_object('success', true, 'status', 'rejected');
    ELSE
        RETURN jsonb_build_object('success', false, 'error', 'INVALID_DECISION');
    END IF;
END;
$$;

-- Revoke public execution on internal functions
REVOKE ALL ON FUNCTION public.fn_claim_booking_auto FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_review_claim_request FROM PUBLIC;
