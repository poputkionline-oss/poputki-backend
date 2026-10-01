-- Preserve historical polls/answers; snapshots are unknown for legacy rows.
ALTER TABLE public.poll_settings ADD COLUMN enabled boolean NOT NULL DEFAULT true;
ALTER TABLE public.poll_settings ADD COLUMN webhook_configured_at timestamptz;
ALTER TABLE public.poll_settings ADD COLUMN webhook_url text;
ALTER TABLE public.poll_settings ADD COLUMN delay_minutes integer NOT NULL DEFAULT 15 CHECK(delay_minutes BETWEEN 1 AND 1440);
ALTER TABLE public.poll_settings ADD COLUMN cooldown_days integer NOT NULL DEFAULT 7 CHECK(cooldown_days BETWEEN 1 AND 365);
ALTER TABLE public.sent_polls ADD COLUMN question_snapshot text;
ALTER TABLE public.sent_polls ADD COLUMN options_snapshot jsonb;
ALTER TABLE public.purchase_poll_answers ADD COLUMN poll_id text REFERENCES public.sent_polls(poll_id) ON DELETE SET NULL;
ALTER TABLE public.purchase_poll_answers ADD COLUMN question_snapshot text;
ALTER TABLE public.purchase_poll_answers ADD COLUMN selected_option integer;
CREATE UNIQUE INDEX purchase_poll_answer_booking_unique ON public.purchase_poll_answers(booking_id);
CREATE UNIQUE INDEX sent_poll_booking_unique ON public.sent_polls(booking_id);
ALTER TABLE public.bus_ticket_bookings ADD COLUMN purchase_poll_expired_at timestamptz;
CREATE FUNCTION public.fn_mark_purchase_poll_expiration() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
 IF OLD.status='pending_payment' AND NEW.status='cancelled'
  AND coalesce(OLD.hold_expires_at,OLD.created_at+interval '30 minutes')<=now() THEN
  NEW.purchase_poll_expired_at:=now();
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.fn_mark_purchase_poll_expiration() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER mark_purchase_poll_expiration BEFORE UPDATE OF status ON public.bus_ticket_bookings FOR EACH ROW EXECUTE FUNCTION public.fn_mark_purchase_poll_expiration();

CREATE TABLE public.purchase_poll_outbox(
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 booking_id integer NOT NULL UNIQUE REFERENCES public.bus_ticket_bookings(id) ON DELETE CASCADE,
 user_id integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
 telegram_id text NOT NULL,
 question_snapshot text NOT NULL, options_snapshot jsonb NOT NULL,
 status text NOT NULL DEFAULT 'processing' CHECK(status IN('processing','sent','skipped','failed','uncertain')),
 created_at timestamptz NOT NULL DEFAULT now(),lease_expires_at timestamptz DEFAULT now()+interval '2 minutes',
 sent_at timestamptz,last_error text,poll_id text);
CREATE INDEX purchase_poll_user_cooldown_idx ON public.purchase_poll_outbox(user_id,created_at DESC);
CREATE TABLE public.purchase_poll_sessions(
 telegram_id text PRIMARY KEY,
 sent_poll_id integer NOT NULL REFERENCES public.sent_polls(id) ON DELETE CASCADE,
 expires_at timestamptz NOT NULL DEFAULT now()+interval '1 day');
ALTER TABLE public.purchase_poll_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchase_poll_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY poll_outbox_service ON public.purchase_poll_outbox TO service_role USING(true) WITH CHECK(true);
CREATE POLICY poll_session_service ON public.purchase_poll_sessions TO service_role USING(true) WITH CHECK(true);
DROP POLICY IF EXISTS allow_all_app_access ON public.poll_settings;
DROP POLICY IF EXISTS allow_all_app_access ON public.sent_polls;
DROP POLICY IF EXISTS allow_all_app_access ON public.purchase_poll_answers;
-- Revoke grants as defense in depth, irrespective of legacy public policy names.
REVOKE ALL ON public.poll_settings,public.sent_polls,public.purchase_poll_answers,public.purchase_poll_outbox,public.purchase_poll_sessions FROM anon,authenticated;
GRANT ALL ON public.poll_settings,public.sent_polls,public.purchase_poll_answers,public.purchase_poll_outbox,public.purchase_poll_sessions TO service_role;
GRANT USAGE,SELECT ON SEQUENCE public.purchase_poll_outbox_id_seq,public.sent_polls_id_seq,public.purchase_poll_answers_id_seq TO service_role;

CREATE FUNCTION public.fn_claim_purchase_polls(p_limit integer DEFAULT 5) RETURNS SETOF public.purchase_poll_outbox
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE s public.poll_settings%ROWTYPE; b record; q public.purchase_poll_outbox%ROWTYPE; n integer:=0;
BEGIN
 UPDATE public.purchase_poll_outbox SET status='uncertain',last_error='LEASE_EXPIRED' WHERE status='processing' AND lease_expires_at<now();
 SELECT * INTO s FROM public.poll_settings WHERE id=1 FOR SHARE;
 IF NOT FOUND OR NOT s.enabled THEN RETURN; END IF;
 FOR b IN SELECT bk.*,coalesce(bk.claimed_by_user_id,bk.passenger_id) AS recipient,u.telegram_id AS recipient_tg
  FROM public.bus_ticket_bookings bk JOIN public.users u ON u.id=coalesce(bk.claimed_by_user_id,bk.passenger_id)
  JOIN public.bus_tickets t ON t.id=bk.bus_ticket_id
  WHERE bk.created_at>=now()-interval '24 hours' AND u.telegram_id IS NOT NULL AND u.is_blocked IS NOT TRUE
   AND t.status='active' AND (t.departure_date+t.departure_time) AT TIME ZONE 'Asia/Dushanbe'>now()
   AND coalesce(bk.channel,'')<>'manual' AND coalesce(bk.source_type,'')<>'manual' AND bk.contact_role<>'carrier_contact'
   AND coalesce(bk.claimed_by_user_id,bk.passenger_id)<>t.operator_id
   AND ((bk.status='pending_payment' AND coalesce(bk.hold_expires_at,bk.created_at+interval '30 minutes')<=now()-make_interval(mins=>s.delay_minutes))
    OR (bk.status='cancelled' AND bk.purchase_poll_expired_at<=now()-make_interval(mins=>s.delay_minutes)))
   AND NOT EXISTS(SELECT 1 FROM public.sent_polls sp WHERE sp.booking_id=bk.id)
   AND NOT EXISTS(SELECT 1 FROM public.purchase_poll_outbox po WHERE po.booking_id=bk.id)
  ORDER BY bk.created_at DESC,bk.id DESC LIMIT 100 FOR UPDATE OF bk SKIP LOCKED
 LOOP
  -- Serialize a recipient's reservations across concurrent cron workers.
  IF NOT pg_try_advisory_xact_lock(86105,b.recipient) THEN CONTINUE; END IF;
  IF EXISTS(SELECT 1 FROM public.purchase_poll_outbox WHERE user_id=b.recipient AND created_at>now()-make_interval(days=>s.cooldown_days))
   OR EXISTS(SELECT 1 FROM public.sent_polls WHERE user_id=b.recipient AND created_at>now()-make_interval(days=>s.cooldown_days))
   OR EXISTS(SELECT 1 FROM public.bus_ticket_bookings x WHERE x.bus_ticket_id=b.bus_ticket_id AND x.status='confirmed' AND coalesce(x.claimed_by_user_id,x.passenger_id)=b.recipient)
  THEN CONTINUE; END IF;
  INSERT INTO public.purchase_poll_outbox(booking_id,user_id,telegram_id,question_snapshot,options_snapshot)
  VALUES(b.id,b.recipient,b.recipient_tg::text,s.question,jsonb_build_array(s.option1,s.option2,s.option3,'Ваш вариант (напишите, что именно мешает)'))
  ON CONFLICT(booking_id) DO NOTHING RETURNING * INTO q;
  IF FOUND THEN RETURN NEXT q; n:=n+1; END IF;
  EXIT WHEN n>=greatest(1,least(p_limit,5));
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.fn_claim_purchase_polls(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_claim_purchase_polls(integer) TO service_role;

CREATE FUNCTION public.fn_finalize_purchase_poll(p_outbox_id bigint,p_poll_id text) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE q public.purchase_poll_outbox%ROWTYPE;
BEGIN
 SELECT * INTO q FROM public.purchase_poll_outbox WHERE id=p_outbox_id FOR UPDATE;
 IF NOT FOUND OR q.status<>'processing' OR p_poll_id IS NULL OR length(p_poll_id)=0 THEN RETURN jsonb_build_object('success',false); END IF;
 INSERT INTO public.sent_polls(poll_id,booking_id,user_id,telegram_id,question_snapshot,options_snapshot)
 VALUES(p_poll_id,q.booking_id,q.user_id,q.telegram_id,q.question_snapshot,q.options_snapshot);
 UPDATE public.purchase_poll_outbox SET status='sent',poll_id=p_poll_id,sent_at=now(),lease_expires_at=NULL WHERE id=q.id;
 RETURN jsonb_build_object('success',true);
END $$;
REVOKE ALL ON FUNCTION public.fn_finalize_purchase_poll(bigint,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_finalize_purchase_poll(bigint,text) TO service_role;

CREATE FUNCTION public.fn_answer_purchase_poll(p_poll_id text,p_telegram_id text,p_option integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE p public.sent_polls%ROWTYPE;
BEGIN
 SELECT * INTO p FROM public.sent_polls WHERE poll_id=p_poll_id AND telegram_id=p_telegram_id FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('status','ignored'); END IF;
 IF EXISTS(SELECT 1 FROM public.purchase_poll_answers WHERE booking_id=p.booking_id) THEN RETURN jsonb_build_object('status','duplicate'); END IF;
 IF p.options_snapshot IS NULL THEN RETURN jsonb_build_object('status','legacy'); END IF;
 IF p_option IS NULL OR p_option NOT BETWEEN 0 AND 3 THEN RETURN jsonb_build_object('status','ignored'); END IF;
 IF p_option=3 THEN
  INSERT INTO public.purchase_poll_sessions(telegram_id,sent_poll_id) VALUES(p_telegram_id,p.id)
  ON CONFLICT(telegram_id) DO UPDATE SET sent_poll_id=excluded.sent_poll_id,expires_at=now()+interval '1 day';
  RETURN jsonb_build_object('status','custom');
 END IF;
 INSERT INTO public.purchase_poll_answers(booking_id,user_id,telegram_id,answer,poll_id,question_snapshot,selected_option)
 VALUES(p.booking_id,p.user_id,p.telegram_id,p.options_snapshot->>p_option,p.poll_id,p.question_snapshot,p_option)
 ON CONFLICT(booking_id) DO NOTHING;
 DELETE FROM public.purchase_poll_sessions WHERE telegram_id=p_telegram_id AND sent_poll_id=p.id;
 RETURN jsonb_build_object('status','saved');
END $$;
REVOKE ALL ON FUNCTION public.fn_answer_purchase_poll(text,text,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_answer_purchase_poll(text,text,integer) TO service_role;

CREATE FUNCTION public.fn_answer_purchase_poll_text(p_telegram_id text,p_text text) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE p public.sent_polls%ROWTYPE; s public.purchase_poll_sessions%ROWTYPE;
BEGIN
 SELECT * INTO s FROM public.purchase_poll_sessions WHERE telegram_id=p_telegram_id FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('status','ignored'); END IF;
 IF s.expires_at<now() OR p_text='/cancel' THEN
  DELETE FROM public.purchase_poll_sessions WHERE telegram_id=p_telegram_id;
  RETURN jsonb_build_object('status',CASE WHEN p_text='/cancel' THEN 'cancelled' ELSE 'expired' END);
 END IF;
 IF length(btrim(coalesce(p_text,''))) NOT BETWEEN 1 AND 2000 THEN RETURN jsonb_build_object('status','invalid'); END IF;
 SELECT * INTO p FROM public.sent_polls WHERE id=s.sent_poll_id AND telegram_id=p_telegram_id;
 IF NOT FOUND THEN RETURN jsonb_build_object('status','ignored'); END IF;
 INSERT INTO public.purchase_poll_answers(booking_id,user_id,telegram_id,answer,poll_id,question_snapshot,selected_option)
 VALUES(p.booking_id,p.user_id,p.telegram_id,btrim(p_text),p.poll_id,p.question_snapshot,3)
 ON CONFLICT(booking_id) DO NOTHING;
 DELETE FROM public.purchase_poll_sessions WHERE telegram_id=p_telegram_id;
 RETURN jsonb_build_object('status','saved');
END $$;
REVOKE ALL ON FUNCTION public.fn_answer_purchase_poll_text(text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_answer_purchase_poll_text(text,text) TO service_role;
