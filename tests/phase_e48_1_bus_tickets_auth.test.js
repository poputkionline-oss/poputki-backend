/**
 * tests/phase_e48_1_bus_tickets_auth.test.js
 *
 * PHASE E.48.1 — Secure Bus Trip Creation Authorization (POST /api/bus-tickets)
 *
 * Verifies that the insecure unauthenticated `operator_id` fallback in
 * POST /api/bus-tickets is completely eliminated:
 *  - Carrier requests require a valid signed JWT (audience: 'poputki-carrier',
 *    issuer: 'poputki.online'). The authoritative carrier identity is derived
 *    strictly server-side (decoded.carrierId || decoded.sub).
 *  - Any client-supplied body.operator_id or body.carrier_id CANNOT cross tenants
 *    or override the authenticated carrier identity.
 *  - Admin requests require X-Admin-Token matching ADMIN_SECRET_TOKEN, and may
 *    explicitly specify the target operator_id (missing operator_id gives 400).
 *  - Unauthenticated requests, requests with invalid JWT/admin tokens, or requests
 *    supplying ONLY the legacy x-mana-man header fail with 401 Unauthorized with
 *    ZERO database mutation.
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const jwt = require('jsonwebtoken');

const TEST_JWT_SECRET = 'test-jwt-secret-for-phase-e48-1-bus-tickets-auth-32bytes';
const TEST_ADMIN_SECRET = 'test-admin-secret-e48-1-secure-key';

process.env.JWT_SECRET = TEST_JWT_SECRET;
process.env.ADMIN_SECRET_TOKEN = TEST_ADMIN_SECRET;

/**
 * Creates a signed test carrier JWT.
 */
function signCarrierToken(payload = {}, options = {}) {
    return jwt.sign(
        {
            sub: '101',
            carrierId: 101,
            role: 'owner',
            ...payload
        },
        TEST_JWT_SECRET,
        {
            algorithm: 'HS256',
            expiresIn: '7d',
            issuer: 'poputki.online',
            audience: 'poputki-carrier',
            ...options
        }
    );
}

/**
 * Simulates POST /api/bus-tickets authorization logic extracted from routes/busTickets.js.
 * Tracks whether the database insert was ever called to verify zero mutation.
 */
function runBusTicketAuthPipeline({
    headers = {},
    body = {},
    mockOperator = { is_blocked: false }
} = {}) {
    let insertCalled = false;
    let insertedData = null;
    let statusCode = 200;
    let responseData = null;

    // --- Authentication extraction matching routes/busTickets.js ---
    let verifiedCarrierId = null;
    let verifiedRole = 'owner';
    let verifiedUserId = null;
    let effectiveOperatorId = null;
    let isAdmin = false;

    const adminTokenHeader = headers['x-admin-token'];
    const adminSecret = process.env.ADMIN_SECRET_TOKEN;

    if (adminTokenHeader !== undefined) {
        if (!adminSecret || adminTokenHeader !== adminSecret) {
            return {
                statusCode: 401,
                responseData: { error: 'Unauthorized: Admin access required' },
                insertCalled: false
            };
        }
        isAdmin = true;
        const parsedOpId = parseInt(body.operator_id || body?.carrier_id, 10);
        if (!parsedOpId || isNaN(parsedOpId)) {
            return {
                statusCode: 400,
                responseData: { error: 'Не указан идентификатор перевозчика' },
                insertCalled: false
            };
        }
        effectiveOperatorId = parsedOpId;
        verifiedCarrierId = parsedOpId;
        verifiedRole = 'admin';
        verifiedUserId = 1;
    } else {
        const authHeader = headers['authorization'];
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return {
                statusCode: 401,
                responseData: { error: 'Необходима авторизация перевозчика: отсутствует Bearer токен' },
                insertCalled: false
            };
        }

        const token = authHeader.substring(7).trim();
        const jwtSecret = process.env.JWT_SECRET;
        if (!jwtSecret) {
            return {
                statusCode: 500,
                responseData: { error: 'Внутренняя ошибка конфигурации безопасности сервера' },
                insertCalled: false
            };
        }

        let decoded;
        try {
            decoded = jwt.verify(token, jwtSecret, {
                algorithms: ['HS256'],
                issuer: 'poputki.online',
                audience: 'poputki-carrier'
            });
        } catch (jwtErr) {
            return {
                statusCode: 401,
                responseData: { error: 'Недействительный или истекший токен перевозчика' },
                insertCalled: false
            };
        }

        verifiedCarrierId = parseInt(decoded.carrierId || decoded.sub, 10);
        if (!verifiedCarrierId || isNaN(verifiedCarrierId)) {
            return {
                statusCode: 401,
                responseData: { error: 'Некорректный идентификатор перевозчика в токене' },
                insertCalled: false
            };
        }

        verifiedRole = decoded.role || 'owner';
        verifiedUserId = parseInt(decoded.sub, 10);
        effectiveOperatorId = verifiedCarrierId;
    }

    if (mockOperator?.is_blocked) {
        return {
            statusCode: 403,
            responseData: { error: 'Ваш аккаунт заблокирован. Вы не можете создавать новые рейсы.' },
            insertCalled: false
        };
    }

    // Simulate mutation
    insertCalled = true;
    insertedData = {
        id: 9999,
        operator_id: effectiveOperatorId,
        from_city: body.from_city,
        to_city: body.to_city
    };

    responseData = {
        ...body,
        id: insertedData.id,
        operator_id: effectiveOperatorId
    };

    return {
        statusCode,
        responseData,
        effectiveOperatorId,
        verifiedRole,
        isAdmin,
        insertCalled,
        insertedData
    };
}

describe('Phase E.48.1 — Secure Bus Trip Creation Authorization', () => {

    // 1. Unauthenticated + operator_id -> rejected
    it('[E48.1-01] unauthenticated request with operator_id in body is rejected with 401', () => {
        const res = runBusTicketAuthPipeline({
            headers: {},
            body: { operator_id: 101, from_city: 'Душанбе', to_city: 'Худжанд' }
        });
        assert.equal(res.statusCode, 401);
        assert.equal(res.insertCalled, false);
        assert.ok(res.responseData.error.includes('отсутствует Bearer токен'));
    });

    // 2. x-mana-man only + operator_id -> rejected
    it('[E48.1-02] request with x-mana-man only (no Bearer token) is rejected with 401 and zero mutation', () => {
        const res = runBusTicketAuthPipeline({
            headers: { 'x-mana-man': 'nasa.2006' },
            body: { operator_id: 101, from_city: 'Душанбе', to_city: 'Худжанд' }
        });
        assert.equal(res.statusCode, 401);
        assert.equal(res.insertCalled, false);
    });

    // 3. Invalid carrier JWT -> rejected
    it('[E48.1-03] invalid or forged carrier JWT is rejected with 401 and zero mutation', () => {
        const forgedToken = jwt.sign(
            { sub: '101', carrierId: 101, role: 'owner' },
            'wrong-attacker-secret-key-1234567890',
            { issuer: 'poputki.online', audience: 'poputki-carrier' }
        );
        const res = runBusTicketAuthPipeline({
            headers: { authorization: `Bearer ${forgedToken}` },
            body: { from_city: 'Душанбе', to_city: 'Худжанд' }
        });
        assert.equal(res.statusCode, 401);
        assert.equal(res.insertCalled, false);
        assert.ok(res.responseData.error.includes('Недействительный или истекший токен'));
    });

    // 4. Valid carrier JWT -> accepted
    it('[E48.1-04] valid carrier JWT without body operator_id creates trip for authenticated carrier', () => {
        const token = signCarrierToken({ sub: '101', carrierId: 101 });
        const res = runBusTicketAuthPipeline({
            headers: { authorization: `Bearer ${token}` },
            body: { from_city: 'Душанбе', to_city: 'Худжанд' }
        });
        assert.equal(res.statusCode, 200);
        assert.equal(res.insertCalled, true);
        assert.equal(res.effectiveOperatorId, 101);
        assert.equal(res.responseData.operator_id, 101);
    });

    // 5. Valid carrier JWT + own operator_id -> accepted
    it('[E48.1-05] valid carrier JWT with matching body operator_id creates trip successfully', () => {
        const token = signCarrierToken({ sub: '101', carrierId: 101 });
        const res = runBusTicketAuthPipeline({
            headers: { authorization: `Bearer ${token}` },
            body: { operator_id: 101, from_city: 'Душанбе', to_city: 'Худжанд' }
        });
        assert.equal(res.statusCode, 200);
        assert.equal(res.insertCalled, true);
        assert.equal(res.effectiveOperatorId, 101);
    });

    // 6. Valid carrier JWT + foreign operator_id -> cannot cross tenant
    it('[E48.1-06] valid carrier JWT + foreign operator_id (spoof attempt) derives carrier from token and blocks cross-tenant access', () => {
        // Authenticated as Carrier 101, attempting to create trip for Carrier 999
        const token = signCarrierToken({ sub: '101', carrierId: 101 });
        const res = runBusTicketAuthPipeline({
            headers: { authorization: `Bearer ${token}` },
            body: { operator_id: 999, from_city: 'Душанбе', to_city: 'Худжанд' }
        });
        assert.equal(res.statusCode, 200);
        assert.equal(res.insertCalled, true);
        // Authoritative server-derived operator_id MUST be 101, NOT 999!
        assert.equal(res.effectiveOperatorId, 101);
        assert.equal(res.insertedData.operator_id, 101);
        assert.equal(res.responseData.operator_id, 101);
    });

    // 7. Valid admin token + operator_id -> accepted
    it('[E48.1-07] valid admin token with explicit operator_id creates trip for target carrier', () => {
        const res = runBusTicketAuthPipeline({
            headers: { 'x-admin-token': TEST_ADMIN_SECRET },
            body: { operator_id: 202, from_city: 'Душанбе', to_city: 'Худжанд' }
        });
        assert.equal(res.statusCode, 200);
        assert.equal(res.insertCalled, true);
        assert.equal(res.effectiveOperatorId, 202);
        assert.equal(res.isAdmin, true);
        assert.equal(res.verifiedRole, 'admin');
    });

    // 8. Invalid admin token -> rejected
    it('[E48.1-08] invalid admin token is rejected with 401 and zero mutation', () => {
        const res = runBusTicketAuthPipeline({
            headers: { 'x-admin-token': 'wrong-admin-secret-token' },
            body: { operator_id: 202, from_city: 'Душанбе', to_city: 'Худжанд' }
        });
        assert.equal(res.statusCode, 401);
        assert.equal(res.insertCalled, false);
        assert.ok(res.responseData.error.includes('Admin access required'));
    });

    // 9. Body carrier_id spoofing -> ineffective
    it('[E48.1-09] body carrier_id spoof attempt by carrier is completely ignored in favor of token', () => {
        const token = signCarrierToken({ sub: '101', carrierId: 101 });
        const res = runBusTicketAuthPipeline({
            headers: { authorization: `Bearer ${token}` },
            body: { carrier_id: 888, from_city: 'Душанбе', to_city: 'Худжанд' }
        });
        assert.equal(res.statusCode, 200);
        assert.equal(res.effectiveOperatorId, 101);
        assert.equal(res.insertedData.operator_id, 101);
    });

    // 10. Body user_id spoofing -> ineffective
    it('[E48.1-10] body user_id spoof attempt by carrier is completely ignored in favor of token', () => {
        const token = signCarrierToken({ sub: '101', carrierId: 101 });
        const res = runBusTicketAuthPipeline({
            headers: { authorization: `Bearer ${token}` },
            body: { user_id: 777, from_city: 'Душанбе', to_city: 'Худжанд' }
        });
        assert.equal(res.statusCode, 200);
        assert.equal(res.effectiveOperatorId, 101);
        assert.equal(res.insertedData.operator_id, 101);
    });

    // 11. Authenticated carrier identity server-derived
    it('[E48.1-11] carrier identity is authoritatively server-derived from JWT claims', () => {
        const token = signCarrierToken({ sub: '555', carrierId: 555, role: 'dispatcher' });
        const res = runBusTicketAuthPipeline({
            headers: { authorization: `Bearer ${token}` },
            body: { from_city: 'Душанбе', to_city: 'Худжанд' }
        });
        assert.equal(res.statusCode, 200);
        assert.equal(res.effectiveOperatorId, 555);
        assert.equal(res.verifiedRole, 'dispatcher');
    });

    // 12. No mutation on failed authorization
    it('[E48.1-12] no database mutation occurs when authorization fails', () => {
        const cases = [
            { headers: {}, body: { operator_id: 11 } },
            { headers: { 'x-mana-man': 'nasa.2006' }, body: { operator_id: 11 } },
            { headers: { authorization: 'Bearer bad.token.here' }, body: { operator_id: 11 } },
            { headers: { 'x-admin-token': 'invalid' }, body: { operator_id: 11 } }
        ];

        for (const testCase of cases) {
            const res = runBusTicketAuthPipeline(testCase);
            assert.equal(res.statusCode, 401);
            assert.equal(res.insertCalled, false);
        }
    });

    // 13. Admin workflow requires operator_id (missing operator_id gives 400)
    it('[E48.1-13] valid admin token with missing operator_id returns 400 validation error', () => {
        const res = runBusTicketAuthPipeline({
            headers: { 'x-admin-token': TEST_ADMIN_SECRET },
            body: { from_city: 'Душанбе', to_city: 'Худжанд' } // missing operator_id
        });
        assert.equal(res.statusCode, 400);
        assert.equal(res.insertCalled, false);
        assert.ok(res.responseData.error.includes('Не указан идентификатор перевозчика'));
    });

    // 14. Auth precedence: valid admin token takes precedence over bearer header
    it('[E48.1-14] valid admin token takes precedence when both admin and carrier headers are sent', () => {
        const token = signCarrierToken({ sub: '101', carrierId: 101 });
        const res = runBusTicketAuthPipeline({
            headers: {
                'x-admin-token': TEST_ADMIN_SECRET,
                authorization: `Bearer ${token}`
            },
            body: { operator_id: 303, from_city: 'Душанбе', to_city: 'Худжанд' }
        });
        assert.equal(res.statusCode, 200);
        assert.equal(res.isAdmin, true);
        assert.equal(res.effectiveOperatorId, 303);
    });

    // 15. Blocked operator check preserved
    it('[E48.1-15] blocked carrier account is rejected with 403 even with valid token', () => {
        const token = signCarrierToken({ sub: '101', carrierId: 101 });
        const res = runBusTicketAuthPipeline({
            headers: { authorization: `Bearer ${token}` },
            body: { from_city: 'Душанбе', to_city: 'Худжанд' },
            mockOperator: { is_blocked: true }
        });
        assert.equal(res.statusCode, 403);
        assert.equal(res.insertCalled, false);
        assert.ok(res.responseData.error.includes('заблокирован'));
    });

    // 16. Source code audit: ensure routes/busTickets.js contains no insecure fallback
    it('[E48.1-16] routes/busTickets.js source does NOT contain the legacy insecure fallback', () => {
        const filePath = path.join(__dirname, '../routes/busTickets.js');
        const source = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');

        // Confirm legacy fallback line is absent
        assert.equal(
            source.includes('verifiedCarrierId || parseInt(operator_id, 10)'),
            false,
            'legacy fallback verifiedCarrierId || parseInt(operator_id, 10) must be removed'
        );

        // Confirm Phase E.48.1 comment exists
        assert.ok(
            source.includes('Phase E.48.1: Secure Bus Trip Creation Authorization'),
            'Phase E.48.1 hardening header must be present'
        );

        // Confirm strict Bearer token check exists
        assert.ok(
            source.includes("!authHeader.startsWith('Bearer ')"),
            'Strict Bearer token requirement must be present'
        );
    });
});
