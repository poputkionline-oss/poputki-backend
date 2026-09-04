const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
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
