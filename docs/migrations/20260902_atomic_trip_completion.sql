-- ==============================================================================
-- Migration: 20260902_atomic_trip_completion.sql
-- Description: Phase E.47.2 — Atomic canonical trip completion RPC.
--              Replaces the two sequential PostgREST updates used by E.47.1
--              (pending_boarding -> no_show, then trip -> completed) with a
--              single database transaction, locked against concurrent
--              completion of the same trip.
-- Project: POPUTKI.ONLINE
--
-- NOT APPLIED TO PRODUCTION. Prepared locally per Phase E.47.2 instructions
-- ("this phase MAY prepare a migration ... DO NOT apply migration to
-- production"). Apply via the project's normal Supabase migration process
-- when the combined E.45 + E.47 release is authorized.
-- ==============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_complete_bus_trip(
    p_trip_id INTEGER,
    p_expected_operator_id INTEGER DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_trip RECORD;
    v_no_show_count INTEGER := 0;
BEGIN
    -- Lock the trip row for the lifetime of this transaction. A concurrent
    -- fn_complete_bus_trip() call for the SAME trip blocks here until this
    -- transaction commits, then observes status = 'completed' and returns
    -- the idempotent no-op branch below instead of re-applying STEP 1/2.
    SELECT id, operator_id, status
    INTO v_trip
    FROM public.bus_tickets
    WHERE id = p_trip_id
    FOR UPDATE;

    IF v_trip.id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'TRIP_NOT_FOUND');
    END IF;

    -- Defense-in-depth tenant check: the backend already verifies ownership
    -- before calling this RPC for manual completion; this re-verifies inside
    -- the same locked transaction. The automatic arrival+12h sweep has no
    -- single-carrier context and passes NULL to skip this check by design.
    IF p_expected_operator_id IS NOT NULL
       AND v_trip.operator_id IS DISTINCT FROM p_expected_operator_id THEN
        RETURN jsonb_build_object('success', false, 'error', 'TRIP_OWNERSHIP_MISMATCH');
    END IF;

    -- Idempotent no-op: trip already completed (manual retry, overlapping
    -- sweep runs, or a race that lost the row lock above).
    IF v_trip.status = 'completed' THEN
        RETURN jsonb_build_object(
            'success', true,
            'already_completed', true,
            'trip_id', v_trip.id,
            'no_show_marked', 0
        );
    END IF;

    IF v_trip.status <> 'active' THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'TRIP_NOT_ACTIVE',
            'status', v_trip.status
        );
    END IF;

    -- STEP 1: confirmed + pending_boarding (including legacy NULL) -> no_show.
    -- Never touches boarded, already no_show, or non-confirmed/cancelled rows.
    WITH updated AS (
        UPDATE public.bus_ticket_bookings
        SET boarding_status = 'no_show'
        WHERE bus_ticket_id = p_trip_id
          AND status = 'confirmed'
          AND (boarding_status = 'pending_boarding' OR boarding_status IS NULL)
        RETURNING id
    )
    SELECT COUNT(*) INTO v_no_show_count FROM updated;

    -- STEP 2: trip -> completed. Commits together with STEP 1 as ONE
    -- transaction — this is the actual atomicity guarantee: no other
    -- session can observe STEP 1 applied without STEP 2, or vice versa.
    UPDATE public.bus_tickets
    SET status = 'completed'
    WHERE id = p_trip_id
      AND status = 'active';

    -- No finance, payment, or Ticket V1.1 fields are touched. No row is
    -- ever deleted. Only bus_ticket_bookings.boarding_status and
    -- bus_tickets.status are mutated by this function.
    RETURN jsonb_build_object(
        'success', true,
        'already_completed', false,
        'trip_id', v_trip.id,
        'no_show_marked', v_no_show_count
    );
END;
$$;

REVOKE ALL ON FUNCTION public.fn_complete_bus_trip(INTEGER, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_complete_bus_trip(INTEGER, INTEGER) FROM anon;
REVOKE ALL ON FUNCTION public.fn_complete_bus_trip(INTEGER, INTEGER) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fn_complete_bus_trip(INTEGER, INTEGER) TO service_role;

COMMIT;
