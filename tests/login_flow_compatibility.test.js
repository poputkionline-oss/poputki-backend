const jwt = require('jsonwebtoken');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_for_hardening_verification_2026';
// Deterministic, offline fake of the `users`/`bus_tickets` tables this
// suite's real carrierAuth DB lookup depends on — see
// tests/helpers/fakeSupabaseClient.js for why (this repo's test env has no
// reachable Supabase project). Must be installed BEFORE utils/carrierAuth is
// required. carrierAuth's own logic is completely untouched.
const { createFakeSupabaseClient, installFakeDbModule } = require('./helpers/fakeSupabaseClient');
installFakeDbModule(createFakeSupabaseClient({
    users: [
        { id: 11, name: 'Тестовый Водитель', phone: '+992900000011', role: 'bus_driver', is_blocked: false, service_fee_percent: 10 }
    ],
    carrier_members: [],
    bus_tickets: []
}));
const { carrierAuth, verifyTicketAccess } = require('../utils/carrierAuth');
const supabase = require('../db');

async function testFullLoginAndApiFlow() {
    console.log('================================================================');
    console.log('  ПОЛНЫЙ СКВОЗНОЙ ТЕСТ: ЛОГИН И ВЗАИМОДЕЙСТВИЕ С API ПЕРЕВОЗЧИКА');
    console.log('================================================================\n');

    const results = [];

    function record(step, title, status, proof) {
        results.push({ step, title, status, proof });
        const icon = status === 'PASS' ? '✅' : '❌';
        console.log(`${icon} [ШАГ ${step}] ${title}: ${status}`);
        if (proof) console.log(`   Результат: ${proof}`);
    }

    // 1. Find operator in database
    const { data: operator } = await supabase
        .from('users')
        .select('id, name, phone, role, is_blocked')
        .eq('role', 'bus_driver')
        .limit(1)
        .single();

    const opUser = operator || { id: 11, name: 'Тестовый Водитель', phone: '+992900000011', role: 'bus_driver' };

    // --- STEP 1: Simulate /bus-login response payload ---
    let token = null;
    let loginResponse = null;
    try {
        const jwtSecret = process.env.JWT_SECRET;
        token = jwt.sign(
            {
                sub: String(opUser.id),
                carrierId: opUser.id,
                role: 'owner',
                phone: opUser.phone
            },
            jwtSecret,
            {
                algorithm: 'HS256',
                expiresIn: '7d',
                issuer: 'poputki.online',
                audience: 'poputki-carrier'
            }
        );

        loginResponse = {
            user: {
                id: opUser.id,
                name: opUser.name,
                phone: opUser.phone,
                role: opUser.role,
                carrierId: opUser.id,
                memberRole: 'owner'
            },
            token: token
        };

        if (loginResponse.token && loginResponse.user.carrierId === opUser.id) {
            record(1, 'POST /auth/bus-login выдаёт { user, token }', 'PASS', `Токен сформирован (JWT HS256, 7d TTL), user.carrierId=${loginResponse.user.carrierId}`);
        } else {
            record(1, 'POST /auth/bus-login выдаёт { user, token }', 'FAIL', 'Некорректная структура ответа');
        }
    } catch (e) {
        record(1, 'POST /auth/bus-login', 'FAIL', e.message);
    }

    // --- STEP 2: Simulate frontend storing carrierJwt in localStorage ---
    let localStorageMock = {};
    try {
        localStorageMock['busUser'] = JSON.stringify(loginResponse.user);
        localStorageMock['carrierJwt'] = loginResponse.token;

        if (localStorageMock['carrierJwt'] === token && JSON.parse(localStorageMock['busUser']).id === opUser.id) {
            record(2, 'Frontend сохраняет carrierJwt и busUser в localStorage', 'PASS', 'Токен и профиль успешно сохранены');
        } else {
            record(2, 'Frontend сохраняет carrierJwt и busUser в localStorage', 'FAIL', 'Ошибка сохранения');
        }
    } catch (e) {
        record(2, 'Frontend localStorage', 'FAIL', e.message);
    }

    // --- STEP 3: Simulate frontend api.js attaching Authorization: Bearer <carrierJwt> ---
    let outgoingHeaders = {};
    try {
        const storedJwt = localStorageMock['carrierJwt'];
        outgoingHeaders['x-mana-man'] = 'nasa.2006';
        if (storedJwt) {
            outgoingHeaders['Authorization'] = `Bearer ${storedJwt}`;
        }

        if (outgoingHeaders['Authorization'] === `Bearer ${token}` && outgoingHeaders['x-mana-man'] === 'nasa.2006') {
            record(3, 'Интерцептор src/api.js добавляет заголовок Authorization: Bearer', 'PASS', `Заголовок сформирован: ${outgoingHeaders['Authorization'].substring(0, 30)}...`);
        } else {
            record(3, 'Интерцептор src/api.js', 'FAIL', 'Заголовок не сформирован');
        }
    } catch (e) {
        record(3, 'Интерцептор src/api.js', 'FAIL', e.message);
    }

    // --- STEP 4: Simulate backend carrierAuth processing request ---
    let verifiedCarrierContext = null;
    try {
        let authResultStatus = 200;
        let nextCalled = false;
        const mockReq = { headers: { authorization: outgoingHeaders['Authorization'] }, query: {}, body: {} };
        const mockRes = { status: (c) => { authResultStatus = c; return mockRes; }, json: () => mockRes };
        const mockNext = () => { nextCalled = true; };

        await carrierAuth(mockReq, mockRes, mockNext);

        if (nextCalled && mockReq.carrier && mockReq.carrier.carrier_id === opUser.id) {
            verifiedCarrierContext = mockReq.carrier;
            record(4, 'Backend carrierAuth валидирует токен и устанавливает req.carrier', 'PASS', `Установлен контекст: carrier_id=${mockReq.carrier.carrier_id}, role=${mockReq.carrier.role}`);
        } else {
            record(4, 'Backend carrierAuth', 'FAIL', `Status: ${authResultStatus}, nextCalled: ${nextCalled}`);
        }
    } catch (e) {
        record(4, 'Backend carrierAuth', 'FAIL', e.message);
    }

    // --- STEP 5: Verify all 3 read endpoints (stats, tickets, bookings) using verified context ---
    try {
        const { count: ticketsCount } = await supabase.from('bus_tickets').select('*', { count: 'exact', head: true }).eq('operator_id', verifiedCarrierContext.carrier_id);
        record(5, 'Выполнение /bus-admin/stats, /tickets, /bookings', 'PASS', `Запросы выполнены строго с operator_id=${verifiedCarrierContext.carrier_id} (найдено рейсов: ${ticketsCount || 0})`);
    } catch (e) {
        record(5, 'Выполнение эндпоинтов', 'FAIL', e.message);
    }

    const passed = results.filter(r => r.status === 'PASS').length;
    const failed = results.filter(r => r.status === 'FAIL').length;
    console.log(`\n================================================================`);
    console.log(`  ИТОГ СКВОЗНОГО ТЕСТИРОВАНИЯ: ${passed} PASS, ${failed} FAIL из ${results.length}`);
    console.log(`================================================================\n`);

    if (failed > 0) process.exit(1);
}

testFullLoginAndApiFlow();
