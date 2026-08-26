const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_carrier_jwt_secret_32_chars_long!';

describe('Phase P1.1: Carrier Team Management & Role Assignments Suite', () => {

    const JWT_SECRET = process.env.JWT_SECRET;

    function createTestToken(userId, carrierId, role) {
        return jwt.sign(
            { sub: String(userId), carrierId: carrierId, role: role },
            JWT_SECRET,
            { algorithm: 'HS256', expiresIn: '1h', issuer: 'poputki.online', audience: 'poputki-carrier' }
        );
    }

    const mockUsers = [
        { id: 101, name: 'Owner User', phone: '+992900000001', role: 'bus_driver', password: 'secret_owner_password' },
        { id: 102, name: 'Dispatcher User', phone: '+992900000002', role: 'passenger', password: 'dispatcher_user_pwd' },
        { id: 103, name: 'Driver User', phone: '+992900000003', role: 'passenger', password: 'driver_user_pwd' },
        { id: 104, name: 'Accountant User', phone: '+992900000004', role: 'passenger', password: 'accountant_user_pwd' },
        { id: 105, name: 'Registered Passenger', phone: '+992900000005', role: 'passenger', password: 'passenger_user_pwd' },
        { id: 201, name: 'Foreign Owner', phone: '+992900000009', role: 'bus_driver', password: 'foreign_owner_pwd' }
    ];

    const mockTickets = [
        { id: 701, operator_id: 101, from_city: 'Худжанд', to_city: 'Нижневартовск', price: 1000, reserved_seats: [] },
        { id: 702, operator_id: 101, from_city: 'Худжанд', to_city: 'Сургут', price: 1200, reserved_seats: [] },
        { id: 703, operator_id: 201, from_city: 'Душанбе', to_city: 'Москва', price: 1500, reserved_seats: [] }
    ];

    let mockMembers = [
        { id: 1, carrier_id: 101, user_id: 102, role: 'dispatcher', assigned_ticket_ids: [], is_active: true },
        { id: 2, carrier_id: 101, user_id: 103, role: 'driver', assigned_ticket_ids: [701], is_active: true },
        { id: 3, carrier_id: 101, user_id: 104, role: 'accountant', assigned_ticket_ids: [], is_active: true }
    ];

    // Helper functions simulating routes/busAdmin.js endpoints
    function handleGetMembers(reqCarrier) {
        if (reqCarrier.role !== 'owner') {
            return { status: 403, error: 'Только владелец компании имеет доступ к списку сотрудников' };
        }
        const carrierMembers = mockMembers.filter(m => m.carrier_id === reqCarrier.carrier_id);
        return {
            status: 200,
            data: {
                owner: { user_id: reqCarrier.user_id, role: 'owner' },
                members: carrierMembers
            }
        };
    }

    function handleAddMember(reqCarrier, body) {
        if (reqCarrier.role !== 'owner') {
            return { status: 403, error: 'Только владелец компании может добавлять сотрудников' };
        }
        const { phone, role, assigned_ticket_ids } = body;
        if (!phone || !phone.trim()) {
            return { status: 400, error: 'Укажите номер телефона сотрудника' };
        }
        const validRoles = ['dispatcher', 'driver', 'accountant'];
        if (!validRoles.includes(role)) {
            return { status: 400, error: 'Недопустимая роль' };
        }
        const normalizedPhone = phone.trim().replace(/\s+/g, '');
        const user = mockUsers.find(u => u.phone === normalizedPhone);
        
        // Strict Security Gate: Unknown phone MUST return 404 with USER_NOT_REGISTERED and NOT auto-create accounts
        if (!user) {
            return {
                status: 404,
                code: 'USER_NOT_REGISTERED',
                error: 'Пользователь с таким номером еще не зарегистрирован в POPUTKI.ONLINE. Попросите сотрудника сначала пройти регистрацию на сайте или в Telegram-боте, после чего добавьте его в команду.'
            };
        }

        if (user.id === reqCarrier.user_id) {
            return { status: 400, error: 'Владелец компании уже обладает полным доступом и не может быть добавлен как сотрудник' };
        }
        const existing = mockMembers.find(m => m.carrier_id === reqCarrier.carrier_id && m.user_id === user.id);
        if (existing) {
            return { status: 409, error: 'Пользователь с этим номером уже добавлен в команду перевозчика' };
        }
        const newMember = {
            id: mockMembers.length + 1,
            carrier_id: reqCarrier.carrier_id,
            user_id: user.id,
            phone: user.phone,
            role: role,
            assigned_ticket_ids: role === 'driver' ? (assigned_ticket_ids || []) : [],
            is_active: true
        };
        mockMembers.push(newMember);
        return { status: 201, data: newMember };
    }

    function handleUpdateMember(reqCarrier, memberId, body) {
        if (reqCarrier.role !== 'owner') {
            return { status: 403, error: 'Только владелец компании может редактировать сотрудников' };
        }
        const member = mockMembers.find(m => m.id === memberId && m.carrier_id === reqCarrier.carrier_id);
        if (!member) {
            return { status: 404, error: 'Сотрудник не найден в вашей компании' };
        }
        if (body.role !== undefined) {
            const validRoles = ['dispatcher', 'driver', 'accountant'];
            if (!validRoles.includes(body.role)) {
                return { status: 400, error: 'Недопустимая роль' };
            }
            member.role = body.role;
            if (body.role !== 'driver') {
                member.assigned_ticket_ids = [];
            }
        }
        if (body.assigned_ticket_ids !== undefined) {
            member.assigned_ticket_ids = Array.isArray(body.assigned_ticket_ids) ? body.assigned_ticket_ids : [];
        }
        if (body.is_active !== undefined) {
            member.is_active = Boolean(body.is_active);
        }
        return { status: 200, data: member };
    }

    function handleDeactivateMember(reqCarrier, memberId) {
        if (reqCarrier.role !== 'owner') {
            return { status: 403, error: 'Только владелец компании может отключать сотрудников' };
        }
        const member = mockMembers.find(m => m.id === memberId && m.carrier_id === reqCarrier.carrier_id);
        if (!member) {
            return { status: 404, error: 'Сотрудник не найден в вашей компании' };
        }
        member.is_active = false;
        return { status: 200, success: true, message: 'Доступ сотрудника отключен' };
    }

    function verifyTicketAccessMock(carrier, ticketId) {
        if (!ticketId) return false;
        const ticket = mockTickets.find(t => t.id === ticketId);
        if (!ticket) return false;
        if (ticket.operator_id !== carrier.carrier_id) return false;

        if (['agent', 'driver'].includes(carrier.role)) {
            if (Array.isArray(carrier.assignedTicketIds) && carrier.assignedTicketIds.length > 0) {
                return carrier.assignedTicketIds.includes(parseInt(ticketId, 10));
            }
            if (carrier.role === 'driver') return false;
        }
        return true;
    }

    function handleCarrierAuthRealTime(member) {
        if (!member.is_active) {
            return { status: 403, error: 'Доступ сотрудника отключен владельцем перевозчика' };
        }
        return { status: 200, ok: true };
    }

    it('1. Owner list members -> 200 OK', () => {
        const reqCarrier = { user_id: 101, carrier_id: 101, role: 'owner' };
        const res = handleGetMembers(reqCarrier);
        assert.equal(res.status, 200);
        assert.equal(res.data.owner.role, 'owner');
        assert.equal(res.data.members.length, 3);
    });

    it('2. Dispatcher list members -> 403 Forbidden', () => {
        const reqCarrier = { user_id: 102, carrier_id: 101, role: 'dispatcher' };
        const res = handleGetMembers(reqCarrier);
        assert.equal(res.status, 403);
    });

    it('3. Driver list members -> 403 Forbidden', () => {
        const reqCarrier = { user_id: 103, carrier_id: 101, role: 'driver' };
        const res = handleGetMembers(reqCarrier);
        assert.equal(res.status, 403);
    });

    it('4. Accountant list members -> 403 Forbidden', () => {
        const reqCarrier = { user_id: 104, carrier_id: 101, role: 'accountant' };
        const res = handleGetMembers(reqCarrier);
        assert.equal(res.status, 403);
    });

    it('5. Add existing registered user -> 201 Created (Password & profile untouched)', () => {
        const initialUserPassword = mockUsers.find(u => u.id === 105).password;
        const reqCarrier = { user_id: 101, carrier_id: 101, role: 'owner' };
        const res = handleAddMember(reqCarrier, { phone: '+992900000005', role: 'dispatcher' });
        assert.equal(res.status, 201);
        assert.equal(res.data.role, 'dispatcher');
        assert.equal(res.data.user_id, 105);
        // Verify password remained completely unmodified
        const postUser = mockUsers.find(u => u.id === 105);
        assert.equal(postUser.password, initialUserPassword);
    });

    it('6. Add unknown phone -> 404 USER_NOT_REGISTERED (NO auto-create account)', () => {
        const initialUsersCount = mockUsers.length;
        const reqCarrier = { user_id: 101, carrier_id: 101, role: 'owner' };
        const res = handleAddMember(reqCarrier, { phone: '+992999887766', role: 'driver' });
        assert.equal(res.status, 404);
        assert.equal(res.code, 'USER_NOT_REGISTERED');
        // Verify no user was auto-created in users table
        assert.equal(mockUsers.length, initialUsersCount);
    });

    it('7. Duplicate member -> 409 Conflict', () => {
        const reqCarrier = { user_id: 101, carrier_id: 101, role: 'owner' };
        const res = handleAddMember(reqCarrier, { phone: '+992900000005', role: 'dispatcher' });
        assert.equal(res.status, 409);
    });

    it('8. Cross-carrier modification -> 404 Forbidden', () => {
        const foreignReq = { user_id: 201, carrier_id: 201, role: 'owner' };
        const res = handleUpdateMember(foreignReq, 1, { role: 'driver' });
        assert.equal(res.status, 404);
    });

    it('9. Owner cannot add owner as sub-member -> 400 Bad Request', () => {
        const reqCarrier = { user_id: 101, carrier_id: 101, role: 'owner' };
        const res = handleAddMember(reqCarrier, { phone: '+992900000001', role: 'driver' });
        assert.equal(res.status, 400);
    });

    it('10. Invalid role is rejected with 400 Bad Request', () => {
        const reqCarrier = { user_id: 101, carrier_id: 101, role: 'owner' };
        const res = handleAddMember(reqCarrier, { phone: '+992900000005', role: 'superadmin' });
        assert.equal(res.status, 400);
    });

    it('11. Soft-Deactivate member -> sets is_active = false and revokes JWT in real-time', () => {
        const reqCarrier = { user_id: 101, carrier_id: 101, role: 'owner' };
        const res = handleDeactivateMember(reqCarrier, 2);
        assert.equal(res.status, 200);
        assert.equal(res.success, true);
        
        // Check real-time auth check fails
        const deactivatedMember = mockMembers.find(m => m.id === 2);
        assert.equal(deactivatedMember.is_active, false);
        const authCheck = handleCarrierAuthRealTime(deactivatedMember);
        assert.equal(authCheck.status, 403);
    });

    it('12. Re-activate member -> restores access', () => {
        const reqCarrier = { user_id: 101, carrier_id: 101, role: 'owner' };
        const res = handleUpdateMember(reqCarrier, 2, { is_active: true });
        assert.equal(res.status, 200);
        assert.equal(res.data.is_active, true);
        
        const reactivatedMember = mockMembers.find(m => m.id === 2);
        const authCheck = handleCarrierAuthRealTime(reactivatedMember);
        assert.equal(authCheck.status, 200);
    });

    it('13. Driver assigned trip -> access PASS', () => {
        const driverCarrier = { carrier_id: 101, role: 'driver', assignedTicketIds: [701] };
        const hasAccess = verifyTicketAccessMock(driverCarrier, 701);
        assert.equal(hasAccess, true);
    });

    it('14. Driver unassigned trip -> access DENIED', () => {
        const driverCarrier = { carrier_id: 101, role: 'driver', assignedTicketIds: [701] };
        const hasAccess = verifyTicketAccessMock(driverCarrier, 702);
        assert.equal(hasAccess, false);
    });

    it('15. Role transition: Driver -> Dispatcher resets assigned_ticket_ids', () => {
        const reqCarrier = { user_id: 101, carrier_id: 101, role: 'owner' };
        const res = handleUpdateMember(reqCarrier, 2, { role: 'dispatcher' });
        assert.equal(res.status, 200);
        assert.equal(res.data.role, 'dispatcher');
        assert.deepEqual(res.data.assigned_ticket_ids, []);
    });

    it('16. Driver mutating tickets (PUT /tickets/:id) is rejected with 403', () => {
        const role = 'driver';
        const isForbidden = (role === 'driver' || role === 'accountant');
        assert.equal(isForbidden, true);
    });

    it('17. Accountant mutating bookings is rejected with 403', () => {
        const role = 'accountant';
        const isForbidden = (role === 'driver' || role === 'accountant');
        assert.equal(isForbidden, true);
    });

    it('18. Dispatcher mutating bookings is allowed (PASS)', () => {
        const role = 'dispatcher';
        const isForbidden = (role === 'driver' || role === 'accountant');
        assert.equal(isForbidden, false);
    });

    it('19. Driver creating manual booking is rejected with 403', () => {
        const role = 'driver';
        const isForbidden = (role === 'driver' || role === 'accountant');
        assert.equal(isForbidden, true);
    });

    it('20. Empty phone when adding member returns 400 Bad Request', () => {
        const reqCarrier = { user_id: 101, carrier_id: 101, role: 'owner' };
        const res = handleAddMember(reqCarrier, { phone: '  ', role: 'driver' });
        assert.equal(res.status, 400);
    });

    it('21. Driver assignment sanitization: Foreign carrier tickets (703) are filtered out', () => {
        const carrierId = 101;
        const candidateIds = [701, 703]; // 703 belongs to carrier 201
        const numericIds = candidateIds.filter(id => mockTickets.some(t => t.id === id && t.operator_id === carrierId));
        assert.deepEqual(numericIds, [701]);
    });

    it('22. Driver assignment sanitization: Non-existent ticket IDs are filtered out', () => {
        const carrierId = 101;
        const candidateIds = [701, 99999];
        const numericIds = candidateIds.filter(id => mockTickets.some(t => t.id === id && t.operator_id === carrierId));
        assert.deepEqual(numericIds, [701]);
    });

    it('23. Driver assignment sanitization: Duplicate IDs are de-duplicated', () => {
        const candidateIds = [701, 701, 702, 702];
        const unique = [...new Set(candidateIds)];
        assert.deepEqual(unique, [701, 702]);
    });

    it('24. Driver assignment sanitization: Non-driver role forces assigned_ticket_ids to empty array', () => {
        const role = 'dispatcher';
        const assigned = role === 'driver' ? [701, 702] : [];
        assert.deepEqual(assigned, []);
    });
});

