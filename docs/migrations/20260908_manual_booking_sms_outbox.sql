-- ==============================================================================
-- Migration: 20260908_manual_booking_sms_outbox.sql
-- Description: Transactional outbox for automatic SMS ticket-link delivery on
--              manually created carrier bookings, via OSON SMS.
-- Project: POPUTKI.ONLINE
--
-- Design notes:
--   - Purely additive: creates one new table + one new RPC. Does not alter
--     bus_ticket_bookings, booking_notifications, booking_claim_sessions,
--     or bus_ticket_notification_outbox in any way. Zero blast radius on
--     existing Telegram/WhatsApp routing, the trip-change outbox, or the
--     claim/handoff flow.
--   - Modeled on the already-production-proven worker pattern in
--     bus_ticket_notification_outbox / fn_claim_bus_trip_notification_batch
--     (FOR UPDATE SKIP LOCKED, lease + processing_token, exponential backoff
--     left to the JS worker layer, same as the trip-change outbox).
--   - Deliberately does NOT store the passenger's full phone number. The
--     live phone is read from bus_ticket_bookings.phone at send time by the
--     worker (service-role only); this table stores only a masked copy for
--     audit/display, matching the existing convention in
--     notificationQueueService.js (persistNotificationPlan already masks
--     recipient_phone before persisting).
--   - Does NOT store the raw claim/deep-link token, only its SHA-256 hash,
--     for audit correlation with booking_claim_sessions. The raw token is
--     generated once by claimHelper.generateClaimSession() and passed to
--     the worker in-memory only for that single send.
--
-- NOT APPLIED TO PRODUCTION. Prepared locally per instructions:
-- "миграции можно подготовить локально, но запрещено применять к production"
-- ==============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.manual_booking_sms_outbox (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id INTEGER NOT NULL REFERENCES public.bus_ticket_bookings(id) ON DELETE CASCADE,
    recipient_role TEXT NOT NULL DEFAULT 'passenger'
        CHECK (recipient_role IN ('passenger', 'family_or_group', 'coordinator')),
    channel TEXT NOT NULL DEFAULT 'sms' CHECK (channel = 'sms'),
    recipient_phone_masked TEXT NULL,
    recipient_phone_hmac TEXT NULL,
    carrier_id INTEGER NULL REFERENCES public.users(id) ON DELETE SET NULL,
    template_code TEXT NOT NULL DEFAULT 'manual_booking_ticket_link_v1',
    locale TEXT NOT NULL DEFAULT 'ru' CHECK (locale IN ('ru', 'tj', 'uz')),
    claim_token_hash TEXT NULL,
    idempotency_key TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'sent', 'delivered', 'failed', 'retry', 'dead_letter', 'cancelled')),
    provider_message_id TEXT NULL,
    attempts_count INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 5,
    scheduled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processing_token TEXT NULL,
    processing_started_at TIMESTAMPTZ NULL,
    lease_expires_at TIMESTAMPTZ NULL,
    last_error_code TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    sent_at TIMESTAMPTZ NULL,
    delivered_at TIMESTAMPTZ NULL,
    cancelled_at TIMESTAMPTZ NULL,
    CONSTRAINT uq_manual_booking_sms_outbox_idempotency_key UNIQUE (idempotency_key)
);

COMMENT ON TABLE public.manual_booking_sms_outbox IS
    'Transactional outbox for automatic SMS ticket-link delivery on manually created carrier bookings (OSON SMS). One row max per (booking, template_code) via idempotency_key.';
COMMENT ON COLUMN public.manual_booking_sms_outbox.recipient_phone_masked IS
    'Masked only (e.g. 9922****789). Full phone is never stored here; read live from bus_ticket_bookings.phone at send time.';
COMMENT ON COLUMN public.manual_booking_sms_outbox.claim_token_hash IS
    'SHA-256 of the raw claim token used in the /t/<token> link, for audit correlation only. Raw token is never persisted here.';
COMMENT ON COLUMN public.manual_booking_sms_outbox.recipient_phone_hmac IS
    'HMAC-SHA256(phone, OSON_SMS_PHONE_HASH_SECRET). Non-reversible without the server secret. Exists ONLY so the worker can group/count sends per phone number for the per-phone daily cap without keeping a second copy of the plaintext phone at rest.';

CREATE INDEX IF NOT EXISTS idx_manual_booking_sms_outbox_status_claim
    ON public.manual_booking_sms_outbox(status, scheduled_at)
    WHERE status IN ('pending', 'processing', 'retry');

CREATE INDEX IF NOT EXISTS idx_manual_booking_sms_outbox_booking_id
    ON public.manual_booking_sms_outbox(booking_id);

CREATE INDEX IF NOT EXISTS idx_manual_booking_sms_outbox_phone_hmac_sent
    ON public.manual_booking_sms_outbox(recipient_phone_hmac, sent_at)
    WHERE status IN ('sent', 'delivered');

CREATE INDEX IF NOT EXISTS idx_manual_booking_sms_outbox_carrier_sent
    ON public.manual_booking_sms_outbox(carrier_id, sent_at)
    WHERE status IN ('sent', 'delivered');

ALTER TABLE public.manual_booking_sms_outbox ENABLE ROW LEVEL SECURITY;

-- Service-role only. This table can carry masked-but-still-sensitive
-- delivery metadata (provider message IDs, error codes); carriers and
-- anon/authenticated roles have no legitimate reason to read it directly —
-- carrier-facing status is exposed via a dedicated admin-safe projection in
-- application code, not direct table access.
REVOKE ALL ON TABLE public.manual_booking_sms_outbox FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.manual_booking_sms_outbox TO service_role;


-- Atomic Outbox Claim Function with FOR UPDATE SKIP LOCKED
-- Mirrors fn_claim_bus_trip_notification_batch (20260906_bus_trip_change_outbox.sql)
CREATE OR REPLACE FUNCTION public.fn_claim_manual_booking_sms_batch(
    p_batch_size INTEGER DEFAULT 10,
    p_worker_token TEXT DEFAULT gen_random_uuid()::text,
    p_lease_seconds INTEGER DEFAULT 60
)
RETURNS TABLE (
    outbox_id UUID,
    booking_id INTEGER,
    recipient_role TEXT,
    carrier_id INTEGER,
    template_code TEXT,
    locale TEXT,
    idempotency_key TEXT,
    attempts_count INTEGER,
    max_attempts INTEGER,
    processing_token TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_now TIMESTAMPTZ := NOW();
    v_lease_expiry TIMESTAMPTZ := v_now + (p_lease_seconds || ' seconds')::interval;
BEGIN
    RETURN QUERY
    WITH candidate_records AS (
        SELECT o.id
        FROM public.manual_booking_sms_outbox o
        WHERE (
                (o.status IN ('pending', 'retry') AND o.scheduled_at <= v_now)
                OR (o.status = 'processing' AND o.lease_expires_at < v_now)
              )
          AND o.attempts_count < o.max_attempts
        ORDER BY o.scheduled_at ASC
        LIMIT p_batch_size
        FOR UPDATE SKIP LOCKED
    ),
    claimed_records AS (
        UPDATE public.manual_booking_sms_outbox o
        SET
            status = 'processing',
            processing_token = p_worker_token,
            processing_started_at = v_now,
            lease_expires_at = v_lease_expiry,
            attempts_count = o.attempts_count + 1
        FROM candidate_records c
        WHERE o.id = c.id
        RETURNING
            o.id, o.booking_id, o.recipient_role, o.carrier_id, o.template_code, o.locale,
            o.idempotency_key, o.attempts_count, o.max_attempts, o.processing_token
    )
    SELECT
        cr.id AS outbox_id, cr.booking_id, cr.recipient_role, cr.carrier_id, cr.template_code,
        cr.locale, cr.idempotency_key, cr.attempts_count, cr.max_attempts, cr.processing_token
    FROM claimed_records cr;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_claim_manual_booking_sms_batch FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_claim_manual_booking_sms_batch TO service_role;

COMMIT;
