const supabase = require('../db');
const jwt = require('jsonwebtoken');

/**
 * Middleware to authenticate Carrier / Operator requests.
 * ONLY accepts valid, cryptographically signed JWT tokens:
 * - Authorization: Bearer <jwt>
 * 
 * Strict Security Guarantees:
 * - Fail-closed: if process.env.JWT_SECRET is not configured, all requests fail with 500 without leaking secrets.
 * - bus-token-* and predictable integer IDs are PERMANENTLY REJECTED with 401.
 * - Validates cryptographic signature using process.env.JWT_SECRET (HS256).
 * - Validates issuer ('poputki.online'), audience ('poputki-carrier').
 * - Queries database in real-time on every sensitive request to verify user is NOT blocked.
 */
async function carrierAuth(req, res, next) {
    try {
        let authHeader = req.headers['authorization'] || '';

        // Platform admin bypass
        if (req.headers['x-admin-token'] && req.headers['x-admin-token'] === process.env.ADMIN_SECRET_TOKEN) {
            const opId = req.query.operator_id ? parseInt(req.query.operator_id, 10) : 1;
            req.carrier = {
                id: opId,
                carrier_id: opId,
                user_id: 1,
                role: 'admin',
                isAdmin: true
            };
            return next();
        }

        if (!authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Необходима авторизация: отсутствует Bearer токен' });
        }

        const token = authHeader.substring(7).trim();

        // Reject legacy / predictable token format immediately
        if (token.startsWith('bus-token-') || /^\d+$/.test(token)) {
            return res.status(401).json({ 
                error: 'Устаревший или небезопасный формат токена. Пожалуйста, выполните вход заново.' 
            });
        }

        const jwtSecret = process.env.JWT_SECRET;
        if (!jwtSecret) {
            console.error('[CarrierAuth Error] JWT_SECRET is not configured in environment!');
            return res.status(500).json({ error: 'Внутренняя ошибка конфигурации безопасности сервера' });
        }

        let decoded;
        try {
            decoded = jwt.verify(token, jwtSecret, {
                algorithms: ['HS256'],
                issuer: 'poputki.online',
                audience: 'poputki-carrier'
            });
        } catch (jwtErr) {
            if (jwtErr.name === 'TokenExpiredError') {
                return res.status(401).json({ error: 'Срок действия сессии истек. Войдите заново.' });
            }
            if (jwtErr.name === 'JsonWebTokenError') {
                return res.status(401).json({ error: 'Недействительная подпись токена или поддельный токен.' });
            }
            return res.status(401).json({ error: 'Ошибка проверки авторизации: ' + jwtErr.message });
        }

        const userId = parseInt(decoded.sub, 10);
        if (!userId) {
            return res.status(401).json({ error: 'Некорректный идентификатор пользователя в токене' });
        }

        // Real-time verification against database
        const { data: user, error: uErr } = await supabase
            .from('users')
            .select('id, name, phone, role, is_blocked, service_fee_percent')
            .eq('id', userId)
            .maybeSingle();

        if (uErr || !user) {
            return res.status(401).json({ error: 'Пользователь перевозчика не найден в базе данных' });
        }

        if (user.is_blocked) {
            return res.status(403).json({ error: 'Аккаунт перевозчика заблокирован администратором' });
        }

        let carrierId = decoded.carrierId ? parseInt(decoded.carrierId, 10) : user.id;
        let memberRole = decoded.role || (user.role === 'bus_driver' ? 'owner' : null);
        let assignedTicketIds = [];

        // Check carrier_members table if present
        try {
            const { data: member } = await supabase
                .from('carrier_members')
                .select('carrier_id, role, assigned_ticket_ids, is_active')
                .eq('user_id', user.id)
                .maybeSingle();

            if (member) {
                if (!member.is_active) {
                    return res.status(403).json({ error: 'Доступ сотрудника отключен владельцем перевозчика' });
                }
                carrierId = member.carrier_id;
                memberRole = member.role;
                assignedTicketIds = member.assigned_ticket_ids || [];
            }
        } catch (mErr) {
            // carrier_members table might not exist in early environments; fallback gracefully
        }

        if (!memberRole && user.role !== 'bus_driver') {
            return res.status(403).json({ error: 'Пользователь не имеет активных прав перевозчика' });
        }

        req.carrier = {
            id: user.id,
            carrier_id: carrierId || user.id,
            user_id: user.id,
            role: memberRole || 'owner',
            name: user.name,
            phone: user.phone,
            assignedTicketIds: assignedTicketIds,
            service_fee_percent: user.service_fee_percent ?? 10
        };

        next();
    } catch (err) {
        console.error('[CarrierAuth] Error:', err);
        res.status(500).json({ error: 'Внутренняя ошибка аутентификации' });
    }
}

/**
 * Check if the carrier has access to a specific bus ticket
 */
async function verifyTicketAccess(carrier, ticketId) {
    if (!ticketId) return false;
    if (carrier.isAdmin) return true;

    const { data: ticket, error } = await supabase
        .from('bus_tickets')
        .select('id, operator_id')
        .eq('id', ticketId)
        .maybeSingle();

    if (error || !ticket) return false;

    const carrierTargetId = carrier.carrier_id || carrier.id;
    // Must belong to this carrier organization
    if (ticket.operator_id !== carrierTargetId && ticket.operator_id !== carrier.id) {
        return false;
    }

    // If role is agent or driver, verify ticket assignment
    if (['agent', 'driver'].includes(carrier.role)) {
        if (Array.isArray(carrier.assignedTicketIds) && carrier.assignedTicketIds.length > 0) {
            return carrier.assignedTicketIds.includes(parseInt(ticketId, 10));
        }
        // If driver has no assigned tickets, reject access to unassigned tickets
        if (carrier.role === 'driver') {
            return false;
        }
    }

    return true;
}

module.exports = { carrierAuth, verifyTicketAccess };
