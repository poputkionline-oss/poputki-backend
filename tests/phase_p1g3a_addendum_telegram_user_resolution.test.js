/**
 * tests/phase_p1g3a_addendum_telegram_user_resolution.test.js
 *
 * PHASE P.1G.3A ADDENDUM — fix: BOT_STARTED/CONTACT_SHARED outbox events
 * failing with a real production FK violation (23503)
 *
 * Found via live verification after deploying the /start Mini App button
 * fix: a real BOT_STARTED outbox row for a genuine (unregistered) Telegram
 * user was stuck retrying with last_error_code 23503 (Postgres foreign key
 * violation). Root cause: routes/internalAcquisition.js passed the raw
 * Telegram numeric user id straight into resolveCanonicalUserId(), a
 * function meant to alias-resolve an ALREADY-internal users.id - for a
 * telegram id with no matching alias row, it falls back to returning its
 * input unchanged, so the outbox row's user_id ended up holding a Telegram
 * id that doesn't exist in `users` at all, permanently failing the FK-
 * constrained insert for every unregistered Telegram user (the common
 * case), forever, on every one of consume-telegram-session/bot-start/
 * contact-shared.
 *
 * Fixed with resolveUserIdFromTelegramId(): looks the real internal user up
 * by the actual users.telegram_id linking column first, and only feeds a
 * genuinely-internal id into resolveCanonicalUserId() - or returns null for
 * an unregistered Telegram user, which enqueueOutboxEvent already handles
 * correctly (userId: null is a normal, valid, anonymous event).
 *
 * Deterministic, offline: identityMergeHelper.js's resolveCanonicalUserId()
 * queries a module-level `require('../db')` singleton directly (not an
 * injectable client), so a fake is installed into require's module cache
 * before internalAcquisition.js (which transitively requires it) is first
 * loaded - see tests/helpers/fakeSupabaseClient.js.
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createFakeSupabaseClient, installFakeDbModule } = require('./helpers/fakeSupabaseClient');

installFakeDbModule(createFakeSupabaseClient({
    users: [{ id: 555, telegram_id: 386189312 }],
    user_identity_aliases: []
}));

const { resolveUserIdFromTelegramId } = require('../routes/internalAcquisition');
const SYSTEM_PLACEHOLDER_VISITOR_ID = '00000000-0000-0000-0000-000000000000';

describe('Phase P.1G.3A ADDENDUM — resolveUserIdFromTelegramId()', () => {
    it('resolves to the real internal users.id when a matching users.telegram_id row exists', async () => {
        const db = createFakeSupabaseClient({
            users: [{ id: 555, telegram_id: 386189312 }],
            user_identity_aliases: []
        });
        const result = await resolveUserIdFromTelegramId(386189312, db);
        assert.equal(result, 555);
    });

    it('returns null (not the raw Telegram id) for an unregistered Telegram user - the bug this fixes', async () => {
        const db = createFakeSupabaseClient({
            users: [],
            user_identity_aliases: []
        });
        const result = await resolveUserIdFromTelegramId(386189312, db);
        assert.equal(result, null, 'must never fall back to returning the raw Telegram id as if it were an internal users.id');
        assert.notEqual(result, 386189312);
    });

    it('returns null for a falsy/missing telegram id without querying', async () => {
        const db = createFakeSupabaseClient({ users: [] });
        assert.equal(await resolveUserIdFromTelegramId(null, db), null);
        assert.equal(await resolveUserIdFromTelegramId(undefined, db), null);
        assert.equal(await resolveUserIdFromTelegramId(0, db), null);
    });

    it('fails safe to null (never throws, never leaks the raw id) on a DB error', async () => {
        const db = {
            from() {
                return {
                    select() { return this; },
                    eq() { return this; },
                    async maybeSingle() { return { data: null, error: new Error('simulated DB failure') }; }
                };
            }
        };
        const result = await resolveUserIdFromTelegramId(386189312, db);
        assert.equal(result, null);
    });
});

describe('Phase P.1G.3A ADDENDUM — system placeholder visitor (second FK, same production incident)', () => {
    it('outboxService.js still substitutes the exact well-known placeholder UUID for a missing anonymous_visitor_id', () => {
        const src = fs.readFileSync(path.resolve(__dirname, '../services/acquisition/outboxService.js'), 'utf8');
        assert.ok(src.includes(`|| '${SYSTEM_PLACEHOLDER_VISITOR_ID}'`), 'the fallback literal must match the seeded placeholder row exactly');
    });

    it('a migration seeding that exact placeholder row into acquisition_visitors exists', () => {
        const files = fs.readdirSync(path.resolve(__dirname, '../supabase/migrations'));
        const match = files.find(f => f.includes('seed_system_placeholder_visitor'));
        assert.ok(match, 'seed migration file must exist');
        const sql = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations', match), 'utf8');
        assert.ok(sql.includes(SYSTEM_PLACEHOLDER_VISITOR_ID));
        assert.ok(sql.includes('acquisition_visitors'));
        assert.ok(sql.includes('ON CONFLICT'), 'must be idempotent (safe to re-run)');
        assert.ok(!/DELETE|UPDATE|TRUNCATE/i.test(sql), 'must only insert - never mutate or delete existing rows');
    });

    it('the docs/migrations mirror is byte-identical to the supabase/migrations file (repo convention)', () => {
        const supaFiles = fs.readdirSync(path.resolve(__dirname, '../supabase/migrations'));
        const docsFiles = fs.readdirSync(path.resolve(__dirname, '../docs/migrations'));
        const supaMatch = supaFiles.find(f => f.includes('seed_system_placeholder_visitor'));
        const docsMatch = docsFiles.find(f => f.includes('seed_system_placeholder_visitor'));
        assert.ok(supaMatch && docsMatch);
        const supaContent = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations', supaMatch), 'utf8');
        const docsContent = fs.readFileSync(path.resolve(__dirname, '../docs/migrations', docsMatch), 'utf8');
        assert.equal(supaContent, docsContent);
    });
});
