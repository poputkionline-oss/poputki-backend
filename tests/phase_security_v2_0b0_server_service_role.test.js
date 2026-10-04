/**
 * tests/phase_security_v2_0b0_server_service_role.test.js
 *
 * SECURITY V2.0B-0 — server-side database access uses the SERVICE ROLE key,
 * fails closed when it is missing, never falls back to the anon key, and the
 * credential is never logged or exposed to frontend sources/bundles.
 * Synthetic credentials only; no real Supabase project is contacted
 * (@supabase/supabase-js is replaced by a recording fake).
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SERVICE = 'synthetic-service-role-key-AAAA1111';
const ANON = 'synthetic-anon-key-BBBB2222';
const URL_ = 'https://synthetic-project.supabase.test';

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const fakeJwt = (role) => `eyJ${b64({ alg: 'HS256' }).slice(3)}.${b64({ role, iss: 'supabase' })}.c3ludGhldGljLXNpZw`;

const sdkPath = require.resolve('@supabase/supabase-js');
const dbPath = path.join(ROOT, 'db.js');
const svcPath = path.join(ROOT, 'dbServiceRole.js');

let created;          // recorded createClient() invocations
let logLines;         // captured console output
let saved;            // saved env + console

function installFakeSdk() {
    created = [];
    require.cache[sdkPath] = {
        id: sdkPath, filename: sdkPath, loaded: true,
        exports: { createClient: (url, key, opts) => { created.push({ url, key, opts }); return { __fake: true }; } }
    };
}

function loadFresh(file) {
    delete require.cache[file];
    return require(file);
}

function setEnv(env) {
    for (const k of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_ANON_KEY']) delete process.env[k];
    Object.assign(process.env, env);
}

beforeEach(() => {
    saved = {
        env: { ...process.env },
        log: console.log, warn: console.warn, error: console.error,
        sdk: require.cache[sdkPath]
    };
    logLines = [];
    const cap = (...a) => { logLines.push(a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); };
    console.log = cap; console.warn = cap; console.error = cap;
    installFakeSdk();
});

afterEach(() => {
    console.log = saved.log; console.warn = saved.warn; console.error = saved.error;
    process.env = saved.env;
    if (saved.sdk) require.cache[sdkPath] = saved.sdk; else delete require.cache[sdkPath];
    delete require.cache[dbPath]; delete require.cache[svcPath];
});

describe('A. backend database client selects the service-role key', () => {
    it('db.js builds its client from SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY and ignores the anon key', () => {
        setEnv({ SUPABASE_URL: URL_, SUPABASE_SERVICE_ROLE_KEY: SERVICE, SUPABASE_ANON_KEY: ANON });
        const client = loadFresh(dbPath);
        assert.equal(client.__fake, true);
        assert.equal(created.length, 1);
        assert.equal(created[0].url, URL_);
        assert.equal(created[0].key, SERVICE);
        assert.notEqual(created[0].key, ANON);
        assert.equal(created[0].opts.auth.persistSession, false);
        assert.equal(created[0].opts.auth.autoRefreshToken, false);
    });

    it('accepts a service_role JWT-shaped key', () => {
        const key = fakeJwt('service_role');
        setEnv({ SUPABASE_URL: URL_, SUPABASE_SERVICE_ROLE_KEY: key });
        loadFresh(dbPath);
        assert.equal(created[0].key, key);
    });
});

describe('B. backend fails closed', () => {
    it('db.js throws at load when SUPABASE_SERVICE_ROLE_KEY is missing, even if the anon key is set; no client is created', () => {
        setEnv({ SUPABASE_URL: URL_, SUPABASE_ANON_KEY: ANON });
        assert.throws(() => loadFresh(dbPath), (e) => e.code === 'SUPABASE_SERVICE_ROLE_KEY_MISSING' && /SUPABASE_SERVICE_ROLE_KEY/.test(e.message));
        assert.equal(created.length, 0, 'no client may be created (no anon fallback)');
    });

    it('db.js throws when SUPABASE_URL is missing', () => {
        setEnv({ SUPABASE_SERVICE_ROLE_KEY: SERVICE });
        assert.throws(() => loadFresh(dbPath), (e) => e.code === 'SUPABASE_URL_MISSING');
        assert.equal(created.length, 0);
    });

    it('an anon-role JWT in SUPABASE_SERVICE_ROLE_KEY is refused (db.js and dbServiceRole.js)', () => {
        const anonJwt = fakeJwt('anon');
        setEnv({ SUPABASE_URL: URL_, SUPABASE_SERVICE_ROLE_KEY: anonJwt });
        assert.throws(() => loadFresh(dbPath), (e) => e.code === 'SUPABASE_KEY_NOT_SERVICE_ROLE' && !e.message.includes(anonJwt));
        const svc = loadFresh(svcPath);
        assert.throws(() => svc.getServiceRoleClient(), (e) => /service_role/.test(e.message) && !e.message.includes(anonJwt));
        assert.equal(created.length, 0);
    });

    it('dbServiceRole.getServiceRoleClient() never falls back to the anon key', () => {
        setEnv({ SUPABASE_URL: URL_, SUPABASE_ANON_KEY: ANON });
        const svc = loadFresh(svcPath);
        assert.throws(() => svc.getServiceRoleClient(), /SUPABASE_SERVICE_ROLE_KEY is required/);
        assert.equal(created.length, 0);
    });

    it('with the key present dbServiceRole uses it', () => {
        setEnv({ SUPABASE_URL: URL_, SUPABASE_SERVICE_ROLE_KEY: SERVICE, SUPABASE_ANON_KEY: ANON });
        const svc = loadFresh(svcPath);
        svc.getServiceRoleClient();
        assert.equal(created[0].key, SERVICE);
    });
});

describe('F. credentials are never logged', () => {
    it('success and failure paths of db.js / dbServiceRole.js never print any key value', () => {
        setEnv({ SUPABASE_URL: URL_, SUPABASE_SERVICE_ROLE_KEY: SERVICE, SUPABASE_ANON_KEY: ANON });
        loadFresh(dbPath);
        const svc = loadFresh(svcPath);
        svc.getServiceRoleClient();
        svc.getServiceRoleDiagnostics();

        setEnv({ SUPABASE_URL: URL_, SUPABASE_ANON_KEY: ANON });
        try { loadFresh(dbPath); } catch (e) { logLines.push(e.message); }
        const svc2 = loadFresh(svcPath);
        try { svc2.getServiceRoleClient(); } catch (e) { logLines.push(e.message); }

        const all = logLines.join('\n');
        assert.ok(!all.includes(SERVICE), 'service-role key leaked to logs');
        assert.ok(!all.includes(ANON), 'anon key leaked to logs');
    });

    it('no log statement in server source prints a key variable (booleans excepted)', () => {
        const offenders = [];
        const walk = (dir) => {
            for (const name of fs.readdirSync(dir)) {
                if (['node_modules', '.git', 'tests', 'docs'].includes(name)) continue;
                const p = path.join(dir, name);
                const st = fs.statSync(p);
                if (st.isDirectory()) walk(p);
                else if (name.endsWith('.js')) {
                    fs.readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
                        if (/console\.(log|warn|error|info)\(/.test(line) &&
                            /(SUPABASE_SERVICE_ROLE_KEY|serviceRoleKey|SUPABASE_ANON_KEY)/.test(line) &&
                            !/Boolean\(/.test(line)) offenders.push(`${path.relative(ROOT, p)}:${i + 1}`);
                    });
                }
            }
        };
        walk(ROOT);
        assert.deepEqual(offenders, []);
    });
});

describe('Unsafe fallbacks / hardcoded credentials are gone', () => {
    const walkJs = (dir, out = []) => {
        for (const name of fs.readdirSync(dir)) {
            if (['node_modules', '.git', 'tests', 'docs'].includes(name)) continue;
            const p = path.join(dir, name);
            if (fs.statSync(p).isDirectory()) walkJs(p, out);
            else if (name.endsWith('.js')) out.push(p);
        }
        return out;
    };

    it('no server code reads SUPABASE_ANON_KEY', () => {
        const hits = walkJs(ROOT).filter(f => /process\.env\.SUPABASE_ANON_KEY|env\.SUPABASE_ANON_KEY/.test(fs.readFileSync(f, 'utf8')));
        assert.deepEqual(hits.map(f => path.relative(ROOT, f)), []);
    });

    it('no SERVICE_ROLE || ANON / ANON || SERVICE_ROLE fallback chains', () => {
        const bad = walkJs(ROOT).filter(f => {
            const s = fs.readFileSync(f, 'utf8');
            return /SERVICE_ROLE_KEY\s*\|\|\s*process\.env/.test(s) || /ANON_KEY\s*\|\|/.test(s) || /\|\|\s*process\.env\.SUPABASE_(ANON|SERVICE)/.test(s);
        });
        assert.deepEqual(bad.map(f => path.relative(ROOT, f)), []);
    });

    it('no hardcoded JWT-looking key literals in current server source', () => {
        const bad = walkJs(ROOT).filter(f => /eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{10,}\./.test(fs.readFileSync(f, 'utf8')));
        assert.deepEqual(bad.map(f => path.relative(ROOT, f)), []);
    });
});

describe('E. service_role cannot reach browser/frontend source or build', () => {
    const FRONT = path.join(ROOT, '..', 'poputki-front');
    const haveFront = fs.existsSync(path.join(FRONT, 'src'));

    it('frontend source has no service-role reference or VITE-exposed Supabase key (skipped if the frontend checkout is absent)', { skip: !haveFront }, () => {
        const offenders = [];
        const walk = (dir) => {
            for (const name of fs.readdirSync(dir)) {
                const p = path.join(dir, name);
                if (fs.statSync(p).isDirectory()) walk(p);
                else if (/\.(vue|js|ts|html|json|env.*)$/.test(name) || name.startsWith('.env')) {
                    const s = fs.readFileSync(p, 'utf8');
                    if (/service[_-]?role/i.test(s) || /VITE_SUPABASE_(SERVICE|ANON|KEY)/i.test(s) || /SUPABASE_SERVICE/i.test(s)) offenders.push(path.relative(FRONT, p));
                }
            }
        };
        walk(path.join(FRONT, 'src'));
        for (const f of ['index.html', 'vite.config.js', '.env.example']) {
            const p = path.join(FRONT, f);
            if (fs.existsSync(p)) {
                const s = fs.readFileSync(p, 'utf8');
                if (/service[_-]?role/i.test(s) || /VITE_SUPABASE_(SERVICE|ANON|KEY)/i.test(s)) offenders.push(f);
            }
        }
        assert.deepEqual(offenders, []);
    });

    it('a built frontend bundle (if present) contains no JWT-shaped key', { skip: !haveFront || !fs.existsSync(path.join(FRONT, 'dist')) }, () => {
        const offenders = [];
        const walk = (dir) => {
            for (const name of fs.readdirSync(dir)) {
                const p = path.join(dir, name);
                if (fs.statSync(p).isDirectory()) walk(p);
                else if (/\.(js|html|css|map)$/.test(name) && /eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{10,}\./.test(fs.readFileSync(p, 'utf8'))) offenders.push(name);
            }
        };
        walk(path.join(FRONT, 'dist'));
        assert.deepEqual(offenders, []);
    });

    it('this backend never sends the service-role key in any API response (no handler references it)', () => {
        const hits = [];
        const walk = (dir) => {
            for (const name of fs.readdirSync(dir)) {
                if (['node_modules', '.git', 'tests', 'docs'].includes(name)) continue;
                const p = path.join(dir, name);
                if (fs.statSync(p).isDirectory()) walk(p);
                else if (name.endsWith('.js')) {
                    const s = fs.readFileSync(p, 'utf8');
                    if (/res\.(json|send)\([^)]*(SERVICE_ROLE|serviceRoleKey)/.test(s)) hits.push(path.relative(ROOT, p));
                }
            }
        };
        walk(ROOT);
        assert.deepEqual(hits, []);
    });
});
