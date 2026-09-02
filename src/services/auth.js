const crypto = require('crypto');
const pool = require('../db');

const AUTH_SESSION_DAYS = Number(
    process.env.AUTH_SESSION_DAYS || 30
);

// ============================================================
// TOKEN HELPERS
// ============================================================

function generateToken() {
    return crypto.randomBytes(32).toString('hex');
}

function hashToken(token) {
    return crypto
        .createHash('sha256')
        .update(token)
        .digest('hex');
}

// ============================================================
// CREATE AUTH SESSION
// ============================================================

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

// ============================================================
// CREATE AUTH SESSION USING EXISTING DB CLIENT
// ============================================================

async function createAuthSessionWithClient(
    client,
    playerId
) {
    const token = generateToken();
    const tokenHash = hashToken(token);

    const result = await client.query(
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

// ============================================================
// AUTHENTICATE BEARER TOKEN
// ============================================================

async function authenticateToken(token) {
    if (
        typeof token !== 'string' ||
        !/^[0-9a-f]{64}$/i.test(token)
    ) {
        return null;
    }

    const tokenHash = hashToken(token);

    const result = await pool.query(
        `
        SELECT
            id AS session_id,
            player_id,
            expires_at
        FROM auth_sessions
        WHERE token_hash = $1
          AND expires_at > NOW()
        `,
        [tokenHash]
    );

    if (result.rowCount === 0) {
        return null;
    }

    const session = result.rows[0];

    await pool.query(
        `
        UPDATE auth_sessions
        SET last_used_at = NOW()
        WHERE id = $1
        `,
        [session.session_id]
    );

    return session;
}

// ============================================================
// REVOKE AUTH SESSION
// ============================================================

async function revokeAuthSession(token) {
    if (
        typeof token !== 'string' ||
        !/^[0-9a-f]{64}$/i.test(token)
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

// ============================================================
// EXTRACT BEARER TOKEN
// ============================================================

function getBearerToken(request) {
    const header = request.headers.authorization;

    if (
        typeof header !== 'string' ||
        !header.startsWith('Bearer ')
    ) {
        return null;
    }

    const token = header
        .slice(7)
        .trim();

    if (!token) {
        return null;
    }

    return token;
}

// ============================================================
// FASTIFY AUTH MIDDLEWARE
// ============================================================

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

    request.playerId =
        Number(auth.player_id);

    request.authSessionId =
        Number(auth.session_id);
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
    createAuthSession,
    createAuthSessionWithClient,
    hashToken,
    authenticateToken,
    revokeAuthSession,
    getBearerToken,
    requireAuth
};
