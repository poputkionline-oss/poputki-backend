/**
 * tests/phase_e48_4_users_authorization.test.js
 *
 * PHASE E.48.4 — User PII & Ownership Protection Test Suite
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const jwt = require('jsonwebtoken');

const TEST_JWT_SECRET = 'test-jwt-secret-phase-e48-4-ownership-protection-32b';
process.env.JWT_SECRET = TEST_JWT_SECRET;

const {
    issueUserToken,
    userAuth,
    optionalUserAuth,
    JWT_ISSUER,
    PASSENGER_AUDIENCE
} = require('../utils/userAuth');

const usersRouter = require('../routes/users');

/**
 * Creates a mock req/res pair to invoke an express route layer directly.
 */
function createMockReqRes(method = 'GET', url = '/', headers = {}, body = {}, params = {}) {
    let statusCode = null;
    let responseData = null;
    let nextCalled = false;

    const req = {
        method,
        url,
        headers,
        body,
        params,
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

describe('Phase E.48.4 — User PII & Ownership Protection', () => {

    // Helper to generate a carrier token for cross-privilege tests
    function issueCarrierToken(carrierId = 11) {
        return jwt.sign(
            { sub: String(carrierId), carrierId, role: 'owner' },
            TEST_JWT_SECRET,
            { algorithm: 'HS256', expiresIn: '7d', issuer: JWT_ISSUER, audience: 'poputki-carrier' }
        );
    }

    // =========================================================================
    // SECTION 1: PROFILE PRIVACY & PUBLIC PROJECTION (GET /:id/profile)
    // =========================================================================
    describe('1. Profile Privacy & Projections', () => {
        it('[E48.4-01] optionalUserAuth sets req.user when valid passenger token is sent', () => {
            const token = issueUserToken({ id: 10 });
            const { req, res, next, getResult } = createMockReqRes('GET', '/10/profile', {
                authorization: `Bearer ${token}`
            });

            optionalUserAuth(req, res, next);
            const result = getResult();

            assert.equal(result.nextCalled, true);
            assert.deepEqual(result.user, { id: 10, sub: '10' });
        });

        it('[E48.4-02] optionalUserAuth leaves req.user = null on missing Authorization without 401', () => {
            const { req, res, next, getResult } = createMockReqRes('GET', '/10/profile', {
                'x-mana-man': 'nasa.2006'
            });

            optionalUserAuth(req, res, next);
            const result = getResult();

            assert.equal(result.nextCalled, true);
            assert.equal(result.statusCode, null);
            assert.equal(result.user, null);
        });

        it('[E48.4-03] optionalUserAuth leaves req.user = null on invalid or carrier token without 401', () => {
            const carrierToken = issueCarrierToken(11);
            const { req, res, next, getResult } = createMockReqRes('GET', '/10/profile', {
                authorization: `Bearer ${carrierToken}`
            });

            optionalUserAuth(req, res, next);
            const result = getResult();

            assert.equal(result.nextCalled, true);
            assert.equal(result.statusCode, null);
            assert.equal(result.user, null);
        });

        it('[E48.4-04] routes/users.js GET /:id/profile isolates owner private fields from public projection', () => {
            const source = fs.readFileSync(path.join(__dirname, '../routes/users.js'), 'utf8');

            // Verify handler logic checks isOwner
            assert.ok(source.includes('const isOwner = req.user && req.user.id === requestedId;'));
            // Verify phone is only attached for isOwner
            assert.ok(source.includes('if (isOwner)'));
            assert.ok(source.includes('profileResponse.phone = user.phone;'));
            // Verify base public projection does NOT include user.phone
            const baseProjectionMatch = source.match(/const profileResponse = \{([\s\S]*?)\};/);
            assert.ok(baseProjectionMatch);
            assert.equal(baseProjectionMatch[1].includes('phone'), false, 'Base public projection must NOT contain phone');
        });
    });

    // =========================================================================
    // SECTION 2: BUS BOOKINGS OWNERSHIP (GET /:id/bus-bookings)
    // =========================================================================
    describe('2. Bus Bookings Ownership', () => {
        it('[E48.4-05] GET /:id/bus-bookings requires userAuth middleware', () => {
            const layer = usersRouter.stack.find(l => l.route && l.route.path === '/:id/bus-bookings');
            assert.ok(layer, 'Route must exist');
            assert.equal(layer.route.stack[0].handle, userAuth, 'userAuth must be first middleware');
        });

        it('[E48.4-06] GET /:id/bus-bookings rejects missing Authorization with 401', () => {
            const { req, res, next, getResult } = createMockReqRes('GET', '/10/bus-bookings', {});
            userAuth(req, res, next);
            const result = getResult();

            assert.equal(result.statusCode, 401);
        });

        it('[E48.4-07] GET /:id/bus-bookings rejects other user (cross-user access) with 403 Forbidden', () => {
            const tokenUser10 = issueUserToken({ id: 10 });
            const { req, res, next, getResult } = createMockReqRes(
                'GET',
                '/11/bus-bookings',
                { authorization: `Bearer ${tokenUser10}` },
                {},
                { id: '11' } // Requesting user 11's bookings while authenticated as user 10
            );

            // Execute userAuth
            userAuth(req, res, next);
            assert.equal(getResult().nextCalled, true);

            // Execute handler
            const layer = usersRouter.stack.find(l => l.route && l.route.path === '/:id/bus-bookings');
            const handler = layer.route.stack[layer.route.stack.length - 1].handle;

            handler(req, res);
            const finalResult = getResult();

            assert.equal(finalResult.statusCode, 403);
            assert.ok(finalResult.responseData.error.includes('Доступ запрещен'));
        });

        it('[E48.4-08] GET /:id/bus-bookings rejects carrier token with 401', () => {
            const carrierToken = issueCarrierToken(11);
            const { req, res, next, getResult } = createMockReqRes('GET', '/11/bus-bookings', {
                authorization: `Bearer ${carrierToken}`
            });

            userAuth(req, res, next);
            const result = getResult();

            assert.equal(result.statusCode, 401);
        });
    });

    // =========================================================================
    // SECTION 3: PROFILE UPDATE ALLOW-LIST & SPOOF PREVENTION (PUT /:id)
    // =========================================================================
    describe('3. Profile Update Allow-list & Spoof Prevention', () => {
        it('[E48.4-09] PUT /:id requires userAuth middleware', () => {
            const layer = usersRouter.stack.find(l => l.route && l.route.methods.put && l.route.path === '/:id');
            assert.ok(layer, 'PUT /:id route must exist');
            assert.equal(layer.route.stack[0].handle, userAuth, 'userAuth must be first middleware');
        });

        it('[E48.4-10] PUT /:id rejects unauthenticated request with 401', () => {
            const { req, res, next, getResult } = createMockReqRes('PUT', '/10', {});
            userAuth(req, res, next);
            const result = getResult();

            assert.equal(result.statusCode, 401);
        });

        it('[E48.4-11] PUT /:id rejects modifying another user profile with 403 Forbidden', () => {
            const tokenUser10 = issueUserToken({ id: 10 });
            const { req, res, next, getResult } = createMockReqRes(
                'PUT',
                '/99',
                { authorization: `Bearer ${tokenUser10}` },
                { name: 'Hacker' },
                { id: '99' }
            );

            userAuth(req, res, next);
            assert.equal(getResult().nextCalled, true);

            const layer = usersRouter.stack.find(l => l.route && l.route.methods.put && l.route.path === '/:id');
            const handler = layer.route.stack[layer.route.stack.length - 1].handle;

            handler(req, res);
            const finalResult = getResult();

            assert.equal(finalResult.statusCode, 403);
            assert.ok(finalResult.responseData.error.includes('Доступ запрещен'));
        });

        it('[E48.4-12] PUT /:id source uses strict allow-list and disallows role/id/carrier escalation', () => {
            const source = fs.readFileSync(path.join(__dirname, '../routes/users.js'), 'utf8');
            const putRouteMatch = source.match(/router\.put\('\/:id'[\s\S]*?const updateData = \{[\s\S]*?\}\;/);
            assert.ok(putRouteMatch);
            const updateBlock = putRouteMatch[0];

            // Only allowed fields may be in updateData
            assert.ok(updateBlock.includes('name'));
            assert.ok(updateBlock.includes('surname'));
            assert.ok(updateBlock.includes('age'));
            assert.ok(updateBlock.includes('sex'));
            assert.ok(updateBlock.includes('preferences'));

            // Privileged fields must NOT be assigned into updateData
            assert.equal(updateBlock.includes('updateData.role'), false, 'Must not update role');
            assert.equal(updateBlock.includes('updateData.carrier_id'), false, 'Must not update carrier_id');
            assert.equal(updateBlock.includes('updateData.id'), false, 'Must not update id');
            assert.equal(updateBlock.includes('updateData.is_admin'), false, 'Must not update is_admin');
            assert.equal(updateBlock.includes('updateData.telegram_id'), false, 'Must not update telegram_id');
            assert.equal(updateBlock.includes('updateData.rating'), false, 'Must not update rating');
        });
    });

    // =========================================================================
    // SECTION 4: VEHICLE MUTATION & PROJECTION (POST /vehicle & GET /:id/vehicle)
    // =========================================================================
    describe('4. Vehicle Mutation & Projections', () => {
        it('[E48.4-13] POST /vehicle requires userAuth middleware', () => {
            const layer = usersRouter.stack.find(l => l.route && l.route.methods.post && l.route.path === '/vehicle');
            assert.ok(layer, 'POST /vehicle route must exist');
            assert.equal(layer.route.stack[0].handle, userAuth, 'userAuth must be first middleware');
        });

        it('[E48.4-14] POST /vehicle rejects unauthenticated mutation with 401', () => {
            const { req, res, next, getResult } = createMockReqRes('POST', '/vehicle', {}, { make: 'Toyota' });
            userAuth(req, res, next);
            const result = getResult();

            assert.equal(result.statusCode, 401);
        });

        it('[E48.4-15] POST /vehicle rejects cross-user spoofing (body user_id !== req.user.id) with 403', () => {
            const tokenUser10 = issueUserToken({ id: 10 });
            const { req, res, next, getResult } = createMockReqRes(
                'POST',
                '/vehicle',
                { authorization: `Bearer ${tokenUser10}` },
                { user_id: 99, make: 'BMW' }
            );

            userAuth(req, res, next);
            assert.equal(getResult().nextCalled, true);

            const layer = usersRouter.stack.find(l => l.route && l.route.methods.post && l.route.path === '/vehicle');
            const handler = layer.route.stack[layer.route.stack.length - 1].handle;

            handler(req, res);
            const finalResult = getResult();

            assert.equal(finalResult.statusCode, 403);
            assert.ok(finalResult.responseData.error.includes('Доступ запрещен'));
        });

        it('[E48.4-16] GET /:id/vehicle returns safe public projection without private documents', () => {
            const source = fs.readFileSync(path.join(__dirname, '../routes/users.js'), 'utf8');
            const vehicleRouteMatch = source.match(/router\.get\('\/:id\/vehicle'[\s\S]*?select\(([\s\S]*?)\)/);
            assert.ok(vehicleRouteMatch);
            const selectFields = vehicleRouteMatch[1];

            // Verify select excludes wildcards or private docs
            assert.equal(selectFields.includes('*'), false, 'Should not use wildcard select on vehicles');
            assert.ok(selectFields.includes('make'));
            assert.ok(selectFields.includes('model'));
            assert.ok(selectFields.includes('plate_number'));
        });
    });

    // =========================================================================
    // SECTION 5: REVIEWS REPUTATION PROJECTION (GET /:id/reviews)
    // =========================================================================
    describe('5. Reviews Public Reputation', () => {
        it('[E48.4-17] GET /:id/reviews scrubs reviewer contact PII from projection', () => {
            const source = fs.readFileSync(path.join(__dirname, '../routes/users.js'), 'utf8');
            const reviewsMatch = source.match(/router\.get\('\/:id\/reviews'[\s\S]*?select\(([\s\S]*?)\)/);
            assert.ok(reviewsMatch);
            const selectQuery = reviewsMatch[1];

            assert.equal(selectQuery.includes('*'), false, 'Should not use wildcard select on reviews');
            assert.equal(selectQuery.includes('phone'), false, 'Should not select phone in reviews');
            assert.equal(selectQuery.includes('passport'), false, 'Should not select passport in reviews');
        });
    });
});
