-- ==============================================================================
-- Migration: 20260912144509_harden_booking_follower_events_append_only.sql
-- Description: Corrective migration for 20260912142942_manual_booking_subscription_
--              model.sql. Does NOT modify that migration.
--
-- Finding: production's booking_follower_events granted service_role UPDATE
-- and DELETE despite the original migration's stated intent ("append-only:
-- no UPDATE/DELETE grant") and its explicit `GRANT SELECT, INSERT ... TO
-- service_role`. Root cause: this project has a pre-existing
-- ALTER DEFAULT PRIVILEGES rule for role `postgres` in schema `public` that
-- auto-grants service_role full privileges (arwdDxtm) on every newly
-- created table at CREATE TABLE time — the original migration's plain
-- GRANT only ADDED to that already-full set rather than narrowing it, since
-- it never explicitly REVOKE'd service_role first. anon/authenticated were
-- unaffected (that REVOKE ALL ... FROM PUBLIC, anon, authenticated already
-- ran and is unaffected by this file).
--
-- Also adds the two foreign-key columns on the new tables confirmed
-- (read-only, against production) to have zero covering index:
--   - booking_follower_events.user_id  (FK -> users, ON DELETE RESTRICT)
--   - booking_subscription_sessions.booking_id (FK -> bus_ticket_bookings,
--     ON DELETE CASCADE)
-- booking_followers.booking_id is deliberately NOT re-indexed here: it is
-- already covered by the leading column of the existing
-- uq_booking_followers_booking_user(booking_id, user_id) unique index.
-- ==============================================================================

BEGIN;

-- ------------------------------------------------------------------------
-- Re-narrow service_role's privileges on booking_follower_events to
-- exactly SELECT + INSERT. REVOKE ALL first (undoes the default-ACL-
-- granted UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER that the original
-- migration's plain GRANT never removed), then GRANT only what was always
-- intended.
-- ------------------------------------------------------------------------
REVOKE ALL ON TABLE public.booking_follower_events FROM service_role;
GRANT SELECT, INSERT ON TABLE public.booking_follower_events TO service_role;

-- Re-affirm (idempotent, already true today) that PUBLIC/anon/authenticated
-- have no privileges at all on this table.
REVOKE ALL ON TABLE public.booking_follower_events FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------------------
-- Missing FK-covering indexes (read-only audit against production
-- confirmed these two, and only these two, have zero covering index).
-- ------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_booking_follower_events_user_id
    ON public.booking_follower_events(user_id);

CREATE INDEX IF NOT EXISTS idx_booking_subscription_sessions_booking_id
    ON public.booking_subscription_sessions(booking_id);

COMMIT;

-- ==============================================================================
-- Rollback Instructions:
-- BEGIN;
-- DROP INDEX IF EXISTS public.idx_booking_subscription_sessions_booking_id;
-- DROP INDEX IF EXISTS public.idx_booking_follower_events_user_id;
-- GRANT ALL ON TABLE public.booking_follower_events TO service_role; -- restores prior (unintended) broader grant if ever needed
-- COMMIT;
-- ==============================================================================
