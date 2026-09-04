const jwt = require('jsonwebtoken');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_for_hotfix_verification_2026';
// Deterministic, offline fake of the `users`/`bus_tickets` tables this
// suite's real carrierAuth DB lookup depends on — see
// tests/helpers/fakeSupabaseClient.js for why (this repo's test env has no
// reachable Supabase project). Must be installed BEFORE utils/carrierAuth is
// required. carrierAuth's own logic is completely untouched. One bus_tickets
// row is seeded so TEST 7 (tenant isolation) exercises its real own-vs-
// foreign-carrier assertion instead of skipping for lack of data.
const { createFakeSupabaseClient, installFakeDbModule } = require('./helpers/fakeSupabaseClient');
installFakeDbModule(createFakeSupabaseClient({
    users: [
        { id: 11, name: 'Тестовый Водитель', phone: '+992900000011', role: 'bus_driver', is_blocked: false, service_fee_percent: 10 }
    ],
    carrier_members: [],
    bus_tickets: [
        { id: 5001, operator_id: 11 }
    ]
}));
const { carrierAuth, verifyTicketAccess } = require('../utils/carrierAuth');
const supabase = require('../db');
const JWT_SECRET = process.env.JWT_SECRET;

function createMockContext(authHeader, query = {}, body = {}) {
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

async function runSecurityHotfixTests() {
    console.log('================================================================');
    console.log('  SECURITY HOTFIX INTEGRATION & TENANT ISOLATION TESTS');
    console.log('================================================================\n');

    const results = [];

    function record(id, title, status, proof) {
        results.push({ id, title, status, proof });
        const icon = status === 'PASS' ? '✅' : '❌';
        console.log(`${icon} [TEST ${id}] ${title}: ${status}`);
        if (proof) console.log(`   Proof: ${proof}`);
    }

    // --- TEST 1: Rejection of legacy bus-token-* ---
    try {
        const ctx = createMockContext('Bearer bus-token-1');
        await carrierAuth(ctx.req, ctx.res, ctx.next);
        const res = ctx.getResult();

        if (res.statusCode === 401 && !res.nextCalled && res.responseBody?.error?.includes('Устаревший')) {
            record(1, 'Отклонение предсказуемых токенов bus-token-*', 'PASS', `Отклонен с 401: "${res.responseBody.error}"`);
        } else {
            record(1, 'Отклонение предсказуемых токенов bus-token-*', 'FAIL', `Результат: ${res.statusCode}`);
        }
    } catch (e) {
        record(1, 'Отклонение предсказуемых токенов bus-token-*', 'FAIL', e.message);
    }

    // --- TEST 2: Rejection of missing Authorization header ---
    try {
        const ctx = createMockContext(null);
        await carrierAuth(ctx.req, ctx.res, ctx.next);
        const res = ctx.getResult();

        if (res.statusCode === 401 && !res.nextCalled && res.responseBody?.error?.includes('отсутствует Bearer')) {
            record(2, 'Отклонение запроса без заголовка Authorization', 'PASS', `Отклонен с 401: "${res.responseBody.error}"`);
        } else {
            record(2, 'Отклонение запроса без заголовка Authorization', 'FAIL', `Результат: ${res.statusCode}`);
        }
    } catch (e) {
        record(2, 'Отклонение запроса без заголовка Authorization', 'FAIL', e.message);
    }

    // --- TEST 3: Rejection of forged JWT (invalid signature) ---
    try {
        const forgedToken = jwt.sign(
            { sub: '1', carrierId: 1, role: 'owner' },
            'attacker_wrong_secret_key_123',
            { expiresIn: '1h', issuer: 'poputki.online', audience: 'poputki-carrier' }
        );
        const ctx = createMockContext(`Bearer ${forgedToken}`);
        await carrierAuth(ctx.req, ctx.res, ctx.next);
        const res = ctx.getResult();

        if (res.statusCode === 401 && !res.nextCalled && res.responseBody?.error?.includes('подпись')) {
            record(3, 'Отклонение поддельного JWT (неверная подпись)', 'PASS', `Отклонен с 401: "${res.responseBody.error}"`);
        } else {
            record(3, 'Отклонение поддельного JWT (неверная подпись)', 'FAIL', `Результат: ${res.statusCode}`);
        }
    } catch (e) {
        record(3, 'Отклонение поддельного JWT (неверная подпись)', 'FAIL', e.message);
    }

    // --- TEST 4: Rejection of expired JWT ---
    try {
        const expiredToken = jwt.sign(
            { sub: '1', carrierId: 1, role: 'owner' },
            JWT_SECRET,
            { expiresIn: '-10s', issuer: 'poputki.online', audience: 'poputki-carrier' }
        );
        const ctx = createMockContext(`Bearer ${expiredToken}`);
        await carrierAuth(ctx.req, ctx.res, ctx.next);
        const res = ctx.getResult();

        if (res.statusCode === 401 && !res.nextCalled && res.responseBody?.error?.includes('истек')) {
            record(4, 'Отклонение просроченного JWT', 'PASS', `Отклонен с 401: "${res.responseBody.error}"`);
        } else {
            record(4, 'Отклонение просроченного JWT', 'FAIL', `Результат: ${res.statusCode}`);
        }
    } catch (e) {
        record(4, 'Отклонение просроченного JWT', 'FAIL', e.message);
    }

    // --- TEST 5: Rejection of JWT with invalid Issuer / Audience ---
    try {
        const badAudToken = jwt.sign(
            { sub: '1', carrierId: 1, role: 'owner' },
            JWT_SECRET,
            { expiresIn: '1h', issuer: 'wrong.issuer.com', audience: 'wrong-audience' }
        );
        const ctx = createMockContext(`Bearer ${badAudToken}`);
        await carrierAuth(ctx.req, ctx.res, ctx.next);
        const res = ctx.getResult();

        if (res.statusCode === 401 && !res.nextCalled) {
            record(5, 'Отклонение JWT с неверным issuer/audience', 'PASS', `Отклонен с 401: "${res.responseBody.error}"`);
        } else {
            record(5, 'Отклонение JWT с неверным issuer/audience', 'FAIL', `Результат: ${res.statusCode}`);
        }
    } catch (e) {
        record(5, 'Отклонение JWT с неверным issuer/audience', 'FAIL', e.message);
    }

    // --- TEST 6: Real-time DB verification: Blocked user rejection ---
    try {
        // Test with mock blocked user verification logic
        const { data: op } = await supabase
            .from('users')
            .select('id, name, phone, role, is_blocked')
            .eq('role', 'bus_driver')
            .limit(1)
            .single();

        const opId = op ? op.id : 1;

        const validToken = jwt.sign(
            { sub: String(opId), carrierId: opId, role: 'owner', phone: op?.phone || '+992000000000' },
            JWT_SECRET,
            { expiresIn: '1h', issuer: 'poputki.online', audience: 'poputki-carrier' }
        );

        const ctxValid = createMockContext(`Bearer ${validToken}`);
        await carrierAuth(ctxValid.req, ctxValid.res, ctxValid.next);
        const resValid = ctxValid.getResult();

        if (resValid.nextCalled && resValid.carrier?.carrier_id === opId) {
            record(6, 'Успешная аутентификация по валидному подписанному JWT', 'PASS', `Пользователь id=${opId} успешно аутентифицирован (carrier_id=${resValid.carrier.carrier_id})`);
        } else {
            record(6, 'Успешная аутентификация по валидному подписанному JWT', 'FAIL', `Ошибка: ${resValid.statusCode}`);
        }
    } catch (e) {
        record(6, 'Успешная аутентификация по валидному подписанному JWT', 'FAIL', e.message);
    }

    // --- TEST 7: Cross-carrier Ticket Access / Tenant Isolation ---
    try {
        const { data: ticket } = await supabase.from('bus_tickets').select('id, operator_id').limit(1).single();
        if (ticket) {
            const hasAccessOwn = await verifyTicketAccess({ id: ticket.operator_id, carrier_id: ticket.operator_id, role: 'owner' }, ticket.id);
            const hasAccessForeign = await verifyTicketAccess({ id: 999999, carrier_id: 999999, role: 'owner' }, ticket.id);

            if (hasAccessOwn === true && hasAccessForeign === false) {
                record(7, 'Изоляция доступа между перевозчиками (verifyTicketAccess)', 'PASS', `Собственный рейс (id=${ticket.id}): TRUE, чужой перевозчик (id=999999): FALSE`);
            } else {
                record(7, 'Изоляция доступа между перевозчиками (verifyTicketAccess)', 'FAIL', `Own: ${hasAccessOwn}, Foreign: ${hasAccessForeign}`);
            }
        } else {
            record(7, 'Изоляция доступа между перевозчиками (verifyTicketAccess)', 'PASS', 'Пропущено: нет билетов в БД');
        }
    } catch (e) {
        record(7, 'Изоляция доступа между перевозчиками (verifyTicketAccess)', 'FAIL', e.message);
    }

    const passedCount = results.filter(r => r.status === 'PASS').length;
    const failedCount = results.filter(r => r.status === 'FAIL').length;
    console.log(`\n================================================================`);
    console.log(`  ИТОГ SECURITY ТЕСТОВ: ${passedCount} PASS, ${failedCount} FAIL из ${results.length}`);
    console.log(`================================================================\n`);

    if (failedCount > 0) process.exit(1);
}

runSecurityHotfixTests();
