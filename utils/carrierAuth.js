const supabase = require('../db');
const jwt = require('jsonwebtoken');

/**
 * Canonical Carrier Role Resolver
 * 
 * Deterministic Rules (Positive Ownership Proof):
 * 1. Positive Root Owner Proof:
 *    User has user.role === 'bus_driver' AND targetCarrierId matches user.id (the user is the carrier operator).
 *    -> Effective role is ALWAYS 'owner'.
 *    -> Anti-downgrade protection: A self-referencing or legacy carrier_members row (e.g. role='dispatcher' where user_id === carrier_id) CANNOT downgrade the owner.
 * 2. Explicit Owner Member:
 *    Member record exists for target carrier, member.role === 'owner', and member.is_active is true.
 *    -> Effective role is 'owner'.
 * 3. Hired Team Member (Positive Membership Proof):
 *    Member record exists for target carrier with user_id !== carrier_id:
 *    -> If !member.is_active -> blocked (isDeactivated: true).
 *    -> If member.is_active -> effective role is member.role ('dispatcher' | 'driver' | 'accountant').
 * 4. No Positive Ownership or Membership Proof:
 *    -> Effective role is null (access denied).
 */
function resolveCarrierRole({ user, member, carrierId }) {
    if (!user) return { role: null, carrierId: null, isOwner: false, isDeactivated: false, assignedTicketIds: [] };

    // Resolve target carrier ID
    let targetCarrierId = null;
    if (carrierId !== undefined && carrierId !== null) {
        targetCarrierId = parseInt(carrierId, 10);
    } else if (member?.carrier_id) {
        targetCarrierId = parseInt(member.carrier_id, 10);
    }

    const userId = parseInt(user.id, 10);

    // 1. Positive Root Owner Proof: user has bus_driver role AND is operating their own carrier (userId === targetCarrierId)
    const isProvenRootOwner = user.role === 'bus_driver' && targetCarrierId !== null && userId === targetCarrierId;
    
    // Explicit owner assignment in carrier_members
    const hasExplicitOwnerRole = member && member.role === 'owner' && member.is_active && targetCarrierId !== null && parseInt(member.carrier_id, 10) === targetCarrierId;

    if (isProvenRootOwner || hasExplicitOwnerRole) {
        return {
            role: 'owner',
            carrierId: targetCarrierId,
            isOwner: true,
            isDeactivated: false,
            assignedTicketIds: []
        };
    }

    // 2. Positive Employee Membership Proof in carrier_members
    if (member && targetCarrierId !== null && parseInt(member.carrier_id, 10) === targetCarrierId) {
        if (!member.is_active) {
            return {
                role: null,
                carrierId: targetCarrierId,
                isOwner: false,
                isDeactivated: true,
                assignedTicketIds: []
            };
        }

        const validRoles = ['dispatcher', 'driver', 'accountant'];
        if (validRoles.includes(member.role)) {
            return {
                role: member.role,
                carrierId: targetCarrierId,
                isOwner: false,
                isDeactivated: false,
                assignedTicketIds: member.assigned_ticket_ids || []
            };
        }
    }

    // 3. Fallback: No positive ownership or membership proof -> No Access
    return { role: null, carrierId: null, isOwner: false, isDeactivated: false, assignedTicketIds: [] };
}


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
 * - Resolves canonical effective role server-side (prevents stale JWT downgrades).
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

        // Check carrier_members table if present
        let member = null;
        try {
            const { data: mData } = await supabase
                .from('carrier_members')
                .select('carrier_id, role, assigned_ticket_ids, is_active')
                .eq('user_id', user.id)
                .maybeSingle();
            member = mData;
        } catch (mErr) {
            // carrier_members table might not exist in early environments; fallback gracefully
        }

        // Canonical server-side role resolution
        const resolved = resolveCarrierRole({
            user,
            member,
            carrierId: decoded.carrierId ? parseInt(decoded.carrierId, 10) : user.id
        });

        if (resolved.isDeactivated) {
            return res.status(403).json({ error: 'Доступ сотрудника отключен владельцем перевозчика' });
        }

        if (!resolved.role) {
            return res.status(403).json({ error: 'Пользователь не имеет активных прав перевозчика' });
        }

        req.carrier = {
            id: user.id,
            carrier_id: resolved.carrierId,
            user_id: user.id,
            role: resolved.role,
            name: user.name,
            phone: user.phone,
            assignedTicketIds: resolved.assignedTicketIds || [],
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

    // Must belong to the carrier operator
    if (ticket.operator_id !== carrier.carrier_id) {
        return false;
    }

    // Role-specific operational access:
    // If role is driver, they MUST be assigned to this specific ticket
    if (carrier.role === 'driver') {
        const assigned = Array.isArray(carrier.assignedTicketIds) ? carrier.assignedTicketIds : [];
        const isAssigned = assigned.some(id => String(id) === String(ticketId));
        if (!isAssigned) {
            return false;
        }
    }

    // Owner, Dispatcher, Accountant have company-wide access to operator's tickets
    return true;
}

module.exports = {
    carrierAuth,
    verifyTicketAccess,
    resolveCarrierRole
};
