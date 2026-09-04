-- =============================================================================
-- Migration: 20260904144755_reconciliation_maintenance_lock.sql
-- Target: POPUTKI.ONLINE Production (xzvtjcqwmuezxyeerkki)
-- Phase: P.1G.3A — Reconciliation / Outbox Sweep Distributed Lock
-- Description:
--   Adds a lease-based advisory/distributed lock so overlapping scheduled
--   maintenance runs (e.g. a manual trigger racing the hourly GitHub Actions
--   schedule) cannot run reconciliation concurrently. Implemented as a
--   conditional upsert against public.acquisition_system_config rather than
--   a native Postgres advisory lock, because RPC calls in this architecture
--   do not share a persistent session/connection (PostgREST/pooled), so a
--   session-scoped pg_advisory_lock would not reliably span the
--   acquire -> do work -> release call sequence. The row-based lease pattern
--   mirrors the outbox's own lease mechanism (fn_claim_outbox_events) and is
--   connection-agnostic.
--
-- Security: SECURITY DEFINER, service_role only, REVOKE ALL FROM PUBLIC/anon/authenticated.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_try_acquire_maintenance_lock(
    p_lock_key VARCHAR(64),
    p_holder VARCHAR(128),
    p_lease_seconds INT DEFAULT 300
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_updated INT;
BEGIN
    INSERT INTO public.acquisition_system_config (key, value, description)
    VALUES (
        p_lock_key,
        jsonb_build_object(
            'holder', p_holder,
            'locked_until', to_char(now() + (GREATEST(p_lease_seconds, 10) || ' seconds')::interval, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        ),
        'Distributed maintenance lock (lease-based, row-level)'
    )
    ON CONFLICT (key) DO UPDATE
    SET value = jsonb_build_object(
            'holder', p_holder,
            'locked_until', to_char(now() + (GREATEST(p_lease_seconds, 10) || ' seconds')::interval, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        ),
        updated_at = now()
    WHERE (public.acquisition_system_config.value->>'locked_until') IS NULL
       OR (public.acquisition_system_config.value->>'locked_until')::timestamptz < now();

    GET DIAGNOSTICS v_updated = ROW_COUNT;
    RETURN v_updated > 0;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_try_acquire_maintenance_lock(VARCHAR, VARCHAR, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_try_acquire_maintenance_lock(VARCHAR, VARCHAR, INT) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_release_maintenance_lock(
    p_lock_key VARCHAR(64),
    p_holder VARCHAR(128)
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_updated INT;
BEGIN
    UPDATE public.acquisition_system_config
    SET value = jsonb_build_object('holder', NULL, 'locked_until', NULL),
        updated_at = now()
    WHERE key = p_lock_key
      AND value->>'holder' = p_holder;

    GET DIAGNOSTICS v_updated = ROW_COUNT;
    RETURN v_updated > 0;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_release_maintenance_lock(VARCHAR, VARCHAR) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_release_maintenance_lock(VARCHAR, VARCHAR) TO service_role;

COMMIT;
