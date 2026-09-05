-- ============================================================================
-- Migration: 20260905092248_secure_carrier_buses_rls.sql
-- Description: P0/P1 Security Hotfix - Enable RLS on public.carrier_buses and isolate fleet access
-- Author: Antigravity Security Agent
-- Target Environment: Supabase PostgreSQL
-- Idempotency: Fully idempotent (IF EXISTS / IF NOT EXISTS)
-- ============================================================================

BEGIN;

-- 1. Enable Row Level Security (resolves Supabase Linter Critical Advisory 0013_rls_disabled_in_public)
ALTER TABLE IF EXISTS public.carrier_buses ENABLE ROW LEVEL SECURITY;

-- 2. Revoke broad unauthenticated privileges
REVOKE ALL PRIVILEGES ON TABLE public.carrier_buses FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE public.carrier_buses FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.carrier_buses FROM authenticated;

-- 3. Grant required privileges strictly to service_role (Express backend uses service_role)
GRANT ALL PRIVILEGES ON TABLE public.carrier_buses TO service_role;

-- 4. Service role full access policy
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies 
        WHERE schemaname = 'public' 
          AND tablename = 'carrier_buses' 
          AND policyname = 'service_role_carrier_buses_all'
    ) THEN
        CREATE POLICY "service_role_carrier_buses_all" 
            ON public.carrier_buses 
            FOR ALL 
            TO service_role 
            USING (true) 
            WITH CHECK (true);
    END IF;
END $$;

-- 5. Documentation comments
COMMENT ON TABLE public.carrier_buses IS 
    'Carrier fleet master records (license plates, chassis, seat configurations). Protected by RLS; accessed via backend service_role.';

COMMIT;
