/**
 * tests/phase_e48_5_carpool_authorization.test.js
 *
 * PHASE E.48.5 — Carpool Rides & Bookings Authorization Test Suite
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const jwt = require('jsonwebtoken');

const TEST_JWT_SECRET = 'test-jwt-secret-phase-e48-5-carpool-auth-32bytes';
const TEST_BOT_SERVICE_TOKEN = 'test-bot-token-e48-5-carpool-service';

process.env.JWT_SECRET = TEST_JWT_SECRET;
process.env.BOT_SERVICE_TOKEN = TEST_BOT_SERVICE_TOKEN;

const {
    issueUserToken,
    userAuth,
    optionalUserAuth,
    JWT_ISSUER,
    PASSENGER_AUDIENCE
} = require('../utils/userAuth');

const { verifyBotServiceToken } = require('../utils/botAuth');
const ridesRouter = require('../routes/rides');
const bookingsRouter = require('../routes/bookings');

/**
 * Helper to generate a carrier token for cross-privilege tests.
 */
function issueCarrierToken(carrierId = 11) {
    return jwt.sign(
        { sub: String(carrierId), carrierId, role: 'owner' },
        TEST_JWT_SECRET,
        { algorithm: 'HS256', expiresIn: '7d', issuer: JWT_ISSUER, audience: 'poputki-carrier' }
    );
}

/**
 * Mock req/res generator.
 */
function createMockReqRes(method = 'GET', url = '/', headers = {}, body = {}, params = {}, query = {}) {
    let statusCode = null;
    let responseData = null;
    let nextCalled = false;

    const req = {
        method,
        url,
        headers,
        body,
        params,
        query,
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
        },
        send(data) {
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

describe('Phase E.48.5 — Carpool Rides & Bookings Authorization', () => {

    // =========================================================================
    // SECTION 1: PUBLIC RIDE CATALOG & DETAILS PRIVACY
    // =========================================================================
    describe('1. Public Catalog & Details Privacy', () => {
        it('[E48.5-01] GET /api/rides does NOT require userAuth (catalog remains publicly discoverable)', () => {
            const layer = ridesRouter.stack.find(l => l.route && l.route.path === '/' && l.route.methods.get);
            assert.ok(layer, 'GET / route must exist');
            // Ensure userAuth is not blocking GET /
            assert.notEqual(layer.route.stack[0].handle, userAuth);
        });

        it('[E48.5-02] GET /api/rides source code scrubs driver_phone from public list items', () => {
            const source = fs.readFileSync(path.join(__dirname, '../routes/rides.js'), 'utf8');
            const getCatalogMatch = source.match(/router\.get\('\/'[\s\S]*?res\.json\(formattedRides\)\;/);
            assert.ok(getCatalogMatch);
            const listBlock = getCatalogMatch[0];
            assert.equal(listBlock.includes('driver_phone: driverPhone'), false, 'driver_phone must be omitted from public catalog');
        });

        it('[E48.5-03] GET /api/rides/:id uses optionalUserAuth and hides driver_phone from non-booked users', () => {
            const source = fs.readFileSync(path.join(__dirname, '../routes/rides.js'), 'utf8');
            const getDetailsMatch = source.match(/router\.get\('\/:id'[\s\S]*?res\.json\(\{ \.\.\.ride, vehicle, bookings \}\)\;/);
            assert.ok(getDetailsMatch);
            const detailsBlock = getDetailsMatch[0];

            assert.ok(detailsBlock.includes('optionalUserAuth'));
            assert.ok(detailsBlock.includes('driver_phone: (isDriver || hasBooked) ? driverPhone : undefined'));
            assert.ok(detailsBlock.includes('passenger_phone: isDriver ? pData.phone : undefined'));
        });
    });

    // =========================================================================
    // SECTION 2: DRIVER OPERATIONS & OWNERSHIP (POST, PUT, COMPLETE, CANCEL, MY)
    // =========================================================================
    describe('2. Driver Operations & Ownership', () => {
        it('[E48.5-04] POST /api/rides rejects unauthenticated request without token or bot secret', async () => {
            const { req, res, getResult } = createMockReqRes('POST', '/', {
                'x-mana-man': 'nasa.2006'
            }, { from_city: 'Душанбе', to_city: 'Худжанд' });

            const layer = ridesRouter.stack.find(l => l.route && l.route.path === '/' && l.route.methods.post);
            const handler = layer.route.stack[0].handle;

            await handler(req, res);
            const result = getResult();

            assert.equal(result.statusCode, 401);
            assert.ok(result.responseData.error.includes('Необходима авторизация'));
        });

        it('[E48.5-05] POST /api/rides rejects invalid/expired token with 401', async () => {
            const { req, res, getResult } = createMockReqRes('POST', '/', {
                authorization: 'Bearer invalid.jwt.token'
            }, { from_city: 'Душанбе', to_city: 'Худжанд' });

            const layer = ridesRouter.stack.find(l => l.route && l.route.path === '/' && l.route.methods.post);
            const handler = layer.route.stack[0].handle;

            await handler(req, res);
            const result = getResult();

            assert.equal(result.statusCode, 401);
        });

        it('[E48.5-06] POST /api/rides derives driver_id strictly server-side and ignores body driver_id spoof', () => {
            const source = fs.readFileSync(path.join(__dirname, '../routes/rides.js'), 'utf8');
            const postRideMatch = source.match(/router\.post\('\/'[\s\S]*?const driver_id = effectiveDriverId\;/);
            assert.ok(postRideMatch);
            assert.ok(postRideMatch[0].includes('effectiveDriverId = parseInt(decoded.sub, 10)'));
        });

        it('[E48.5-07] PUT /api/rides/:id requires userAuth and rejects non-owner with 403', () => {
            const layer = ridesRouter.stack.find(l => l.route && l.route.path === '/:id' && l.route.methods.put);
            assert.ok(layer);
            assert.equal(layer.route.stack[0].handle, userAuth);

            const source = fs.readFileSync(path.join(__dirname, '../routes/rides.js'), 'utf8');
            const putMatch = source.match(/router\.put\('\/:id'[\s\S]*?existingRide\.driver_id !== req\.user\.id[\s\S]*?403/);
            assert.ok(putMatch, 'PUT /:id must verify existingRide.driver_id === req.user.id or return 403');
        });

        it('[E48.5-08] POST /api/rides/:id/complete requires userAuth', () => {
            const layer = ridesRouter.stack.find(l => l.route && l.route.path === '/:id/complete');
            assert.ok(layer);
            assert.equal(layer.route.stack[0].handle, userAuth);
        });

        it('[E48.5-09] POST /api/rides/:id/cancel requires userAuth', () => {
            const layer = ridesRouter.stack.find(l => l.route && l.route.path === '/:id/cancel');
            assert.ok(layer);
            assert.equal(layer.route.stack[0].handle, userAuth);
        });

        it('[E48.5-10] GET /api/rides/my requires userAuth and pins query strictly to req.user.id', () => {
            const layer = ridesRouter.stack.find(l => l.route && l.route.path === '/my');
            assert.ok(layer);
            assert.equal(layer.route.stack[0].handle, userAuth);

            const source = fs.readFileSync(path.join(__dirname, '../routes/rides.js'), 'utf8');
            assert.ok(source.includes('router.get(\'/my\', userAuth, async (req, res) => {'));
            assert.ok(source.includes('const userId = req.user.id;'));
        });
    });

    // =========================================================================
    // SECTION 3: PASSENGER BOOKING OPERATIONS (POST, CANCEL)
    // =========================================================================
    describe('3. Passenger Booking Operations', () => {
        it('[E48.5-11] POST /api/bookings requires userAuth middleware', () => {
            const layer = bookingsRouter.stack.find(l => l.route && l.route.path === '/' && l.route.methods.post);
            assert.ok(layer);
            assert.equal(layer.route.stack[0].handle, userAuth);
        });

        it('[E48.5-12] POST /api/bookings sets passenger_id strictly from req.user.id (blocking body spoof)', () => {
            const source = fs.readFileSync(path.join(__dirname, '../routes/bookings.js'), 'utf8');
            const postBookingMatch = source.match(/router\.post\('\/'[\s\S]*?const passenger_id = req\.user\.id\;/);
            assert.ok(postBookingMatch, 'passenger_id must be assigned from req.user.id');
        });

        it('[E48.5-13] POST /api/bookings/:id/cancel requires userAuth middleware', () => {
            const layer = bookingsRouter.stack.find(l => l.route && l.route.path === '/:id/cancel');
            assert.ok(layer);
            assert.equal(layer.route.stack[0].handle, userAuth);
        });

        it('[E48.5-14] POST /api/bookings/:id/cancel verifies passenger or driver ownership (rejecting others with 403)', () => {
            const source = fs.readFileSync(path.join(__dirname, '../routes/bookings.js'), 'utf8');
            const cancelBookingMatch = source.match(/router\.post\('\/:id\/cancel'[\s\S]*?isPassenger && !isDriver[\s\S]*?403/);
            assert.ok(cancelBookingMatch, 'Must reject unauthorized user with 403');
        });
    });

    // =========================================================================
    // SECTION 4: BOT SERVER-TO-SERVER AUTHENTICATION
    // =========================================================================
    describe('4. Telegram Bot Server-to-Server Authentication', () => {
        it('[E48.5-15] verifyBotServiceToken returns true with valid X-Bot-Service-Token', () => {
            const { req } = createMockReqRes('POST', '/', {
                'x-bot-service-token': TEST_BOT_SERVICE_TOKEN
            });
            assert.equal(verifyBotServiceToken(req), true);
        });

        it('[E48.5-16] verifyBotServiceToken returns false with missing token', () => {
            const { req } = createMockReqRes('POST', '/', {});
            assert.equal(verifyBotServiceToken(req), false);
        });

        it('[E48.5-17] verifyBotServiceToken returns false with invalid token', () => {
            const { req } = createMockReqRes('POST', '/', {
                'x-bot-service-token': 'wrong-token-attacker'
            });
            assert.equal(verifyBotServiceToken(req), false);
        });

        it('[E48.5-18] bot service token is strictly scoped: cannot authenticate on bookings or userAuth', () => {
            const { req, res, next, getResult } = createMockReqRes('POST', '/api/bookings', {
                'x-bot-service-token': TEST_BOT_SERVICE_TOKEN
            });
            userAuth(req, res, next);
            const result = getResult();

            assert.equal(result.nextCalled, false);
            assert.equal(result.statusCode, 401);
        });

        it('[E48.5-19] fallback to TELEGRAM_BOT_TOKEN works if BOT_SERVICE_TOKEN is not explicitly configured', () => {
            const savedServiceToken = process.env.BOT_SERVICE_TOKEN;
            const savedBotToken = process.env.TELEGRAM_BOT_TOKEN;
            try {
                delete process.env.BOT_SERVICE_TOKEN;
                process.env.TELEGRAM_BOT_TOKEN = 'telegram-fallback-bot-token-secret';

                const { req } = createMockReqRes('POST', '/', {
                    'x-bot-service-token': 'telegram-fallback-bot-token-secret'
                });
                assert.equal(verifyBotServiceToken(req), true);
            } finally {
                process.env.BOT_SERVICE_TOKEN = savedServiceToken;
                process.env.TELEGRAM_BOT_TOKEN = savedBotToken;
            }
        });
    });

    // =========================================================================
    // SECTION 5: TOKEN SEPARATION & MOCK TOKEN REJECTION
    // =========================================================================
    describe('5. Token Privilege Separation & Rejection', () => {
        it('[E48.5-20] carrier token is rejected by userAuth on ride/booking operations with 401', () => {
            const carrierToken = issueCarrierToken(11);
            const { req, res, next, getResult } = createMockReqRes('POST', '/api/bookings', {
                authorization: `Bearer ${carrierToken}`
            });
            userAuth(req, res, next);
            const result = getResult();

            assert.equal(result.statusCode, 401);
        });

        it('[E48.5-21] legacy mock-token-* is rejected by userAuth on ride/booking operations with 401', () => {
            const { req, res, next, getResult } = createMockReqRes('POST', '/api/bookings', {
                authorization: 'Bearer mock-token-123'
            });
            userAuth(req, res, next);
            const result = getResult();

            assert.equal(result.statusCode, 401);
        });

        it('[E48.5-22] x-mana-man alone without token cannot authorize booking or driver operations', () => {
            const { req, res, next, getResult } = createMockReqRes('POST', '/api/bookings', {
                'x-mana-man': 'nasa.2006'
            });
            userAuth(req, res, next);
            const result = getResult();

            assert.equal(result.statusCode, 401);
        });
    });
});
