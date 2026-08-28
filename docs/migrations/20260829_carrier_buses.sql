-- ============================================================================
-- Migration: 20260829_carrier_buses.sql
-- Description: Foundation for "Мой автопарк" (Carrier Fleet Management)
-- Author: POPUTKI.ONLINE Engineering
-- Date: 2026-08-29
-- Safety: Non-destructive, backward-compatible, nullable bus_id on bus_tickets
-- ============================================================================

-- 1. Create carrier_buses table
CREATE TABLE IF NOT EXISTS public.carrier_buses (
    id BIGSERIAL PRIMARY KEY,
    carrier_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    brand VARCHAR(50) NOT NULL,
    model VARCHAR(80) NOT NULL,
    license_plate VARCHAR(30) NOT NULL,
    vin VARCHAR(50) DEFAULT NULL,
    year_built INT DEFAULT NULL,
    color VARCHAR(30) DEFAULT NULL,
    bus_type VARCHAR(20) NOT NULL DEFAULT 'single',
    total_seats INT NOT NULL DEFAULT 53,
    floor1_seats INT DEFAULT NULL,
    floor2_seats INT DEFAULT NULL,
    photos JSONB NOT NULL DEFAULT '[]'::jsonb,
    amenities JSONB NOT NULL DEFAULT '[]'::jsonb,
    seat_layout_override JSONB DEFAULT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    notes TEXT DEFAULT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Domain Constraints
    CONSTRAINT chk_carrier_buses_bus_type 
        CHECK (bus_type IN ('single', 'double')),
    
    CONSTRAINT chk_carrier_buses_status 
        CHECK (status IN ('active', 'maintenance', 'inactive', 'archived')),
    
    CONSTRAINT chk_carrier_buses_total_seats 
        CHECK (total_seats > 0),
    
    CONSTRAINT chk_carrier_buses_year_built 
        CHECK (year_built IS NULL OR (year_built >= 1950 AND year_built <= 2100)),
    
    CONSTRAINT chk_carrier_buses_floors 
        CHECK (
            (bus_type = 'single') OR 
            (bus_type = 'double' AND floor1_seats IS NOT NULL AND floor1_seats > 0 AND floor2_seats IS NOT NULL AND floor2_seats > 0 AND (floor1_seats + floor2_seats = total_seats))
        )
);

-- 2. Create Indexes for carrier_buses
CREATE INDEX IF NOT EXISTS idx_carrier_buses_carrier_id 
    ON public.carrier_buses (carrier_id);

CREATE INDEX IF NOT EXISTS idx_carrier_buses_status 
    ON public.carrier_buses (status);

-- 3. License plate uniqueness per tenant for non-archived buses
-- (Allows same plate across different carriers, and allows reusing plate if old vehicle is archived)
CREATE UNIQUE INDEX IF NOT EXISTS uq_carrier_buses_active_plate 
    ON public.carrier_buses (carrier_id, UPPER(REPLACE(license_plate, ' ', ''))) 
    WHERE (status != 'archived');

-- 4. Add nullable bus_id to bus_tickets (Backward compatible with all historical trips)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' 
          AND table_name = 'bus_tickets' 
          AND column_name = 'bus_id'
    ) THEN
        ALTER TABLE public.bus_tickets 
        ADD COLUMN bus_id BIGINT NULL REFERENCES public.carrier_buses(id) ON DELETE SET NULL;
    END IF;
END $$;

-- 5. Create index on bus_tickets.bus_id
CREATE INDEX IF NOT EXISTS idx_bus_tickets_bus_id 
    ON public.bus_tickets (bus_id);

-- ============================================================================
-- End of Migration
-- ============================================================================
