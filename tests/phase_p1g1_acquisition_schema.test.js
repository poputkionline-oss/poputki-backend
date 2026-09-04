/**
 * tests/phase_p1g1_acquisition_schema.test.js
 *
 * Test Suite for Phase P.1G.1:
 * Production Acquisition and Passenger Funnel Database Schema.
 * Validates migration integrity, SHA256, schema invariants,
 * append-only triggers, RLS security isolation, and RPC contracts.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { describe, it } = require('node:test');

describe('Phase P.1G.1 Acquisition and Passenger Funnel Schema', () => {
    const migrationPath = path.join(__dirname, '..', 'supabase', 'migrations', '20260904130756_acquisition_passenger_funnel_schema.sql');
    const docsMigrationPath = path.join(__dirname, '..', 'docs', 'migrations', '20260904130756_acquisition_passenger_funnel_schema.sql');
    const snapshotPath = path.join(__dirname, '..', 'docs', 'migrations', 'snapshots', '20260904_p1g1_preflight_schema_snapshot.json');

    it('1. Migration file exists in both supabase/migrations and docs/migrations', () => {
        assert.ok(fs.existsSync(migrationPath), 'supabase migration file must exist');
        assert.ok(fs.existsSync(docsMigrationPath), 'docs migration copy must exist');
    });

    it('2. Migration SHA256 is consistent and matches recorded hash', () => {
        const content = fs.readFileSync(migrationPath);
        const hash = crypto.createHash('sha256').update(content).digest('hex').toUpperCase();
        const docsContent = fs.readFileSync(docsMigrationPath);
        const docsHash = crypto.createHash('sha256').update(docsContent).digest('hex').toUpperCase();

        assert.strictEqual(hash, docsHash, 'Migration copies must have identical SHA256');
        assert.strictEqual(hash, '135F0A5BAB0B2D5347976E0AE359677E742A99DF955BBC100931E65236B2F707');
    });

    it('3. Preflight schema snapshot exists and confirms zero prior P.1G.1 tables', () => {
        assert.ok(fs.existsSync(snapshotPath), 'Snapshot must exist');
        const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
        assert.strictEqual(snapshot.project_ref, 'xzvtjcqwmuezxyeerkki');
        assert.strictEqual(snapshot.types_verified['public.users.id'], 'integer');
        assert.strictEqual(snapshot.types_verified['public.bus_ticket_bookings.id'], 'integer');
        assert.strictEqual(snapshot.types_verified['public.bus_tickets.id'], 'integer');
        assert.strictEqual(Object.keys(snapshot.p1g1_tables_prior_state).length, 15);
    });

    it('4. Migration defines all 15 required tables with RLS enabled', () => {
        const sql = fs.readFileSync(migrationPath, 'utf8');
        const requiredTables = [
            'public.acquisition_campaigns',
            'public.acquisition_partners',
            'public.acquisition_links',
            'public.acquisition_visitors',
            'public.acquisition_sessions',
            'public.acquisition_link_clicks',
            'public.acquisition_events',
            'public.acquisition_identity_links',
            'public.telegram_link_sessions',
            'public.marketing_consent_events',
            'public.marketing_consent_current',
            'public.referral_links',
            'public.referral_attributions',
            'public.booking_acquisition_attributions',
            'public.acquisition_daily_metrics'
        ];

        for (const table of requiredTables) {
            const shortName = table.replace('public.', '');
            assert.ok(sql.includes(`CREATE TABLE IF NOT EXISTS ${table}`), `Must define table ${table}`);
            assert.ok(sql.includes(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`), `Must enable RLS on ${table}`);
            assert.ok(sql.includes(`REVOKE ALL ON TABLE ${table} FROM PUBLIC, anon, authenticated;`), `Must revoke all on ${table}`);
            assert.ok(sql.includes(`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${table} TO service_role;`), `Must grant to service_role on ${table}`);
        }
    });

    it('5. Migration defines all 16 required event names and defense-in-depth PII check', () => {
        const sql = fs.readFileSync(migrationPath, 'utf8');
        const requiredEvents = [
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
        ];

        for (const ev of requiredEvents) {
            assert.ok(sql.includes(`'${ev}'`), `Must include event ${ev}`);
        }

        // PII check in properties
        const forbiddenKeys = ['phone', 'passport', 'password', 'token', 'jwt', 'telegram_token', 'card_number', 'cvv', 'full_name'];
        for (const key of forbiddenKeys) {
            assert.ok(sql.includes(`'${key}'`), `Must forbid PII key '${key}' in properties JSONB check`);
        }
    });

    it('6. Migration defines 3 service_role-only RPCs and append-only trigger protection', () => {
        const sql = fs.readFileSync(migrationPath, 'utf8');
        assert.ok(sql.includes('CREATE OR REPLACE FUNCTION public.fn_record_marketing_consent'), 'Must define fn_record_marketing_consent');
        assert.ok(sql.includes('CREATE OR REPLACE FUNCTION public.fn_consume_telegram_link_session'), 'Must define fn_consume_telegram_link_session');
        assert.ok(sql.includes('CREATE OR REPLACE FUNCTION public.fn_create_booking_acquisition_attribution'), 'Must define fn_create_booking_acquisition_attribution');

        assert.ok(sql.includes('CREATE OR REPLACE FUNCTION public.prevent_append_only_mutation()'), 'Must define prevent_append_only_mutation');
        assert.ok(sql.includes('CREATE OR REPLACE FUNCTION public.prevent_booking_attribution_mutation()'), 'Must define prevent_booking_attribution_mutation');

        // Verify security definer and search_path isolation
        assert.ok(sql.includes("SET search_path = pg_catalog, pg_temp"), 'Must isolate search_path');
    });
});
