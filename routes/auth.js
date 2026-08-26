const express = require('express');
const router = express.Router();
const supabase = require('../db');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { verifyAndMigrateDurable, hashPassword } = require('../utils/passwordSecurity');

// Professional Telegram initData verification
// Use environment variable for bot token
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

function verifyTelegramData(initData) {
    if (!initData) return false;

    try {
        const urlParams = new URLSearchParams(initData);
        const hash = urlParams.get('hash');
        urlParams.delete('hash');

        const sortedKeys = Array.from(urlParams.keys()).sort();
        const dataCheckString = sortedKeys
            .map(key => `${key}=${urlParams.get(key)}`)
            .join('\n');

        const secretKey = crypto
            .createHmac('sha256', 'WebAppData')
            .update(BOT_TOKEN)
            .digest();

        const generatedHash = crypto
            .createHmac('sha256', secretKey)
            .update(dataCheckString)
            .digest('hex');

        return generatedHash === hash;
    } catch (e) {
        console.error('Telegram sync verification error:', e);
        return false;
    }
}

/**
 * @swagger
 * /api/auth/login:
 *   post:
 *     summary: Login or Register user
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - phone
 *             properties:
 *               phone:
 *                 type: string
 *               role:
 *                 type: string
 *                 enum: [passenger, driver]
 *                 description: Required for new registration
 *     responses:
 *       200:
 *         description: Login successful
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 user:
 *                   type: object
 *                 token:
 *                   type: string
 *       400:
 *         description: Phone missing
 */
router.post('/login', async (req, res) => {
    let { phone, password } = req.body;
    if (!phone) return res.status(400).json({ error: 'Номер телефона требуется' });

    // Normalize phone (digits only + optional start plus)
    phone = phone.replace(/[^\d+]/g, '');
    console.log('[Auth/Login] Attempting login with normalized phone:', phone);

    try {
        let { data: user, error } = await supabase
            .from('users')
            .select('*')
            .eq('phone', phone)
            .maybeSingle();

        if (error) {
            console.error('[Auth/Login] Database error:', error);
            throw new Error('Ошибка базы данных: ' + error.message);
        }

        console.log('[Auth/Login] User lookup result:', user ? `Found user ${user.id}` : 'User not found, creating new');

        // Case 1: User does not exist at all — auto-create new user
        if (!user) {
            console.log('[Auth/Login] Creating new user with phone:', phone);
            const { data: newUser, error: insertErr } = await supabase
                .from('users')
                .insert([{
                    phone: phone,
                    name: '',
                    age: null,
                    role: 'passenger'
                }])
                .select('*')
                .single();

            if (insertErr) {
                console.error('[Auth/Login] Error creating user:', insertErr);
                throw new Error('Не удалось создать пользователя: ' + insertErr.message);
            }

            console.log('[Auth/Login] New user created with ID:', newUser.id);
            newUser.isNew = true;
            return res.json({
                user: newUser,
                token: 'mock-token-' + newUser.id
            });
        }

        // Case 2: User exists but has no password set (e.g. TG bot passenger/skeleton)
        if (!user.password) {
            console.log('[Auth/Login] User exists but no password. Profile complete:', user.name && user.age);
            const isNew = !user.name || !user.age || user.age <= 0;
            return res.json({
                user: {
                    id: user.id,
                    phone: user.phone,
                    name: user.name,
                    age: user.age,
                    rating: user.rating,
                    role: user.role,
                    isNew: isNew
                },
                token: 'mock-token-' + user.id
            });
        }

        // Case 3: User exists and has a password (durable lazy migration supported)
        // For web/mobile clients: password is only checked if explicitly provided
        if (password !== undefined && user.password) {
            const isMatch = await verifyAndMigrateDurable(supabase, user, password);
            if (!isMatch) {
                return res.status(401).json({ error: 'Неверный пароль. Пожалуйста, попробуйте снова.' });
            }
        }

        // User exists - return sanitized user object (never expose password or hash)
        const sanitizedUser = { ...user };
        delete sanitizedUser.password;
        sanitizedUser.isNew = !sanitizedUser.phone || !sanitizedUser.age || !sanitizedUser.name || sanitizedUser.age <= 0;
        return res.json({ user: sanitizedUser, token: 'mock-token-' + user.id });
    } catch (err) {
        console.error('[Auth/Login] Catch error:', err);
        res.status(500).json({ error: 'Ошибка входа: ' + err.message });
    }
});

/**
 * @swagger
 * /api/auth/register-mobile:
 *   post:
 *     summary: Register a new mobile user or secure an existing skeleton account
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - phone
 *               - password
 *               - name
 *             properties:
 *               phone:
 *                 type: string
 *               password:
 *                 type: string
 *               name:
 *                 type: string
 *               age:
 *                 type: integer
 *               sex:
 *                 type: string
 */
router.post('/register-mobile', async (req, res) => {
    let { phone, password, name, age, sex } = req.body;
    if (!phone || !password || !name) {
        return res.status(400).json({ error: 'Phone, password, and name are required' });
    }

    if (String(password).length < 6) {
        return res.status(400).json({ error: 'Пароль должен содержать не менее 6 символов' });
    }

    phone = phone.replace(/[^\d+]/g, '');

    try {
        // Always hash password before persisting
        const hashedPassword = await hashPassword(password);

        // Check if user already exists
        let { data: existingUser, error: findError } = await supabase
            .from('users')
            .select('*')
            .eq('phone', phone)
            .maybeSingle();

        if (findError) throw findError;

        let user;
        if (existingUser) {
            // If they already have a password, we protect them from overwrite!
            if (existingUser.password) {
                return res.status(400).json({ error: 'Пользователь с таким телефоном уже зарегистрирован. Пожалуйста, войдите.' });
            }
            
            // Upgrade the existing skeleton user with hashed password and details
            const { data: updatedUser, error: updateError } = await supabase
                .from('users')
                .update({
                    password: hashedPassword,
                    name,
                    age: parseInt(age) || null,
                    sex: sex || null
                })
                .eq('id', existingUser.id)
                .select()
                .single();

            if (updateError) throw updateError;
            user = updatedUser;
        } else {
            // Create a completely new user with hashed password
            const { data: newUser, error: insertError } = await supabase
                .from('users')
                .insert([{
                    phone,
                    password: hashedPassword,
                    name,
                    age: parseInt(age) || null,
                    sex: sex || null,
                    role: 'passenger'
                }])
                .select()
                .single();

            if (insertError) throw insertError;
            user = newUser;
        }

        const sanitizedUser = { ...user };
        delete sanitizedUser.password;

        res.json({ 
            success: true,
            user: sanitizedUser,
            token: 'mock-token-' + user.id 
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * @swagger
 * /api/auth/register:
 *   post:
 *     summary: Complete user profile registration
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - id
 *               - name
 *               - age
 *             properties:
 *               id:
 *                 type: integer
 *               name:
 *                 type: string
 *               surname:
 *                 type: string
 *               age:
 *                 type: integer
 *               sex:
 *                 type: string
 *     responses:
 *       200:
 *         description: Registration successful
 *       500:
 *         description: Server error
 */
router.post('/register', async (req, res) => {
    const { id, name, age, phone } = req.body;
    try {
        const updateData = { name, age };

        if (phone) {
            updateData.phone = phone.replace(/[^\d+]/g, '');
        }

        const { data: user, error } = await supabase
            .from('users')
            .update(updateData)
            .eq('id', id)
            .select()
            .single();

        if (error) throw error;
        res.json({ user });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * @swagger
 * /api/auth/bus-login:
 *   post:
 *     summary: Login for Bus Drivers
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - phone
 *               - password
 *             properties:
 *               phone:
 *                 type: string
 *               password:
 *                 type: string
 */
router.post('/bus-login', async (req, res) => {
    const { phone, password } = req.body;
    if (!phone || !password) return res.status(400).json({ error: 'Необходимо указать телефон и пароль' });

    try {
        const { data: user, error } = await supabase
            .from('users')
            .select('*')
            .eq('phone', phone)
            .maybeSingle();

        if (error || !user || !user.password) {
            return res.status(401).json({ error: 'Неверный телефон, пароль или нет прав доступа' });
        }

        // Verify password (supports bcrypt hash and legacy plaintext with durable awaited rehash)
        const isMatch = await verifyAndMigrateDurable(supabase, user, password);

        if (!isMatch) {
            return res.status(401).json({ error: 'Неверный телефон, пароль или нет прав доступа' });
        }

        if (user.is_blocked) {
            return res.status(403).json({ error: 'Аккаунт заблокирован администратором' });
        }

        let carrierId = user.id;
        let memberRole = user.role === 'bus_driver' ? 'owner' : null;

        // Check carrier_members if user is an employee
        try {
            const { data: member } = await supabase
                .from('carrier_members')
                .select('carrier_id, role, is_active')
                .eq('user_id', user.id)
                .maybeSingle();

            if (member) {
                if (!member.is_active) {
                    return res.status(403).json({ error: 'Доступ сотрудника отключен владельцем перевозчика' });
                }
                carrierId = member.carrier_id;
                memberRole = member.role;
            }
        } catch (mErr) {
            // graceful fallback if carrier_members not present
        }

        // If neither bus_driver nor carrier_member
        if (!memberRole && user.role !== 'bus_driver') {
            return res.status(403).json({ error: 'У пользователя нет прав доступа к кабинету перевозчика' });
        }

        const jwtSecret = process.env.JWT_SECRET;
        if (!jwtSecret) {
            console.error('[Auth Error] JWT_SECRET is not configured in environment!');
            return res.status(500).json({ error: 'Внутренняя ошибка конфигурации безопасности сервера' });
        }

        // Issue cryptographically signed JWT (7 days TTL, strict issuer & audience)
        const token = jwt.sign(
            {
                sub: String(user.id),
                carrierId: carrierId,
                role: memberRole || 'owner',
                phone: user.phone
            },
            jwtSecret,
            {
                algorithm: 'HS256',
                expiresIn: '7d',
                issuer: 'poputki.online',
                audience: 'poputki-carrier'
            }
        );

        res.json({
            user: {
                id: user.id,
                name: user.name,
                phone: user.phone,
                role: user.role,
                carrierId,
                memberRole: memberRole || 'owner'
            },
            token
        });
    } catch (err) {
        console.error('[bus-login error]', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * @swagger
 * /api/auth/telegram-login:
 *   post:
 *     summary: Login or Register user via Telegram Mini App
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - id
 *               - first_name
 *             properties:
 *               id:
 *                 type: integer
 *               first_name:
 *                 type: string
 *               last_name:
 *                 type: string
 *               username:
 *                 type: string
 *               photo_url:
 *                 type: string
 *     responses:
 *       200:
 *         description: Login successful
 */
router.post('/telegram-login', async (req, res) => {
    const { id, first_name, last_name, username, photo_url, userId, initData } = req.body;

    if (!id || !first_name) {
        return res.status(400).json({ error: 'Telegram ID and first_name are required' });
    }

    // Professional Verification
    if (initData && !verifyTelegramData(initData)) {
        console.error("[Auth/Telegram] Data verification failed for ID:", id);
        return res.status(403).json({ error: 'Ошибка проверки данных Telegram' });
    }

    console.log(`[Auth/Telegram] Login request for ID: ${id}, Name: ${first_name}, userId: ${userId}`);

    console.log(`Telegram Login request for ID: ${id}, Name: ${first_name}, userId: ${userId}`);

    try {
        const fullName = last_name ? `${first_name} ${last_name}` : first_name;
        let user;

        // Step 1: Check if this telegram_id already exists in our DB
        const { data: existingTgUser } = await supabase
            .from('users')
            .select('*')
            .eq('telegram_id', id)
            .maybeSingle();

        if (userId) {
            // We want to link the TG account to an existing profile (usually logged in via phone)
            if (existingTgUser) {
                if (existingTgUser.id !== parseInt(userId)) {
                    // Conflict: This TG account is already linked to another DB user
                    // If the existing linked user is just a skeleton (no phone), we can merge/transfer
                    if (!existingTgUser.phone) {
                        // Delete the skeleton TG user
                        await supabase.from('users').delete().eq('id', existingTgUser.id);
                        // Now update the current user (phone user) with the TG info
                        const { data: updatedUser, error: updateError } = await supabase
                            .from('users')
                            .update({
                                telegram_id: id,
                                username: username || null,
                                photo_url: photo_url || null,
                                name: fullName
                            })
                            .eq('id', userId)
                            .select()
                            .single();

                        if (updateError) {
                            console.error("Error updating user with TG info (merge):", updateError);
                            throw updateError;
                        }
                        user = updatedUser;
                    } else {
                        // Existing user has a phone! This is a real conflict. 
                        // Just use the existing user instead of linking to the new one?
                        // For now, prioritize the account that already has the phone.
                        user = existingTgUser;
                    }
                } else {
                    // Already linked correctly, just update info
                    const { data: updatedUser, error: updateError } = await supabase
                        .from('users')
                        .update({
                            username: username || existingTgUser.username,
                            photo_url: photo_url || existingTgUser.photo_url,
                            name: existingTgUser.name || fullName
                        })
                        .eq('id', userId)
                        .select()
                        .single();

                    if (updateError) {
                        console.error("Error updating existing linked user:", updateError);
                        throw updateError;
                    }
                    user = updatedUser;
                }
            } else {
                // Link new TG account to existing phone user
                const { data: updatedUser, error: updateError } = await supabase
                    .from('users')
                    .update({
                        telegram_id: id,
                        username: username || null,
                        photo_url: photo_url || null,
                        name: fullName
                    })
                    .eq('id', userId)
                    .select()
                    .single();

                if (updateError) {
                    console.error("Error linking TG to user:", updateError);
                    throw updateError;
                }
                user = updatedUser;
            }
        } else {
            // No userId provided, just find or create by telegram_id
            if (existingTgUser) {
                // Update existing user's Telegram info
                const { data: updatedUser, error: updateError } = await supabase
                    .from('users')
                    .update({
                        username: username || existingTgUser.username,
                        photo_url: photo_url || existingTgUser.photo_url,
                        name: existingTgUser.name || fullName
                    })
                    .eq('id', existingTgUser.id)
                    .select()
                    .single();

                if (updateError) {
                    console.error("Error updating existing TG user:", updateError);
                    throw updateError;
                }
                user = updatedUser;
            } else {
                // Create new user from TG info
                const { data: newUser, error: insertError } = await supabase
                    .from('users')
                    .insert([{
                        telegram_id: id,
                        username: username,
                        name: fullName,
                        photo_url: photo_url,
                        role: 'passenger'
                    }])
                    .select()
                    .single();

                if (insertError) {
                    console.error("Error creating new TG user:", insertError);
                    throw insertError;
                }
                user = newUser;
            }
        }

        // Set isNew flag if they haven't provided enough info yet (name, age, phone)
        user.isNew = !user.phone || !user.age || !user.name || user.age <= 0;

        console.log('[Auth/Telegram] Login successful for user:', user.id);
        res.json({ user, token: 'mock-token-' + user.id });
    } catch (err) {
        console.error("[Auth/Telegram] Login error:", err);
        res.status(500).json({ error: 'Ошибка Telegram входа: ' + err.message });
    }
});

module.exports = router;
