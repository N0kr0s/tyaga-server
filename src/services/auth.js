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
    requireAuth
};
