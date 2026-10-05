const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();
const { resolveServerSupabaseConfig } = require('./utils/serverSupabaseConfig');

// SECURITY (V2.0B-0): server-side database access uses the SERVICE ROLE key.
// All authorization (passenger/carrier/admin JWTs) is enforced in the Express
// layer; the browser and the Flutter app never talk to Supabase tables
// directly, so the anon role needs no table access. This module therefore
// FAILS CLOSED (throws at load time) when SUPABASE_URL or
// SUPABASE_SERVICE_ROLE_KEY is missing — it never falls back to
// SUPABASE_ANON_KEY. The key is read only here, on the server, and is never
// logged or returned in any response.
const { url, serviceRoleKey } = resolveServerSupabaseConfig(process.env);

// Create a single supabase client for interacting with your database
const supabase = createClient(url, serviceRoleKey, {
    auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false
    }
});

module.exports = supabase;
