ALTER TABLE public.poll_settings ADD COLUMN event_type text NOT NULL DEFAULT 'purchase' CHECK(event_type IN ('purchase','completed'));
ALTER TABLE public.purchase_poll_outbox ADD COLUMN event_type text NOT NULL DEFAULT 'purchase' CHECK(event_type IN ('purchase','completed'));
ALTER TABLE public.bus_tickets ADD COLUMN poll_completed_at timestamptz;
CREATE FUNCTION public.fn_mark_poll_trip_completion() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
 IF NEW.status='completed' AND OLD.status IS DISTINCT FROM 'completed' THEN NEW.poll_completed_at:=now(); END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.fn_mark_poll_trip_completion() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER mark_poll_trip_completion BEFORE UPDATE OF status ON public.bus_tickets FOR EACH ROW EXECUTE FUNCTION public.fn_mark_poll_trip_completion();
CREATE TABLE public.poll_templates (
 id text PRIMARY KEY, title text NOT NULL, event_type text NOT NULL CHECK(event_type IN ('purchase','completed')),
 question text NOT NULL, option1 text NOT NULL, option2 text NOT NULL, option3 text NOT NULL
);
ALTER TABLE public.poll_templates ENABLE ROW LEVEL SECURITY;
CREATE POLICY poll_templates_service ON public.poll_templates TO service_role USING(true) WITH CHECK(true);
REVOKE ALL ON public.poll_templates FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.poll_templates TO service_role;
INSERT INTO public.poll_templates VALUES
 ('reasons','Причины незавершённой покупки','purchase','Что помешало Вам купить билет?','Цена','Не получилось оплатить','Изменились планы'),
 ('usability','Удобство оформления','purchase','Что вызвало трудности при оформлении?','Выбор рейса или места','Данные пассажиров','Оплата'),
 ('quality','Улучшения после поездки','completed','Что стоит улучшить в поездке?','Соблюдение расписания','Комфорт автобуса','Обслуживание');
UPDATE public.poll_settings SET question='Что помешало Вам купить билет?',option1='Цена',option2='Не получилось оплатить',option3='Изменились планы' WHERE id=1;
CREATE OR REPLACE FUNCTION public.fn_claim_purchase_polls(p_limit integer DEFAULT 5) RETURNS SETOF public.purchase_poll_outbox
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE s public.poll_settings%ROWTYPE; b record; q public.purchase_poll_outbox%ROWTYPE; n integer:=0;
BEGIN
 UPDATE public.purchase_poll_outbox SET status='uncertain',last_error='LEASE_EXPIRED' WHERE status='processing' AND lease_expires_at<now();
 SELECT * INTO s FROM public.poll_settings WHERE id=1 FOR SHARE;
 IF NOT FOUND OR NOT s.enabled THEN RETURN; END IF;
 FOR b IN SELECT bk.*,coalesce(bk.claimed_by_user_id,bk.passenger_id) AS recipient,u.telegram_id AS recipient_tg
  FROM public.bus_ticket_bookings bk JOIN public.users u ON u.id=coalesce(bk.claimed_by_user_id,bk.passenger_id)
  JOIN public.bus_tickets t ON t.id=bk.bus_ticket_id
  WHERE u.telegram_id IS NOT NULL AND u.is_blocked IS NOT TRUE

   AND coalesce(bk.channel,'')<>'manual' AND coalesce(bk.source_type,'')<>'manual' AND bk.contact_role<>'carrier_contact'
   AND coalesce(bk.claimed_by_user_id,bk.passenger_id)<>t.operator_id
   AND ((s.event_type='purchase' AND bk.created_at>=now()-interval '24 hours'
    AND t.status='active' AND (t.departure_date+t.departure_time) AT TIME ZONE 'Asia/Dushanbe'>now()
    AND ((bk.status='pending_payment' AND coalesce(bk.hold_expires_at,bk.created_at+interval '30 minutes')<=now()-make_interval(mins=>s.delay_minutes))
      OR (bk.status='cancelled' AND bk.purchase_poll_expired_at<=now()-make_interval(mins=>s.delay_minutes))))
    OR (s.event_type='completed' AND t.status='completed' AND bk.status='confirmed' AND bk.boarding_status='boarded'
      AND t.poll_completed_at>=now()-interval '24 hours' AND t.poll_completed_at<=now()-make_interval(mins=>s.delay_minutes)))
   AND NOT EXISTS(SELECT 1 FROM public.sent_polls sp WHERE sp.booking_id=bk.id)
   AND NOT EXISTS(SELECT 1 FROM public.purchase_poll_outbox po WHERE po.booking_id=bk.id)
  ORDER BY bk.created_at DESC,bk.id DESC LIMIT 100 FOR UPDATE OF bk SKIP LOCKED
 LOOP
  -- Serialize a recipient's reservations across concurrent cron workers.
  IF NOT pg_try_advisory_xact_lock(86105,b.recipient) THEN CONTINUE; END IF;
  IF EXISTS(SELECT 1 FROM public.purchase_poll_outbox WHERE user_id=b.recipient AND created_at>now()-make_interval(days=>s.cooldown_days))
   OR EXISTS(SELECT 1 FROM public.sent_polls WHERE user_id=b.recipient AND created_at>now()-make_interval(days=>s.cooldown_days))
   OR (s.event_type='purchase' AND EXISTS(SELECT 1 FROM public.bus_ticket_bookings x WHERE x.bus_ticket_id=b.bus_ticket_id AND x.status='confirmed' AND coalesce(x.claimed_by_user_id,x.passenger_id)=b.recipient))
  THEN CONTINUE; END IF;
  INSERT INTO public.purchase_poll_outbox(booking_id,user_id,telegram_id,question_snapshot,options_snapshot,event_type)
  VALUES(b.id,b.recipient,b.recipient_tg::text,s.question,jsonb_build_array(s.option1,s.option2,s.option3,'Свой вариант (напишите ответ)'),s.event_type)
  ON CONFLICT(booking_id) DO NOTHING RETURNING * INTO q;
  IF FOUND THEN RETURN NEXT q; n:=n+1; END IF;
  EXIT WHEN n>=greatest(1,least(p_limit,5));
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.fn_claim_purchase_polls(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_claim_purchase_polls(integer) TO service_role;

