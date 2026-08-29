const crypto = require('crypto');
const pool = require('../db');

function hashToken(token) {
    return crypto
        .createHash('sha256')
        .update(token)
        .digest('hex');
}

async function requireAuth(request, reply) {
    const header = request.headers.authorization;

    if (
        typeof header !== 'string' ||
        !header.startsWith('Bearer ')
    ) {
        return reply.code(401).send({
            error: 'authentication_required',
        });
    }

    const token = header.slice(7).trim();

    if (!token) {
        return reply.code(401).send({
            error: 'authentication_required',
        });
    }

    const tokenHash = hashToken(token);

    const result = await pool.query(
        `
        SELECT
            a.id AS session_id,
            a.player_id
        FROM auth_sessions a
        WHERE a.token_hash = $1
          AND a.expires_at > NOW()
        `,
        [tokenHash]
    );

    if (result.rowCount === 0) {
        return reply.code(401).send({
            error: 'invalid_or_expired_token',
        });
    }

    request.playerId = Number(result.rows[0].player_id);
    request.authSessionId = Number(result.rows[0].session_id);

    await pool.query(
        `
        UPDATE auth_sessions
        SET last_used_at = NOW()
        WHERE id = $1
        `,
        [result.rows[0].session_id]
    );
}

module.exports = {
    requireAuth,
};
