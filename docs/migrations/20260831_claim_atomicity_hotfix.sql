-- ==============================================================================
-- Migration: 20260831_claim_atomicity_hotfix.sql
-- Description: Harden Phase E claim RPC atomicity, session validation and grants
-- Project: POPUTKI.ONLINE
-- ==============================================================================

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
    v_session_id UUID;
BEGIN
    -- Validate and lock the supplied session before mutating the booking.
    IF p_session_id IS NOT NULL THEN
        SELECT id INTO v_session_id
        FROM public.booking_claim_sessions
        WHERE id = p_session_id
          AND booking_id = p_booking_id
          AND consumed_at IS NULL
          AND expires_at > NOW()
        FOR UPDATE;

        IF v_session_id IS NULL THEN
            RETURN jsonb_build_object(
                'success', false,
                'error', 'SESSION_INVALID_EXPIRED_OR_CONSUMED'
            );
        END IF;
    END IF;

    -- Exactly one claimant can win, and cancellation wins if it happened first.
    UPDATE public.bus_ticket_bookings
    SET claim_status = 'claimed',
        claimed_by_user_id = p_user_id,
        claimed_at = NOW()
    WHERE id = p_booking_id
      AND status = 'confirmed'
      AND claim_status <> 'claimed'
      AND claimed_by_user_id IS NULL
    RETURNING * INTO v_updated_booking;

    IF v_updated_booking.id IS NULL THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'BOOKING_INELIGIBLE_OR_ALREADY_CLAIMED'
        );
    END IF;

    -- Consume the already validated/locked session in the same transaction.
    IF p_session_id IS NOT NULL THEN
        UPDATE public.booking_claim_sessions
        SET consumed_at = NOW()
        WHERE id = p_session_id
          AND booking_id = p_booking_id
          AND consumed_at IS NULL
          AND expires_at > NOW()
        RETURNING id INTO v_session_id;

        IF v_session_id IS NULL THEN
            -- Any unexpected session race must roll back the booking claim.
            RAISE EXCEPTION 'CLAIM_SESSION_CONSUME_FAILED';
        END IF;
    END IF;

    UPDATE public.booking_claim_requests
    SET status = 'superseded',
        failure_reason_code = 'SUPERSEDED_BY_AUTO_CLAIM'
    WHERE booking_id = p_booking_id
      AND status = 'pending';

    RETURN jsonb_build_object(
        'success', true,
        'booking_id', v_updated_booking.id
    );
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
    SELECT * INTO v_req
    FROM public.booking_claim_requests
    WHERE id = p_request_id
      AND status = 'pending'
    FOR UPDATE;

    IF v_req.id IS NULL THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'REQUEST_NOT_FOUND_OR_ALREADY_REVIEWED'
        );
    END IF;

    IF p_decision = 'approved' THEN
        IF v_req.requesting_user_id IS NULL THEN
            UPDATE public.booking_claim_requests
            SET status = 'superseded',
                failure_reason_code = 'REQUESTING_USER_MISSING',
                reviewed_by_user_id = p_carrier_user_id,
                reviewed_at = NOW()
            WHERE id = p_request_id;

            RETURN jsonb_build_object(
                'success', false,
                'error', 'REQUESTING_USER_MISSING'
            );
        END IF;

        UPDATE public.bus_ticket_bookings
        SET claim_status = 'claimed',
            claimed_by_user_id = v_req.requesting_user_id,
            claimed_at = NOW()
        WHERE id = v_req.booking_id
          AND status = 'confirmed'
          AND claim_status <> 'claimed'
          AND claimed_by_user_id IS NULL
        RETURNING * INTO v_updated_booking;

        IF v_updated_booking.id IS NULL THEN
            UPDATE public.booking_claim_requests
            SET status = 'superseded',
                failure_reason_code = 'BOOKING_NO_LONGER_ELIGIBLE',
                reviewed_by_user_id = p_carrier_user_id,
                reviewed_at = NOW()
            WHERE id = p_request_id;

            RETURN jsonb_build_object(
                'success', false,
                'error', 'BOOKING_INELIGIBLE_OR_ALREADY_CLAIMED'
            );
        END IF;

        UPDATE public.booking_claim_requests
        SET status = 'approved',
            reviewed_by_user_id = p_carrier_user_id,
            reviewed_at = NOW()
        WHERE id = p_request_id;

        UPDATE public.booking_claim_requests
        SET status = 'superseded',
            failure_reason_code = 'SUPERSEDED_BY_CARRIER_APPROVAL'
        WHERE booking_id = v_req.booking_id
          AND id <> p_request_id
          AND status = 'pending';

        RETURN jsonb_build_object('success', true, 'status', 'approved');

    ELSIF p_decision = 'rejected' THEN
        UPDATE public.booking_claim_requests
        SET status = 'rejected',
            failure_reason_code = COALESCE(p_reason, 'CARRIER_REJECTED'),
            reviewed_by_user_id = p_carrier_user_id,
            reviewed_at = NOW()
        WHERE id = p_request_id;

        IF NOT EXISTS (
            SELECT 1
            FROM public.booking_claim_requests
            WHERE booking_id = v_req.booking_id
              AND status = 'pending'
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

REVOKE ALL ON FUNCTION public.fn_claim_booking_auto(INTEGER, INTEGER, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_claim_booking_auto(INTEGER, INTEGER, UUID) FROM anon;
REVOKE ALL ON FUNCTION public.fn_claim_booking_auto(INTEGER, INTEGER, UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fn_claim_booking_auto(INTEGER, INTEGER, UUID) TO service_role;

REVOKE ALL ON FUNCTION public.fn_review_claim_request(UUID, INTEGER, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_review_claim_request(UUID, INTEGER, TEXT, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.fn_review_claim_request(UUID, INTEGER, TEXT, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fn_review_claim_request(UUID, INTEGER, TEXT, TEXT) TO service_role;
