/**
 * tests/helpers/fakeSupabaseClient.js
 *
 * Deterministic, in-memory fake of the small slice of the Supabase
 * JS client's query-builder chain that utils/carrierAuth.js (and a few
 * test files that seed data the same way carrierAuth itself queries) use:
 * .from(table).select(...).eq(col, val).limit(n).single()/.maybeSingle().
 *
 * Why this exists: tests/jwt_fail_closed.test.js, login_flow_compatibility,
 * security_hotfix_integration.test.js and phase_p1f_admin_funnel.test.js all
 * exercise the REAL carrierAuth middleware, which does a mandatory real-time
 * DB lookup against the `users` table as part of its fail-closed design (a
 * deliberate security property — see carrierAuth.js's own doc comment).
 * Without a reachable database, that lookup fails and carrierAuth correctly
 * fail-closes with 401 for every request, which made these tests
 * non-deterministic here (dependent on whatever SUPABASE_URL happens to be
 * reachable) without proving or disproving anything about carrierAuth's own
 * logic. This fake makes the DB layer itself deterministic and offline,
 * WITHOUT touching a single line of utils/carrierAuth.js or weakening any of
 * its fail-closed checks — carrierAuth still does exactly the same DB call,
 * gets back a real (fake, but real-shaped) row or a real "not found", and
 * decides exactly as it does in production. This is standard CommonJS
 * require-cache injection, not a change to application code.
 */

'use strict';

function matchesFilters(row, filters) {
    return filters.every(([col, val, op]) => {
        if (op === 'gte') return row[col] >= val;
        if (op === 'lte') return row[col] <= val;
        if (op === 'gt') return row[col] > val;
        if (op === 'neq') return String(row[col]) !== String(val);
        if (op === 'in') return Array.isArray(val) && val.some(v => String(v) === String(row[col]));
        return String(row[col]) === String(val);
    });
}

function createFakeSupabaseClient(tables = {}) {
    let autoId = 1000000; // far above any seeded fixture id, to avoid collisions
    return {
        // Minimal, narrowly-scoped RPC support — only for the specific
        // production RPCs this fake's test callers actually need (currently
        // just fn_create_booking_handoff, used by utils/journeyHelper.js's
        // real, non-mock createBookingHandoff() path). Anything else throws
        // clearly rather than silently no-opping, so a test relying on an
        // unsupported RPC fails loudly instead of getting a false pass.
        async rpc(fnName, params = {}) {
            if (fnName === 'fn_create_booking_handoff') {
                if (!tables.booking_handoffs) tables.booking_handoffs = [];
                if (!tables.booking_journey_events) tables.booking_journey_events = [];
                const now = new Date().toISOString();
                const handoffId = autoId++;
                const eventId = autoId++;
                tables.booking_handoffs.push({
                    id: handoffId,
                    booking_id: params.p_booking_id,
                    claim_session_id: params.p_claim_session_id,
                    channel: params.p_channel,
                    recipient_phone_masked: params.p_recipient_phone_masked,
                    initiated_by_user_id: params.p_initiated_by_user_id,
                    created_at: now
                });
                tables.booking_journey_events.push({
                    id: eventId,
                    booking_id: params.p_booking_id,
                    handoff_id: handoffId,
                    event_type: 'SHARE_INITIATED',
                    created_at: now
                });
                return {
                    data: { success: true, handoff_id: handoffId, event_id: eventId, created_at: now },
                    error: null
                };
            }
            throw new Error(`fakeSupabaseClient: unsupported rpc "${fnName}" — add explicit support in tests/helpers/fakeSupabaseClient.js if a test genuinely needs it`);
        },
        from(tableName) {
            if (!tables[tableName]) tables[tableName] = [];
            const rows = tables[tableName];
            const filters = [];

            const builder = {
                select() { return builder; },
                eq(col, val) {
                    filters.push([col, val, 'eq']);
                    return builder;
                },
                neq(col, val) {
                    filters.push([col, val, 'neq']);
                    return builder;
                },
                gte(col, val) {
                    filters.push([col, val, 'gte']);
                    return builder;
                },
                lte(col, val) {
                    filters.push([col, val, 'lte']);
                    return builder;
                },
                gt(col, val) {
                    filters.push([col, val, 'gt']);
                    return builder;
                },
                in(col, vals) {
                    filters.push([col, vals, 'in']);
                    return builder;
                },
                order() { return builder; },
                limit() { return builder; },
                then(resolve, reject) {
                    const matches = rows.filter(row => matchesFilters(row, filters));
                    return Promise.resolve({ data: matches, error: null }).then(resolve, reject);
                },
                async maybeSingle() {
                    const matches = rows.filter(row => matchesFilters(row, filters));
                    if (matches.length === 0) return { data: null, error: null };
                    if (matches.length > 1) return { data: null, error: new Error(`fakeSupabaseClient: ${matches.length} rows matched, expected at most 1`) };
                    return { data: matches[0], error: null };
                },
                async single() {
                    const matches = rows.filter(row => matchesFilters(row, filters));
                    if (matches.length === 0) return { data: null, error: new Error('fakeSupabaseClient: no rows matched') };
                    if (matches.length > 1) return { data: null, error: new Error(`fakeSupabaseClient: ${matches.length} rows matched, expected exactly 1`) };
                    return { data: matches[0], error: null };
                },
                // .insert([{...}]).select().single()/.maybeSingle(), or bare
                // .insert([{...}]) awaited directly. The inserted row is
                // pushed into this table's in-memory array so a later read in
                // the SAME test can see it.
                insert(newRows) {
                    const inserted = (Array.isArray(newRows) ? newRows : [newRows]).map(r => {
                        const row = { id: r.id ?? autoId++, created_at: new Date().toISOString(), ...r };
                        rows.push(row);
                        return row;
                    });
                    return {
                        select() { return this; },
                        async single() {
                            return inserted.length === 1
                                ? { data: inserted[0], error: null }
                                : { data: null, error: new Error('fakeSupabaseClient: insert().single() expected exactly 1 row') };
                        },
                        async maybeSingle() {
                            return { data: inserted[0] || null, error: null };
                        },
                        then(resolve, reject) {
                            return Promise.resolve({ data: inserted, error: null }).then(resolve, reject);
                        }
                    };
                },
                // .update({...}).eq(col, val)[.eq(...)] applied in-place to
                // matching rows, then optionally .select().single()/
                // .maybeSingle(), or awaited bare.
                update(patch) {
                    const updateFilters = [];
                    const updateBuilder = {
                        eq(col, val) { updateFilters.push([col, val, 'eq']); return updateBuilder; },
                        select() { return updateBuilder; },
                        async single() {
                            const matches = rows.filter(row => matchesFilters(row, updateFilters));
                            matches.forEach(row => Object.assign(row, patch));
                            return matches.length === 1
                                ? { data: matches[0], error: null }
                                : { data: null, error: new Error('fakeSupabaseClient: update().single() expected exactly 1 matching row') };
                        },
                        async maybeSingle() {
                            const matches = rows.filter(row => matchesFilters(row, updateFilters));
                            matches.forEach(row => Object.assign(row, patch));
                            return { data: matches[0] || null, error: null };
                        },
                        then(resolve, reject) {
                            const matches = rows.filter(row => matchesFilters(row, updateFilters));
                            matches.forEach(row => Object.assign(row, patch));
                            return Promise.resolve({ data: matches, error: null }).then(resolve, reject);
                        }
                    };
                    return updateBuilder;
                }
            };

            return builder;
        }
    };
}

/**
 * Injects a fake client into require's module cache at the resolved path of
 * repo-root db.js, so that any subsequent `require('../db')` (including the
 * one inside utils/carrierAuth.js) resolves to the fake instead of the real
 * Supabase client. Must be called BEFORE utils/carrierAuth.js (or any route
 * file that requires it) is first required in this process — node:test runs
 * each matched file in its own process by default, so a call at the top of
 * a test file, before any require of carrierAuth/routes, is sufficient and
 * fully isolated from every other test file.
 */
function installFakeDbModule(fakeClient) {
    const dbPath = require.resolve('../../db');
    require.cache[dbPath] = {
        id: dbPath,
        filename: dbPath,
        loaded: true,
        exports: fakeClient
    };
    return fakeClient;
}

/**
 * Same idea as installFakeDbModule, but for dbServiceRole.js's
 * getServiceRoleClient() — used by utils/claimHelper.js,
 * utils/bookingSubscriptionHelper.js and others in preference to plain
 * require('../db') whenever it's reachable. Without this, any route that
 * calls getServiceRoleClient() with no SUPABASE_SERVICE_ROLE_KEY configured
 * in the test process throws synchronously (dbServiceRole.js fails closed
 * by design) before ever falling back to the fake db module. Must be called
 * before any route/helper file that requires dbServiceRole.js is first
 * required in this process, same ordering rule as installFakeDbModule.
 */
function installFakeServiceRoleModule(fakeClient) {
    const path = require.resolve('../../dbServiceRole');
    require.cache[path] = {
        id: path,
        filename: path,
        loaded: true,
        exports: {
            getServiceRoleClient: () => fakeClient,
            getServiceRoleDiagnostics: () => ({
                serviceRoleEnvPresent: true,
                serviceRoleClientCached: true,
                moduleInstanceId: 'fake-service-role',
                processPid: process.pid
            })
        }
    };
    return fakeClient;
}

module.exports = { createFakeSupabaseClient, installFakeDbModule, installFakeServiceRoleModule };
