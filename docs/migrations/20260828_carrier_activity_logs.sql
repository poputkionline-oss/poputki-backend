-- Migration: 20260828_carrier_activity_logs.sql
-- Description: Create hardened append-only carrier activity audit log table
-- Phase: P1.3 Carrier Audit & Activity History (Hardened Append-Only)

-- 1. Create table with immutable structure
CREATE TABLE IF NOT EXISTS public.carrier_activity_logs (
    id BIGSERIAL PRIMARY KEY,
    carrier_id BIGINT NOT NULL,
    actor_user_id BIGINT NOT NULL,
    actor_role TEXT NOT NULL,
    actor_name TEXT,
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT,
    entity_label TEXT,
    old_data JSONB,
    new_data JSONB,
    metadata JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Comments for documentation
COMMENT ON TABLE public.carrier_activity_logs IS 'Append-only audit log of all operational and security actions within carrier panel';
COMMENT ON COLUMN public.carrier_activity_logs.carrier_id IS 'Tenant carrier operator ID';
COMMENT ON COLUMN public.carrier_activity_logs.actor_user_id IS 'User ID who performed the action (from verified JWT)';
COMMENT ON COLUMN public.carrier_activity_logs.action IS 'Standardized action code (e.g. booking_created_manual, ticket_updated, member_deactivated)';

-- 2. Indexes for performant filtering and pagination
CREATE INDEX IF NOT EXISTS idx_carrier_activity_carrier_created 
    ON public.carrier_activity_logs(carrier_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_carrier_activity_entity 
    ON public.carrier_activity_logs(carrier_id, entity_type, entity_id);

CREATE INDEX IF NOT EXISTS idx_carrier_activity_action 
    ON public.carrier_activity_logs(carrier_id, action);

CREATE INDEX IF NOT EXISTS idx_carrier_activity_actor 
    ON public.carrier_activity_logs(carrier_id, actor_user_id, created_at DESC);

-- 3. Security: Enable RLS and restrict client direct access
ALTER TABLE public.carrier_activity_logs ENABLE ROW LEVEL SECURITY;

-- 4. Minimum Privilege Grants: Table Level
-- Revoke all permissions from untrusted roles and service_role
REVOKE ALL ON public.carrier_activity_logs FROM anon, authenticated, service_role;

-- Grant ONLY SELECT and INSERT to service_role (UPDATE and DELETE are strictly prohibited)
GRANT SELECT, INSERT ON public.carrier_activity_logs TO service_role;

-- 5. Minimum Privilege Grants: Sequence Level
REVOKE ALL ON SEQUENCE public.carrier_activity_logs_id_seq FROM anon, authenticated, service_role;
GRANT USAGE, SELECT ON SEQUENCE public.carrier_activity_logs_id_seq TO service_role;

-- 6. Database-Level Immutability Enforcement (Trigger)
-- Guarantees zero UPDATE or DELETE operations even if executed with elevated service role
CREATE OR REPLACE FUNCTION public.prevent_carrier_activity_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    RAISE EXCEPTION 'carrier_activity_logs is strictly append-only: % operation is prohibited', TG_OP;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_carrier_activity_mutation ON public.carrier_activity_logs;
CREATE TRIGGER trg_prevent_carrier_activity_mutation
    BEFORE UPDATE OR DELETE ON public.carrier_activity_logs
    FOR EACH ROW
    EXECUTE FUNCTION public.prevent_carrier_activity_mutation();
