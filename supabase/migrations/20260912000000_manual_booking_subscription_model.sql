-- ==============================================================================
-- Migration: 20260912000000_manual_booking_subscription_model.sql
-- Description: Additive "booking follower" subscription model for MANUAL
--              bookings, replacing the "first Telegram user wins the booking
--              forever" claim semantics for that channel only. Does NOT touch
--              booking_claim_sessions, fn_claim_booking_auto, or any existing
--              online-booking claim path.
-- Project: POPUTKI.ONLINE
--
-- LOCAL / STAGING ONLY AT THIS STAGE. Not applied to production Supabase as
-- part of this change — see routes/claims.js MANUAL_BOOKING_SUBSCRIPTION_
-- MODEL_ENABLED feature flag (default false).
-- ==============================================================================

BEGIN;

-- ------------------------------------------------------------------------
-- (a) booking_subscription_sessions — deliberately separate from
--     booking_claim_sessions. Different table, different hash namespace,
--     different `purpose` domain: a token minted here can never be looked
--     up by resolveClaimSession()/fn_claim_booking_auto (they query a
--     different table entirely), and vice versa.
-- ------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.booking_subscription_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id INTEGER NOT NULL REFERENCES public.bus_ticket_bookings(id) ON DELETE CASCADE,
    session_token_hash TEXT NOT NULL UNIQUE,
    purpose TEXT NOT NULL DEFAULT 'booking_subscription' CHECK (purpose = 'booking_subscription'),
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.booking_subscription_sessions IS
    'Short-lived (15 min) token session for adding a Telegram subscriber to a manual booking. Purpose-locked so a token minted here can never be consumed by the unrelated booking_claim_sessions/fn_claim_booking_auto ownership-transfer flow. Raw token is never stored — only session_token_hash (SHA-256).';

-- ------------------------------------------------------------------------
-- (b) booking_followers — additive. Multiple independent subscribers per
--     booking; does not touch bus_ticket_bookings.claimed_by_user_id.
-- ------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.booking_followers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id INTEGER NOT NULL REFERENCES public.bus_ticket_bookings(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES public.users(id),
    role_declared TEXT NOT NULL DEFAULT 'unknown'
        CHECK (role_declared IN ('unknown', 'passenger', 'family_or_group', 'coordinator', 'intermediary')),
    notifications_enabled BOOLEAN NOT NULL DEFAULT true,
    subscribed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    unsubscribed_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_booking_followers_booking_user UNIQUE (booking_id, user_id)
);

COMMENT ON COLUMN public.booking_followers.role_declared IS
    'Self-declared by the subscriber only. NEVER used for authorization, NEVER treated as proof of identity, NEVER gates which data is shown. Default unknown, never passenger.';
COMMENT ON CONSTRAINT booking_followers_user_id_fkey ON public.booking_followers IS
    'Intentionally no ON DELETE CASCADE on user_id: this project never physically deletes users (accounts are blocked, not removed) — a future hard-delete of a user must fail loudly here rather than silently erasing subscription history.';

-- ------------------------------------------------------------------------
-- (c) booking_follower_events — append-only audit trail. No PII.
-- ------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.booking_follower_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id INTEGER NOT NULL REFERENCES public.bus_ticket_bookings(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    event_type TEXT NOT NULL CHECK (event_type IN ('subscribed', 'unsubscribed', 'resubscribed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.booking_follower_events IS
    'Append-only. No phone/username/name — only booking_id/user_id/event_type/created_at.';

CREATE INDEX IF NOT EXISTS idx_booking_followers_user ON public.booking_followers(user_id);
CREATE INDEX IF NOT EXISTS idx_booking_follower_events_booking ON public.booking_follower_events(booking_id);

-- ------------------------------------------------------------------------
-- (d) fn_is_booking_subscribable — single shared availability rule, used
--     by every entry point (ticket-view, start-subscription, complete-
--     subscription) so the rule can never drift between call sites.
--     Grace-period keyed off the REAL arrival_date/arrival_time (not a
--     fixed departure+24h — bus_tickets.arrival_date can differ from
--     departure_date on multi-day international routes), using the same
--     arrival+12h/Asia-Dushanbe watermark as the existing trip auto-
--     complete sweep (utils/tripCompletionHelper.js) rather than inventing
--     a second, independent time rule.
-- ------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_is_booking_subscribable(p_booking_id INTEGER)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT
        b.status = 'confirmed'
        AND t.status NOT IN ('completed', 'cancelled')
        AND ((t.arrival_date + t.arrival_time)::timestamp AT TIME ZONE 'Asia/Dushanbe' + INTERVAL '12 hours') > NOW()
    FROM public.bus_ticket_bookings b
    JOIN public.bus_tickets t ON t.id = b.bus_ticket_id
    WHERE b.id = p_booking_id;
$$;

REVOKE ALL ON FUNCTION public.fn_is_booking_subscribable(INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_is_booking_subscribable(INTEGER) TO service_role;

-- ------------------------------------------------------------------------
-- (e) fn_start_booking_subscription_session — expires_at computed inside
--     the DB (NOW() + 15 minutes), never accepted as a parameter. Refuses
--     to create a session for a booking that already fails the shared
--     availability rule (cancelled/completed/past arrival+grace).
-- ------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_start_booking_subscription_session(
    p_booking_id INTEGER,
    p_session_token_hash TEXT
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_new_id UUID;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.bus_ticket_bookings WHERE id = p_booking_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'BOOKING_NOT_FOUND');
    END IF;

    IF NOT public.fn_is_booking_subscribable(p_booking_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'BOOKING_NOT_SUBSCRIBABLE');
    END IF;

    INSERT INTO public.booking_subscription_sessions (booking_id, session_token_hash, expires_at)
    VALUES (p_booking_id, p_session_token_hash, NOW() + INTERVAL '15 minutes')
    RETURNING id INTO v_new_id;

    RETURN jsonb_build_object('success', true, 'session_id', v_new_id);
END;
$$;

REVOKE ALL ON FUNCTION public.fn_start_booking_subscription_session(INTEGER, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_start_booking_subscription_session(INTEGER, TEXT) TO service_role;

-- ------------------------------------------------------------------------
-- (f) fn_complete_booking_subscription — atomic hash+purpose+TTL+consumed
--     check, re-checks fn_is_booking_subscribable (booking could have been
--     cancelled between session start and bot confirmation), normalizes
--     role_declared server-side (never a raw CHECK violation), records the
--     correct subscribed/resubscribed event based on the row's state
--     BEFORE the upsert, and is idempotent for an already-active follower.
-- ------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_complete_booking_subscription(
    p_session_hash TEXT,
    p_user_id INTEGER,
    p_role_declared TEXT
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_session_id UUID;
    v_booking_id INTEGER;
    v_safe_role TEXT;
    v_existing RECORD;
    v_event_type TEXT;
BEGIN
    -- Looked up by hash ALONE, exactly like the existing
    -- resolveClaimSession()/booking_claim_sessions pattern — the caller
    -- (the bot, via the raw token from the Telegram deep link) never knows
    -- the session's UUID id, only the raw token it hashes client-side.
    SELECT id, booking_id INTO v_session_id, v_booking_id
    FROM public.booking_subscription_sessions
    WHERE session_token_hash = p_session_hash
      AND purpose = 'booking_subscription'
      AND consumed_at IS NULL
      AND expires_at > NOW()
    FOR UPDATE;

    IF v_booking_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'SESSION_INVALID_EXPIRED_OR_CONSUMED');
    END IF;

    IF NOT public.fn_is_booking_subscribable(v_booking_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'BOOKING_NOT_SUBSCRIBABLE');
    END IF;

    v_safe_role := CASE
        WHEN p_role_declared IN ('unknown', 'passenger', 'family_or_group', 'coordinator', 'intermediary')
        THEN p_role_declared
        ELSE 'unknown'
    END;

    -- Read existing state BEFORE mutating, so the event type reflects what
    -- was actually true a moment ago rather than being inferred from the
    -- post-upsert row (which would always look "active").
    SELECT * INTO v_existing
    FROM public.booking_followers
    WHERE booking_id = v_booking_id AND user_id = p_user_id
    FOR UPDATE;

    IF NOT FOUND THEN
        v_event_type := 'subscribed';
    ELSIF v_existing.unsubscribed_at IS NOT NULL THEN
        v_event_type := 'resubscribed';
    ELSE
        v_event_type := NULL; -- already active: idempotent no-op, no event
    END IF;

    INSERT INTO public.booking_followers (booking_id, user_id, role_declared, notifications_enabled)
    VALUES (v_booking_id, p_user_id, v_safe_role, true)
    ON CONFLICT (booking_id, user_id) DO UPDATE
        SET notifications_enabled = true,
            unsubscribed_at = NULL,
            role_declared = EXCLUDED.role_declared,
            updated_at = NOW();

    IF v_event_type IS NOT NULL THEN
        INSERT INTO public.booking_follower_events (booking_id, user_id, event_type)
        VALUES (v_booking_id, p_user_id, v_event_type);
    END IF;

    UPDATE public.booking_subscription_sessions
    SET consumed_at = NOW()
    WHERE id = v_session_id AND consumed_at IS NULL;

    RETURN jsonb_build_object('success', true, 'booking_id', v_booking_id, 'event', COALESCE(v_event_type, 'already_active'));
END;
$$;

REVOKE ALL ON FUNCTION public.fn_complete_booking_subscription(TEXT, INTEGER, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_complete_booking_subscription(TEXT, INTEGER, TEXT) TO service_role;

-- ------------------------------------------------------------------------
-- (g) fn_unsubscribe_booking_follower — soft unsubscribe only, never a
--     physical DELETE.
-- ------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_unsubscribe_booking_follower(
    p_booking_id INTEGER,
    p_user_id INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_updated RECORD;
BEGIN
    UPDATE public.booking_followers
    SET notifications_enabled = false,
        unsubscribed_at = NOW(),
        updated_at = NOW()
    WHERE booking_id = p_booking_id
      AND user_id = p_user_id
      AND unsubscribed_at IS NULL
    RETURNING id INTO v_updated;

    IF v_updated IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'NOT_SUBSCRIBED_OR_ALREADY_UNSUBSCRIBED');
    END IF;

    INSERT INTO public.booking_follower_events (booking_id, user_id, event_type)
    VALUES (p_booking_id, p_user_id, 'unsubscribed');

    RETURN jsonb_build_object('success', true);
END;
$$;

REVOKE ALL ON FUNCTION public.fn_unsubscribe_booking_follower(INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_unsubscribe_booking_follower(INTEGER, INTEGER) TO service_role;

-- ------------------------------------------------------------------------
-- (h) RLS — default-deny. No policy is created for anon/authenticated on
--     any of the three tables: all real access goes through the
--     SECURITY DEFINER RPCs above (service_role only) or a service-role
--     backend read, exactly like every other sensitive table in this
--     project (bus_ticket_bookings, booking_claim_sessions, etc.).
-- ------------------------------------------------------------------------
ALTER TABLE public.booking_subscription_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.booking_followers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.booking_follower_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.booking_subscription_sessions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.booking_followers FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.booking_follower_events FROM PUBLIC, anon, authenticated;

GRANT ALL ON public.booking_subscription_sessions TO service_role;
GRANT ALL ON public.booking_followers TO service_role;
GRANT SELECT, INSERT ON public.booking_follower_events TO service_role; -- append-only: no UPDATE/DELETE grant

COMMIT;

-- ==============================================================================
-- Rollback Instructions:
-- BEGIN;
-- DROP FUNCTION IF EXISTS public.fn_unsubscribe_booking_follower(INTEGER, INTEGER);
-- DROP FUNCTION IF EXISTS public.fn_complete_booking_subscription(TEXT, INTEGER, TEXT);
-- DROP FUNCTION IF EXISTS public.fn_start_booking_subscription_session(INTEGER, TEXT);
-- DROP FUNCTION IF EXISTS public.fn_is_booking_subscribable(INTEGER);
-- DROP TABLE IF EXISTS public.booking_follower_events;
-- DROP TABLE IF EXISTS public.booking_followers;
-- DROP TABLE IF EXISTS public.booking_subscription_sessions;
-- COMMIT;
-- ==============================================================================
