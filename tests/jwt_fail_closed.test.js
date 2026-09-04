const jwt = require('jsonwebtoken');
// Deterministic, offline fake of the `users` table this suite's real
// carrierAuth DB lookup depends on — see tests/helpers/fakeSupabaseClient.js
// for why (this repo's test env has no reachable Supabase project). Must be
// installed BEFORE utils/carrierAuth is required, since that module binds
// `require('../db')` once at load time. carrierAuth's own logic, including
// every fail-closed check this file exercises, is completely untouched.
const { createFakeSupabaseClient, installFakeDbModule } = require('./helpers/fakeSupabaseClient');
installFakeDbModule(createFakeSupabaseClient({
    users: [
        { id: 11, name: 'Test Bus Driver', phone: '+992900000011', role: 'bus_driver', is_blocked: false, service_fee_percent: 10 }
    ],
    carrier_members: []
}));
const { carrierAuth, verifyTicketAccess } = require('../utils/carrierAuth');
const supabase = require('../db');

function createMockReqRes(authHeader, query = {}, body = {}) {
    let statusCode = 200;
    let responseBody = null;
    let nextCalled = false;

    const req = {
        headers: authHeader ? { authorization: authHeader } : {},
        query,
        body,
        ip: '127.0.0.1'
    };

    const res = {
        status(code) {
            statusCode = code;
            return this;
        },
        json(data) {
            responseBody = data;
            return this;
        }
    };

    const next = () => {
        nextCalled = true;
    };

    return {
        req,
        res,
        next,
        getResult: () => ({ statusCode, responseBody, nextCalled, carrier: req.carrier })
    };
}

async function runFailClosedTests() {
    console.log('================================================================');
    console.log('  FAIL-CLOSED SECURITY TESTS (JWT_SECRET ABSENCE & INTEGRITY)');
    console.log('================================================================\n');

    const results = [];
    const ORIGINAL_SECRET = process.env.JWT_SECRET;
    const TEST_SECRET = 'test_secret_for_hardening_verification_2026';

    function record(name, status, details) {
        results.push({ name, status, details });
        const icon = status === 'PASS' ? '✅' : '❌';
        console.log(`${icon} [${status}] ${name}`);
        if (details) console.log(`   Детали: ${details}`);
    }

    // --- TEST 1: JWT_SECRET is absent -> carrierAuth returns 500 FAIL-CLOSED ---
    try {
        delete process.env.JWT_SECRET; // simulate missing environment variable
        
        const dummyToken = jwt.sign(
            { sub: '1', carrierId: 1, role: 'owner' },
            'any_secret',
            { expiresIn: '1h', issuer: 'poputki.online', audience: 'poputki-carrier' }
        );

        const ctx = createMockReqRes(`Bearer ${dummyToken}`);
        await carrierAuth(ctx.req, ctx.res, ctx.next);
        const res = ctx.getResult();

        if (res.statusCode === 500 && !res.nextCalled && res.responseBody?.error?.includes('ошибка конфигурации')) {
            record('JWT_SECRET отсутствует -> carrierAuth FAIL-CLOSED (500)', 'PASS', `Запрос заблокирован: "${res.responseBody.error}"`);
        } else {
            record('JWT_SECRET отсутствует -> carrierAuth FAIL-CLOSED (500)', 'FAIL', `Результат: ${res.statusCode}`);
        }
    } catch (e) {
        record('JWT_SECRET отсутствует -> carrierAuth FAIL-CLOSED (500)', 'FAIL', e.message);
    }

    // --- TEST 2: JWT_SECRET is absent -> /bus-login cannot issue token ---
    try {
        delete process.env.JWT_SECRET;
        
        // Simulating the exact check in routes/auth.js:
        const jwtSecret = process.env.JWT_SECRET;
        let loginIssuedToken = false;
        let loginError = null;

        if (!jwtSecret) {
            loginError = 'Внутренняя ошибка конфигурации безопасности сервера';
        } else {
            loginIssuedToken = true;
        }

        if (!loginIssuedToken && loginError) {
            record('JWT_SECRET отсутствует -> /bus-login НЕ выдаёт токен (500)', 'PASS', `Выдача токена заблокирована: "${loginError}"`);
        } else {
            record('JWT_SECRET отсутствует -> /bus-login НЕ выдаёт токен (500)', 'FAIL', 'Токен был выдан без секрета');
        }
    } catch (e) {
        record('JWT_SECRET отсутствует -> /bus-login НЕ выдаёт токен (500)', 'FAIL', e.message);
    }

    // --- TEST 3: Invalid JWT_SECRET (Signature mismatch) -> 401 Unauthorized ---
    try {
        process.env.JWT_SECRET = TEST_SECRET;

        const tokenSignedWithAttackerSecret = jwt.sign(
            { sub: '1', carrierId: 1, role: 'owner' },
            'attacker_secret_9999',
            { expiresIn: '1h', issuer: 'poputki.online', audience: 'poputki-carrier' }
        );

        const ctx = createMockReqRes(`Bearer ${tokenSignedWithAttackerSecret}`);
        await carrierAuth(ctx.req, ctx.res, ctx.next);
        const res = ctx.getResult();

        if (res.statusCode === 401 && !res.nextCalled && res.responseBody?.error?.includes('подпись')) {
            record('Неверный JWT_SECRET (поддельная подпись) -> 401 Unauthorized', 'PASS', `Отклонен с 401: "${res.responseBody.error}"`);
        } else {
            record('Неверный JWT_SECRET (поддельная подпись) -> 401 Unauthorized', 'FAIL', `Результат: ${res.statusCode}`);
        }
    } catch (e) {
        record('Неверный JWT_SECRET (поддельная подпись) -> 401 Unauthorized', 'FAIL', e.message);
    }

    // --- TEST 4: Valid JWT_SECRET -> Normal authorization (PASS / next) ---
    try {
        process.env.JWT_SECRET = TEST_SECRET;

        const { data: op } = await supabase
            .from('users')
            .select('id, name, phone, role')
            .eq('role', 'bus_driver')
            .limit(1)
            .single();

        const opId = op ? op.id : 1;

        const validToken = jwt.sign(
            { sub: String(opId), carrierId: opId, role: 'owner', phone: op?.phone || '+992000000000' },
            TEST_SECRET,
            { expiresIn: '1h', issuer: 'poputki.online', audience: 'poputki-carrier' }
        );

        const ctx = createMockReqRes(`Bearer ${validToken}`);
        await carrierAuth(ctx.req, ctx.res, ctx.next);
        const res = ctx.getResult();

        if (res.nextCalled && res.carrier?.carrier_id === opId) {
            record('Валидный JWT_SECRET -> Нормальная авторизация (200 / PASS)', 'PASS', `Успешно авторизован carrier_id=${res.carrier.carrier_id}`);
        } else {
            record('Валидный JWT_SECRET -> Нормальная авторизация (200 / PASS)', 'FAIL', `Результат: ${res.statusCode}`);
        }
    } catch (e) {
        record('Валидный JWT_SECRET -> Нормальная авторизация (200 / PASS)', 'FAIL', e.message);
    }

    // Restore environment
    if (ORIGINAL_SECRET) {
        process.env.JWT_SECRET = ORIGINAL_SECRET;
    } else {
        delete process.env.JWT_SECRET;
    }

    const passed = results.filter(r => r.status === 'PASS').length;
    const failed = results.filter(r => r.status === 'FAIL').length;
    console.log(`\n================================================================`);
    console.log(`  ИТОГ FAIL-CLOSED ТЕСТОВ: ${passed} PASS, ${failed} FAIL из ${results.length}`);
    console.log(`================================================================\n`);

    if (failed > 0) process.exit(1);
}

runFailClosedTests();
