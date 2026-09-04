-- ==============================================================================
-- SCHEMA-ONLY BASELINE FOR STAGING / DEVELOPMENT BRANCH
-- File: docs/migrations/staging/00_staging_schema_baseline.sql
-- Description: Creates bare schema structure without any passenger data or secrets.
-- Project: POPUTKI.ONLINE
-- ==============================================================================

-- 1. Users Table Baseline
CREATE TABLE IF NOT EXISTS public.users (
    id SERIAL PRIMARY KEY,
    name TEXT NULL,
    phone TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL DEFAULT 'passenger' CHECK (role IN ('passenger', 'carrier', 'admin', 'dispatcher', 'driver', 'accountant')),
    telegram_id BIGINT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Bus Tickets Table Baseline
CREATE TABLE IF NOT EXISTS public.bus_tickets (
    id SERIAL PRIMARY KEY,
    carrier_id INTEGER NOT NULL REFERENCES public.users(id),
    from_city TEXT NOT NULL,
    to_city TEXT NOT NULL,
    departure_date DATE NOT NULL,
    departure_time TEXT NOT NULL,
    price NUMERIC(10, 2) NOT NULL DEFAULT 0,
    total_seats INTEGER NOT NULL DEFAULT 40,
    available_seats INTEGER NOT NULL DEFAULT 40,
    reserved_seats TEXT[] NOT NULL DEFAULT '{}'::text[],
    transport_company TEXT NULL,
    bus_model TEXT NULL,
    created_by_user_id INTEGER NULL REFERENCES public.users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Bus Ticket Bookings Table Baseline
CREATE TABLE IF NOT EXISTS public.bus_ticket_bookings (
    id SERIAL PRIMARY KEY,
    bus_ticket_id INTEGER NOT NULL REFERENCES public.bus_tickets(id) ON DELETE CASCADE,
    passenger_id INTEGER NOT NULL REFERENCES public.users(id),
    claimed_by_user_id INTEGER NULL REFERENCES public.users(id),
    seat_numbers TEXT[] NOT NULL DEFAULT '{}'::text[],
    total_price NUMERIC(10, 2) NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'pending_payment', 'cancelled')),
    boarding_status TEXT NOT NULL DEFAULT 'pending_boarding' CHECK (boarding_status IN ('pending_boarding', 'boarded', 'no_show')),
    claim_status TEXT NOT NULL DEFAULT 'unclaimed' CHECK (claim_status IN ('unclaimed', 'pending_verification', 'claimed', 'rejected')),
    contact_role TEXT NOT NULL DEFAULT 'unknown',
    claimed_at TIMESTAMPTZ NULL,
    phone TEXT NOT NULL,
    pickup_city TEXT NULL,
    drop_off_city TEXT NULL,
    channel TEXT NOT NULL DEFAULT 'manual',
    source_type TEXT NOT NULL DEFAULT 'manual',
    source_id TEXT NULL,
    created_by_user_id INTEGER NULL REFERENCES public.users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bus_bookings_ticket_id ON public.bus_ticket_bookings(bus_ticket_id);
CREATE INDEX IF NOT EXISTS idx_bus_bookings_passenger_id ON public.bus_ticket_bookings(passenger_id);
CREATE INDEX IF NOT EXISTS idx_bus_bookings_claimed_by ON public.bus_ticket_bookings(claimed_by_user_id);
CREATE INDEX IF NOT EXISTS idx_bus_bookings_claim_status ON public.bus_ticket_bookings(claim_status);

-- 4. Booking Claim Sessions Table Baseline
CREATE TABLE IF NOT EXISTS public.booking_claim_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id INTEGER NOT NULL REFERENCES public.bus_ticket_bookings(id) ON DELETE CASCADE,
    session_token_hash TEXT NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    opened_at TIMESTAMPTZ NULL,
    consumed_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_claim_sessions_booking_id ON public.booking_claim_sessions(booking_id);
CREATE INDEX IF NOT EXISTS idx_claim_sessions_token_hash ON public.booking_claim_sessions(session_token_hash);
CREATE INDEX IF NOT EXISTS idx_claim_sessions_expires_at ON public.booking_claim_sessions(expires_at);

-- 5. Booking Claim Requests Table Baseline
CREATE TABLE IF NOT EXISTS public.booking_claim_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id INTEGER NOT NULL REFERENCES public.bus_ticket_bookings(id) ON DELETE CASCADE,
    requesting_user_id INTEGER NULL REFERENCES public.users(id) ON DELETE SET NULL,
    verification_method TEXT NOT NULL CHECK (verification_method IN ('telegram_contact', 'manual_review')),
    status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'superseded')),
    attempt_count INTEGER NOT NULL DEFAULT 1,
    failure_reason_code TEXT NULL,
    reviewed_by_user_id INTEGER NULL REFERENCES public.users(id) ON DELETE SET NULL,
    reviewed_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_claim_requests_pending_unique 
    ON public.booking_claim_requests(booking_id, requesting_user_id) 
    WHERE status = 'pending';

-- 6. Atomic Auto-Claim Function Baseline
CREATE OR REPLACE FUNCTION public.fn_claim_booking_auto(
    p_booking_id INTEGER,
    p_user_id INTEGER,
    p_session_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_updated_booking RECORD;
BEGIN
    UPDATE public.bus_ticket_bookings
    SET claim_status = 'claimed',
        claimed_by_user_id = p_user_id,
        claimed_at = NOW()
    WHERE id = p_booking_id
      AND status = 'confirmed'
      AND claim_status != 'claimed'
      AND claimed_by_user_id IS NULL
    RETURNING * INTO v_updated_booking;

    IF v_updated_booking.id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'BOOKING_INELIGIBLE_OR_ALREADY_CLAIMED');
    END IF;

    IF p_session_id IS NOT NULL THEN
        UPDATE public.booking_claim_sessions
        SET consumed_at = NOW()
        WHERE id = p_session_id;
    END IF;

    UPDATE public.booking_claim_requests
    SET status = 'superseded',
        reviewed_at = NOW()
    WHERE booking_id = p_booking_id
      AND status = 'pending';

    RETURN jsonb_build_object(
        'success', true,
        'booking_id', p_booking_id,
        'claimed_by_user_id', p_user_id,
        'claimed_at', v_updated_booking.claimed_at
    );
END;
$$;
