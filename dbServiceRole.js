const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const { readJwtRole } = require('./utils/serverSupabaseConfig');
require('dotenv').config();

let serviceRoleClient = null;
const moduleInstanceId = crypto.randomBytes(4).toString('hex');

/**
 * Returns safe diagnostic information about the service-role client module state.
 * NEVER returns secret values.
 */
function getServiceRoleDiagnostics() {
    return {
        serviceRoleEnvPresent: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
        serviceRoleClientCached: Boolean(serviceRoleClient),
        moduleInstanceId,
        processPid: process.pid
    };
}

/**
 * Returns a server-only Supabase client backed by the service-role key.
 *
 * IMPORTANT:
 * - Never import this module into frontend/client code.
 * - Never log SUPABASE_SERVICE_ROLE_KEY.
 * - The client is initialized lazily so test/import environments without the
 *   secret do not crash at module load time.
 */
function getServiceRoleClient() {
    const clientCachedBefore = Boolean(serviceRoleClient);
    if (serviceRoleClient) {
        console.log('[ServiceRole] SERVICE_ROLE_RUNTIME_TRACE', {
            processPid: process.pid,
            moduleInstanceId,
            envPresent: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
            clientCachedBefore,
            result: 'CACHED'
        });
        return serviceRoleClient;
    }

    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !serviceRoleKey) {
        console.warn('[ServiceRole] SERVICE_ROLE_RUNTIME_TRACE', {
            processPid: process.pid,
            moduleInstanceId,
            envPresent: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
            clientCachedBefore: false,
            result: 'FAILED'
        });
        throw new Error('SUPABASE_SERVICE_ROLE_KEY is required for server-side claim operations');
    }

    // V2.0B-0: refuse a JWT-shaped key that is not a service_role key (e.g. an
    // anon key pasted into SUPABASE_SERVICE_ROLE_KEY). Only the role string is
    // ever reported, never the key.
    const keyRole = readJwtRole(serviceRoleKey);
    if (keyRole !== null && keyRole !== 'service_role') {
        throw new Error(`SUPABASE_SERVICE_ROLE_KEY does not hold a service_role key (role claim: "${keyRole}")`);
    }

    serviceRoleClient = createClient(supabaseUrl, serviceRoleKey, {
        auth: {
            persistSession: false,
            autoRefreshToken: false,
            detectSessionInUrl: false
        }
    });

    console.log('[ServiceRole] SERVICE_ROLE_RUNTIME_TRACE', {
        processPid: process.pid,
        moduleInstanceId,
        envPresent: true,
        clientCachedBefore: false,
        result: 'INITIALIZED'
    });

    return serviceRoleClient;
}

function setServiceRoleClient(client) {
    serviceRoleClient = client;
}

module.exports = {
    getServiceRoleClient,
    getServiceRoleDiagnostics,
    setServiceRoleClient
};
