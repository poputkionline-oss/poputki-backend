-- =============================================================================
-- Migration: 20260904130756_acquisition_passenger_funnel_schema.sql
-- Target: POPUTKI.ONLINE Production (xzvtjcqwmuezxyeerkki)
-- Phase: P.1G.1 Production Acquisition and Passenger Funnel Database Schema
-- Description:
--   Creates 15 core acquisition & funnel tables, constraints, indexes,
--   append-only trigger protection, and 3 service_role-only RPCs.
--   Strictly adheres to zero PII in properties, normalized vocabularies,
--   and service_role isolation (RLS enabled, anon/authenticated revoked).
-- =============================================================================

SET lock_timeout = '5s';
SET statement_timeout = '120s';

-- -----------------------------------------------------------------------------
-- 1. Acquisition Campaigns
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.acquisition_campaigns (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code VARCHAR(64) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    source_platform VARCHAR(32) NOT NULL,
    source_medium VARCHAR(32) NOT NULL,
    campaign_type VARCHAR(16) NOT NULL,
    budget_amount NUMERIC(12,2) NULL,
    currency VARCHAR(3) NULL,
    starts_at TIMESTAMPTZ NULL,
    ends_at TIMESTAMPTZ NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_acq_camp_platform CHECK (
        source_platform IN ('instagram','facebook','telegram','whatsapp','tiktok','youtube','google','yandex','website','direct','offline','unknown')
    ),
    CONSTRAINT chk_acq_camp_medium CHECK (
        source_medium IN ('organic_social','paid_social','messenger','search_organic','search_paid','influencer','referral','qr','direct','offline','carrier_link','unknown')
    ),
    CONSTRAINT chk_acq_camp_dates CHECK (
        ends_at IS NULL OR starts_at IS NULL OR ends_at >= starts_at
    )
);

-- -----------------------------------------------------------------------------
-- 2. Acquisition Partners
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.acquisition_partners (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code VARCHAR(64) UNIQUE NOT NULL,
    display_name VARCHAR(255) NOT NULL,
    partner_type VARCHAR(32) NOT NULL,
    user_id INTEGER NULL REFERENCES public.users(id) ON DELETE SET NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- 3. Acquisition Links
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.acquisition_links (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    short_token_hash VARCHAR(64) UNIQUE NOT NULL,
    campaign_id UUID NULL REFERENCES public.acquisition_campaigns(id) ON DELETE SET NULL,
    partner_id UUID NULL REFERENCES public.acquisition_partners(id) ON DELETE SET NULL,
    source_platform VARCHAR(32) NOT NULL,
    source_medium VARCHAR(32) NOT NULL,
    attribution_type VARCHAR(32) NOT NULL,
    content_code VARCHAR(64) NULL,
    placement_code VARCHAR(64) NULL,
    target_path VARCHAR(255) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    expires_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_acq_link_platform CHECK (
        source_platform IN ('instagram','facebook','telegram','whatsapp','tiktok','youtube','google','yandex','website','direct','offline','unknown')
    ),
    CONSTRAINT chk_acq_link_medium CHECK (
        source_medium IN ('organic_social','paid_social','messenger','search_organic','search_paid','influencer','referral','qr','direct','offline','carrier_link','unknown')
    ),
    CONSTRAINT chk_acq_link_attr_type CHECK (
        attribution_type IN ('marketing','passenger_referral','carrier_handoff','partner_affiliate','direct_organic','unknown')
    ),
    CONSTRAINT chk_acq_link_target_path CHECK (
        target_path LIKE '/%' AND
        target_path NOT LIKE '%//%' AND
        target_path NOT LIKE '%\\%' AND
        target_path NOT LIKE '%..%' AND
        target_path NOT LIKE '%:%'
    ),
    CONSTRAINT chk_acq_link_expires CHECK (
        expires_at IS NULL OR expires_at > created_at
    )
);

-- -----------------------------------------------------------------------------
-- 4. Acquisition Visitors
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.acquisition_visitors (
    anonymous_visitor_id UUID PRIMARY KEY,
    current_user_id INTEGER NULL REFERENCES public.users(id) ON DELETE SET NULL,
    initial_platform VARCHAR(32) NOT NULL,
    initial_medium VARCHAR(32) NOT NULL,
    initial_attribution_type VARCHAR(32) NOT NULL,
    initial_campaign_id UUID NULL REFERENCES public.acquisition_campaigns(id) ON DELETE SET NULL,
    initial_partner_id UUID NULL REFERENCES public.acquisition_partners(id) ON DELETE SET NULL,
    first_non_direct_platform VARCHAR(32) NULL,
    first_non_direct_medium VARCHAR(32) NULL,
    first_non_direct_campaign_id UUID NULL REFERENCES public.acquisition_campaigns(id) ON DELETE SET NULL,
    first_non_direct_partner_id UUID NULL REFERENCES public.acquisition_partners(id) ON DELETE SET NULL,
    last_non_direct_platform VARCHAR(32) NULL,
    last_non_direct_medium VARCHAR(32) NULL,
    last_non_direct_campaign_id UUID NULL REFERENCES public.acquisition_campaigns(id) ON DELETE SET NULL,
    last_non_direct_partner_id UUID NULL REFERENCES public.acquisition_partners(id) ON DELETE SET NULL,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    identified_at TIMESTAMPTZ NULL,
    CONSTRAINT chk_acq_vis_init_platform CHECK (
        initial_platform IN ('instagram','facebook','telegram','whatsapp','tiktok','youtube','google','yandex','website','direct','offline','unknown')
    ),
    CONSTRAINT chk_acq_vis_init_medium CHECK (
        initial_medium IN ('organic_social','paid_social','messenger','search_organic','search_paid','influencer','referral','qr','direct','offline','carrier_link','unknown')
    ),
    CONSTRAINT chk_acq_vis_init_attr_type CHECK (
        initial_attribution_type IN ('marketing','passenger_referral','carrier_handoff','partner_affiliate','direct_organic','unknown')
    ),
    CONSTRAINT chk_acq_vis_fnd_platform CHECK (
        first_non_direct_platform IS NULL OR first_non_direct_platform IN ('instagram','facebook','telegram','whatsapp','tiktok','youtube','google','yandex','website','direct','offline','unknown')
    ),
    CONSTRAINT chk_acq_vis_fnd_medium CHECK (
        first_non_direct_medium IS NULL OR first_non_direct_medium IN ('organic_social','paid_social','messenger','search_organic','search_paid','influencer','referral','qr','direct','offline','carrier_link','unknown')
    ),
    CONSTRAINT chk_acq_vis_lnd_platform CHECK (
        last_non_direct_platform IS NULL OR last_non_direct_platform IN ('instagram','facebook','telegram','whatsapp','tiktok','youtube','google','yandex','website','direct','offline','unknown')
    ),
    CONSTRAINT chk_acq_vis_lnd_medium CHECK (
        last_non_direct_medium IS NULL OR last_non_direct_medium IN ('organic_social','paid_social','messenger','search_organic','search_paid','influencer','referral','qr','direct','offline','carrier_link','unknown')
    ),
    CONSTRAINT chk_acq_vis_seen_dates CHECK (
        last_seen_at >= first_seen_at
    ),
    CONSTRAINT chk_acq_vis_ident_date CHECK (
        identified_at IS NULL OR identified_at >= first_seen_at
    )
);

-- -----------------------------------------------------------------------------
-- 5. Acquisition Sessions
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.acquisition_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    anonymous_visitor_id UUID NOT NULL REFERENCES public.acquisition_visitors(anonymous_visitor_id) ON DELETE RESTRICT,
    user_id INTEGER NULL REFERENCES public.users(id) ON DELETE SET NULL,
    source_platform VARCHAR(32) NOT NULL,
    source_medium VARCHAR(32) NOT NULL,
    attribution_type VARCHAR(32) NOT NULL,
    campaign_id UUID NULL REFERENCES public.acquisition_campaigns(id) ON DELETE SET NULL,
    partner_id UUID NULL REFERENCES public.acquisition_partners(id) ON DELETE SET NULL,
    acquisition_link_id UUID NULL REFERENCES public.acquisition_links(id) ON DELETE SET NULL,
    content_code VARCHAR(64) NULL,
    placement_code VARCHAR(64) NULL,
    landing_path VARCHAR(255) NULL,
    referrer_host VARCHAR(128) NULL,
    is_direct BOOLEAN NOT NULL DEFAULT false,
    attribution_confidence VARCHAR(24) NOT NULL,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at TIMESTAMPTZ NULL,
    CONSTRAINT chk_acq_sess_platform CHECK (
        source_platform IN ('instagram','facebook','telegram','whatsapp','tiktok','youtube','google','yandex','website','direct','offline','unknown')
    ),
    CONSTRAINT chk_acq_sess_medium CHECK (
        source_medium IN ('organic_social','paid_social','messenger','search_organic','search_paid','influencer','referral','qr','direct','offline','carrier_link','unknown')
    ),
    CONSTRAINT chk_acq_sess_attr_type CHECK (
        attribution_type IN ('marketing','passenger_referral','carrier_handoff','partner_affiliate','direct_organic','unknown')
    ),
    CONSTRAINT chk_acq_sess_attr_conf CHECK (
        attribution_confidence IN ('verified_link','verified_referral','verified_partner','verified_referrer','unverified_utm','fallback','direct')
    ),
    CONSTRAINT chk_acq_sess_activity_date CHECK (
        last_activity_at >= started_at
    ),
    CONSTRAINT chk_acq_sess_ended_date CHECK (
        ended_at IS NULL OR ended_at >= started_at
    )
);

-- -----------------------------------------------------------------------------
-- 6. Acquisition Link Clicks
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.acquisition_link_clicks (
    id BIGSERIAL PRIMARY KEY,
    link_id UUID NOT NULL REFERENCES public.acquisition_links(id) ON DELETE RESTRICT,
    anonymous_visitor_id UUID NULL REFERENCES public.acquisition_visitors(anonymous_visitor_id) ON DELETE SET NULL,
    session_id UUID NULL REFERENCES public.acquisition_sessions(id) ON DELETE SET NULL,
    is_bot_suspected BOOLEAN NOT NULL DEFAULT false,
    clicked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- 7. Acquisition Events
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.acquisition_events (
    id BIGSERIAL PRIMARY KEY,
    event_name VARCHAR(40) NOT NULL,
    anonymous_visitor_id UUID NOT NULL REFERENCES public.acquisition_visitors(anonymous_visitor_id) ON DELETE RESTRICT,
    session_id UUID NULL REFERENCES public.acquisition_sessions(id) ON DELETE SET NULL,
    user_id INTEGER NULL REFERENCES public.users(id) ON DELETE SET NULL,
    booking_id INTEGER NULL REFERENCES public.bus_ticket_bookings(id) ON DELETE SET NULL,
    bus_ticket_id INTEGER NULL REFERENCES public.bus_tickets(id) ON DELETE SET NULL,
    campaign_id UUID NULL REFERENCES public.acquisition_campaigns(id) ON DELETE SET NULL,
    partner_id UUID NULL REFERENCES public.acquisition_partners(id) ON DELETE SET NULL,
    event_source VARCHAR(16) NOT NULL,
    idempotency_key VARCHAR(128) NOT NULL UNIQUE,
    properties JSONB NOT NULL DEFAULT '{}'::jsonb,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_acq_ev_name CHECK (
        event_name IN (
            'LANDING_VIEWED',
            'ROUTE_SEARCHED',
            'TRIP_VIEWED',
            'BOOKING_STARTED',
            'TELEGRAM_OPENED',
            'BOT_STARTED',
            'CONTACT_SHARED',
            'USER_IDENTIFIED',
            'MARKETING_CONSENT_GRANTED',
            'MARKETING_CONSENT_REVOKED',
            'BOOKING_CREATED',
            'PAYMENT_COMPLETED',
            'TRIP_COMPLETED',
            'REPEAT_BOOKING',
            'SHARE_CLICKED',
            'REFERRAL_OPENED'
        )
    ),
    CONSTRAINT chk_acq_ev_source CHECK (
        event_source IN ('client','backend','bot','payment_webhook','system')
    ),
    CONSTRAINT chk_acq_ev_no_pii CHECK (
        NOT (properties ?| ARRAY[
            'phone',
            'passport',
            'password',
            'token',
            'jwt',
            'telegram_token',
            'card_number',
            'cvv',
            'full_name'
        ])
    )
);

-- -----------------------------------------------------------------------------
-- 8. Acquisition Identity Links
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.acquisition_identity_links (
    id BIGSERIAL PRIMARY KEY,
    anonymous_visitor_id UUID NOT NULL REFERENCES public.acquisition_visitors(anonymous_visitor_id) ON DELETE RESTRICT,
    user_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    link_method VARCHAR(32) NOT NULL,
    session_id UUID NULL REFERENCES public.acquisition_sessions(id) ON DELETE SET NULL,
    linked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_acq_ident_link UNIQUE (anonymous_visitor_id, user_id)
);

-- -----------------------------------------------------------------------------
-- 9. Telegram Link Sessions
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.telegram_link_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    token_hash VARCHAR(64) UNIQUE NOT NULL,
    anonymous_visitor_id UUID NOT NULL REFERENCES public.acquisition_visitors(anonymous_visitor_id) ON DELETE RESTRICT,
    acquisition_session_id UUID NULL REFERENCES public.acquisition_sessions(id) ON DELETE SET NULL,
    acquisition_link_id UUID NULL REFERENCES public.acquisition_links(id) ON DELETE SET NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ NULL,
    telegram_chat_id BIGINT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_tg_sess_expires CHECK (expires_at > created_at),
    CONSTRAINT chk_tg_sess_consumed CHECK (consumed_at IS NULL OR consumed_at >= created_at)
);

-- -----------------------------------------------------------------------------
-- 10. Marketing Consent Events
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.marketing_consent_events (
    id BIGSERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    channel VARCHAR(16) NOT NULL,
    purpose VARCHAR(32) NOT NULL,
    action VARCHAR(16) NOT NULL,
    policy_version VARCHAR(32) NOT NULL,
    consent_source VARCHAR(32) NOT NULL,
    idempotency_key VARCHAR(128) UNIQUE NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_mktg_ev_action CHECK (action IN ('granted','revoked')),
    CONSTRAINT chk_mktg_ev_channel CHECK (channel IN ('sms','telegram','whatsapp','email','push'))
);

-- -----------------------------------------------------------------------------
-- 11. Marketing Consent Current
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.marketing_consent_current (
    user_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    channel VARCHAR(16) NOT NULL,
    purpose VARCHAR(32) NOT NULL,
    status VARCHAR(16) NOT NULL,
    source_event_id BIGINT NOT NULL REFERENCES public.marketing_consent_events(id) ON DELETE RESTRICT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, channel, purpose),
    CONSTRAINT chk_mktg_curr_status CHECK (status IN ('granted','revoked')),
    CONSTRAINT chk_mktg_curr_channel CHECK (channel IN ('sms','telegram','whatsapp','email','push'))
);

-- -----------------------------------------------------------------------------
-- 12. Referral Links
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.referral_links (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    short_code_hash VARCHAR(64) UNIQUE NOT NULL,
    owner_user_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    is_active BOOLEAN NOT NULL DEFAULT true,
    expires_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at TIMESTAMPTZ NULL,
    CONSTRAINT chk_ref_link_expires CHECK (expires_at IS NULL OR expires_at > created_at),
    CONSTRAINT chk_ref_link_revoked CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

-- -----------------------------------------------------------------------------
-- 13. Referral Attributions
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.referral_attributions (
    id BIGSERIAL PRIMARY KEY,
    invitee_user_id INTEGER UNIQUE NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    referrer_user_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    referral_link_id UUID NOT NULL REFERENCES public.referral_links(id) ON DELETE RESTRICT,
    acquisition_session_id UUID NULL REFERENCES public.acquisition_sessions(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_ref_attr_not_self CHECK (invitee_user_id <> referrer_user_id)
);

-- -----------------------------------------------------------------------------
-- 14. Booking Acquisition Attributions
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.booking_acquisition_attributions (
    booking_id INTEGER PRIMARY KEY REFERENCES public.bus_ticket_bookings(id) ON DELETE CASCADE,
    anonymous_visitor_id UUID NULL REFERENCES public.acquisition_visitors(anonymous_visitor_id) ON DELETE SET NULL,
    acquisition_session_id UUID NULL REFERENCES public.acquisition_sessions(id) ON DELETE SET NULL,
    acquisition_link_id UUID NULL REFERENCES public.acquisition_links(id) ON DELETE SET NULL,
    campaign_id UUID NULL REFERENCES public.acquisition_campaigns(id) ON DELETE SET NULL,
    partner_id UUID NULL REFERENCES public.acquisition_partners(id) ON DELETE SET NULL,
    referral_attribution_id BIGINT NULL REFERENCES public.referral_attributions(id) ON DELETE SET NULL,
    source_platform VARCHAR(32) NOT NULL,
    source_medium VARCHAR(32) NOT NULL,
    attribution_type VARCHAR(32) NOT NULL,
    attribution_confidence VARCHAR(24) NOT NULL,
    content_code VARCHAR(64) NULL,
    placement_code VARCHAR(64) NULL,
    initial_platform VARCHAR(32) NOT NULL,
    first_non_direct_platform VARCHAR(32) NULL,
    last_non_direct_platform VARCHAR(32) NULL,
    converting_platform VARCHAR(32) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_bk_attr_platform CHECK (
        source_platform IN ('instagram','facebook','telegram','whatsapp','tiktok','youtube','google','yandex','website','direct','offline','unknown')
    ),
    CONSTRAINT chk_bk_attr_medium CHECK (
        source_medium IN ('organic_social','paid_social','messenger','search_organic','search_paid','influencer','referral','qr','direct','offline','carrier_link','unknown')
    ),
    CONSTRAINT chk_bk_attr_type CHECK (
        attribution_type IN ('marketing','passenger_referral','carrier_handoff','partner_affiliate','direct_organic','unknown')
    ),
    CONSTRAINT chk_bk_attr_conf CHECK (
        attribution_confidence IN ('verified_link','verified_referral','verified_partner','verified_referrer','unverified_utm','fallback','direct')
    ),
    CONSTRAINT chk_bk_attr_init_platform CHECK (
        initial_platform IN ('instagram','facebook','telegram','whatsapp','tiktok','youtube','google','yandex','website','direct','offline','unknown')
    ),
    CONSTRAINT chk_bk_attr_conv_platform CHECK (
        converting_platform IN ('instagram','facebook','telegram','whatsapp','tiktok','youtube','google','yandex','website','direct','offline','unknown')
    ),
    CONSTRAINT chk_bk_attr_fnd_platform CHECK (
        first_non_direct_platform IS NULL OR first_non_direct_platform IN ('instagram','facebook','telegram','whatsapp','tiktok','youtube','google','yandex','website','direct','offline','unknown')
    ),
    CONSTRAINT chk_bk_attr_lnd_platform CHECK (
        last_non_direct_platform IS NULL OR last_non_direct_platform IN ('instagram','facebook','telegram','whatsapp','tiktok','youtube','google','yandex','website','direct','offline','unknown')
    )
);

-- -----------------------------------------------------------------------------
-- 15. Acquisition Daily Metrics
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.acquisition_daily_metrics (
    id BIGSERIAL PRIMARY KEY,
    metric_date DATE NOT NULL,
    source_platform VARCHAR(32) NOT NULL,
    source_medium VARCHAR(32) NOT NULL,
    attribution_type VARCHAR(32) NOT NULL,
    campaign_id UUID NULL REFERENCES public.acquisition_campaigns(id) ON DELETE SET NULL,
    partner_id UUID NULL REFERENCES public.acquisition_partners(id) ON DELETE SET NULL,
    content_code VARCHAR(64) NULL,
    placement_code VARCHAR(64) NULL,
    visitors_count INTEGER NOT NULL DEFAULT 0,
    sessions_count INTEGER NOT NULL DEFAULT 0,
    bot_starts_count INTEGER NOT NULL DEFAULT 0,
    contacts_shared_count INTEGER NOT NULL DEFAULT 0,
    users_identified_count INTEGER NOT NULL DEFAULT 0,
    bookings_count INTEGER NOT NULL DEFAULT 0,
    paid_bookings_count INTEGER NOT NULL DEFAULT 0,
    completed_trips_count INTEGER NOT NULL DEFAULT 0,
    referral_opens_count INTEGER NOT NULL DEFAULT 0,
    total_revenue_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_adm_platform CHECK (
        source_platform IN ('instagram','facebook','telegram','whatsapp','tiktok','youtube','google','yandex','website','direct','offline','unknown')
    ),
    CONSTRAINT chk_adm_medium CHECK (
        source_medium IN ('organic_social','paid_social','messenger','search_organic','search_paid','influencer','referral','qr','direct','offline','carrier_link','unknown')
    ),
    CONSTRAINT chk_adm_attr_type CHECK (
        attribution_type IN ('marketing','passenger_referral','carrier_handoff','partner_affiliate','direct_organic','unknown')
    )
);

-- Unique expression index on normalized dimensions
CREATE UNIQUE INDEX IF NOT EXISTS idx_acquisition_daily_metrics_dimensions ON public.acquisition_daily_metrics (
    metric_date,
    source_platform,
    source_medium,
    attribution_type,
    COALESCE(campaign_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(partner_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(content_code, ''),
    COALESCE(placement_code, '')
);

-- -----------------------------------------------------------------------------
-- Indexes Strategy
-- -----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_acquisition_events_name_occurred ON public.acquisition_events (event_name, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_acquisition_events_session_occurred ON public.acquisition_events (session_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_acquisition_events_user_occurred ON public.acquisition_events (user_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_acquisition_events_booking_id ON public.acquisition_events (booking_id);

CREATE INDEX IF NOT EXISTS idx_acquisition_sessions_visitor_started ON public.acquisition_sessions (anonymous_visitor_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_acquisition_sessions_user_started ON public.acquisition_sessions (user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_acquisition_sessions_campaign_started ON public.acquisition_sessions (campaign_id, started_at);

CREATE INDEX IF NOT EXISTS idx_acquisition_link_clicks_link_clicked ON public.acquisition_link_clicks (link_id, clicked_at DESC);
CREATE INDEX IF NOT EXISTS idx_acquisition_identity_links_user_id ON public.acquisition_identity_links (user_id);

CREATE INDEX IF NOT EXISTS idx_marketing_consent_events_lookup ON public.marketing_consent_events (user_id, channel, purpose, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_referral_links_owner ON public.referral_links (owner_user_id);
CREATE INDEX IF NOT EXISTS idx_referral_attributions_referrer ON public.referral_attributions (referrer_user_id);

CREATE INDEX IF NOT EXISTS idx_booking_acq_attr_campaign ON public.booking_acquisition_attributions (campaign_id, created_at);
CREATE INDEX IF NOT EXISTS idx_booking_acq_attr_partner ON public.booking_acquisition_attributions (partner_id, created_at);
CREATE INDEX IF NOT EXISTS idx_acquisition_daily_metrics_date_platform ON public.acquisition_daily_metrics (metric_date, source_platform);

-- -----------------------------------------------------------------------------
-- Append-Only Protection Triggers
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.prevent_append_only_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    RAISE EXCEPTION 'Table % is append-only: % operation is strictly forbidden', TG_TABLE_NAME, TG_OP
        USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS trg_append_only_acquisition_events ON public.acquisition_events;
CREATE TRIGGER trg_append_only_acquisition_events
    BEFORE UPDATE OR DELETE ON public.acquisition_events
    FOR EACH ROW EXECUTE FUNCTION public.prevent_append_only_mutation();

DROP TRIGGER IF EXISTS trg_append_only_acquisition_identity_links ON public.acquisition_identity_links;
CREATE TRIGGER trg_append_only_acquisition_identity_links
    BEFORE UPDATE OR DELETE ON public.acquisition_identity_links
    FOR EACH ROW EXECUTE FUNCTION public.prevent_append_only_mutation();

DROP TRIGGER IF EXISTS trg_append_only_marketing_consent_events ON public.marketing_consent_events;
CREATE TRIGGER trg_append_only_marketing_consent_events
    BEFORE UPDATE OR DELETE ON public.marketing_consent_events
    FOR EACH ROW EXECUTE FUNCTION public.prevent_append_only_mutation();

DROP TRIGGER IF EXISTS trg_append_only_referral_attributions ON public.referral_attributions;
CREATE TRIGGER trg_append_only_referral_attributions
    BEFORE UPDATE OR DELETE ON public.referral_attributions
    FOR EACH ROW EXECUTE FUNCTION public.prevent_append_only_mutation();

-- Booking attribution trigger: prevents UPDATE and direct DELETE, while permitting parent CASCADE
CREATE OR REPLACE FUNCTION public.prevent_booking_attribution_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'Table booking_acquisition_attributions is immutable: UPDATE is strictly forbidden'
            USING ERRCODE = '55000';
    ELSIF TG_OP = 'DELETE' THEN
        IF EXISTS (SELECT 1 FROM public.bus_ticket_bookings WHERE id = OLD.booking_id) THEN
            RAISE EXCEPTION 'Table booking_acquisition_attributions is immutable: direct DELETE is strictly forbidden'
                USING ERRCODE = '55000';
        END IF;
        RETURN OLD;
    END IF;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_immutable_booking_acquisition_attributions ON public.booking_acquisition_attributions;
CREATE TRIGGER trg_immutable_booking_acquisition_attributions
    BEFORE UPDATE OR DELETE ON public.booking_acquisition_attributions
    FOR EACH ROW EXECUTE FUNCTION public.prevent_booking_attribution_mutation();

-- -----------------------------------------------------------------------------
-- RPC Functions (SECURITY DEFINER, isolated search_path, service_role only)
-- -----------------------------------------------------------------------------

-- A. fn_record_marketing_consent
CREATE OR REPLACE FUNCTION public.fn_record_marketing_consent(
    p_user_id INTEGER,
    p_channel VARCHAR,
    p_purpose VARCHAR,
    p_action VARCHAR,
    p_policy_version VARCHAR,
    p_consent_source VARCHAR,
    p_idempotency_key VARCHAR,
    p_occurred_at TIMESTAMPTZ DEFAULT now()
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v_event_id BIGINT;
    v_existing_event RECORD;
BEGIN
    IF p_user_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'USER_ID_REQUIRED');
    END IF;

    IF p_channel NOT IN ('sms','telegram','whatsapp','email','push') THEN
        RETURN jsonb_build_object('success', false, 'error', 'INVALID_CHANNEL');
    END IF;

    IF p_action NOT IN ('granted','revoked') THEN
        RETURN jsonb_build_object('success', false, 'error', 'INVALID_ACTION');
    END IF;

    IF p_idempotency_key IS NULL OR length(trim(p_idempotency_key)) = 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'IDEMPOTENCY_KEY_REQUIRED');
    END IF;

    -- Idempotency check on event
    SELECT id, action INTO v_existing_event
    FROM public.marketing_consent_events
    WHERE idempotency_key = p_idempotency_key;

    IF FOUND THEN
        RETURN jsonb_build_object(
            'success', true,
            'idempotent', true,
            'event_id', v_existing_event.id,
            'action', v_existing_event.action
        );
    END IF;

    -- Verify user exists
    IF NOT EXISTS (SELECT 1 FROM public.users WHERE id = p_user_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'USER_NOT_FOUND');
    END IF;

    -- Insert append-only event
    INSERT INTO public.marketing_consent_events (
        user_id,
        channel,
        purpose,
        action,
        policy_version,
        consent_source,
        idempotency_key,
        occurred_at
    ) VALUES (
        p_user_id,
        p_channel,
        p_purpose,
        p_action,
        p_policy_version,
        p_consent_source,
        p_idempotency_key,
        COALESCE(p_occurred_at, now())
    ) RETURNING id INTO v_event_id;

    -- Upsert current state
    INSERT INTO public.marketing_consent_current (
        user_id,
        channel,
        purpose,
        status,
        source_event_id,
        updated_at
    ) VALUES (
        p_user_id,
        p_channel,
        p_purpose,
        p_action,
        v_event_id,
        COALESCE(p_occurred_at, now())
    )
    ON CONFLICT (user_id, channel, purpose)
    DO UPDATE SET
        status = EXCLUDED.status,
        source_event_id = EXCLUDED.source_event_id,
        updated_at = EXCLUDED.updated_at;

    RETURN jsonb_build_object(
        'success', true,
        'idempotent', false,
        'event_id', v_event_id,
        'action', p_action
    );
END;
$$;

-- B. fn_consume_telegram_link_session
CREATE OR REPLACE FUNCTION public.fn_consume_telegram_link_session(
    p_token_hash VARCHAR,
    p_telegram_chat_id BIGINT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v_session RECORD;
BEGIN
    IF p_token_hash IS NULL OR length(trim(p_token_hash)) = 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'TOKEN_HASH_REQUIRED');
    END IF;

    SELECT id, anonymous_visitor_id, acquisition_session_id, acquisition_link_id, expires_at, consumed_at, telegram_chat_id
    INTO v_session
    FROM public.telegram_link_sessions
    WHERE token_hash = p_token_hash
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'SESSION_NOT_FOUND');
    END IF;

    IF v_session.consumed_at IS NOT NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'ALREADY_CONSUMED');
    END IF;

    IF v_session.expires_at <= now() THEN
        RETURN jsonb_build_object('success', false, 'error', 'SESSION_EXPIRED');
    END IF;

    UPDATE public.telegram_link_sessions
    SET consumed_at = now(),
        telegram_chat_id = COALESCE(p_telegram_chat_id, v_session.telegram_chat_id)
    WHERE id = v_session.id;

    RETURN jsonb_build_object(
        'success', true,
        'session_id', v_session.id,
        'anonymous_visitor_id', v_session.anonymous_visitor_id,
        'acquisition_session_id', v_session.acquisition_session_id,
        'acquisition_link_id', v_session.acquisition_link_id
    );
END;
$$;

-- C. fn_create_booking_acquisition_attribution
CREATE OR REPLACE FUNCTION public.fn_create_booking_acquisition_attribution(
    p_booking_id INTEGER,
    p_anonymous_visitor_id UUID DEFAULT NULL,
    p_acquisition_session_id UUID DEFAULT NULL,
    p_acquisition_link_id UUID DEFAULT NULL,
    p_campaign_id UUID DEFAULT NULL,
    p_partner_id UUID DEFAULT NULL,
    p_referral_attribution_id BIGINT DEFAULT NULL,
    p_source_platform VARCHAR DEFAULT 'unknown',
    p_source_medium VARCHAR DEFAULT 'unknown',
    p_attribution_type VARCHAR DEFAULT 'unknown',
    p_attribution_confidence VARCHAR DEFAULT 'fallback',
    p_content_code VARCHAR DEFAULT NULL,
    p_placement_code VARCHAR DEFAULT NULL,
    p_initial_platform VARCHAR DEFAULT 'unknown',
    p_first_non_direct_platform VARCHAR DEFAULT NULL,
    p_last_non_direct_platform VARCHAR DEFAULT NULL,
    p_converting_platform VARCHAR DEFAULT 'unknown'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v_existing RECORD;
BEGIN
    IF p_booking_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'BOOKING_ID_REQUIRED');
    END IF;

    -- Check if attribution already exists for this booking
    SELECT * INTO v_existing
    FROM public.booking_acquisition_attributions
    WHERE booking_id = p_booking_id;

    IF FOUND THEN
        -- Verify complete match for idempotency
        IF (v_existing.anonymous_visitor_id IS NOT DISTINCT FROM p_anonymous_visitor_id AND
            v_existing.acquisition_session_id IS NOT DISTINCT FROM p_acquisition_session_id AND
            v_existing.acquisition_link_id IS NOT DISTINCT FROM p_acquisition_link_id AND
            v_existing.campaign_id IS NOT DISTINCT FROM p_campaign_id AND
            v_existing.partner_id IS NOT DISTINCT FROM p_partner_id AND
            v_existing.referral_attribution_id IS NOT DISTINCT FROM p_referral_attribution_id AND
            v_existing.source_platform = p_source_platform AND
            v_existing.source_medium = p_source_medium AND
            v_existing.attribution_type = p_attribution_type AND
            v_existing.attribution_confidence = p_attribution_confidence AND
            v_existing.content_code IS NOT DISTINCT FROM p_content_code AND
            v_existing.placement_code IS NOT DISTINCT FROM p_placement_code AND
            v_existing.initial_platform = p_initial_platform AND
            v_existing.first_non_direct_platform IS NOT DISTINCT FROM p_first_non_direct_platform AND
            v_existing.last_non_direct_platform IS NOT DISTINCT FROM p_last_non_direct_platform AND
            v_existing.converting_platform = p_converting_platform) THEN
            RETURN jsonb_build_object('success', true, 'idempotent', true, 'booking_id', p_booking_id);
        ELSE
            RETURN jsonb_build_object('success', false, 'error', 'ATTRIBUTION_CONFLICT', 'booking_id', p_booking_id);
        END IF;
    END IF;

    -- Verify booking exists in bus_ticket_bookings
    IF NOT EXISTS (SELECT 1 FROM public.bus_ticket_bookings WHERE id = p_booking_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'BOOKING_NOT_FOUND', 'booking_id', p_booking_id);
    END IF;

    INSERT INTO public.booking_acquisition_attributions (
        booking_id,
        anonymous_visitor_id,
        acquisition_session_id,
        acquisition_link_id,
        campaign_id,
        partner_id,
        referral_attribution_id,
        source_platform,
        source_medium,
        attribution_type,
        attribution_confidence,
        content_code,
        placement_code,
        initial_platform,
        first_non_direct_platform,
        last_non_direct_platform,
        converting_platform,
        created_at
    ) VALUES (
        p_booking_id,
        p_anonymous_visitor_id,
        p_acquisition_session_id,
        p_acquisition_link_id,
        p_campaign_id,
        p_partner_id,
        p_referral_attribution_id,
        p_source_platform,
        p_source_medium,
        p_attribution_type,
        p_attribution_confidence,
        p_content_code,
        p_placement_code,
        p_initial_platform,
        p_first_non_direct_platform,
        p_last_non_direct_platform,
        p_converting_platform,
        now()
    );

    RETURN jsonb_build_object('success', true, 'idempotent', false, 'booking_id', p_booking_id);
END;
$$;

-- -----------------------------------------------------------------------------
-- Row Level Security (RLS) and Grants Isolation
-- -----------------------------------------------------------------------------
ALTER TABLE public.acquisition_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.acquisition_partners ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.acquisition_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.acquisition_link_clicks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.acquisition_visitors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.acquisition_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.acquisition_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.acquisition_identity_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.telegram_link_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketing_consent_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketing_consent_current ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.referral_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.referral_attributions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.booking_acquisition_attributions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.acquisition_daily_metrics ENABLE ROW LEVEL SECURITY;

-- Revoke ALL from public, anon, authenticated on all 15 tables
REVOKE ALL ON TABLE public.acquisition_campaigns FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.acquisition_partners FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.acquisition_links FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.acquisition_link_clicks FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.acquisition_visitors FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.acquisition_sessions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.acquisition_events FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.acquisition_identity_links FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.telegram_link_sessions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.marketing_consent_events FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.marketing_consent_current FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.referral_links FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.referral_attributions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.booking_acquisition_attributions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.acquisition_daily_metrics FROM PUBLIC, anon, authenticated;

-- Grant access strictly to service_role
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.acquisition_campaigns TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.acquisition_partners TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.acquisition_links TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.acquisition_link_clicks TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.acquisition_visitors TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.acquisition_sessions TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.acquisition_events TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.acquisition_identity_links TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.telegram_link_sessions TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.marketing_consent_events TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.marketing_consent_current TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.referral_links TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.referral_attributions TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.booking_acquisition_attributions TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.acquisition_daily_metrics TO service_role;

-- Sequences privileges
REVOKE ALL ON SEQUENCE public.acquisition_link_clicks_id_seq FROM PUBLIC, anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.acquisition_link_clicks_id_seq TO service_role;

REVOKE ALL ON SEQUENCE public.acquisition_events_id_seq FROM PUBLIC, anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.acquisition_events_id_seq TO service_role;

REVOKE ALL ON SEQUENCE public.acquisition_identity_links_id_seq FROM PUBLIC, anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.acquisition_identity_links_id_seq TO service_role;

REVOKE ALL ON SEQUENCE public.marketing_consent_events_id_seq FROM PUBLIC, anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.marketing_consent_events_id_seq TO service_role;

REVOKE ALL ON SEQUENCE public.referral_attributions_id_seq FROM PUBLIC, anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.referral_attributions_id_seq TO service_role;

REVOKE ALL ON SEQUENCE public.acquisition_daily_metrics_id_seq FROM PUBLIC, anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.acquisition_daily_metrics_id_seq TO service_role;

-- RPC Execution Privileges (service_role only)
REVOKE EXECUTE ON FUNCTION public.prevent_append_only_mutation() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.prevent_booking_attribution_mutation() FROM PUBLIC, anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.fn_record_marketing_consent(INTEGER, VARCHAR, VARCHAR, VARCHAR, VARCHAR, VARCHAR, VARCHAR, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_record_marketing_consent(INTEGER, VARCHAR, VARCHAR, VARCHAR, VARCHAR, VARCHAR, VARCHAR, TIMESTAMPTZ) TO service_role;

REVOKE EXECUTE ON FUNCTION public.fn_consume_telegram_link_session(VARCHAR, BIGINT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_consume_telegram_link_session(VARCHAR, BIGINT) TO service_role;

REVOKE EXECUTE ON FUNCTION public.fn_create_booking_acquisition_attribution(INTEGER, UUID, UUID, UUID, UUID, UUID, BIGINT, VARCHAR, VARCHAR, VARCHAR, VARCHAR, VARCHAR, VARCHAR, VARCHAR, VARCHAR, VARCHAR, VARCHAR) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_create_booking_acquisition_attribution(INTEGER, UUID, UUID, UUID, UUID, UUID, BIGINT, VARCHAR, VARCHAR, VARCHAR, VARCHAR, VARCHAR, VARCHAR, VARCHAR, VARCHAR, VARCHAR, VARCHAR) TO service_role;
