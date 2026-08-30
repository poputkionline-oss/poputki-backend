-- ==============================================================================
-- Migration: 20260830_trip_group_leader.sql
-- Description: Add optional group leader / escort fields to bus_tickets table
-- Project: POPUTKI.ONLINE
-- Target Table: bus_tickets
-- ==============================================================================

-- 1. Add nullable group leader fields to bus_tickets
ALTER TABLE bus_tickets
ADD COLUMN IF NOT EXISTS group_leader_name TEXT NULL,
ADD COLUMN IF NOT EXISTS group_leader_phone TEXT NULL,
ADD COLUMN IF NOT EXISTS group_leader_whatsapp TEXT NULL;

-- 2. Add helpful column comments for database documentation
COMMENT ON COLUMN bus_tickets.group_leader_name IS 'Full name of the trip group leader / escort person (optional)';
COMMENT ON COLUMN bus_tickets.group_leader_phone IS 'Primary contact phone of the trip group leader (e.g. TJ +992...)';
COMMENT ON COLUMN bus_tickets.group_leader_whatsapp IS 'WhatsApp contact phone of the trip group leader (e.g. RU +7...)';

-- ==============================================================================
-- Rollback Instructions:
-- ALTER TABLE bus_tickets
-- DROP COLUMN IF EXISTS group_leader_name,
-- DROP COLUMN IF EXISTS group_leader_phone,
-- DROP COLUMN IF EXISTS group_leader_whatsapp;
-- ==============================================================================
