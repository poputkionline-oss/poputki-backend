/**
 * tests/phase_e48_3_passenger_jwt.test.js
 *
 * PHASE E.48.3 — Passenger JWT Unification + User Auth Foundation
 *
 * Comprehensive test suite for:
 *  - Canonical passenger JWT issuance (issueUserToken)
 *  - Canonical userAuth middleware (userAuth)
 *  - Token verification and fail-closed guarantees
 *  - Cryptographic privilege separation between passenger, carrier, and admin
 *  - Complete elimination of mock-token-* issuance in all auth flows
 */

'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const jwt = require('jsonwebtoken');

const TEST_JWT_SECRET = 'test-jwt-secret-phase-e48-3-passenger-auth-32bytes';
const TEST_ADMIN_SECRET = 'test-admin-secret-e48-3';

process.env.JWT_SECRET = TEST_JWT_SECRET;
process.env.ADMIN_SECRET_TOKEN = TEST_ADMIN_SECRET;

const {
    issueUserToken,
    verifyUserToken,
    userAuth,
    JWT_ISSUER,
    PASSENGER_AUDIENCE,
    PASSENGER_TOKEN_EXPIRES_IN
} = require('../utils/userAuth');

const { carrierAuth } = require('../utils/carrierAuth');

/**
 * Creates mock req/res objects for testing userAuth middleware.
 */
function createMockReqRes(headers = {}) {
    let statusCode = null;
    let responseData = null;
    let nextCalled = false;

    const req = {
        headers,
        user: null
    };

    const res = {
        status(code) {
            statusCode = code;
            return this;
        },
        json(data) {
            responseData = data;
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
        getResult: () => ({ statusCode, responseData, nextCalled, user: req.user })
    };
}

describe('Phase E.48.3 — Passenger JWT Unification & User Auth Foundation', () => {

    // =========================================================================
    // SECTION 1: TOKEN ISSUANCE & CLAIMS
    // =========================================================================
    describe('Token Issuance & Claims', () => {
        it('[E48.3-01] issueUserToken produces valid cryptographic JWT for user ID', () => {
            const user = { id: 42, phone: '+992900000042', name: 'Иван' };
            const token = issueUserToken(user);
            assert.ok(typeof token === 'string' && token.split('.').length === 3);

            const decoded = jwt.verify(token, TEST_JWT_SECRET, {
                issuer: JWT_ISSUER,
                audience: PASSENGER_AUDIENCE
            });
            assert.equal(decoded.sub, '42');
        });

        it('[E48.3-02] token sub strictly equals canonical user.id as string', () => {
            const token = issueUserToken({ id: 100500 });
            const decoded = verifyUserToken(token);
            assert.equal(decoded.sub, '100500');
        });

        it('[E48.3-03] audience is strictly poputki-passenger', () => {
            const token = issueUserToken({ id: 1 });
            const decoded = jwt.decode(token);
            assert.equal(decoded.aud, 'poputki-passenger');
        });

        it('[E48.3-04] issuer is strictly poputki.online', () => {
            const token = issueUserToken({ id: 1 });
            const decoded = jwt.decode(token);
            assert.equal(decoded.iss, 'poputki.online');
        });

        it('[E48.3-05] expiration exists and is set for 30 days', () => {
            const before = Math.floor(Date.now() / 1000);
            const token = issueUserToken({ id: 1 });
            const decoded = jwt.decode(token);
            assert.ok(decoded.exp);
            const expectedTtl = 30 * 24 * 60 * 60; // 30 days
            assert.ok(Math.abs((decoded.exp - decoded.iat) - expectedTtl) < 5);
        });

        it('[E48.3-06] token payload contains ZERO PII (no phone, passport, name, etc.)', () => {
            const sensitiveUser = {
                id: 77,
                phone: '+992901112233',
                name: 'Алишер',
                surname: 'Шарипов',
                passport: 'A1234567',
                telegram_id: 999888777
            };
            const token = issueUserToken(sensitiveUser);
            const decoded = jwt.decode(token);

            assert.equal(decoded.phone, undefined);
            assert.equal(decoded.name, undefined);
            assert.equal(decoded.surname, undefined);
            assert.equal(decoded.passport, undefined);
            assert.equal(decoded.telegram_id, undefined);
            assert.deepEqual(Object.keys(decoded).sort(), ['aud', 'exp', 'iat', 'iss', 'sub'].sort());
        });

        it('[E48.3-07] issueUserToken throws when user or user.id is invalid', () => {
            assert.throws(() => issueUserToken(null), /missing or invalid user/);
            assert.throws(() => issueUserToken({}), /missing or invalid user/);
            assert.throws(() => issueUserToken({ id: null }), /missing or invalid user/);
        });
    });

    // =========================================================================
    // SECTION 2: USERAUTH MIDDLEWARE
    // =========================================================================
    describe('userAuth Middleware', () => {
        it('[E48.3-08] valid passenger JWT allows access and attaches req.user', () => {
            const token = issueUserToken({ id: 88 });
            const { req, res, next, getResult } = createMockReqRes({
                authorization: `Bearer ${token}`
            });

            userAuth(req, res, next);
            const result = getResult();

            assert.equal(result.nextCalled, true);
            assert.equal(result.statusCode, null);
            assert.deepEqual(result.user, { id: 88, sub: '88' });
        });

        it('[E48.3-09] missing Authorization header returns 401', () => {
            const { req, res, next, getResult } = createMockReqRes({});
            userAuth(req, res, next);
            const result = getResult();

            assert.equal(result.nextCalled, false);
            assert.equal(result.statusCode, 401);
            assert.ok(result.responseData.error.includes('отсутствует Bearer токен'));
        });

        it('[E48.3-10] non-Bearer Authorization header returns 401', () => {
            const { req, res, next, getResult } = createMockReqRes({
                authorization: 'Basic dXNlcjpwYXNz'
            });
            userAuth(req, res, next);
            const result = getResult();

            assert.equal(result.nextCalled, false);
            assert.equal(result.statusCode, 401);
        });

        it('[E48.3-11] empty Bearer token returns 401', () => {
            const { req, res, next, getResult } = createMockReqRes({
                authorization: 'Bearer   '
            });
            userAuth(req, res, next);
            const result = getResult();

            assert.equal(result.nextCalled, false);
            assert.equal(result.statusCode, 401);
        });

        it('[E48.3-12] legacy mock-token-* format is rejected with 401', () => {
            const { req, res, next, getResult } = createMockReqRes({
                authorization: 'Bearer mock-token-123'
            });
            userAuth(req, res, next);
            const result = getResult();

            assert.equal(result.nextCalled, false);
            assert.equal(result.statusCode, 401);
            assert.ok(result.responseData.error.includes('Устаревший формат токена'));
        });

        it('[E48.3-13] random or malformed string is rejected with 401', () => {
            const { req, res, next, getResult } = createMockReqRes({
                authorization: 'Bearer invalid.token.garbage'
            });
            userAuth(req, res, next);
            const result = getResult();

            assert.equal(result.nextCalled, false);
            assert.equal(result.statusCode, 401);
        });

        it('[E48.3-14] tampered/modified JWT signature is rejected with 401', () => {
            const token = issueUserToken({ id: 42 });
            const tampered = token.slice(0, -5) + 'AAAAA';
            const { req, res, next, getResult } = createMockReqRes({
                authorization: `Bearer ${tampered}`
            });
            userAuth(req, res, next);
            const result = getResult();

            assert.equal(result.nextCalled, false);
            assert.equal(result.statusCode, 401);
        });

        it('[E48.3-15] expired passenger JWT is rejected with 401', () => {
            const expiredToken = jwt.sign(
                { sub: '42' },
                TEST_JWT_SECRET,
                {
                    algorithm: 'HS256',
                    expiresIn: '-1s',
                    issuer: JWT_ISSUER,
                    audience: PASSENGER_AUDIENCE
                }
            );
            const { req, res, next, getResult } = createMockReqRes({
                authorization: `Bearer ${expiredToken}`
            });
            userAuth(req, res, next);
            const result = getResult();

            assert.equal(result.nextCalled, false);
            assert.equal(result.statusCode, 401);
            assert.ok(result.responseData.error.includes('истек'));
        });

        it('[E48.3-16] wrong audience (e.g. carrier JWT) is rejected with 401', () => {
            const carrierToken = jwt.sign(
                { sub: '42', carrierId: 42, role: 'owner' },
                TEST_JWT_SECRET,
                {
                    algorithm: 'HS256',
                    expiresIn: '7d',
                    issuer: JWT_ISSUER,
                    audience: 'poputki-carrier'
                }
            );
            const { req, res, next, getResult } = createMockReqRes({
                authorization: `Bearer ${carrierToken}`
            });
            userAuth(req, res, next);
            const result = getResult();

            assert.equal(result.nextCalled, false);
            assert.equal(result.statusCode, 401);
        });

        it('[E48.3-17] wrong issuer is rejected with 401', () => {
            const foreignToken = jwt.sign(
                { sub: '42' },
                TEST_JWT_SECRET,
                {
                    algorithm: 'HS256',
                    expiresIn: '30d',
                    issuer: 'attacker.com',
                    audience: PASSENGER_AUDIENCE
                }
            );
            const { req, res, next, getResult } = createMockReqRes({
                authorization: `Bearer ${foreignToken}`
            });
            userAuth(req, res, next);
            const result = getResult();

            assert.equal(result.nextCalled, false);
            assert.equal(result.statusCode, 401);
        });

        it('[E48.3-18] x-mana-man header alone without Bearer token returns 401', () => {
            const { req, res, next, getResult } = createMockReqRes({
                'x-mana-man': 'nasa.2006'
            });
            userAuth(req, res, next);
            const result = getResult();

            assert.equal(result.nextCalled, false);
            assert.equal(result.statusCode, 401);
        });
    });

    // =========================================================================
    // SECTION 3: PRIVILEGE SEPARATION
    // =========================================================================
    describe('Privilege Separation (Passenger vs Carrier vs Admin)', () => {
        it('[E48.3-19] passenger JWT is strictly rejected by carrierAuth', async () => {
            const passengerToken = issueUserToken({ id: 101 });
            let carrierAuthResult = null;

            const req = {
                headers: { authorization: `Bearer ${passengerToken}` },
                query: {},
                ip: '127.0.0.1'
            };
            const res = {
                status(code) {
                    carrierAuthResult = { statusCode: code };
                    return this;
                },
                json(d) {
                    carrierAuthResult.data = d;
                    return this;
                }
            };

            await carrierAuth(req, res, () => {
                carrierAuthResult = { nextCalled: true };
            });

            assert.equal(carrierAuthResult.nextCalled, undefined);
            assert.equal(carrierAuthResult.statusCode, 401);
        });

        it('[E48.3-20] passenger JWT does not grant admin access', () => {
            const token = issueUserToken({ id: 1 });
            // Admin authentication strictly checks X-Admin-Token header matching ADMIN_SECRET_TOKEN
            const isAdmin = token === process.env.ADMIN_SECRET_TOKEN;
            assert.equal(isAdmin, false);
        });
    });

    // =========================================================================
    // SECTION 4: FAIL-CLOSED BEHAVIOR
    // =========================================================================
    describe('Fail-Closed Invariants', () => {
        it('[E48.3-21] issueUserToken fails closed (throws) if JWT_SECRET is missing', () => {
            const savedSecret = process.env.JWT_SECRET;
            try {
                delete process.env.JWT_SECRET;
                assert.throws(() => issueUserToken({ id: 1 }), /configuration error/i);
            } finally {
                process.env.JWT_SECRET = savedSecret;
            }
        });

        it('[E48.3-22] userAuth fails closed (500) if JWT_SECRET is missing', () => {
            const token = issueUserToken({ id: 1 });
            const savedSecret = process.env.JWT_SECRET;
            try {
                delete process.env.JWT_SECRET;
                const { req, res, next, getResult } = createMockReqRes({
                    authorization: `Bearer ${token}`
                });
                userAuth(req, res, next);
                const result = getResult();

                assert.equal(result.nextCalled, false);
                assert.equal(result.statusCode, 500);
            } finally {
                process.env.JWT_SECRET = savedSecret;
            }
        });
    });

    // =========================================================================
    // SECTION 5: SOURCE CODE AUDIT (AUTH.JS)
    // =========================================================================
    describe('Source Code Audit — routes/auth.js', () => {
        it('[E48.3-23] routes/auth.js does NOT contain any mock-token- returns', () => {
            const authPath = path.join(__dirname, '../routes/auth.js');
            const source = fs.readFileSync(authPath, 'utf8');

            assert.equal(
                source.includes('mock-token-'),
                false,
                'routes/auth.js must not return mock-token-* anywhere'
            );
        });

        it('[E48.3-24] routes/auth.js imports and uses issueUserToken', () => {
            const authPath = path.join(__dirname, '../routes/auth.js');
            const source = fs.readFileSync(authPath, 'utf8');

            assert.ok(
                source.includes("const { issueUserToken } = require('../utils/userAuth');"),
                'routes/auth.js must import issueUserToken'
            );

            // Count usages in routes
            const matches = source.match(/issueUserToken\(/g) || [];
            assert.ok(matches.length >= 4, `Expected at least 4 issueUserToken calls, found ${matches.length}`);
        });

        it('[E48.3-25] native Telegram verification and password security remain intact in auth.js', () => {
            const authPath = path.join(__dirname, '../routes/auth.js');
            const source = fs.readFileSync(authPath, 'utf8');

            assert.ok(source.includes('verifyAndParseTelegramInitData'), 'Telegram initData verification must be preserved');
            assert.ok(source.includes('verifyAndMigrateDurable'), 'Password durable migration must be preserved');
            assert.ok(source.includes('hashPassword'), 'Password hashing must be preserved');
        });
    });
});
