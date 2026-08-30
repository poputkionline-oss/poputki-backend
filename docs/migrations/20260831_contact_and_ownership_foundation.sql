-- ==============================================================================
-- Migration: 20260831_contact_and_ownership_foundation.sql
-- Description: Phase A/A.1/B/C - Contact Role, Claim State, Concurrency & Notification Log
-- Project: POPUTKI.ONLINE
-- Target Tables: bus_ticket_bookings, booking_notifications
-- ==============================================================================

-- 1. Add contact_role, claim_status, claimed_by_user_id, claimed_at to bus_ticket_bookings
ALTER TABLE public.bus_ticket_bookings
ADD COLUMN IF NOT EXISTS contact_role TEXT NOT NULL DEFAULT 'unknown',
ADD COLUMN IF NOT EXISTS claim_status TEXT NOT NULL DEFAULT 'unclaimed',
ADD COLUMN IF NOT EXISTS claimed_by_user_id INTEGER NULL REFERENCES public.users(id),
ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ NULL;

-- 2. Add constraints safely if they don't already exist
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_bus_bookings_contact_role'
    ) THEN
        ALTER TABLE public.bus_ticket_bookings
        ADD CONSTRAINT chk_bus_bookings_contact_role 
        CHECK (contact_role IN ('passenger', 'family_or_group', 'coordinator', 'unknown'));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_bus_bookings_claim_status'
    ) THEN
        ALTER TABLE public.bus_ticket_bookings
        ADD CONSTRAINT chk_bus_bookings_claim_status 
        CHECK (claim_status IN ('unclaimed', 'claimed'));
    END IF;
END $$;

-- 3. Create booking_notifications table for idempotent multi-channel delivery & retry queue
CREATE TABLE IF NOT EXISTS public.booking_notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id INTEGER NOT NULL REFERENCES public.bus_ticket_bookings(id) ON DELETE CASCADE,
    recipient_type TEXT NOT NULL CHECK (recipient_type IN ('passenger', 'family_or_group', 'coordinator', 'creator')),
    recipient_user_id INTEGER NULL REFERENCES public.users(id) ON DELETE SET NULL,
    recipient_phone TEXT NULL,
    channel TEXT NOT NULL CHECK (channel IN ('telegram', 'whatsapp')),
    notification_type TEXT NOT NULL CHECK (notification_type IN ('ticket_issued', 'coordinator_manifest', 'family_group_manifest', 'creator_handoff', 'trip_reminder', 'claim_invite')),
    status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'delivered', 'failed', 'skipped')),
    provider_message_id TEXT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    error_code TEXT NULL,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    last_attempt_at TIMESTAMPTZ NULL,
    next_attempt_at TIMESTAMPTZ NULL,
    sending_started_at TIMESTAMPTZ NULL,
    attempted_at TIMESTAMPTZ NULL,
    delivered_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. Create performance indices on booking_notifications
CREATE INDEX IF NOT EXISTS idx_booking_notifications_booking_id ON public.booking_notifications(booking_id);
CREATE INDEX IF NOT EXISTS idx_booking_notifications_status ON public.booking_notifications(status);
CREATE INDEX IF NOT EXISTS idx_booking_notifications_channel ON public.booking_notifications(channel);
CREATE INDEX IF NOT EXISTS idx_booking_notifications_recipient_user_id ON public.booking_notifications(recipient_user_id);
CREATE INDEX IF NOT EXISTS idx_booking_notifications_recipient_phone ON public.booking_notifications(recipient_phone);
CREATE INDEX IF NOT EXISTS idx_booking_notifications_next_attempt ON public.booking_notifications(status, next_attempt_at);

-- 5. Add column comments
COMMENT ON COLUMN public.bus_ticket_bookings.contact_role IS 'Ownership role of booking phone contact: passenger, family_or_group, coordinator, unknown';
COMMENT ON COLUMN public.bus_ticket_bookings.claim_status IS 'Claim state of manual booking: unclaimed, claimed';
COMMENT ON COLUMN public.bus_ticket_bookings.claimed_by_user_id IS 'Platform user who successfully claimed this offline booking';
COMMENT ON COLUMN public.bus_ticket_bookings.claimed_at IS 'Timestamp when the booking was claimed by a verified passenger';

-- ==============================================================================
-- Rollback Instructions:
-- DROP TABLE IF EXISTS public.booking_notifications;
-- ALTER TABLE public.bus_ticket_bookings DROP CONSTRAINT IF EXISTS chk_bus_bookings_contact_role;
-- ALTER TABLE public.bus_ticket_bookings DROP CONSTRAINT IF EXISTS chk_bus_bookings_claim_status;
-- ALTER TABLE public.bus_ticket_bookings DROP COLUMN IF EXISTS contact_role;
-- ALTER TABLE public.bus_ticket_bookings DROP COLUMN IF EXISTS claim_status;
-- ALTER TABLE public.bus_ticket_bookings DROP COLUMN IF EXISTS claimed_by_user_id;
-- ALTER TABLE public.bus_ticket_bookings DROP COLUMN IF EXISTS claimed_at;
-- ==============================================================================
