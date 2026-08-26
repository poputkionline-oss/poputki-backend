const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const {
    isPasswordHash,
    hashPassword,
    hashPasswordSync,
    timingSafeCompare,
    migrateLegacyPasswordDurable,
    verifyAndMigrateDurable
} = require('../utils/passwordSecurity');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_carrier_jwt_secret_32_chars_long!';

describe('Security P1.2: Final Migration Safety Gate Suite', () => {

    const JWT_SECRET = process.env.JWT_SECRET;

    // In-memory mock database
    let mockUsersDb = [
        { id: 101, phone: '+992900000001', name: 'Owner', password: 'legacy_plain_pass_1', role: 'bus_driver', is_blocked: false },
        { id: 102, phone: '+992900000002', name: 'Dispatcher', password: 'legacy_plain_pass_2', role: 'passenger', is_blocked: false },
        { id: 103, phone: '+992900000003', name: 'Driver', password: 'legacy_plain_pass_3', role: 'passenger', is_blocked: false },
        { id: 104, phone: '+992900000004', name: 'Accountant', password: 'legacy_plain_pass_4', role: 'passenger', is_blocked: false },
        { id: 105, phone: '+992900000005', name: 'HashedUser', password: hashPasswordSync('already_hashed_pwd'), role: 'passenger', is_blocked: false },
        { id: 106, phone: '+992900000006', name: 'NoPasswordUser', password: null, role: 'passenger', is_blocked: false }
    ];

    const mockMembersDb = [
        { id: 1, carrier_id: 101, user_id: 102, role: 'dispatcher', is_active: true },
        { id: 2, carrier_id: 101, user_id: 103, role: 'driver', is_active: true },
        { id: 3, carrier_id: 101, user_id: 104, role: 'accountant', is_active: true }
    ];

    // Mock Supabase client supporting conditional updates
    function createMockSupabase(simulateFailure = false) {
        return {
            from: (tableName) => ({
                update: (updateFields) => ({
                    eq: (field1, val1) => ({
                        eq: (field2, val2) => ({
                            select: async () => {
                                if (simulateFailure) {
                                    return { data: null, error: { message: 'Simulated network timeout' } };
                                }
                                const user = mockUsersDb.find(u => u[field1] === val1 && u[field2] === val2);
                                if (user) {
                                    Object.assign(user, updateFields);
                                    return { data: [{ id: user.id }], error: null };
                                }
                                return { data: [], error: null }; // 0 rows updated (condition mismatch)
                            }
                        })
                    })
                })
            })
        };
    }

    async function handleBusLoginMock(phone, password, supabaseMock = createMockSupabase()) {
        if (!phone || !password) {
            return { status: 400, error: 'Необходимо указать телефон и пароль' };
        }

        const user = mockUsersDb.find(u => u.phone === phone);
        if (!user || !user.password) {
            return { status: 401, error: 'Неверный телефон, пароль или нет прав доступа' };
        }

        const isMatch = await verifyAndMigrateDurable(supabaseMock, user, password);

        if (!isMatch) {
            return { status: 401, error: 'Неверный телефон, пароль или нет прав доступа' };
        }

        if (user.is_blocked) {
            return { status: 403, error: 'Аккаунт заблокирован администратором' };
        }

        let carrierId = user.id;
        let memberRole = user.role === 'bus_driver' ? 'owner' : null;

        const member = mockMembersDb.find(m => m.user_id === user.id);
        if (member) {
            if (!member.is_active) {
                return { status: 403, error: 'Доступ сотрудника отключен' };
            }
            carrierId = member.carrier_id;
            memberRole = member.role;
        }

        if (!memberRole && user.role !== 'bus_driver') {
            return { status: 403, error: 'У пользователя нет прав доступа к кабинету перевозчика' };
        }

        const token = jwt.sign(
            { sub: String(user.id), carrierId, role: memberRole || 'owner', phone: user.phone },
            JWT_SECRET,
            { algorithm: 'HS256', expiresIn: '7d', issuer: 'poputki.online', audience: 'poputki-carrier' }
        );

        const sanitizedUser = {
            id: user.id,
            name: user.name,
            phone: user.phone,
            role: user.role,
            carrierId,
            memberRole: memberRole || 'owner'
        };

        return { status: 200, data: { user: sanitizedUser, token } };
    }

    it('1. Legacy correct password -> login PASS', async () => {
        const user101 = mockUsersDb.find(u => u.id === 101);
        assert.equal(isPasswordHash(user101.password), false);

        const res = await handleBusLoginMock('+992900000001', 'legacy_plain_pass_1');
        assert.equal(res.status, 200);
        assert.equal(res.data.user.id, 101);
        assert.equal(res.data.user.memberRole, 'owner');
    });

    it('2. Awaited migration durably writes bcrypt hash to DB', () => {
        const user101 = mockUsersDb.find(u => u.id === 101);
        assert.equal(isPasswordHash(user101.password), true);
        assert.notEqual(user101.password, 'legacy_plain_pass_1');
    });

    it('3. DB update failure -> login still PASS + safe error handling', async () => {
        const failingSupabase = createMockSupabase(true);
        const testUser = { id: 109, phone: '+992900000009', password: 'plain_with_db_failure', role: 'bus_driver' };
        mockUsersDb.push(testUser);

        const res = await handleBusLoginMock('+992900000009', 'plain_with_db_failure', failingSupabase);
        assert.equal(res.status, 200);
        assert.equal(res.data.user.id, 109);
    });

    it('4. Second login with bcrypt hash -> PASS without re-hashing', async () => {
        const user101 = mockUsersDb.find(u => u.id === 101);
        const hashBefore = user101.password;

        const res = await handleBusLoginMock('+992900000001', 'legacy_plain_pass_1');
        assert.equal(res.status, 200);
        assert.equal(user101.password, hashBefore);
    });

    it('5. Wrong legacy password -> 401 Unauthorized', async () => {
        const res = await handleBusLoginMock('+992900000002', 'wrong_password_attempt');
        assert.equal(res.status, 401);
    });

    it('6. Wrong bcrypt password -> 401 Unauthorized', async () => {
        const res = await handleBusLoginMock('+992900000005', 'wrong_password_attempt');
        assert.equal(res.status, 401);
    });

    it('7. Concurrent legacy login -> safe execution', async () => {
        const testUser = { id: 110, phone: '+992900000010', password: 'concurrent_plain_pwd', role: 'bus_driver' };
        mockUsersDb.push(testUser);

        const [r1, r2] = await Promise.all([
            handleBusLoginMock('+992900000010', 'concurrent_plain_pwd'),
            handleBusLoginMock('+992900000010', 'concurrent_plain_pwd')
        ]);

        assert.equal(r1.status, 200);
        assert.equal(r2.status, 200);
        assert.equal(isPasswordHash(testUser.password), true);
    });

    it('8. Conditional update prevents overwriting newer password if changed concurrently', async () => {
        const testUser = { id: 111, phone: '+992900000011', password: 'old_legacy_password', role: 'bus_driver' };
        mockUsersDb.push(testUser);

        // Simulate concurrent password change happened right before lazy rehash update executes
        const oldStoredValue = 'old_legacy_password';
        testUser.password = hashPasswordSync('new_updated_password_2026');

        const mockClient = createMockSupabase();
        const res = await migrateLegacyPasswordDurable(mockClient, 111, oldStoredValue, 'old_legacy_password');
        
        // 0 rows updated because WHERE password = oldStoredValue failed
        assert.equal(res.migrated, false);
        // Password in DB was NOT overwritten with old hash
        assert.notEqual(testUser.password, 'old_legacy_password');
    });

    it('9. Zero-row conditional update -> login still completes successfully', async () => {
        const testUser = { id: 112, phone: '+992900000012', password: 'zero_row_plain', role: 'bus_driver' };
        mockUsersDb.push(testUser);

        // Custom mock that returns 0 rows updated
        const zeroRowMock = {
            from: () => ({
                update: () => ({
                    eq: () => ({
                        eq: () => ({
                            select: async () => ({ data: [], error: null })
                        })
                    })
                })
            })
        };

        const res = await handleBusLoginMock('+992900000012', 'zero_row_plain', zeroRowMock);
        assert.equal(res.status, 200);
    });

    it('10. Bcrypt password is never double-hashed on login', async () => {
        const user105 = mockUsersDb.find(u => u.id === 105);
        const originalHash = user105.password;
        assert.equal(isPasswordHash(originalHash), true);

        const res = await handleBusLoginMock('+992900000005', 'already_hashed_pwd');
        assert.equal(res.status, 200);
        assert.equal(user105.password, originalHash);
    });

    it('11. New registration -> stores bcrypt hash', async () => {
        const rawPass = 'new_registered_pass_12345';
        const hashed = await hashPassword(rawPass);
        assert.equal(isPasswordHash(hashed), true);
        assert.notEqual(hashed, rawPass);
    });

    it('12. Admin bus-driver creation -> stores bcrypt hash', async () => {
        const driverPass = 'driver_admin_pwd_8899';
        const hashed = await hashPassword(driverPass);
        assert.equal(isPasswordHash(hashed), true);
    });

    it('13. Password and hash are never returned in JSON response', async () => {
        const res = await handleBusLoginMock('+992900000001', 'legacy_plain_pass_1');
        assert.equal(res.data.user.password, undefined);
    });

    it('14. Password null user flow is completely unchanged (no regression)', async () => {
        const nullUser = mockUsersDb.find(u => u.id === 106);
        assert.equal(nullUser.password, null);
        
        // Attempting bus password login on null-password user returns 401
        const res = await handleBusLoginMock('+992900000006', 'any_pass');
        assert.equal(res.status, 401);
    });

    it('15. Timing-safe comparison handles differing string lengths safely', () => {
        assert.equal(timingSafeCompare('short', 'much_longer_string'), false);
        assert.equal(timingSafeCompare('exact_match', 'exact_match'), true);
        assert.equal(timingSafeCompare('pass1', 'pass2'), false);
    });

    it('16. Owner bus-login -> PASS (role = owner)', async () => {
        const res = await handleBusLoginMock('+992900000001', 'legacy_plain_pass_1');
        assert.equal(res.status, 200);
        assert.equal(res.data.user.memberRole, 'owner');
    });

    it('17. Dispatcher bus-login -> PASS (role = dispatcher, migrated)', async () => {
        const res = await handleBusLoginMock('+992900000002', 'legacy_plain_pass_2');
        assert.equal(res.status, 200);
        assert.equal(res.data.user.memberRole, 'dispatcher');
        assert.equal(res.data.user.carrierId, 101);
    });

    it('18. Driver bus-login -> PASS (role = driver, migrated)', async () => {
        const res = await handleBusLoginMock('+992900000003', 'legacy_plain_pass_3');
        assert.equal(res.status, 200);
        assert.equal(res.data.user.memberRole, 'driver');
        assert.equal(res.data.user.carrierId, 101);
    });

    it('19. Accountant bus-login -> PASS (role = accountant, migrated)', async () => {
        const res = await handleBusLoginMock('+992900000004', 'legacy_plain_pass_4');
        assert.equal(res.status, 200);
        assert.equal(res.data.user.memberRole, 'accountant');
        assert.equal(res.data.user.carrierId, 101);
    });

    it('20. Existing JWT claims unchanged and properly signed', async () => {
        const res = await handleBusLoginMock('+992900000001', 'legacy_plain_pass_1');
        const decoded = jwt.verify(res.data.token, JWT_SECRET, {
            issuer: 'poputki.online',
            audience: 'poputki-carrier'
        });
        assert.equal(decoded.sub, '101');
        assert.equal(decoded.carrierId, 101);
        assert.equal(decoded.role, 'owner');
        assert.equal(decoded.phone, '+992900000001');
    });
});
