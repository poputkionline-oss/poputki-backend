-- =============================================================================
-- Migration: 20260904183500_correct_reconciliation_launch_watermark.sql
-- Target: POPUTKI.ONLINE Production (xzvtjcqwmuezxyeerkki)
-- Phase: P.1G.3 / P.1G.3A — Launch Watermark Correction
-- Description:
--   Replaces the erroneous future watermark ('2026-09-04T18:50:00.000Z')
--   with the real, guarded UTC instant from pg_catalog.clock_timestamp().
--   Guarded: fails closed (RAISE EXCEPTION) if the existing watermark does not
--   match the expected old value, or if clock skew is detected.
-- =============================================================================

SET statement_timeout = '15s';
SET lock_timeout = '5s';

DO $$
DECLARE
    v_current_val jsonb;
    v_old_watermark text;
    v_now_utc timestamptz;
    v_now_iso text;
    v_updated_count int;
BEGIN
    -- 1. Guard: check current watermark exists and equals the expected old value
    SELECT value INTO v_current_val
    FROM public.acquisition_system_config
    WHERE key = 'reconciliation_launch_watermark';

    IF v_current_val IS NULL THEN
        RAISE EXCEPTION 'reconciliation_launch_watermark key not found in acquisition_system_config';
    END IF;

    v_old_watermark := v_current_val->>'watermark_utc';
    IF v_old_watermark <> '2026-09-04T18:50:00.000Z' THEN
        RAISE EXCEPTION 'Unexpected existing watermark: %, expected 2026-09-04T18:50:00.000Z', v_old_watermark;
    END IF;

    -- 2. Obtain exact server timestamp from PostgreSQL clock
    v_now_utc := pg_catalog.clock_timestamp();
    v_now_iso := to_char(v_now_utc AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');

    -- 3. Guard against timestamp in future
    IF v_now_utc > pg_catalog.clock_timestamp() THEN
        RAISE EXCEPTION 'Clock skew: v_now_utc is in the future';
    END IF;

    -- 4. Update the watermark guarded
    UPDATE public.acquisition_system_config
    SET value = jsonb_build_object(
            'phase', 'P.1G.3',
            'source', 'migration_20260904183500',
            'description', 'Cutoff timestamp for reconciliation. Operations before this date are skipped to prevent legacy backfill.',
            'watermark_utc', v_now_iso
        ),
        updated_at = v_now_utc
    WHERE key = 'reconciliation_launch_watermark'
      AND value->>'watermark_utc' = '2026-09-04T18:50:00.000Z';

    GET DIAGNOSTICS v_updated_count = ROW_COUNT;
    IF v_updated_count <> 1 THEN
        RAISE EXCEPTION 'Watermark update failed: affected rows count is %', v_updated_count;
    END IF;

    RAISE NOTICE 'Launch watermark successfully updated from % to %', v_old_watermark, v_now_iso;
END;
$$;
