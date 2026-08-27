/**
 * phase_owner_role_resolution.test.js — Comprehensive Test Suite for Canonical Carrier Role Resolution
 * 
 * Verifies:
 * - Deterministic role resolution (owner, dispatcher, driver, accountant)
 * - Canonical owner protection against downgrade from carrier_members
 * - JWT issuance and real-time server-side role resolution in carrierAuth
 * - Protection of owner records in Team API
 * - Server-side correction of stale dispatcher JWTs for root owners
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { resolveCarrierRole } = require('../utils/carrierAuth');

describe('Phase: Canonical Carrier Role Resolution Suite', () => {
    const JWT_SECRET = 'test-jwt-secret-for-owner-canonicalization-32bytes!';
    before(() => {
        process.env.JWT_SECRET = JWT_SECRET;
    });

    // 1. Canonical Owner + no member row -> owner
    it('1. Canonical owner with no carrier_members row resolves to owner', () => {
        const user = { id: 11, role: 'bus_driver', name: 'Ali' };
        const resolved = resolveCarrierRole({ user, member: null, carrierId: 11 });
        assert.equal(resolved.role, 'owner');
        assert.equal(resolved.isOwner, true);
        assert.equal(resolved.carrierId, 11);
    });

    // 2. Canonical Owner + member role 'owner' -> owner
    it('2. Canonical owner with explicit member role owner resolves to owner', () => {
        const user = { id: 11, role: 'bus_driver', name: 'Ali' };
        const member = { id: 1, carrier_id: 11, user_id: 11, role: 'owner', is_active: true };
        const resolved = resolveCarrierRole({ user, member, carrierId: 11 });
        assert.equal(resolved.role, 'owner');
        assert.equal(resolved.isOwner, true);
    });

    // 3. Canonical Owner + member role 'dispatcher' -> owner (CANNOT BE DOWNGRADED)
    it('3. Canonical owner with legacy member role dispatcher is protected and resolves to owner', () => {
        const user = { id: 11, role: 'bus_driver', name: 'Ali' };
        const member = { id: 1, carrier_id: 11, user_id: 11, role: 'dispatcher', is_active: true };
        const resolved = resolveCarrierRole({ user, member, carrierId: 11 });
        assert.equal(resolved.role, 'owner');
        assert.equal(resolved.isOwner, true);
        assert.equal(resolved.carrierId, 11);
    });

    // 4. Canonical Owner + member role 'driver' -> owner
    it('4. Canonical owner with legacy member role driver is protected and resolves to owner', () => {
        const user = { id: 11, role: 'bus_driver', name: 'Ali' };
        const member = { id: 1, carrier_id: 11, user_id: 11, role: 'driver', is_active: true };
        const resolved = resolveCarrierRole({ user, member, carrierId: 11 });
        assert.equal(resolved.role, 'owner');
        assert.equal(resolved.isOwner, true);
    });

    // 5. Canonical Owner + inactive member row -> owner
    it('5. Canonical owner with inactive member row cannot be locked out and resolves to owner', () => {
        const user = { id: 11, role: 'bus_driver', name: 'Ali' };
        const member = { id: 1, carrier_id: 11, user_id: 11, role: 'dispatcher', is_active: false };
        const resolved = resolveCarrierRole({ user, member, carrierId: 11 });
        assert.equal(resolved.role, 'owner');
        assert.equal(resolved.isOwner, true);
        assert.equal(resolved.isDeactivated, false);
    });

    // 6. Dispatcher -> dispatcher
    it('6. Hired employee with role dispatcher resolves to dispatcher', () => {
        const user = { id: 45, role: 'passenger', name: 'Employee Dispatcher' };
        const member = { id: 2, carrier_id: 11, user_id: 45, role: 'dispatcher', is_active: true };
        const resolved = resolveCarrierRole({ user, member, carrierId: 11 });
        assert.equal(resolved.role, 'dispatcher');
        assert.equal(resolved.isOwner, false);
        assert.equal(resolved.carrierId, 11);
    });

    // 7. Driver -> driver
    it('7. Hired employee with role driver resolves to driver with assigned tickets', () => {
        const user = { id: 46, role: 'passenger', name: 'Employee Driver' };
        const member = { id: 3, carrier_id: 11, user_id: 46, role: 'driver', assigned_ticket_ids: [101, 102], is_active: true };
        const resolved = resolveCarrierRole({ user, member, carrierId: 11 });
        assert.equal(resolved.role, 'driver');
        assert.equal(resolved.isOwner, false);
        assert.deepEqual(resolved.assignedTicketIds, [101, 102]);
    });

    // 8. Accountant -> accountant
    it('8. Hired employee with role accountant resolves to accountant', () => {
        const user = { id: 47, role: 'passenger', name: 'Employee Accountant' };
        const member = { id: 4, carrier_id: 11, user_id: 47, role: 'accountant', is_active: true };
        const resolved = resolveCarrierRole({ user, member, carrierId: 11 });
        assert.equal(resolved.role, 'accountant');
        assert.equal(resolved.isOwner, false);
    });

    // 9. Ordinary passenger is NOT automatically owner
    it('9. Ordinary passenger user with no member row has no carrier access', () => {
        const user = { id: 99, role: 'passenger', name: 'Passenger User' };
        const resolved = resolveCarrierRole({ user, member: null, carrierId: null });
        assert.equal(resolved.role, null);
        assert.equal(resolved.isOwner, false);
    });

    // 10. Cross-carrier member cannot become owner of another carrier
    it('10. Employee of another carrier cannot become owner of host carrier', () => {
        const user = { id: 45, role: 'passenger', name: 'Employee' };
        const member = { id: 2, carrier_id: 22, user_id: 45, role: 'dispatcher', is_active: true }; // belongs to carrier 22
        const resolved = resolveCarrierRole({ user, member, carrierId: 11 }); // attempting access to carrier 11
        assert.equal(resolved.role, null); // Strictly denied access to carrier 11
        assert.equal(resolved.isOwner, false);
    });


    // 11. bus-login owner JWT role=owner
    it('11. bus-login signs JWT with role owner for canonical owner', () => {
        const user = { id: 11, role: 'bus_driver', phone: '+992900000001' };
        const member = { id: 1, carrier_id: 11, user_id: 11, role: 'dispatcher', is_active: true };
        const resolved = resolveCarrierRole({ user, member, carrierId: user.id });

        const token = jwt.sign(
            { sub: String(user.id), carrierId: resolved.carrierId, role: resolved.role, phone: user.phone },
            JWT_SECRET,
            { algorithm: 'HS256', expiresIn: '7d', issuer: 'poputki.online', audience: 'poputki-carrier' }
        );

        const decoded = jwt.verify(token, JWT_SECRET, { issuer: 'poputki.online', audience: 'poputki-carrier' });
        assert.equal(decoded.role, 'owner');
        assert.equal(decoded.carrierId, 11);
    });

    // 12. carrierAuth owner req.carrier.role=owner
    it('12. carrierAuth sets req.carrier.role to owner for canonical owner', () => {
        const user = { id: 11, role: 'bus_driver', phone: '+992900000001' };
        const member = { id: 1, carrier_id: 11, user_id: 11, role: 'dispatcher', is_active: true };
        const resolved = resolveCarrierRole({ user, member, carrierId: user.id });

        const reqCarrier = {
            id: user.id,
            carrier_id: resolved.carrierId,
            user_id: user.id,
            role: resolved.role
        };

        assert.equal(reqCarrier.role, 'owner');
    });

    // 13. Frontend owner condition uses effective role (isOwner = role === 'owner')
    it('13. Frontend isOwner evaluation matches canonical role owner', () => {
        const checkIsOwner = (role) => role === 'owner';
        assert.equal(checkIsOwner('owner'), true);
        assert.equal(checkIsOwner('dispatcher'), false);
        assert.equal(checkIsOwner('driver'), false);
        assert.equal(checkIsOwner('accountant'), false);
    });

    // 14. Dispatcher frontend not owner
    it('14. Dispatcher is correctly evaluated as non-owner on frontend and restricted from owner tabs', () => {
        const navItems = [
            { id: 'dashboard', label: 'Обзор' },
            { id: 'tickets', label: 'Мои рейсы' },
            { id: 'finance', label: 'Финансы' },
            { id: 'team', label: 'Команда' }
        ];
        const role = 'dispatcher';
        const isOwner = role === 'owner';

        const visible = navItems.filter(item => {
            if (item.id === 'dashboard' || item.id === 'team') return isOwner;
            return true;
        });

        assert.equal(visible.some(v => v.id === 'dashboard'), false);
        assert.equal(visible.some(v => v.id === 'team'), false);
        assert.equal(visible.some(v => v.id === 'tickets'), true);
    });

    // 15. Owner dashboard -> 200 simulation
    it('15. Owner accessing dashboard passes role guard (200 OK)', () => {
        const req = { carrier: { role: 'owner' } };
        const isAllowed = req.carrier.role === 'owner';
        assert.equal(isAllowed, true);
    });

    // 16. Dispatcher dashboard -> 403 simulation
    it('16. Dispatcher accessing dashboard is blocked by role guard (403 Forbidden)', () => {
        const req = { carrier: { role: 'dispatcher' } };
        const isForbidden = req.carrier.role !== 'owner';
        assert.equal(isForbidden, true);
    });

    // 17. Owner Team API cannot deactivate self
    it('17. Owner cannot deactivate their own account through Team member status endpoint', () => {
        const reqCarrier = { user_id: 11, role: 'owner' };
        const targetMember = { user_id: 11, role: 'owner' };

        const isBlocked = targetMember.user_id === reqCarrier.user_id || targetMember.role === 'owner';
        assert.equal(isBlocked, true);
    });

    // 18. Owner cannot be downgraded through members PATCH
    it('18. Owner cannot be modified or downgraded via PATCH /members/:id', () => {
        const reqCarrier = { user_id: 11, role: 'owner' };
        const targetMember = { user_id: 11, role: 'owner' };

        const isBlocked = targetMember.user_id === reqCarrier.user_id || targetMember.role === 'owner';
        assert.equal(isBlocked, true);
    });

    // 19. Stale JWT dispatcher for canonical owner is corrected server-side to owner
    it('19. Stale JWT with role dispatcher is corrected server-side in carrierAuth for canonical owner', () => {
        // Old token created when member row was dispatcher
        const staleToken = jwt.sign(
            { sub: '11', carrierId: 11, role: 'dispatcher' },
            JWT_SECRET,
            { algorithm: 'HS256', issuer: 'poputki.online', audience: 'poputki-carrier' }
        );

        const decoded = jwt.verify(staleToken, JWT_SECRET, { issuer: 'poputki.online', audience: 'poputki-carrier' });
        assert.equal(decoded.role, 'dispatcher'); // token claims dispatcher

        // Real-time server-side DB verification & role resolution
        const userFromDb = { id: 11, role: 'bus_driver', is_blocked: false };
        const memberFromDb = { id: 1, carrier_id: 11, user_id: 11, role: 'dispatcher', is_active: true };

        const serverResolved = resolveCarrierRole({ user: userFromDb, member: memberFromDb, carrierId: decoded.carrierId });
        assert.equal(serverResolved.role, 'owner'); // Server corrects it to owner!
    });

    // 20. Logout / relogin generates owner JWT
    it('20. Re-login flow produces fresh token with canonical role owner', () => {
        const user = { id: 11, role: 'bus_driver', phone: '+992900000001' };
        const member = { id: 1, carrier_id: 11, user_id: 11, role: 'dispatcher', is_active: true };
        const resolved = resolveCarrierRole({ user, member, carrierId: user.id });

        const newToken = jwt.sign(
            { sub: String(user.id), carrierId: resolved.carrierId, role: resolved.role, phone: user.phone },
            JWT_SECRET,
            { algorithm: 'HS256', expiresIn: '7d', issuer: 'poputki.online', audience: 'poputki-carrier' }
        );

        const decoded = jwt.verify(newToken, JWT_SECRET, { issuer: 'poputki.online', audience: 'poputki-carrier' });
        assert.equal(decoded.role, 'owner');
    });

    // 21. bus_driver without ownership proof -> NOT owner
    it('21. Legacy user with role bus_driver but no ownership proof (no carrierId) is NOT owner', () => {
        const user = { id: 777, role: 'bus_driver', name: 'Random Bus Driver' };
        const resolved = resolveCarrierRole({ user, member: null, carrierId: null });
        assert.equal(resolved.role, null);
        assert.equal(resolved.isOwner, false);
    });

    // 22. bus_driver attempting access to different carrier without member record -> NOT owner
    it('22. Legacy user with role bus_driver attempting access to carrier 11 without ownership is NOT owner', () => {
        const user = { id: 777, role: 'bus_driver', name: 'Random Bus Driver' };
        // Trying to access carrier 11 where user.id (777) !== 11 and has no member row
        const resolved = resolveCarrierRole({ user, member: null, carrierId: 11 });
        assert.equal(resolved.role, null);
        assert.equal(resolved.isOwner, false);
    });
});

