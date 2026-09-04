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
        return String(row[col]) === String(val);
    });
}

function createFakeSupabaseClient(tables = {}) {
    return {
        from(tableName) {
            const rows = tables[tableName] || [];
            const filters = [];

            const builder = {
                select() { return builder; },
                eq(col, val) {
                    filters.push([col, val, 'eq']);
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

module.exports = { createFakeSupabaseClient, installFakeDbModule };
