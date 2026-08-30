const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

let serviceRoleClient = null;

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
    if (serviceRoleClient) return serviceRoleClient;

    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !serviceRoleKey) {
        throw new Error('SUPABASE_SERVICE_ROLE_KEY is required for server-side claim operations');
    }

    serviceRoleClient = createClient(supabaseUrl, serviceRoleKey, {
        auth: {
            persistSession: false,
            autoRefreshToken: false,
            detectSessionInUrl: false
        }
    });

    return serviceRoleClient;
}

module.exports = { getServiceRoleClient };
