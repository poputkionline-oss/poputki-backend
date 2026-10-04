/**
 * utils/serverSupabaseConfig.js
 *
 * Security V2.0B-0 — single, fail-closed resolver for server-side Supabase
 * database credentials.
 *
 * Contract:
 *  - Server-side database access uses SUPABASE_SERVICE_ROLE_KEY (+ SUPABASE_URL).
 *  - It NEVER falls back to SUPABASE_ANON_KEY. If the service-role key is
 *    missing the process must fail with a clear error instead of silently
 *    running privileged database operations with weaker (or, today, with
 *    overly permissive anon) credentials.
 *  - A JWT-shaped key whose `role` claim is not `service_role` (for example an
 *    anon key pasted into SUPABASE_SERVICE_ROLE_KEY by mistake) is rejected.
 *    Non-JWT keys (new-style secret keys, test doubles) are not inspected.
 *  - Error messages and logs never contain the key value.
 *
 * The service-role key must only ever be read in server-side code
 * (Express backend / Telegram bot on a server runtime). It must never be
 * exposed to browser bundles, Vite env, API responses, logs or messages.
 */

'use strict';

class SupabaseServerConfigError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'SupabaseServerConfigError';
        this.code = code;
    }
}

function clean(value) {
    return typeof value === 'string' ? value.trim() : '';
}

/**
 * Returns the `role` claim of a JWT-shaped key, or null if the key is not a
 * decodable JWT. Only the (non-secret) role string is ever returned.
 */
function readJwtRole(key) {
    if (typeof key !== 'string' || !key.startsWith('eyJ')) return null;
    const parts = key.split('.');
    if (parts.length !== 3) return null;
    try {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        return payload && typeof payload.role === 'string' ? payload.role : null;
    } catch (_) {
        return null;
    }
}

/**
 * @param {Object} env process.env-like object
 * @returns {{ url: string, serviceRoleKey: string }}
 * @throws {SupabaseServerConfigError}
 */
function resolveServerSupabaseConfig(env = process.env) {
    const url = clean(env.SUPABASE_URL);
    const serviceRoleKey = clean(env.SUPABASE_SERVICE_ROLE_KEY);

    if (!url) {
        throw new SupabaseServerConfigError(
            'SUPABASE_URL_MISSING',
            'SUPABASE_URL is required for server-side database access'
        );
    }
    if (!serviceRoleKey) {
        throw new SupabaseServerConfigError(
            'SUPABASE_SERVICE_ROLE_KEY_MISSING',
            'SUPABASE_SERVICE_ROLE_KEY is required for server-side database access (there is no fallback to SUPABASE_ANON_KEY)'
        );
    }

    const role = readJwtRole(serviceRoleKey);
    if (role !== null && role !== 'service_role') {
        throw new SupabaseServerConfigError(
            'SUPABASE_KEY_NOT_SERVICE_ROLE',
            `SUPABASE_SERVICE_ROLE_KEY does not hold a service_role key (role claim: "${role}")`
        );
    }

    return { url, serviceRoleKey };
}

module.exports = {
    SupabaseServerConfigError,
    resolveServerSupabaseConfig,
    readJwtRole
};
