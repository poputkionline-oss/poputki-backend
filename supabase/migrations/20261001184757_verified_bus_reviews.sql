-- Verified reviews; additive schema, old reviews preserved.
ALTER TABLE public.reviews ALTER COLUMN ride_id DROP NOT NULL;
ALTER TABLE public.reviews ADD COLUMN bus_ticket_id integer REFERENCES public.bus_tickets(id);
ALTER TABLE public.reviews ADD COLUMN bus_booking_id integer REFERENCES public.bus_ticket_bookings(id);
ALTER TABLE public.reviews ADD CONSTRAINT reviews_target_check CHECK (
 (ride_id IS NOT NULL AND bus_ticket_id IS NULL AND bus_booking_id IS NULL) OR
 (ride_id IS NULL AND bus_ticket_id IS NOT NULL AND bus_booking_id IS NOT NULL));
ALTER TABLE public.reviews ADD CONSTRAINT reviews_rating_check CHECK (rating BETWEEN 1 AND 5);
ALTER TABLE public.reviews ADD CONSTRAINT reviews_comment_length CHECK (comment IS NULL OR length(comment)<=2000) NOT VALID;
CREATE UNIQUE INDEX reviews_ride_reviewer_unique ON public.reviews(ride_id,reviewer_id) WHERE ride_id IS NOT NULL;
CREATE UNIQUE INDEX reviews_bus_reviewer_unique ON public.reviews(bus_ticket_id,reviewer_id) WHERE bus_ticket_id IS NOT NULL;
CREATE INDEX reviews_carrier_bus_idx ON public.reviews(driver_id,created_at DESC) WHERE bus_ticket_id IS NOT NULL;
DROP POLICY IF EXISTS allow_all_app_access ON public.reviews;
REVOKE ALL ON public.reviews FROM anon,authenticated;
GRANT ALL ON public.reviews TO service_role;

-- Called only by server-authenticated API, with reviewer derived from JWT.
CREATE FUNCTION public.fn_submit_verified_review(p_kind text,p_target_id integer,p_reviewer_id integer,p_rating integer,p_comment text DEFAULT '') RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE v_trip public.bus_tickets%ROWTYPE; v_booking public.bus_ticket_bookings%ROWTYPE;
 v_ride public.rides%ROWTYPE; v_driver integer; v_id integer; v_trip_id integer;
BEGIN
 IF p_rating IS NULL OR p_rating NOT BETWEEN 1 AND 5 OR length(coalesce(p_comment,''))>2000 THEN
  RETURN jsonb_build_object('success',false,'error','INVALID_REVIEW');
 END IF;
 IF p_kind='bus' THEN
  SELECT bus_ticket_id INTO v_trip_id FROM public.bus_ticket_bookings WHERE id=p_target_id;
  SELECT * INTO v_trip FROM public.bus_tickets WHERE id=v_trip_id FOR SHARE;
  IF NOT FOUND OR v_trip.status IS DISTINCT FROM 'completed' THEN
   RETURN jsonb_build_object('success',false,'error','TRIP_NOT_COMPLETED');
  END IF;
  SELECT * INTO v_booking FROM public.bus_ticket_bookings WHERE id=p_target_id FOR SHARE;
  IF NOT FOUND OR v_booking.status IS DISTINCT FROM 'confirmed' OR v_booking.boarding_status IS DISTINCT FROM 'boarded' THEN
   RETURN jsonb_build_object('success',false,'error','PASSENGER_NOT_BOARDED');
  END IF;
  IF v_booking.claimed_by_user_id IS NOT NULL THEN
   IF v_booking.claimed_by_user_id<>p_reviewer_id THEN RETURN jsonb_build_object('success',false,'error','REVIEW_FORBIDDEN'); END IF;
  ELSIF v_booking.passenger_id<>p_reviewer_id OR v_booking.channel='manual' OR v_booking.source_type='manual' OR v_booking.contact_role='carrier_contact' THEN
   RETURN jsonb_build_object('success',false,'error','REVIEW_FORBIDDEN');
  END IF;
  v_driver:=v_trip.operator_id;
 ELSIF p_kind='ride' THEN
  SELECT * INTO v_ride FROM public.rides WHERE id=p_target_id FOR SHARE;
  IF NOT FOUND OR v_ride.status IS DISTINCT FROM 'completed' THEN RETURN jsonb_build_object('success',false,'error','TRIP_NOT_COMPLETED'); END IF;
  PERFORM id FROM public.bookings WHERE ride_id=p_target_id AND passenger_id=p_reviewer_id AND status='confirmed' FOR SHARE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'error','REVIEW_FORBIDDEN'); END IF;
  v_driver:=v_ride.driver_id;
 ELSE RETURN jsonb_build_object('success',false,'error','INVALID_REVIEW'); END IF;
 IF p_reviewer_id=v_driver THEN RETURN jsonb_build_object('success',false,'error','REVIEW_FORBIDDEN'); END IF;
 -- Serialize rating changes and duplicate attempts for this recipient.
 PERFORM id FROM public.users WHERE id=v_driver FOR UPDATE;
 BEGIN
  INSERT INTO public.reviews(ride_id,bus_ticket_id,bus_booking_id,reviewer_id,driver_id,rating,comment)
  VALUES(CASE WHEN p_kind='ride' THEN p_target_id END,CASE WHEN p_kind='bus' THEN v_trip.id END,
   CASE WHEN p_kind='bus' THEN p_target_id END,p_reviewer_id,v_driver,p_rating,btrim(coalesce(p_comment,''))) RETURNING id INTO v_id;
 EXCEPTION WHEN unique_violation THEN RETURN jsonb_build_object('success',false,'error','ALREADY_REVIEWED'); END;
 RETURN jsonb_build_object('success',true,'id',v_id);
END $$;
REVOKE ALL ON FUNCTION public.fn_submit_verified_review(text,integer,integer,integer,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_submit_verified_review(text,integer,integer,integer,text) TO service_role;

-- Keep legacy driver cache accurate after insert/update/delete, including last deletion.
CREATE FUNCTION public.fn_refresh_ride_review_rating() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE v_driver integer;
BEGIN
 v_driver:=CASE WHEN TG_OP='DELETE' THEN OLD.driver_id ELSE NEW.driver_id END;
 IF (CASE WHEN TG_OP='DELETE' THEN OLD.ride_id ELSE NEW.ride_id END) IS NOT NULL THEN
  PERFORM id FROM public.users WHERE id=v_driver FOR UPDATE;
  UPDATE public.users SET rating=(SELECT round(avg(rating)::numeric,1)::double precision FROM public.reviews WHERE driver_id=v_driver AND ride_id IS NOT NULL) WHERE id=v_driver;
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.fn_refresh_ride_review_rating() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER reviews_refresh_rating AFTER INSERT OR DELETE OR UPDATE ON public.reviews FOR EACH ROW EXECUTE FUNCTION public.fn_refresh_ride_review_rating();

-- Invitations only for FUTURE transitions to completed; no historical mass mailing.
CREATE TABLE public.bus_review_invitations (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 bus_ticket_id integer NOT NULL REFERENCES public.bus_tickets(id),
 booking_id integer NOT NULL REFERENCES public.bus_ticket_bookings(id),
 reviewer_id integer NOT NULL REFERENCES public.users(id),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','processing','sent','failed','uncertain','skipped')),
 created_at timestamptz NOT NULL DEFAULT now(),
 lease_expires_at timestamptz, sent_at timestamptz, last_error text,
 UNIQUE(bus_ticket_id,reviewer_id));
ALTER TABLE public.bus_review_invitations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.bus_review_invitations FROM anon,authenticated;
GRANT ALL ON public.bus_review_invitations TO service_role;
GRANT USAGE,SELECT ON SEQUENCE public.bus_review_invitations_id_seq TO service_role;
CREATE INDEX bus_review_invitation_pending_idx ON public.bus_review_invitations(created_at) WHERE status='pending';
CREATE FUNCTION public.fn_enqueue_bus_review_invitations() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
 IF NEW.status='completed' AND OLD.status IS DISTINCT FROM 'completed' THEN
  INSERT INTO public.bus_review_invitations(bus_ticket_id,booking_id,reviewer_id)
  SELECT NEW.id,min(b.id),coalesce(b.claimed_by_user_id,b.passenger_id)
  FROM public.bus_ticket_bookings b JOIN public.users u ON u.id=coalesce(b.claimed_by_user_id,b.passenger_id)
  WHERE b.bus_ticket_id=NEW.id AND b.status='confirmed' AND b.boarding_status='boarded' AND u.telegram_id IS NOT NULL
   AND u.id<>NEW.operator_id
   AND (b.claimed_by_user_id IS NOT NULL OR (coalesce(b.channel,'')<>'manual' AND coalesce(b.source_type,'')<>'manual' AND b.contact_role<>'carrier_contact'))
  GROUP BY coalesce(b.claimed_by_user_id,b.passenger_id) ON CONFLICT DO NOTHING;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.fn_enqueue_bus_review_invitations() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER bus_trip_review_invitation AFTER UPDATE OF status ON public.bus_tickets FOR EACH ROW EXECUTE FUNCTION public.fn_enqueue_bus_review_invitations();
CREATE FUNCTION public.fn_claim_bus_review_invitations(p_limit integer DEFAULT 5) RETURNS SETOF public.bus_review_invitations
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
 -- A stale lease may mean Telegram accepted the message. Never resend automatically.
 UPDATE public.bus_review_invitations SET status='uncertain',last_error='LEASE_EXPIRED' WHERE status='processing' AND lease_expires_at<now();
 RETURN QUERY UPDATE public.bus_review_invitations q SET status='processing',lease_expires_at=now()+interval '2 minutes'
 WHERE q.id IN(SELECT id FROM public.bus_review_invitations WHERE status='pending' ORDER BY id FOR UPDATE SKIP LOCKED LIMIT greatest(1,least(p_limit,5))) RETURNING q.*;
END $$;
REVOKE ALL ON FUNCTION public.fn_claim_bus_review_invitations(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_claim_bus_review_invitations(integer) TO service_role;

CREATE FUNCTION public.fn_delete_verified_review(p_review_id integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE v_driver integer;
BEGIN
 SELECT driver_id INTO v_driver FROM public.reviews WHERE id=p_review_id;
 IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'error','REVIEW_NOT_FOUND'); END IF;
 PERFORM id FROM public.users WHERE id=v_driver FOR UPDATE;
 DELETE FROM public.reviews WHERE id=p_review_id;
 IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'error','REVIEW_NOT_FOUND'); END IF;
 RETURN jsonb_build_object('success',true);
END $$;
REVOKE ALL ON FUNCTION public.fn_delete_verified_review(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_delete_verified_review(integer) TO service_role;
CREATE FUNCTION public.fn_carrier_bus_review_summary(p_carrier_id integer) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path='' AS $$
 SELECT jsonb_build_object('count',count(*),'rating',round(avg(rating)::numeric,1))
 FROM public.reviews WHERE driver_id=p_carrier_id AND bus_ticket_id IS NOT NULL;
$$;
REVOKE ALL ON FUNCTION public.fn_carrier_bus_review_summary(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_carrier_bus_review_summary(integer) TO service_role;
