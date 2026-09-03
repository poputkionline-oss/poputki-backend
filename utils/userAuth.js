/**
 * utils/userAuth.js
 *
 * Phase E.48.3: Canonical Passenger JWT Authentication Foundation
 *
 * Implements canonical token issuance, verification, and Express middleware
 * for passengers and ordinary users:
 *  - Issuer: 'poputki.online'
 *  - Audience: 'poputki-passenger'
 *  - Algorithm: 'HS256'
 *  - TTL: 30 days
 *  - Claims: strictly minimal { sub: String(user.id) }, zero PII.
 *  - Fails closed if process.env.JWT_SECRET is not configured.
 *  - Strict separation from carrier tokens (audience: 'poputki-carrier').
 */

'use strict';

const jwt = require('jsonwebtoken');

const JWT_ISSUER = 'poputki.online';
const PASSENGER_AUDIENCE = 'poputki-passenger';
const PASSENGER_TOKEN_EXPIRES_IN = '30d';

/**
 * Issues a cryptographically signed canonical passenger JWT.
 * Fails closed if process.env.JWT_SECRET is not configured.
 *
 * @param {Object} user - Database user record containing `id`
 * @returns {string} Signed JWT
 */
function issueUserToken(user) {
    if (!user || user.id === undefined || user.id === null) {
        throw new Error('Cannot issue user token: missing or invalid user object');
    }

    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) {
        console.error('[UserAuth Error] JWT_SECRET is not configured in environment!');
        throw new Error('Internal server security configuration error');
    }

    const payload = {
        sub: String(user.id)
    };

    return jwt.sign(payload, jwtSecret, {
        algorithm: 'HS256',
        expiresIn: PASSENGER_TOKEN_EXPIRES_IN,
        issuer: JWT_ISSUER,
        audience: PASSENGER_AUDIENCE
    });
}

/**
 * Verifies a passenger JWT token string.
 * Fails closed if process.env.JWT_SECRET is not configured.
 *
 * @param {string} token
 * @returns {Object} Decoded JWT payload
 */
function verifyUserToken(token) {
    if (!token || typeof token !== 'string') {
        throw new Error('Token missing or invalid');
    }

    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) {
        console.error('[UserAuth Error] JWT_SECRET is not configured in environment!');
        throw new Error('Internal server security configuration error');
    }

    return jwt.verify(token, jwtSecret, {
        algorithms: ['HS256'],
        issuer: JWT_ISSUER,
        audience: PASSENGER_AUDIENCE
    });
}

/**
 * Canonical Express middleware to authenticate passenger / user requests.
 *
 * Invariants:
 * 1. Requires Authorization: Bearer <token>
 * 2. Fails closed on missing JWT_SECRET (500)
 * 3. Validates HS256 signature, audience (poputki-passenger), and issuer (poputki.online)
 * 4. Rejects carrier JWTs (poputki-carrier), mock tokens, malformed strings, and expired tokens (401)
 * 5. Parses canonical sub into a trusted user ID
 * 6. Attaches trusted context to `req.user = { id: <number>, sub: <string> }`
 */
function userAuth(req, res, next) {
    try {
        const authHeader = req.headers['authorization'];
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Необходима авторизация: отсутствует Bearer токен' });
        }

        const token = authHeader.substring(7).trim();
        if (!token) {
            return res.status(401).json({ error: 'Необходима авторизация: токен пуст' });
        }

        // Explicitly reject legacy mock-token format or unparsed integers
        if (token.startsWith('mock-token-') || /^\d+$/.test(token)) {
            return res.status(401).json({ error: 'Устаревший формат токена. Пожалуйста, выполните вход заново.' });
        }

        const jwtSecret = process.env.JWT_SECRET;
        if (!jwtSecret) {
            console.error('[UserAuth Error] JWT_SECRET is not configured in environment!');
            return res.status(500).json({ error: 'Внутренняя ошибка конфигурации безопасности сервера' });
        }

        let decoded;
        try {
            decoded = jwt.verify(token, jwtSecret, {
                algorithms: ['HS256'],
                issuer: JWT_ISSUER,
                audience: PASSENGER_AUDIENCE
            });
        } catch (jwtErr) {
            if (jwtErr.name === 'TokenExpiredError') {
                return res.status(401).json({ error: 'Срок действия сессии истек. Войдите заново.' });
            }
            if (jwtErr.name === 'JsonWebTokenError') {
                return res.status(401).json({ error: 'Недействительный токен авторизации.' });
            }
            return res.status(401).json({ error: 'Ошибка проверки авторизации: ' + jwtErr.message });
        }

        const userId = parseInt(decoded.sub, 10);
        if (!userId || isNaN(userId) || userId <= 0) {
            return res.status(401).json({ error: 'Некорректный идентификатор пользователя в токене' });
        }

        req.user = {
            id: userId,
            sub: String(decoded.sub)
        };

        next();
    } catch (err) {
        console.error('[UserAuth] Unexpected middleware error:', err.message);
        return res.status(500).json({ error: 'Внутренняя ошибка проверки авторизации' });
    }
}

module.exports = {
    issueUserToken,
    verifyUserToken,
    userAuth,
    JWT_ISSUER,
    PASSENGER_AUDIENCE,
    PASSENGER_TOKEN_EXPIRES_IN
};
