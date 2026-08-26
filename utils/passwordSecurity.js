const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const BCRYPT_SALT_ROUNDS = 10;
const BCRYPT_REGEX = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

/**
 * Checks if a string is a valid bcrypt password hash
 */
function isPasswordHash(value) {
    if (typeof value !== 'string') return false;
    return BCRYPT_REGEX.test(value.trim());
}

/**
 * Hash a plaintext password using bcrypt (10 rounds)
 */
async function hashPassword(plaintext) {
    if (!plaintext || typeof plaintext !== 'string') {
        throw new Error('Password must be a non-empty string');
    }
    return await bcrypt.hash(plaintext, BCRYPT_SALT_ROUNDS);
}

/**
 * Synchronous hash version
 */
function hashPasswordSync(plaintext) {
    if (!plaintext || typeof plaintext !== 'string') {
        throw new Error('Password must be a non-empty string');
    }
    return bcrypt.hashSync(plaintext, BCRYPT_SALT_ROUNDS);
}

/**
 * Timing-safe string comparison for legacy plaintext verification
 */
function timingSafeCompare(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    try {
        const bufA = Buffer.from(a, 'utf8');
        const bufB = Buffer.from(b, 'utf8');
        if (bufA.length !== bufB.length) return false;
        return crypto.timingSafeEqual(bufA, bufB);
    } catch {
        return a === b;
    }
}

/**
 * Perform a durable, awaited, and conditional migration from legacy plaintext to bcrypt hash.
 * 
 * Safety features:
 * - Uses optimistic conditional WHERE (id = userId AND password = legacyStoredPassword) to prevent
 *   overwriting newer passwords if changed concurrently.
 * - Handles zero-row update gracefully (e.g. concurrent login already converted the hash).
 * - Catches DB errors safely without failing the legitimate user's login.
 * 
 * @param {object} supabase - Supabase client instance
 * @param {number|string} userId - User ID in users table
 * @param {string} legacyStoredPassword - Existing plaintext password in DB before update
 * @param {string} plainPassword - Plaintext password provided by user
 * @returns {Promise<{ migrated: boolean, error?: string }>}
 */
async function migrateLegacyPasswordDurable(supabase, userId, legacyStoredPassword, plainPassword) {
    if (!supabase || !userId || !legacyStoredPassword || !plainPassword) {
        return { migrated: false };
    }

    try {
        const newHash = await hashPassword(plainPassword);
        
        // Optimistic conditional update: only update if password still equals the legacy stored plaintext
        const { data, error } = await supabase
            .from('users')
            .update({ password: newHash })
            .eq('id', userId)
            .eq('password', legacyStoredPassword)
            .select('id');

        if (error) {
            console.warn(`[PasswordSecurity] Durable rehash DB error for user ${userId}:`, error.message);
            return { migrated: false, error: error.message };
        }

        const updatedCount = Array.isArray(data) ? data.length : (data ? 1 : 0);
        return { migrated: updatedCount > 0 };
    } catch (err) {
        console.warn(`[PasswordSecurity] Durable rehash exception for user ${userId}:`, err.message);
        return { migrated: false, error: err.message };
    }
}

/**
 * High-level verify and durable migrate helper used in login flows.
 * 
 * @param {object} supabase - Supabase client instance
 * @param {object} user - User record from DB (must contain id and password)
 * @param {string} providedPassword - Plaintext password supplied in login request
 * @returns {Promise<boolean>} - true if authenticated, false otherwise
 */
async function verifyAndMigrateDurable(supabase, user, providedPassword) {
    if (!user || !user.password || !providedPassword) {
        return false;
    }

    const providedStr = String(providedPassword);
    const storedStr = String(user.password).trim();

    // 1. If stored password is already a bcrypt hash
    if (isPasswordHash(storedStr)) {
        return await bcrypt.compare(providedStr, storedStr);
    }

    // 2. Legacy plaintext verification
    const isMatch = timingSafeCompare(providedStr, storedStr);
    if (!isMatch) {
        return false;
    }

    // 3. Durable awaited rehash (does not block user if DB update fails)
    await migrateLegacyPasswordDurable(supabase, user.id, storedStr, providedStr);

    return true;
}

module.exports = {
    isPasswordHash,
    hashPassword,
    hashPasswordSync,
    timingSafeCompare,
    migrateLegacyPasswordDurable,
    verifyAndMigrateDurable
};
