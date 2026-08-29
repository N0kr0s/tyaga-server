const crypto = require('crypto');
const pool = require('../db');

const AUTH_SESSION_DAYS = Number(
    process.env.AUTH_SESSION_DAYS || 30
);

const TELEGRAM_AUTH_MAX_AGE_SECONDS = Number(
    process.env.TELEGRAM_AUTH_MAX_AGE_SECONDS || 600
);

// --------------------------------------------------
// API session tokens
// --------------------------------------------------

function generateToken() {
    return crypto.randomBytes(32).toString('hex');
}

function hashToken(token) {
    return crypto
        .createHash('sha256')
        .update(token)
        .digest('hex');
}

// --------------------------------------------------
// Telegram Mini App initData validation
// --------------------------------------------------

function createTelegramSecretKey(botToken) {
    return crypto
        .createHmac('sha256', 'WebAppData')
        .update(botToken)
        .digest();
}

function buildTelegramDataCheckString(params) {
    const entries = [];

    for (const [key, value] of params.entries()) {
        if (key === 'hash') {
            continue;
        }

        entries.push(`${key}=${value}`);
    }

    entries.sort();

    return entries.join('\n');
}

function validateTelegramInitData(initData) {
    if (
        typeof initData !== 'string' ||
        initData.length === 0
    ) {
        return {
            valid: false,
            error: 'invalid_init_data'
        };
    }

    const botToken = process.env.TELEGRAM_BOT_TOKEN;

    if (
        typeof botToken !== 'string' ||
        botToken.length === 0
    ) {
        throw new Error(
            'TELEGRAM_BOT_TOKEN is not configured'
        );
    }

    let params;

    try {
        params = new URLSearchParams(initData);
    } catch (error) {
        return {
            valid: false,
            error: 'invalid_init_data'
        };
    }

    const receivedHash = params.get('hash');

    if (
        typeof receivedHash !== 'string' ||
        !/^[0-9a-f]{64}$/i.test(receivedHash)
    ) {
        return {
            valid: false,
            error: 'invalid_telegram_hash'
        };
    }

    const authDateRaw = params.get('auth_date');

    if (
        typeof authDateRaw !== 'string' ||
        !/^\d+$/.test(authDateRaw)
    ) {
        return {
            valid: false,
            error: 'invalid_auth_date'
        };
    }

    const authDate = Number(authDateRaw);

    if (!Number.isSafeInteger(authDate)) {
        return {
            valid: false,
            error: 'invalid_auth_date'
        };
    }

    const now = Math.floor(Date.now() / 1000);
    const age = now - authDate;

    /*
     * Не принимаем данные из будущего с большим
     * расхождением времени.
     */
    if (age < -60) {
        return {
            valid: false,
            error: 'invalid_auth_date'
        };
    }

    if (age > TELEGRAM_AUTH_MAX_AGE_SECONDS) {
        return {
            valid: false,
            error: 'telegram_auth_data_expired'
        };
    }

    const dataCheckString =
        buildTelegramDataCheckString(params);

    const secretKey =
        createTelegramSecretKey(botToken);

    const calculatedHash = crypto
        .createHmac('sha256', secretKey)
        .update(dataCheckString)
        .digest('hex');

    let hashesEqual = false;

    try {
        hashesEqual = crypto.timingSafeEqual(
            Buffer.from(calculatedHash, 'hex'),
            Buffer.from(receivedHash, 'hex')
        );
    } catch (error) {
        hashesEqual = false;
    }

    if (!hashesEqual) {
        return {
            valid: false,
            error: 'invalid_telegram_signature'
        };
    }

    const userRaw = params.get('user');

    if (
        typeof userRaw !== 'string' ||
        userRaw.length === 0
    ) {
        return {
            valid: false,
            error: 'telegram_user_missing'
        };
    }

    let user;

    try {
        user = JSON.parse(userRaw);
    } catch (error) {
        return {
            valid: false,
            error: 'invalid_telegram_user'
        };
    }

    /*
     * Telegram user.id может быть большим числом.
     * Никогда не приводим его к Number.
     */
    if (
        user === null ||
        typeof user !== 'object' ||
        !Number.isSafeInteger(user.id) ||
        user.id <= 0
    ) {
        return {
            valid: false,
            error: 'invalid_telegram_user'
        };
    }

    return {
        valid: true,
        user,
        authDate
    };
}

// --------------------------------------------------
// Create API session
// --------------------------------------------------

async function createAuthSession(playerId) {
    const token = generateToken();
    const tokenHash = hashToken(token);

    const result = await pool.query(
        `
        INSERT INTO auth_sessions (
            player_id,
            token_hash,
            expires_at
        )
        VALUES (
            $1,
            $2,
            NOW() + ($3 * INTERVAL '1 day')
        )
        RETURNING
            id,
            player_id,
            created_at,
            expires_at
        `,
        [
            playerId,
            tokenHash,
            AUTH_SESSION_DAYS
        ]
    );

    return {
        token,
        session: result.rows[0]
    };
}

// --------------------------------------------------
// Authenticate bearer token
// --------------------------------------------------

async function authenticateToken(token) {
    if (
        typeof token !== 'string' ||
        token.length !== 64
    ) {
        return null;
    }

    const tokenHash = hashToken(token);

    const result = await pool.query(
        `
        SELECT
            s.id AS session_id,
            s.player_id,
            s.expires_at
        FROM auth_sessions s
        WHERE s.token_hash = $1
          AND s.expires_at > NOW()
        `,
        [tokenHash]
    );

    if (result.rowCount === 0) {
        return null;
    }

    await pool.query(
        `
        UPDATE auth_sessions
        SET last_used_at = NOW()
        WHERE id = $1
        `,
        [result.rows[0].session_id]
    );

    return result.rows[0];
}

// --------------------------------------------------
// Revoke bearer token
// --------------------------------------------------

async function revokeAuthSession(token) {
    if (
        typeof token !== 'string' ||
        token.length !== 64
    ) {
        return false;
    }

    const tokenHash = hashToken(token);

    const result = await pool.query(
        `
        DELETE FROM auth_sessions
        WHERE token_hash = $1
        `,
        [tokenHash]
    );

    return result.rowCount > 0;
}

// --------------------------------------------------
// Extract bearer token
// --------------------------------------------------

function getBearerToken(request) {
    const header = request.headers.authorization;

    if (
        typeof header !== 'string' ||
        !header.startsWith('Bearer ')
    ) {
        return null;
    }

    return header.slice(7).trim();
}

// --------------------------------------------------
// Fastify auth preHandler
// --------------------------------------------------

async function requireAuth(request, reply) {
    const token = getBearerToken(request);

    if (!token) {
        return reply.code(401).send({
            error: 'authentication_required'
        });
    }

    const auth = await authenticateToken(token);

    if (!auth) {
        return reply.code(401).send({
            error: 'invalid_or_expired_token'
        });
    }

    request.playerId = Number(auth.player_id);
    request.authSessionId = Number(auth.session_id);
}

module.exports = {
    createAuthSession,
    authenticateToken,
    revokeAuthSession,
    getBearerToken,
    requireAuth,
    validateTelegramInitData
};
