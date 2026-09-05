-- ============================================================================
-- Migration: 20260905092221_secure_chat_sessions_rls.sql
-- Description: P0 Security Hotfix - Isolate public.chat_sessions to server-only (service_role)
-- Author: Antigravity Security Agent
-- Target Environment: Supabase PostgreSQL
-- Idempotency: Fully idempotent (IF EXISTS / IF NOT EXISTS)
-- ============================================================================

BEGIN;

-- 1. Ensure Row Level Security is strictly enabled
ALTER TABLE IF EXISTS public.chat_sessions ENABLE ROW LEVEL SECURITY;

-- 2. Drop insecure legacy permissive policies that granted broad public access
DROP POLICY IF EXISTS "allow_all_app_access" ON public.chat_sessions;
DROP POLICY IF EXISTS "public_chat_sessions_access" ON public.chat_sessions;

-- 3. Revoke all Data API privileges from public, anon, and authenticated roles
REVOKE ALL PRIVILEGES ON TABLE public.chat_sessions FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE public.chat_sessions FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.chat_sessions FROM authenticated;

-- 4. Explicitly grant required privileges strictly to service_role
GRANT ALL PRIVILEGES ON TABLE public.chat_sessions TO service_role;

-- 5. Ensure explicit policy exists for service_role access
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies 
        WHERE schemaname = 'public' 
          AND tablename = 'chat_sessions' 
          AND policyname = 'service_role_all'
    ) THEN
        CREATE POLICY "service_role_all" 
            ON public.chat_sessions 
            FOR ALL 
            TO service_role 
            USING (true) 
            WITH CHECK (true);
    END IF;
END $$;

-- 6. Retention and lookup index optimization (safe for background cleanup)
CREATE INDEX IF NOT EXISTS idx_chat_sessions_last_updated 
    ON public.chat_sessions (last_updated);

-- 7. Audit and security comments on table and columns
COMMENT ON TABLE public.chat_sessions IS 
    'Confidential AI assistant chat history. Isolated strictly to server-side service_role. Direct PostgREST access revoked.';

COMMENT ON COLUMN public.chat_sessions.telegram_id IS 
    'Telegram User ID of the participant. Primary key for user-scoped chat session.';

COMMENT ON COLUMN public.chat_sessions.messages IS 
    'Encapsulated JSONB conversation turns. May contain PII; protected under strict service_role boundary.';

COMMIT;
