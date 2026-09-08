-- ==============================================================================
-- Migration: 20260909_manual_booking_sms_atomic_cap_rpc.sql
-- Description: Atomic (advisory-lock-guarded) cap check for the manual-
--              booking OSON SMS outbox, closing a check-then-act race that
--              a plain app-level COUNT query cannot prevent under multiple
--              concurrent worker processes.
-- Project: POPUTKI.ONLINE
--
-- Design notes:
--   - Purely additive: one new function. Depends only on
--     manual_booking_sms_outbox from 20260908_manual_booking_sms_outbox.sql.
--   - pg_advisory_xact_lock is server-wide (not per-session), so it
--     correctly serializes the check across two DIFFERENT worker processes/
--     connections calling this RPC concurrently, not just within one
--     session. The lock is released automatically at transaction end.
--   - Residual, explicitly accepted risk: this closes the race for the
--     COUNT-and-decide step itself, but the caller still sends the SMS and
--     marks the row 'sent' in a SEPARATE statement after this RPC returns
--     (an external HTTP call cannot practically be made inside the same DB
--     transaction/lock without holding a lock for the OSON round-trip
--     duration). At the pilot's intended scale (daily cap <= 5, a single
--     allowlisted carrier) this residual window is a proportionate,
--     documented trade-off, not a silent gap — see
--     docs/oson-sms-audit-report.md.
--
-- NOT APPLIED TO PRODUCTION.
-- ==============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_oson_sms_check_cap(
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
    -- Serializes this whole check across ALL concurrent callers (any worker
    -- process, any connection) for the duration of this transaction.
    PERFORM pg_advisory_xact_lock(v_lock_key);

    IF p_daily_cap IS NULL OR p_daily_cap <= 0 THEN
        RETURN jsonb_build_object('allowed', false, 'reason', 'DAILY_CAP_NOT_CONFIGURED');
    END IF;

    SELECT COUNT(*) INTO v_global_count
    FROM public.manual_booking_sms_outbox
    WHERE status IN ('sent', 'delivered') AND sent_at >= v_since;

    IF v_global_count >= p_daily_cap THEN
        RETURN jsonb_build_object('allowed', false, 'reason', 'DAILY_CAP_EXCEEDED');
    END IF;

    IF p_phone_hmac IS NOT NULL THEN
        SELECT COUNT(*) INTO v_phone_count
        FROM public.manual_booking_sms_outbox
        WHERE recipient_phone_hmac = p_phone_hmac
          AND status IN ('sent', 'delivered')
          AND sent_at >= v_since;

        IF v_phone_count >= COALESCE(p_per_phone_cap, 1) THEN
            RETURN jsonb_build_object('allowed', false, 'reason', 'PER_PHONE_DAILY_CAP_EXCEEDED');
        END IF;
    END IF;

    IF p_carrier_id IS NOT NULL AND p_per_carrier_cap IS NOT NULL AND p_per_carrier_cap > 0 THEN
        SELECT COUNT(*) INTO v_carrier_count
        FROM public.manual_booking_sms_outbox
        WHERE carrier_id = p_carrier_id
          AND status IN ('sent', 'delivered')
          AND sent_at >= v_since;

        IF v_carrier_count >= p_per_carrier_cap THEN
            RETURN jsonb_build_object('allowed', false, 'reason', 'PER_CARRIER_DAILY_CAP_EXCEEDED');
        END IF;
    END IF;

    RETURN jsonb_build_object('allowed', true);
END;
$$;

REVOKE ALL ON FUNCTION public.fn_oson_sms_check_cap FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_oson_sms_check_cap TO service_role;

COMMIT;
