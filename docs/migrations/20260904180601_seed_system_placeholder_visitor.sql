-- Phase P.1G.3A ADDENDUM: seed the system placeholder visitor row.
--
-- services/acquisition/outboxService.js's processOutboxEvent() has always
-- substituted the well-known placeholder '00000000-0000-0000-0000-000000000000'
-- for anonymous_visitor_id when an outbox event has none (bot-only events,
-- e.g. BOT_STARTED from a Telegram user who never visited the website and
-- so has no real web visitor id) - acquisition_events.anonymous_visitor_id
-- is NOT NULL and foreign-keys to acquisition_visitors(anonymous_visitor_id),
-- so that substitution requires a matching row to actually exist. It never
-- did, so the very first real bot-only event (found via live production
-- verification of the P.1G.3A Mini App button fix) failed permanently with
-- Postgres error 23503 (foreign key violation) on every retry.
--
-- This seeds exactly that one system row. It represents "no real web
-- visitor" generically, not any specific person or session - not a
-- historical backfill of real visitor/booking data, not a change to any
-- append-only event, not a schema change (only a data row insert).

INSERT INTO public.acquisition_visitors (
    anonymous_visitor_id,
    current_user_id,
    initial_platform,
    initial_medium,
    initial_attribution_type,
    first_seen_at,
    last_seen_at
)
VALUES (
    '00000000-0000-0000-0000-000000000000',
    NULL,
    'unknown',
    'unknown',
    'unknown',
    now(),
    now()
)
ON CONFLICT (anonymous_visitor_id) DO NOTHING;
