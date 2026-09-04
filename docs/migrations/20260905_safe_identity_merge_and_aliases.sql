-- ==============================================================================
-- Migration: 20260905_safe_identity_merge_and_aliases.sql
-- Description: Phase P.1G.H0-RC — Hardened Safe Identity Merge & Aliases Engine
-- Target Tables: public.users (columns: merged_into_user_id, merged_at),
--                public.user_identity_aliases,
--                public.user_identity_merge_events
-- Target Functions: public.fn_safe_merge_users,
--                   public.prevent_identity_merge_event_mutation,
--                   public.check_users_merged_not_self
-- Constraints & Checks:
--   - users.id: INTEGER (int4)
--   - users.telegram_id: BIGINT (int8)
--   - users.chk_users_merge_consistency: (merged_into_user_id IS NULL AND merged_at IS NULL)
--                                     OR (merged_into_user_id IS NOT NULL AND merged_at IS NOT NULL)
-- Security:
--   - Hardened SECURITY DEFINER with fixed search_path = pg_catalog, pg_temp
--   - Fully qualified public.* object names
--   - Append-only user_identity_merge_events with mutation prevention trigger
--   - Zero UPDATE / DELETE on booking_journey_events
--   - Cycle, chain, and self-merge prohibition in identity graph
-- Project: POPUTKI.ONLINE (xzvtjcqwmuezxyeerkki)
-- ==============================================================================

-- 1. Extend public.users with merged tracking columns and consistency check
ALTER TABLE public.users
    ADD COLUMN IF NOT EXISTS merged_into_user_id INTEGER NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    ADD COLUMN IF NOT EXISTS merged_at TIMESTAMPTZ NULL;

-- Consistency constraint between merged_into_user_id and merged_at
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_users_merge_consistency' AND conrelid = 'public.users'::regclass
    ) THEN
        ALTER TABLE public.users
            ADD CONSTRAINT chk_users_merge_consistency
            CHECK (
                (merged_into_user_id IS NULL AND merged_at IS NULL)
                OR
                (merged_into_user_id IS NOT NULL AND merged_at IS NOT NULL)
            );
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_users_merged_into
    ON public.users(merged_into_user_id) WHERE merged_into_user_id IS NOT NULL;

-- Self-merge prevention constraint on public.users
CREATE OR REPLACE FUNCTION public.check_users_merged_not_self()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    IF NEW.merged_into_user_id IS NOT NULL AND NEW.merged_into_user_id = NEW.id THEN
        RAISE EXCEPTION 'USERS_SELF_MERGE_PROHIBITED: merged_into_user_id cannot point to the user itself (id: %)', NEW.id;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_check_users_merged_not_self ON public.users;
CREATE TRIGGER trg_check_users_merged_not_self
    BEFORE INSERT OR UPDATE OF merged_into_user_id ON public.users
    FOR EACH ROW
    EXECUTE FUNCTION public.check_users_merged_not_self();

-- 2. Create public.user_identity_aliases table
CREATE TABLE IF NOT EXISTS public.user_identity_aliases (
    source_user_id INTEGER PRIMARY KEY REFERENCES public.users(id) ON DELETE RESTRICT,
    canonical_user_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    merge_reason VARCHAR(32) NOT NULL,
    merged_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
    merged_by VARCHAR(32) NOT NULL DEFAULT 'system',
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT chk_user_identity_aliases_distinct CHECK (source_user_id <> canonical_user_id)
);

CREATE INDEX IF NOT EXISTS idx_user_identity_aliases_canonical
    ON public.user_identity_aliases(canonical_user_id);

-- RLS: Service role only
ALTER TABLE public.user_identity_aliases ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.user_identity_aliases FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.user_identity_aliases TO service_role;

-- 3. Dedicated Append-Only Audit Table: public.user_identity_merge_events
CREATE TABLE IF NOT EXISTS public.user_identity_merge_events (
    id BIGSERIAL PRIMARY KEY,
    source_user_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    canonical_user_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    action VARCHAR(32) NOT NULL DEFAULT 'USER_IDENTITIES_MERGED',
    merge_reason VARCHAR(32) NOT NULL,
    merged_by VARCHAR(32) NOT NULL DEFAULT 'system',
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
    CONSTRAINT chk_merge_events_distinct CHECK (source_user_id <> canonical_user_id)
);

CREATE INDEX IF NOT EXISTS idx_merge_events_source ON public.user_identity_merge_events(source_user_id);
CREATE INDEX IF NOT EXISTS idx_merge_events_canonical ON public.user_identity_merge_events(canonical_user_id);
CREATE INDEX IF NOT EXISTS idx_merge_events_occurred ON public.user_identity_merge_events(occurred_at DESC);

-- RLS: Service role only
ALTER TABLE public.user_identity_merge_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.user_identity_merge_events FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.user_identity_merge_events TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.user_identity_merge_events_id_seq TO service_role;

-- Immutability trigger for user_identity_merge_events (Zero UPDATE / DELETE)
CREATE OR REPLACE FUNCTION public.prevent_identity_merge_event_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    RAISE EXCEPTION 'user_identity_merge_events rows are immutable. UPDATE and DELETE are strictly prohibited.';
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_identity_merge_event_mutation ON public.user_identity_merge_events;
CREATE TRIGGER trg_prevent_identity_merge_event_mutation
    BEFORE UPDATE OR DELETE ON public.user_identity_merge_events
    FOR EACH ROW
    EXECUTE FUNCTION public.prevent_identity_merge_event_mutation();

-- 4. Atomic PostgreSQL RPC: Safe Identity Merge Engine
CREATE OR REPLACE FUNCTION public.fn_safe_merge_users(
    p_source_user_id INTEGER,
    p_canonical_user_id INTEGER,
    p_merge_reason VARCHAR(32) DEFAULT 'telegram_link',
    p_merged_by VARCHAR(32) DEFAULT 'system'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v_source RECORD;
    v_canonical RECORD;
    v_source_phone VARCHAR;
    v_canonical_phone VARCHAR;
    v_source_tg BIGINT;
    v_canonical_tg BIGINT;
    v_existing_alias RECORD;
    v_conflicting_tg RECORD;
    v_result JSONB;
BEGIN
    -- Step 1: Basic validation of inputs
    IF p_source_user_id IS NULL OR p_canonical_user_id IS NULL THEN
        RAISE EXCEPTION 'IDENTITY_MERGE_INVALID_ARGS: Both source and canonical user IDs are required';
    END IF;

    IF p_source_user_id = p_canonical_user_id THEN
        RAISE EXCEPTION 'IDENTITY_MERGE_SAME_USER: Cannot merge a user into themselves';
    END IF;

    -- Step 2: Lock both user rows in strict canonical order to eliminate deadlocks
    IF p_source_user_id < p_canonical_user_id THEN
        SELECT * INTO v_source FROM public.users WHERE id = p_source_user_id FOR UPDATE;
        SELECT * INTO v_canonical FROM public.users WHERE id = p_canonical_user_id FOR UPDATE;
    ELSE
        SELECT * INTO v_canonical FROM public.users WHERE id = p_canonical_user_id FOR UPDATE;
        SELECT * INTO v_source FROM public.users WHERE id = p_source_user_id FOR UPDATE;
    END IF;

    -- Step 3: Verify existence of both records
    IF v_source.id IS NULL THEN
        RAISE EXCEPTION 'IDENTITY_MERGE_SOURCE_NOT_FOUND: Source user % does not exist', p_source_user_id;
    END IF;

    IF v_canonical.id IS NULL THEN
        RAISE EXCEPTION 'IDENTITY_MERGE_CANONICAL_NOT_FOUND: Canonical user % does not exist', p_canonical_user_id;
    END IF;

    -- Step 4: Verify that source is not already merged
    IF v_source.merged_into_user_id IS NOT NULL THEN
        RAISE EXCEPTION 'IDENTITY_MERGE_ALREADY_MERGED: Source user % is already merged into %', 
            p_source_user_id, v_source.merged_into_user_id;
    END IF;

    SELECT * INTO v_existing_alias FROM public.user_identity_aliases WHERE source_user_id = p_source_user_id;
    IF v_existing_alias.source_user_id IS NOT NULL THEN
        RAISE EXCEPTION 'IDENTITY_MERGE_ALIAS_EXISTS: Source user % already has an alias pointing to %',
            p_source_user_id, v_existing_alias.canonical_user_id;
    END IF;

    -- Step 5: Verify that canonical is NOT a merged/source profile (no alias chains allowed)
    IF v_canonical.merged_into_user_id IS NOT NULL THEN
        RAISE EXCEPTION 'IDENTITY_MERGE_CANONICAL_IS_MERGED: Canonical user % is already merged into % (chaining prohibited)', 
            p_canonical_user_id, v_canonical.merged_into_user_id;
    END IF;

    SELECT * INTO v_existing_alias FROM public.user_identity_aliases WHERE source_user_id = p_canonical_user_id;
    IF v_existing_alias.source_user_id IS NOT NULL THEN
        RAISE EXCEPTION 'IDENTITY_MERGE_CANONICAL_HAS_ALIAS: Canonical user % is an alias for % (chaining prohibited)',
            p_canonical_user_id, v_existing_alias.canonical_user_id;
    END IF;

    -- Step 6: Verify no circular reference (canonical pointing to source)
    SELECT * INTO v_existing_alias FROM public.user_identity_aliases 
    WHERE source_user_id = p_canonical_user_id AND canonical_user_id = p_source_user_id;
    IF v_existing_alias.source_user_id IS NOT NULL THEN
        RAISE EXCEPTION 'IDENTITY_MERGE_CYCLE_DETECTED: Merging % into % would create an alias cycle',
            p_source_user_id, p_canonical_user_id;
    END IF;

    -- Step 7: Phone conflict verification
    -- Two accounts with different non-empty verified phone numbers cannot be merged automatically
    v_source_phone := NULLIF(TRIM(v_source.phone), '');
    v_canonical_phone := NULLIF(TRIM(v_canonical.phone), '');

    IF v_source_phone IS NOT NULL AND v_canonical_phone IS NOT NULL AND v_source_phone <> v_canonical_phone THEN
        RAISE EXCEPTION 'IDENTITY_MERGE_PHONE_CONFLICT: Source phone % conflicts with canonical phone %',
            v_source_phone, v_canonical_phone;
    END IF;

    -- Step 8: Telegram ID verification & transfer preparation
    v_source_tg := v_source.telegram_id;
    v_canonical_tg := v_canonical.telegram_id;

    IF v_source_tg IS NOT NULL AND v_canonical_tg IS NOT NULL AND v_source_tg <> v_canonical_tg THEN
        RAISE EXCEPTION 'IDENTITY_MERGE_TELEGRAM_CONFLICT: Source tg % conflicts with canonical tg %',
            v_source_tg, v_canonical_tg;
    END IF;

    -- Check if another 3rd user already holds v_source_tg
    IF v_source_tg IS NOT NULL THEN
        SELECT * INTO v_conflicting_tg FROM public.users 
        WHERE telegram_id = v_source_tg AND id NOT IN (p_source_user_id, p_canonical_user_id);
        IF v_conflicting_tg.id IS NOT NULL THEN
            RAISE EXCEPTION 'IDENTITY_MERGE_THIRD_PARTY_TG: Telegram ID % already held by user %',
                v_source_tg, v_conflicting_tg.id;
        END IF;
    END IF;

    -- Step 9: Atomic Data Operations
    -- 9a. Disconnect telegram_id from source profile to free unique constraint
    UPDATE public.users
    SET telegram_id = NULL,
        merged_into_user_id = p_canonical_user_id,
        merged_at = pg_catalog.now()
    WHERE id = p_source_user_id;

    -- 9b. Update canonical profile with telegram info and any missing profile fields
    UPDATE public.users
    SET telegram_id = COALESCE(v_canonical_tg, v_source_tg),
        username = COALESCE(v_canonical.username, v_source.username),
        photo_url = COALESCE(v_canonical.photo_url, v_source.photo_url),
        name = CASE 
            WHEN v_canonical.name IS NOT NULL AND TRIM(v_canonical.name) <> '' THEN v_canonical.name 
            ELSE v_source.name 
        END,
        surname = COALESCE(v_canonical.surname, v_source.surname)
    WHERE id = p_canonical_user_id;

    -- 9c. Record alias relation in public.user_identity_aliases
    INSERT INTO public.user_identity_aliases (
        source_user_id,
        canonical_user_id,
        merge_reason,
        merged_at,
        merged_by,
        metadata
    ) VALUES (
        p_source_user_id,
        p_canonical_user_id,
        p_merge_reason,
        pg_catalog.now(),
        p_merged_by,
        jsonb_build_object(
            'source_had_tg', (v_source_tg IS NOT NULL),
            'source_had_phone', (v_source_phone IS NOT NULL),
            'canonical_had_tg', (v_canonical_tg IS NOT NULL)
        )
    );

    -- 9d. Record dedicated immutable audit event in public.user_identity_merge_events (Zero PII)
    INSERT INTO public.user_identity_merge_events (
        source_user_id,
        canonical_user_id,
        action,
        merge_reason,
        merged_by,
        details,
        occurred_at
    ) VALUES (
        p_source_user_id,
        p_canonical_user_id,
        'USER_IDENTITIES_MERGED',
        p_merge_reason,
        p_merged_by,
        jsonb_build_object(
            'source_had_tg', (v_source_tg IS NOT NULL),
            'canonical_had_tg', (v_canonical_tg IS NOT NULL),
            'phone_matched', (v_source_phone IS NOT NULL AND v_source_phone = v_canonical_phone)
        ),
        pg_catalog.now()
    );

    -- 9e. Reassign mutable foreign keys where appropriate and conflict-free
    -- Note: Append-only tables (booking_journey_events) are strictly NOT touched!
    
    -- booking_claim_requests
    UPDATE public.booking_claim_requests
    SET requesting_user_id = p_canonical_user_id
    WHERE requesting_user_id = p_source_user_id;

    -- booking_handoffs
    UPDATE public.booking_handoffs
    SET initiated_by_user_id = p_canonical_user_id
    WHERE initiated_by_user_id = p_source_user_id;

    -- bus_ticket_bookings (claimed / passenger / created / boarded)
    UPDATE public.bus_ticket_bookings
    SET passenger_id = p_canonical_user_id
    WHERE passenger_id = p_source_user_id;

    UPDATE public.bus_ticket_bookings
    SET created_by_user_id = p_canonical_user_id
    WHERE created_by_user_id = p_source_user_id;

    UPDATE public.bus_ticket_bookings
    SET claimed_by_user_id = p_canonical_user_id
    WHERE claimed_by_user_id = p_source_user_id;

    UPDATE public.bus_ticket_bookings
    SET boarded_by_user_id = p_canonical_user_id
    WHERE boarded_by_user_id = p_source_user_id;

    -- rides / bookings (passenger_id)
    UPDATE public.bookings
    SET passenger_id = p_canonical_user_id
    WHERE passenger_id = p_source_user_id;

    -- booking_audit_logs
    UPDATE public.booking_audit_logs
    SET performed_by_user_id = p_canonical_user_id
    WHERE performed_by_user_id = p_source_user_id;

    -- booking_notifications
    UPDATE public.booking_notifications
    SET recipient_user_id = p_canonical_user_id
    WHERE recipient_user_id = p_source_user_id;

    -- 9f. Safe merge for carrier_members (respecting UNIQUE(carrier_id, user_id))
    DELETE FROM public.carrier_members
    WHERE user_id = p_source_user_id
      AND carrier_id IN (
          SELECT carrier_id FROM public.carrier_members WHERE user_id = p_canonical_user_id
      );

    UPDATE public.carrier_members
    SET user_id = p_canonical_user_id
    WHERE user_id = p_source_user_id;

    -- Step 10: Form response payload
    v_result := jsonb_build_object(
        'success', true,
        'source_user_id', p_source_user_id,
        'canonical_user_id', p_canonical_user_id,
        'transferred_telegram_id', COALESCE(v_canonical_tg, v_source_tg),
        'merged_at', pg_catalog.now()
    );

    RETURN v_result;
END;
$$;

-- 5. Hardened Security Permissions on RPC (Revoke from PUBLIC immediately in same migration)
REVOKE ALL ON FUNCTION public.fn_safe_merge_users(INTEGER, INTEGER, VARCHAR, VARCHAR) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_safe_merge_users(INTEGER, INTEGER, VARCHAR, VARCHAR) TO service_role;
