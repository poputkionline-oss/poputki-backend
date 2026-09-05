-- ============================================================================
-- Migration: 20260905092259_ai_assistant_rate_limiter_schema.sql
-- Description: P0-F Persistent Atomic Rate Limiter and Idempotency Store for AI Assistant
-- Author: Antigravity Security Agent
-- Target Environment: Supabase PostgreSQL
-- Idempotency: Fully idempotent (IF EXISTS / IF NOT EXISTS)
-- ============================================================================

BEGIN;

-- 1. Table for persistent atomic request logging and idempotency
CREATE TABLE IF NOT EXISTS public.ai_assistant_request_logs (
    id BIGSERIAL PRIMARY KEY,
    telegram_id BIGINT NOT NULL,
    request_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    day_date DATE NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Dushanbe')::date,
    tokens_used INTEGER DEFAULT 0,
    cost_estimate_cents NUMERIC(8,4) DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'ACCEPTED',
    CONSTRAINT uq_ai_assistant_request_id UNIQUE (request_id)
);

-- 2. Performance indexes for fast atomic counting and lookup
CREATE INDEX IF NOT EXISTS idx_ai_req_user_burst 
    ON public.ai_assistant_request_logs (telegram_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_req_user_daily 
    ON public.ai_assistant_request_logs (telegram_id, day_date);

CREATE INDEX IF NOT EXISTS idx_ai_req_global_daily 
    ON public.ai_assistant_request_logs (day_date);

-- 3. Row Level Security strictly enforced
ALTER TABLE public.ai_assistant_request_logs ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE public.ai_assistant_request_logs FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE public.ai_assistant_request_logs FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.ai_assistant_request_logs FROM authenticated;
REVOKE ALL PRIVILEGES ON SEQUENCE public.ai_assistant_request_logs_id_seq FROM PUBLIC, anon, authenticated;

GRANT ALL PRIVILEGES ON TABLE public.ai_assistant_request_logs TO service_role;
GRANT ALL PRIVILEGES ON SEQUENCE public.ai_assistant_request_logs_id_seq TO service_role;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies 
        WHERE schemaname = 'public' 
          AND tablename = 'ai_assistant_request_logs' 
          AND policyname = 'service_role_ai_logs_all'
    ) THEN
        CREATE POLICY "service_role_ai_logs_all" 
            ON public.ai_assistant_request_logs 
            FOR ALL 
            TO service_role 
            USING (true) 
            WITH CHECK (true);
    END IF;
END $$;

-- 4. Atomic verification and rate limit enforcement function
CREATE OR REPLACE FUNCTION public.check_and_record_ai_request(
    p_telegram_id BIGINT,
    p_request_id TEXT,
    p_burst_limit INT DEFAULT 2,          -- max requests in 60s
    p_daily_limit INT DEFAULT 5,          -- max requests per day (Asia/Dushanbe)
    p_global_daily_limit INT DEFAULT 500  -- global daily stop-loss
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_now TIMESTAMPTZ := clock_timestamp();
    v_today DATE := (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Dushanbe')::date;
    v_burst_count INT;
    v_daily_count INT;
    v_global_count INT;
    v_existing RECORD;
BEGIN
    -- 0. Acquire user-level transaction advisory lock to guarantee strict serializability & atomicity
    -- against concurrent parallel requests from the same user (burst race condition protection)
    PERFORM pg_advisory_xact_lock(hashtext('ai_rate_limiter'), hashtext(p_telegram_id::text));

    -- Check for idempotency: if request_id already exists, return previous state
    SELECT id, status INTO v_existing 
    FROM public.ai_assistant_request_logs 
    WHERE request_id = p_request_id;

    IF FOUND THEN
        RETURN jsonb_build_object(
            'allowed', false,
            'reason', 'DUPLICATE_REQUEST',
            'status', 'DUPLICATE'
        );
    END IF;

    -- 1. Check burst limit (last 60 seconds)
    SELECT COUNT(*) INTO v_burst_count
    FROM public.ai_assistant_request_logs
    WHERE telegram_id = p_telegram_id
      AND created_at >= (v_now - INTERVAL '60 seconds')
      AND status IN ('ACCEPTED', 'SUCCESS');

    IF v_burst_count >= p_burst_limit THEN
        RETURN jsonb_build_object(
            'allowed', false,
            'reason', 'RATE_LIMITED_BURST',
            'status', 'RATE_LIMITED',
            'burst_count', v_burst_count,
            'retry_after_seconds', 30
        );
    END IF;

    -- 2. Check user daily limit (current date in Asia/Dushanbe)
    SELECT COUNT(*) INTO v_daily_count
    FROM public.ai_assistant_request_logs
    WHERE telegram_id = p_telegram_id
      AND day_date = v_today
      AND status IN ('ACCEPTED', 'SUCCESS');

    IF v_daily_count >= p_daily_limit THEN
        RETURN jsonb_build_object(
            'allowed', false,
            'reason', 'RATE_LIMITED_DAILY',
            'status', 'RATE_LIMITED',
            'daily_count', v_daily_count,
            'limit', p_daily_limit
        );
    END IF;

    -- 3. Check global daily stop-loss limit
    SELECT COUNT(*) INTO v_global_count
    FROM public.ai_assistant_request_logs
    WHERE day_date = v_today
      AND status IN ('ACCEPTED', 'SUCCESS');

    IF v_global_count >= p_global_daily_limit THEN
        RETURN jsonb_build_object(
            'allowed', false,
            'reason', 'RATE_LIMITED_GLOBAL_STOP_LOSS',
            'status', 'GLOBAL_LIMIT_EXCEEDED',
            'global_count', v_global_count
        );
    END IF;

    -- 4. Atomically record the accepted request
    INSERT INTO public.ai_assistant_request_logs (
        telegram_id,
        request_id,
        created_at,
        day_date,
        status
    ) VALUES (
        p_telegram_id,
        p_request_id,
        v_now,
        v_today,
        'ACCEPTED'
    );

    RETURN jsonb_build_object(
        'allowed', true,
        'status', 'ACCEPTED',
        'burst_count', v_burst_count + 1,
        'daily_count', v_daily_count + 1,
        'global_count', v_global_count + 1
    );
END;
$$;

-- Restrict function execution to service_role only
REVOKE EXECUTE ON FUNCTION public.check_and_record_ai_request(BIGINT, TEXT, INT, INT, INT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.check_and_record_ai_request(BIGINT, TEXT, INT, INT, INT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.check_and_record_ai_request(BIGINT, TEXT, INT, INT, INT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.check_and_record_ai_request(BIGINT, TEXT, INT, INT, INT) TO service_role;

COMMENT ON TABLE public.ai_assistant_request_logs IS 
    'Internal audit and atomic rate limiting log for AI Travel Assistant.';
COMMENT ON FUNCTION public.check_and_record_ai_request IS 
    'Atomic rate limiter enforcing 60s burst, Asia/Dushanbe daily quota, and global budget stop-loss.';

COMMIT;
