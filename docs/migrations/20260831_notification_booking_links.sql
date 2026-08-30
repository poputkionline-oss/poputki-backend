-- ==============================================================================
-- Migration: 20260831_notification_booking_links.sql
-- Description: Add relational link table for multi-booking group notifications (Phase D)
-- Project: POPUTKI.ONLINE
-- Target Table: booking_notification_bookings
-- ==============================================================================

-- 1. Create booking_notification_bookings relational mapping table
CREATE TABLE IF NOT EXISTS public.booking_notification_bookings (
    notification_id UUID NOT NULL REFERENCES public.booking_notifications(id) ON DELETE CASCADE,
    booking_id INTEGER NOT NULL REFERENCES public.bus_ticket_bookings(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (notification_id, booking_id)
);

-- 2. Performance indexes
CREATE INDEX IF NOT EXISTS idx_notif_bookings_booking_id ON public.booking_notification_bookings(booking_id);
CREATE INDEX IF NOT EXISTS idx_notif_bookings_notif_id ON public.booking_notification_bookings(notification_id);

-- 3. Row Level Security: Server-side only table
ALTER TABLE public.booking_notification_bookings ENABLE ROW LEVEL SECURITY;

-- 4. Helpful column comments
COMMENT ON TABLE public.booking_notification_bookings IS 'Relational link between a notification log row and one or more bus bookings (supports 1-to-N group manifests)';
COMMENT ON COLUMN public.booking_notification_bookings.notification_id IS 'Parent notification ID in booking_notifications';
COMMENT ON COLUMN public.booking_notification_bookings.booking_id IS 'Associated booking ID in bus_ticket_bookings';

-- ==============================================================================
-- Rollback Instructions:
-- DROP TABLE IF EXISTS public.booking_notification_bookings;
-- ==============================================================================
