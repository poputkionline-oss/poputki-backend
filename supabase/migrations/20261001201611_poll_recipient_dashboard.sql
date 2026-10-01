-- One row per booking: sent ledger is authoritative, including historical polls.
CREATE VIEW public.purchase_poll_recipients WITH (security_invoker = true) AS
WITH deliveries AS (
 SELECT 'sent-' || s.id AS id, s.booking_id, s.user_id, s.telegram_id,
        s.created_at, s.created_at AS sent_at, 'sent'::text AS delivery_status,
        s.question_snapshot, (s.question_snapshot IS NULL) AS historical
 FROM public.sent_polls s
 UNION ALL
 SELECT 'outbox-' || o.id, o.booking_id, o.user_id, o.telegram_id,
        o.created_at, o.sent_at, o.status, o.question_snapshot, false
 FROM public.purchase_poll_outbox o
 WHERE NOT EXISTS (SELECT 1 FROM public.sent_polls s WHERE s.booking_id = o.booking_id)
)
SELECT d.*, u.name, u.phone, a.answer, a.created_at AS answered_at,
 CASE WHEN a.id IS NOT NULL THEN 'answered'
      WHEN d.delivery_status = 'sent' THEN 'awaiting'
      ELSE 'not_sent' END AS answer_status
FROM deliveries d
LEFT JOIN public.users u ON u.id = d.user_id
LEFT JOIN public.purchase_poll_answers a ON a.booking_id = d.booking_id;
REVOKE ALL ON public.purchase_poll_recipients FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.purchase_poll_recipients TO service_role;
