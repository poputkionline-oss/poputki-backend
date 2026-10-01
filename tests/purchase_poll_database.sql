-- Transaction-only verification. No Telegram calls; all fixture rows roll back.
BEGIN;
DO $test$
DECLARE ids bigint[]; qid bigint; custom_qid bigint; r jsonb;
BEGIN
 INSERT INTO public.users(id,phone,name,telegram_id) VALUES
 (-910001,'poll-test-1','Test carrier',NULL),(-910002,'poll-test-2','Test passenger',910002),
 (-910003,'poll-test-3','Test manual',910003),(-910004,'poll-test-4','Test paid',910004),(-910005,'poll-test-5','Test custom',910005);
 INSERT INTO public.bus_tickets(id,operator_id,transport_company,from_city,from_address,to_city,to_address,departure_date,departure_time,arrival_date,arrival_time,duration_minutes,price,total_seats,status)
 VALUES(-910001,-910001,'Test','A','A','B','B',current_date+10,'10:00',current_date+10,'11:00',60,100,50,'active');
 UPDATE public.poll_settings SET event_type='purchase',enabled=true,delay_minutes=15,cooldown_days=7,question='Fixture question',option1='Price',option2='Payment',option3='Plans' WHERE id=1;
 INSERT INTO public.bus_ticket_bookings(id,bus_ticket_id,passenger_id,seat_numbers,passengers_data,phone,total_price,status,boarding_status,channel,source_type,created_at,hold_expires_at)
 VALUES
 (-910001,-910001,-910002,'[1]','[]','poll-test-2',100,'pending_payment','pending_boarding','web','platform',now()-interval '2 hours',now()-interval '90 minutes'),
 (-910002,-910001,-910003,'[2]','[]','poll-test-3',100,'pending_payment','pending_boarding','manual','manual',now()-interval '2 hours',now()-interval '90 minutes'),
 (-910003,-910001,-910004,'[3]','[]','poll-test-4',100,'pending_payment','pending_boarding','web','platform',now()-interval '2 hours',now()-interval '90 minutes'),
 (-910004,-910001,-910004,'[4]','[]','poll-test-4',100,'confirmed','pending_boarding','web','platform',now()-interval '1 hour',NULL),
 (-910005,-910001,-910005,'[5]','[]','poll-test-5',100,'cancelled','pending_boarding','web','platform',now()-interval '2 hours',now()-interval '90 minutes'),
 (-910006,-910001,-910005,'[6]','[]','poll-test-5',100,'pending_payment','pending_boarding','web','platform',now()-interval '2 hours',now()-interval '90 minutes');
 SELECT array_agg(id) INTO ids FROM public.fn_claim_purchase_polls(5);
 IF coalesce(array_length(ids,1),0)<>2 THEN RAISE EXCEPTION 'expected two valid claims: %',ids; END IF;
 IF EXISTS(SELECT 1 FROM public.purchase_poll_outbox WHERE booking_id IN(-910002,-910003,-910004,-910005)) THEN RAISE EXCEPTION 'manual, paid or historical cancelled claimed'; END IF;
 IF (SELECT count(*) FROM public.fn_claim_purchase_polls(5))<>0 THEN RAISE EXCEPTION 'duplicate claims'; END IF;
 UPDATE public.bus_ticket_bookings SET status='cancelled' WHERE id=-910001;
 IF (SELECT purchase_poll_expired_at FROM public.bus_ticket_bookings WHERE id=-910001) IS NULL THEN RAISE EXCEPTION 'expiry marker missing'; END IF;
 SELECT id INTO qid FROM public.purchase_poll_outbox WHERE booking_id=-910001;
 SELECT id INTO custom_qid FROM public.purchase_poll_outbox WHERE booking_id=-910006;
 IF public.fn_finalize_purchase_poll(qid,'fixture-poll-one')->>'success'<>'true' THEN RAISE EXCEPTION 'finalize failed'; END IF;
 PERFORM public.fn_finalize_purchase_poll(custom_qid,'fixture-poll-custom');
 UPDATE public.poll_settings SET option2='Changed later' WHERE id=1;
 r:=public.fn_answer_purchase_poll('fixture-poll-one','999999',1);
 IF r->>'status'<>'ignored' THEN RAISE EXCEPTION 'wrong voter accepted'; END IF;
 r:=public.fn_answer_purchase_poll('fixture-poll-one','910002',1);
 IF r->>'status'<>'saved' OR (SELECT answer FROM public.purchase_poll_answers WHERE booking_id=-910001)<>'Payment' THEN RAISE EXCEPTION 'original snapshot lost %',r; END IF;
 IF public.fn_answer_purchase_poll('fixture-poll-one','910002',0)->>'status'<>'duplicate' THEN RAISE EXCEPTION 'duplicate vote accepted'; END IF;
 IF public.fn_answer_purchase_poll('fixture-poll-custom','910005',3)->>'status'<>'custom' THEN RAISE EXCEPTION 'custom session failed'; END IF;
 IF public.fn_answer_purchase_poll_text('910005',' My reason ')->>'status'<>'saved' THEN RAISE EXCEPTION 'custom response failed'; END IF;
 IF (SELECT answer FROM public.purchase_poll_answers WHERE booking_id=-910006)<>'My reason' THEN RAISE EXCEPTION 'custom trim failed'; END IF;
 IF public.fn_answer_purchase_poll_text('910005','second answer')->>'status'<>'ignored' THEN RAISE EXCEPTION 'custom duplicated'; END IF;
 INSERT INTO public.sent_polls(poll_id,booking_id,user_id,telegram_id) VALUES('fixture-legacy',-910005,-910005,'910005');
 IF public.fn_answer_purchase_poll('fixture-legacy','910005',0)->>'status'<>'legacy' THEN RAISE EXCEPTION 'legacy guessed from current settings'; END IF;
 UPDATE public.purchase_poll_outbox SET status='processing',lease_expires_at=now()-interval '3 minutes' WHERE id=custom_qid;
 PERFORM * FROM public.fn_claim_purchase_polls(5);
 IF (SELECT status FROM public.purchase_poll_outbox WHERE id=custom_qid)<>'uncertain' THEN RAISE EXCEPTION 'expired lease retried'; END IF;
 -- New completion eligibility does not backfill historical trips.
 UPDATE public.poll_settings SET event_type='completed',question='Improve trip?' WHERE id=1;
 UPDATE public.bus_ticket_bookings SET boarding_status='boarded' WHERE id=-910004;
 UPDATE public.bus_ticket_bookings SET status='confirmed',boarding_status='boarded' WHERE id=-910002;
 UPDATE public.bus_tickets SET status='completed' WHERE id=-910001;
 IF (SELECT poll_completed_at FROM public.bus_tickets WHERE id=-910001) IS NULL THEN RAISE EXCEPTION 'completion marker missing'; END IF;
 UPDATE public.bus_tickets SET poll_completed_at=NULL WHERE id=-910001;
 IF (SELECT count(*) FROM public.fn_claim_purchase_polls(5))<>0 THEN RAISE EXCEPTION 'historical completion claimed'; END IF;
 UPDATE public.bus_tickets SET poll_completed_at=now()-interval '20 minutes' WHERE id=-910001;
 SELECT array_agg(id) INTO ids FROM public.fn_claim_purchase_polls(5);
 IF coalesce(array_length(ids,1),0)<>1 OR NOT EXISTS(SELECT 1 FROM public.purchase_poll_outbox WHERE booking_id=-910004 AND event_type='completed') THEN RAISE EXCEPTION 'completion poll eligibility failed %',ids; END IF;
 IF EXISTS(SELECT 1 FROM public.purchase_poll_outbox WHERE booking_id=-910002) THEN RAISE EXCEPTION 'manual post-trip claimed'; END IF;
 IF (SELECT count(*) FROM public.fn_claim_purchase_polls(5))<>0 THEN RAISE EXCEPTION 'completion duplicated'; END IF;
 IF (SELECT count(*) FROM public.poll_templates)<>3 OR has_table_privilege('anon','public.poll_templates','SELECT') THEN RAISE EXCEPTION 'template catalogue security'; END IF;
 IF has_table_privilege('anon','public.sent_polls','SELECT') OR has_table_privilege('authenticated','public.purchase_poll_answers','INSERT')
  OR has_function_privilege('anon','public.fn_answer_purchase_poll(text,text,integer)','EXECUTE') THEN RAISE EXCEPTION 'public poll access'; END IF;
END $test$;
ROLLBACK;
SELECT 'PASS: eligibility, manual/paid exclusion, unique claims, expiry, snapshots, recipient, custom answers, duplicate replies, legacy safety, stale leases, privileges; fixtures rolled back' AS validation,
 (SELECT count(*) FROM public.sent_polls) AS preserved_polls,(SELECT count(*) FROM public.purchase_poll_answers) AS preserved_answers,
 (SELECT count(*) FROM public.purchase_poll_outbox) AS real_outbox;
