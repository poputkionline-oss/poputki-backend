-- =============================================================================
-- Migration: 20260904135004_acquisition_event_outbox.sql
-- Created by Supabase CLI for Phase P.1G.3
--
-- Components:
-- 1. Persistent Outbox: public.acquisition_event_outbox
-- 2. Atomic Lease Claim: public.fn_claim_outbox_events
-- 3. Outbox Event Resolver: public.fn_resolve_outbox_event
-- 4. Persistent Replay Nonce Cache: public.internal_service_nonces & fn_record_internal_service_nonce
-- 5. System Config & Launch Watermark: public.acquisition_system_config
--
-- Security:
-- - RLS enabled on all tables
-- - Service_role ONLY
-- - REVOKE ALL from PUBLIC, anon, authenticated
-- - Zero PII
-- =============================================================================

BEGIN;

-- 1. Persistent Outbox Table
CREATE TABLE IF NOT EXISTS public.acquisition_event_outbox (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_name VARCHAR(64) NOT NULL,
    event_source VARCHAR(32) NOT NULL DEFAULT 'backend',
    idempotency_key VARCHAR(128) NOT NULL,
    anonymous_visitor_id UUID,
    session_id UUID,
    user_id BIGINT,
    booking_id BIGINT,
    bus_ticket_id BIGINT,
    campaign_id UUID,
    partner_id UUID,
    properties JSONB NOT NULL DEFAULT '{}'::jsonb,
    status VARCHAR(32) NOT NULL DEFAULT 'pending', -- pending, processing, completed, dead_letter
    attempt_count INT NOT NULL DEFAULT 0,
    max_attempts INT NOT NULL DEFAULT 5,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    lease_token UUID,
    leased_until TIMESTAMPTZ,
    last_error_code VARCHAR(64),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    processed_at TIMESTAMPTZ,

    CONSTRAINT chk_outbox_status CHECK (status IN ('pending', 'processing', 'completed', 'dead_letter')),
    CONSTRAINT chk_outbox_event_source CHECK (event_source IN ('backend', 'bot', 'reconciliation', 'worker')),
    CONSTRAINT uq_acquisition_event_outbox_idemp UNIQUE (idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_outbox_claim_lookup 
    ON public.acquisition_event_outbox (status, next_attempt_at, leased_until)
    WHERE status IN ('pending', 'processing');

CREATE INDEX IF NOT EXISTS idx_outbox_booking_id 
    ON public.acquisition_event_outbox (booking_id) 
    WHERE booking_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_outbox_created_at 
    ON public.acquisition_event_outbox (created_at);

ALTER TABLE public.acquisition_event_outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.acquisition_event_outbox FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.acquisition_event_outbox TO service_role;

-- 2. Atomic Lease Claim RPC Function
CREATE OR REPLACE FUNCTION public.fn_claim_outbox_events(
    p_batch_size INT DEFAULT 50,
    p_lease_seconds INT DEFAULT 60
)
RETURNS TABLE (
    id UUID,
    event_name VARCHAR(64),
    event_source VARCHAR(32),
    idempotency_key VARCHAR(128),
    anonymous_visitor_id UUID,
    session_id UUID,
    user_id BIGINT,
    booking_id BIGINT,
    bus_ticket_id BIGINT,
    campaign_id UUID,
    partner_id UUID,
    properties JSONB,
    attempt_count INT,
    lease_token UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_lease_token UUID := gen_random_uuid();
    v_lease_until TIMESTAMPTZ := now() + (GREATEST(p_lease_seconds, 10) || ' seconds')::interval;
    v_limit INT := LEAST(GREATEST(p_batch_size, 1), 100);
BEGIN
    RETURN QUERY
    WITH candidate_rows AS (
        SELECT outbox.id
        FROM public.acquisition_event_outbox outbox
        WHERE outbox.status IN ('pending', 'processing')
          AND outbox.attempt_count < outbox.max_attempts
          AND outbox.next_attempt_at <= now()
          AND (outbox.leased_until IS NULL OR outbox.leased_until < now())
        ORDER BY outbox.next_attempt_at ASC, outbox.created_at ASC
        LIMIT v_limit
        FOR UPDATE SKIP LOCKED
    ),
    updated_rows AS (
        UPDATE public.acquisition_event_outbox outbox
        SET status = 'processing',
            attempt_count = outbox.attempt_count + 1,
            lease_token = v_lease_token,
            leased_until = v_lease_until
        FROM candidate_rows
        WHERE outbox.id = candidate_rows.id
        RETURNING 
            outbox.id,
            outbox.event_name,
            outbox.event_source,
            outbox.idempotency_key,
            outbox.anonymous_visitor_id,
            outbox.session_id,
            outbox.user_id,
            outbox.booking_id,
            outbox.bus_ticket_id,
            outbox.campaign_id,
            outbox.partner_id,
            outbox.properties,
            outbox.attempt_count,
            outbox.lease_token
    )
    SELECT * FROM updated_rows;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_claim_outbox_events(INT, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_claim_outbox_events(INT, INT) TO service_role;

-- 3. Outbox Event Resolution RPC Function
CREATE OR REPLACE FUNCTION public.fn_resolve_outbox_event(
    p_id UUID,
    p_lease_token UUID,
    p_success BOOLEAN,
    p_error_code VARCHAR(64) DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_max_attempts INT;
    v_current_attempts INT;
BEGIN
    SELECT attempt_count, max_attempts
    INTO v_current_attempts, v_max_attempts
    FROM public.acquisition_event_outbox
    WHERE id = p_id AND (lease_token = p_lease_token OR lease_token IS NULL);

    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;

    IF p_success THEN
        UPDATE public.acquisition_event_outbox
        SET status = 'completed',
            processed_at = now(),
            lease_token = NULL,
            leased_until = NULL,
            last_error_code = NULL
        WHERE id = p_id;
        RETURN TRUE;
    ELSE
        UPDATE public.acquisition_event_outbox
        SET status = CASE WHEN v_current_attempts >= v_max_attempts THEN 'dead_letter' ELSE 'pending' END,
            next_attempt_at = now() + (POWER(2, LEAST(v_current_attempts, 6)) * INTERVAL '15 seconds'),
            lease_token = NULL,
            leased_until = NULL,
            last_error_code = SUBSTRING(COALESCE(p_error_code, 'PROCESSING_ERROR'), 1, 64)
        WHERE id = p_id;
        RETURN TRUE;
    END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_resolve_outbox_event(UUID, UUID, BOOLEAN, VARCHAR) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_resolve_outbox_event(UUID, UUID, BOOLEAN, VARCHAR) TO service_role;

-- 4. Persistent Replay Nonce Cache
CREATE TABLE IF NOT EXISTS public.internal_service_nonces (
    nonce VARCHAR(64) PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_internal_nonces_expires_at 
    ON public.internal_service_nonces (expires_at);

ALTER TABLE public.internal_service_nonces ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.internal_service_nonces FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.internal_service_nonces TO service_role;

-- Atomic Nonce Recorder & Replay Guard
CREATE OR REPLACE FUNCTION public.fn_record_internal_service_nonce(
    p_nonce VARCHAR(64),
    p_ttl_seconds INT DEFAULT 300
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_inserted BOOLEAN := FALSE;
BEGIN
    -- Opportunistic cleanup of expired nonces
    DELETE FROM public.internal_service_nonces WHERE expires_at < now();

    -- Atomic check-and-insert
    INSERT INTO public.internal_service_nonces (nonce, created_at, expires_at)
    VALUES (p_nonce, now(), now() + (GREATEST(p_ttl_seconds, 30) || ' seconds')::interval)
    ON CONFLICT (nonce) DO NOTHING;

    IF FOUND THEN
        RETURN TRUE;
    ELSE
        RETURN FALSE;
    END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_record_internal_service_nonce(VARCHAR, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_record_internal_service_nonce(VARCHAR, INT) TO service_role;

-- 5. System Config & Launch Watermark
CREATE TABLE IF NOT EXISTS public.acquisition_system_config (
    key VARCHAR(64) PRIMARY KEY,
    value JSONB NOT NULL,
    description TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.acquisition_system_config ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.acquisition_system_config FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.acquisition_system_config TO service_role;

-- Set Controlled Immutable Launch Watermark for P.1G.3 Reconciliation
INSERT INTO public.acquisition_system_config (key, value, description)
VALUES (
    'reconciliation_launch_watermark',
    jsonb_build_object(
        'watermark_utc', '2026-09-04T18:50:00.000Z',
        'phase', 'P.1G.3',
        'source', 'migration_20260904135004',
        'description', 'Cutoff timestamp for reconciliation. Operations before this date are skipped to prevent legacy backfill.'
    ),
    'Immutable launch watermark for Phase P.1G.3 reconciliation engine'
)
ON CONFLICT (key) DO UPDATE
SET value = EXCLUDED.value,
    updated_at = now();

COMMIT;
