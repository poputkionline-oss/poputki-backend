-- ==============================================================================
-- Migration: 20260910_manual_booking_sms_cap_reservation.sql
-- Description: Closes a real concurrency gap found while gate-testing
--              20260909's fn_oson_sms_check_cap: that function only
--              serialized the COUNT computation itself, but performed no
--              reservation — so two DIFFERENT concurrent worker processes,
--              each checking the cap for a DIFFERENT outbox row, could both
--              observe "allowed" before either had actually sent anything,
--              since the count of already-sent rows hadn't changed yet.
--              Proven empirically: with daily_cap=1 and 0 sent so far, two
--              concurrent calls to fn_oson_sms_check_cap both returned
--              {"allowed": true}. See docs/oson-sms-audit-report.md.
--
-- Fix: the cap check now takes the specific outbox row id being evaluated
-- and, while STILL holding the advisory lock, atomically reserves that row
-- (cap_reserved_at = NOW()) before returning "allowed". A second concurrent
-- caller blocked on the same lock will see that reservation in its own
-- COUNT the moment it acquires the lock, so it correctly sees the slot as
-- taken instead of independently re-deriving "allowed" from a stale count.
-- Project: POPUTKI.ONLINE
--
-- NOT APPLIED TO PRODUCTION.
-- ==============================================================================

BEGIN;

ALTER TABLE public.manual_booking_sms_outbox
    ADD COLUMN IF NOT EXISTS cap_reserved_at TIMESTAMPTZ NULL;

COMMENT ON COLUMN public.manual_booking_sms_outbox.cap_reserved_at IS
    'Set atomically by fn_oson_sms_check_cap the moment a send is approved against the daily/per-phone/per-carrier caps, so a concurrent worker checking a DIFFERENT row sees this slot as already taken even before this row reaches status=sent.';

-- The 20260909 signature (no p_outbox_id) cannot be upgraded via
-- CREATE OR REPLACE — a changed parameter list is a distinct overload in
-- Postgres, not a replacement, and would leave two ambiguous functions of
-- the same name behind. Drop the old signature explicitly first.
DROP FUNCTION IF EXISTS public.fn_oson_sms_check_cap(TEXT, INTEGER, INTEGER, INTEGER, INTEGER);

CREATE OR REPLACE FUNCTION public.fn_oson_sms_check_cap(
    p_outbox_id UUID,
    p_phone_hmac TEXT,
    p_carrier_id INTEGER,
    p_daily_cap INTEGER,
    p_per_phone_cap INTEGER,
    p_per_carrier_cap INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_lock_key BIGINT := ('x' || substr(md5('oson_sms_daily_cap'), 1, 16))::bit(64)::bigint;
    v_since TIMESTAMPTZ := date_trunc('day', NOW());
    v_global_count INTEGER;
    v_phone_count INTEGER;
    v_carrier_count INTEGER;
BEGIN
    PERFORM pg_advisory_xact_lock(v_lock_key);

    IF p_daily_cap IS NULL OR p_daily_cap <= 0 THEN
        RETURN jsonb_build_object('allowed', false, 'reason', 'DAILY_CAP_NOT_CONFIGURED');
    END IF;

    -- A slot counts as taken whether it has already been sent/delivered OR
    -- was reserved by a concurrent/prior call still in flight today.
    SELECT COUNT(*) INTO v_global_count
    FROM public.manual_booking_sms_outbox
    WHERE (status IN ('sent', 'delivered') AND sent_at >= v_since)
       OR (cap_reserved_at IS NOT NULL AND cap_reserved_at >= v_since);

    IF v_global_count >= p_daily_cap THEN
        RETURN jsonb_build_object('allowed', false, 'reason', 'DAILY_CAP_EXCEEDED');
    END IF;

    IF p_phone_hmac IS NOT NULL THEN
        SELECT COUNT(*) INTO v_phone_count
        FROM public.manual_booking_sms_outbox
        WHERE recipient_phone_hmac = p_phone_hmac
          AND (
              (status IN ('sent', 'delivered') AND sent_at >= v_since)
              OR (cap_reserved_at IS NOT NULL AND cap_reserved_at >= v_since)
          );

        IF v_phone_count >= COALESCE(p_per_phone_cap, 1) THEN
            RETURN jsonb_build_object('allowed', false, 'reason', 'PER_PHONE_DAILY_CAP_EXCEEDED');
        END IF;
    END IF;

    IF p_carrier_id IS NOT NULL AND p_per_carrier_cap IS NOT NULL AND p_per_carrier_cap > 0 THEN
        SELECT COUNT(*) INTO v_carrier_count
        FROM public.manual_booking_sms_outbox
        WHERE carrier_id = p_carrier_id
          AND (
              (status IN ('sent', 'delivered') AND sent_at >= v_since)
              OR (cap_reserved_at IS NOT NULL AND cap_reserved_at >= v_since)
          );

        IF v_carrier_count >= p_per_carrier_cap THEN
            RETURN jsonb_build_object('allowed', false, 'reason', 'PER_CARRIER_DAILY_CAP_EXCEEDED');
        END IF;
    END IF;

    IF p_outbox_id IS NOT NULL THEN
        UPDATE public.manual_booking_sms_outbox
        SET cap_reserved_at = NOW()
        WHERE id = p_outbox_id;
    END IF;

    RETURN jsonb_build_object('allowed', true);
END;
$$;

REVOKE ALL ON FUNCTION public.fn_oson_sms_check_cap(UUID, TEXT, INTEGER, INTEGER, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_oson_sms_check_cap(UUID, TEXT, INTEGER, INTEGER, INTEGER, INTEGER) TO service_role;

COMMIT;
