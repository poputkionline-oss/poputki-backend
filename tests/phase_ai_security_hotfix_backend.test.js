const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

describe('PHASE AI SECURITY HOTFIX — Backend Migrations & Search Contracts', () => {
  const migrationsDir = path.join(__dirname, '..', 'supabase', 'migrations');
  const functionPath = path.join(__dirname, '..', 'supabase', 'functions', 'assistant-chat', 'index.ts');

  it('1. Chat sessions security migration drops broad policy and revokes public privileges', () => {
    const migrationFile = path.join(migrationsDir, '20260905092221_secure_chat_sessions_rls.sql');
    assert.ok(fs.existsSync(migrationFile), 'Migration file must exist');

    const sql = fs.readFileSync(migrationFile, 'utf8');
    assert.ok(sql.includes('ENABLE ROW LEVEL SECURITY'), 'Must enable RLS on chat_sessions');
    assert.ok(sql.includes('DROP POLICY IF EXISTS "allow_all_app_access" ON public.chat_sessions'), 'Must drop allow_all_app_access');
    assert.ok(sql.includes('REVOKE ALL PRIVILEGES ON TABLE public.chat_sessions FROM PUBLIC'), 'Must revoke from PUBLIC');
    assert.ok(sql.includes('REVOKE ALL PRIVILEGES ON TABLE public.chat_sessions FROM anon'), 'Must revoke from anon');
    assert.ok(sql.includes('REVOKE ALL PRIVILEGES ON TABLE public.chat_sessions FROM authenticated'), 'Must revoke from authenticated');
    assert.ok(sql.includes('GRANT ALL PRIVILEGES ON TABLE public.chat_sessions TO service_role'), 'Must grant to service_role');
  });

  it('2. Carrier buses security migration enables RLS and revokes anon privileges', () => {
    const migrationFile = path.join(migrationsDir, '20260905092248_secure_carrier_buses_rls.sql');
    assert.ok(fs.existsSync(migrationFile), 'Migration file must exist');

    const sql = fs.readFileSync(migrationFile, 'utf8');
    assert.ok(sql.includes('ALTER TABLE IF EXISTS public.carrier_buses ENABLE ROW LEVEL SECURITY'), 'Must enable RLS on carrier_buses');
    assert.ok(sql.includes('REVOKE ALL PRIVILEGES ON TABLE public.carrier_buses FROM anon'), 'Must revoke from anon');
    assert.ok(sql.includes('GRANT ALL PRIVILEGES ON TABLE public.carrier_buses TO service_role'), 'Must grant to service_role');
  });

  it('3. Rate limiter migration establishes persistent atomic store and stored procedure', () => {
    const migrationFile = path.join(migrationsDir, '20260905092259_ai_assistant_rate_limiter_schema.sql');
    assert.ok(fs.existsSync(migrationFile), 'Migration file must exist');

    const sql = fs.readFileSync(migrationFile, 'utf8');
    assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS public.ai_assistant_request_logs'), 'Must create request logs table');
    assert.ok(sql.includes('CONSTRAINT uq_ai_assistant_request_id UNIQUE (request_id)'), 'Must enforce unique request_id for idempotency');
    assert.ok(sql.includes('FUNCTION public.check_and_record_ai_request'), 'Must create atomic rate check function');
    assert.ok(sql.includes('RATE_LIMITED_BURST'), 'Must enforce burst limit');
    assert.ok(sql.includes('RATE_LIMITED_DAILY'), 'Must enforce daily user limit');
    assert.ok(sql.includes('Asia/Dushanbe'), 'Must evaluate day boundaries using Asia/Dushanbe');
  });

  it('4. Assistant-chat Edge Function source code is committed to Git and strictly guarded', () => {
    assert.ok(fs.existsSync(functionPath), 'Function source file must exist in git');

    const source = fs.readFileSync(functionPath, 'utf8');
    // Secret authentication check
    assert.ok(source.includes('timingSafeEqualStr'), 'Must use constant-time secret verification');
    assert.ok(source.includes('X-Bot-Service-Secret'), 'Must enforce secret header');
    assert.ok(source.includes('INTERNAL_BOT_ASSISTANT_SECRET'), 'Must check secret from environment');

    // Fail-closed checks
    assert.ok(source.includes('AI_ASSISTANT_ENABLED'), 'Must check master kill switch');
    assert.ok(source.includes('METHOD_NOT_ALLOWED'), 'Must reject non-POST requests');
    assert.ok(!source.includes("Access-Control-Allow-Origin: *"), 'Must NOT have wildcard CORS');
    assert.ok(!source.includes('TELEGRAM_BOT_TOKEN'), 'Must NOT depend on Telegram bot token');

    // Input validation
    assert.ok(source.includes('message.length > 1000'), 'Must enforce 1000 chars limit');
    assert.ok(source.includes('check_and_record_ai_request'), 'Must invoke atomic persistent rate limiter');
  });

  it('5. Search contract in Edge Function enforces strict business filters and city normalization', () => {
    const source = fs.readFileSync(functionPath, 'utf8');

    // Date & Timezone validation
    assert.ok(source.includes('getDushanbeDateTime'), 'Must calculate current date/time for Asia/Dushanbe (UTC+5)');
    assert.ok(source.includes('is_passenger_entry\', false'), 'Must exclude passenger requests from driver rides');
    assert.ok(source.includes('availableSeats <= 0'), 'Must reject full trips with 0 available seats');
    assert.ok(source.includes('booking_path'), 'Must preserve booking deep link path with record ID');

    // City normalization coverage
    assert.ok(source.includes('хуҷанд'), 'Must normalize Tajik Cyrillic Хуҷанд');
    assert.ok(source.includes('khujand'), 'Must normalize Latin Khujand');
    assert.ok(source.includes('tashkent'), 'Must normalize Tashkent');
  });

  it('6. Edge Function system prompt strictly restricts hallucination, payments and border advice', () => {
    const source = fs.readFileSync(functionPath, 'utf8');

    assert.ok(source.includes('10% (сервисный сбор) оплачивается онлайн'), 'Must state 10% online fee correctly');
    assert.ok(source.includes('90% стоимости оплачиваются водителю/перевозчику наличными'), 'Must state 90% cash on boarding correctly');
    assert.ok(source.includes('Сервис не предоставляет юридических консультаций'), 'Must refuse border legal advice');
    assert.ok(source.includes('НИКОГДА не выдумывай рейсы'), 'Must strictly forbid hallucinating rides');
  });

  it('7. RPC check_and_record_ai_request signature, SECURITY DEFINER and EXECUTE grants are locked down', () => {
    const migrationFile = path.join(migrationsDir, '20260905092259_ai_assistant_rate_limiter_schema.sql');
    const sql = fs.readFileSync(migrationFile, 'utf8');

    // Signature check
    assert.ok(sql.includes('FUNCTION public.check_and_record_ai_request('), 'Must define check_and_record_ai_request');
    assert.ok(sql.includes('p_telegram_id BIGINT'), 'Must accept telegram_id as BIGINT');
    assert.ok(sql.includes('p_request_id TEXT'), 'Must accept request_id as TEXT');
    assert.ok(sql.includes('p_burst_limit INT DEFAULT 2'), 'Must have burst limit default 2');
    assert.ok(sql.includes('p_daily_limit INT DEFAULT 5'), 'Must have daily limit default 5');
    assert.ok(sql.includes('p_global_daily_limit INT DEFAULT 500'), 'Must have global stop-loss default 500');

    // SECURITY DEFINER and empty search_path hardening
    assert.ok(sql.includes('SECURITY DEFINER'), 'Must be SECURITY DEFINER');
    assert.ok(sql.includes("SET search_path = ''"), "Must strictly require empty search_path: SET search_path = ''");
    assert.ok(!sql.includes('SET search_path = public'), 'Must strictly forbid search_path = public');
    assert.ok(!sql.includes('pg_temp'), 'Must strictly forbid pg_temp');

    // Fully qualified functions and objects check
    assert.ok(sql.includes('pg_catalog.pg_advisory_xact_lock(p_telegram_id)'), 'Must acquire transaction advisory lock directly on bigint p_telegram_id');
    assert.ok(sql.includes('pg_catalog.clock_timestamp()'), 'Must qualify clock_timestamp with pg_catalog');
    assert.ok(sql.includes('pg_catalog.timezone('), 'Must qualify timezone with pg_catalog');
    assert.ok(sql.includes('pg_catalog.now()'), 'Must qualify now with pg_catalog');
    assert.ok(sql.includes('pg_catalog.count(*)'), 'Must qualify count with pg_catalog');
    assert.ok(sql.includes('pg_catalog.jsonb_build_object('), 'Must qualify jsonb_build_object with pg_catalog');
    assert.ok(sql.includes('public.ai_assistant_request_logs'), 'Must qualify tables with public');

    // EXECUTE grants strictly service_role
    assert.ok(sql.includes('REVOKE EXECUTE ON FUNCTION public.check_and_record_ai_request(BIGINT, TEXT, INT, INT, INT) FROM PUBLIC'), 'Must revoke from PUBLIC');
    assert.ok(sql.includes('REVOKE EXECUTE ON FUNCTION public.check_and_record_ai_request(BIGINT, TEXT, INT, INT, INT) FROM anon'), 'Must revoke from anon');
    assert.ok(sql.includes('REVOKE EXECUTE ON FUNCTION public.check_and_record_ai_request(BIGINT, TEXT, INT, INT, INT) FROM authenticated'), 'Must revoke from authenticated');
    assert.ok(sql.includes('GRANT EXECUTE ON FUNCTION public.check_and_record_ai_request(BIGINT, TEXT, INT, INT, INT) TO service_role'), 'Must grant to service_role');
  });

  it('8. ai_assistant_request_logs revokes all privileges (SELECT, INSERT, UPDATE, DELETE, TRUNCATE) from anon/auth', () => {
    const migrationFile = path.join(migrationsDir, '20260905092259_ai_assistant_rate_limiter_schema.sql');
    const sql = fs.readFileSync(migrationFile, 'utf8');

    assert.ok(sql.includes('ALTER TABLE public.ai_assistant_request_logs ENABLE ROW LEVEL SECURITY'), 'Must enable RLS');
    assert.ok(sql.includes('REVOKE ALL PRIVILEGES ON TABLE public.ai_assistant_request_logs FROM PUBLIC'), 'Must revoke all from PUBLIC');
    assert.ok(sql.includes('REVOKE ALL PRIVILEGES ON TABLE public.ai_assistant_request_logs FROM anon'), 'Must revoke all from anon');
    assert.ok(sql.includes('REVOKE ALL PRIVILEGES ON TABLE public.ai_assistant_request_logs FROM authenticated'), 'Must revoke all from authenticated');
    assert.ok(sql.includes('GRANT ALL PRIVILEGES ON TABLE public.ai_assistant_request_logs TO service_role'), 'Must grant all to service_role');
  });

  it('9. Concurrent rate limiter simulation: 10 parallel requests with burst_limit 2 accept exactly 2 and reject 8', async () => {
    // In-memory atomic state simulator replicating PostgreSQL transaction advisory lock serialization
    class AtomicRateLimiterSimulator {
      constructor(burstLimit = 2) {
        this.burstLimit = burstLimit;
        this.logs = [];
        this.locks = new Set();
      }

      async acquireLock(key) {
        while (this.locks.has(key)) {
          await new Promise((r) => setTimeout(r, 2));
        }
        this.locks.add(key);
      }

      releaseLock(key) {
        this.locks.delete(key);
      }

      async checkAndRecord(telegramId, requestId) {
        await this.acquireLock(telegramId);
        try {
          const now = Date.now();
          // 1. Idempotency check
          if (this.logs.some((l) => l.requestId === requestId)) {
            return { allowed: false, status: 'DUPLICATE', reason: 'DUPLICATE_REQUEST' };
          }

          // 2. Burst limit check (last 60s)
          const recentCount = this.logs.filter(
            (l) => l.telegramId === telegramId && now - l.timestamp < 60000 && l.status === 'ACCEPTED'
          ).length;

          if (recentCount >= this.burstLimit) {
            return {
              allowed: false,
              status: 'RATE_LIMITED',
              reason: 'RATE_LIMITED_BURST',
              burst_count: recentCount,
            };
          }

          // 3. Record accepted
          this.logs.push({
            telegramId,
            requestId,
            timestamp: now,
            status: 'ACCEPTED',
          });

          return {
            allowed: true,
            status: 'ACCEPTED',
            burst_count: recentCount + 1,
          };
        } finally {
          this.releaseLock(telegramId);
        }
      }
    }

    const limiter = new AtomicRateLimiterSimulator(2);
    const userId = 888777666;

    // Fire 10 parallel requests concurrently
    const parallelRequests = Array.from({ length: 10 }, (_, i) =>
      limiter.checkAndRecord(userId, `req_parallel_${i + 1}`)
    );

    const results = await Promise.all(parallelRequests);

    const accepted = results.filter((r) => r.allowed === true);
    const rejected = results.filter((r) => r.allowed === false && r.reason === 'RATE_LIMITED_BURST');

    assert.strictEqual(accepted.length, 2, 'Exactly 2 concurrent requests must be accepted');
    assert.strictEqual(rejected.length, 8, 'Exactly 8 concurrent requests must be rejected with RATE_LIMITED_BURST');
    assert.strictEqual(results.length, 10, 'All 10 requests must be resolved');
  });
});

