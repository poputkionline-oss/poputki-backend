-- ==============================================================================
-- Migration: 20260911_manual_booking_sms_reconciliation_required.sql
-- Description: Adds a dedicated 'reconciliation_required' outbox status for
--              the HTTP 409/DUPLICATE_TXN_ID case where no provider msg_id
--              is durably known — see the Critical Addendum in
--              docs/oson-sms-audit-report.md.
-- Project: POPUTKI.ONLINE
--
-- Root cause this fixes: the prior migration (20260909) added
-- fn_oson_sms_check_cap; the worker's duplicate-handling branch, added on
-- top of that, called query_sms.php with txn_id alone whenever OSON
-- returned HTTP 409/code 108. The confirmed OSON SMS API 2.0.2 contract
-- lists query_sms.php's parameters as login + txn_id + msg_id — nothing
-- confirms txn_id alone is a valid lookup, and nothing confirms a 409
-- response echoes the original msg_id. Calling the status endpoint on that
-- unproven assumption is no longer done (see osonSmsStatusClient.js and
-- manualBookingSmsOutboxService.js in this same change).
--
-- When a duplicate is received and NO msg_id was already durably stored
-- for that outbox row (the normal case — a row only ever gets msg_id once
-- it reaches 'sent', and a row that already reached 'sent' would never be
-- re-claimed in the first place), the row is moved to this new
-- 'reconciliation_required' status instead of being retried, dead-lettered,
-- or — critically — ever marked sent/delivered. It is deliberately NOT
-- matched by fn_claim_manual_booking_sms_batch's claim query (which only
-- ever claims 'pending'/'retry'/stale-'processing' rows), so it can never
-- be auto-claimed by the send worker again. An operator resolves it
-- manually by checking OSON's own dashboard/support, then updates the row
-- directly (service_role only).
--
-- Purely additive: one CHECK constraint is dropped and recreated with one
-- more allowed value. No other constraint, RLS policy, grant, or the
-- claim RPC's own logic is touched — the claim RPC already excludes any
-- status outside ('pending','retry') / stale-'processing' by construction,
-- so 'reconciliation_required' is excluded automatically, not by a new
-- exclusion rule that could itself be wrong.
--
-- NOT APPLIED TO PRODUCTION.
-- ==============================================================================

BEGIN;

ALTER TABLE public.manual_booking_sms_outbox
    DROP CONSTRAINT IF EXISTS manual_booking_sms_outbox_status_check;

ALTER TABLE public.manual_booking_sms_outbox
    ADD CONSTRAINT manual_booking_sms_outbox_status_check
    CHECK (status IN (
        'pending', 'processing', 'sent', 'delivered', 'failed',
        'retry', 'dead_letter', 'cancelled', 'reconciliation_required'
    ));

COMMENT ON COLUMN public.manual_booking_sms_outbox.status IS
    'reconciliation_required: HTTP 409/duplicate received from OSON with no msg_id durably known for this row — never auto-retried, never auto-claimed, never marked sent/delivered automatically. Requires a human to check OSON''s own dashboard/support and resolve manually.';

COMMIT;
