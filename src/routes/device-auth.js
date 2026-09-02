const crypto = require('crypto');
const pool = require('../db');

const {
    createAuthSessionWithClient,
    hashToken
} = require('../services/auth');

const DEVICE_CHALLENGE_TTL_SECONDS = 300;
const CODE_PATTERN = /^[0-9a-f]{64}$/i;

function generateCode() {
    return crypto.randomBytes(32).toString('hex');
}

function isValidCode(code) {
    return (
        typeof code === 'string' &&
        CODE_PATTERN.test(code)
    );
}

function getRequestCode(value) {
    if (!isValidCode(value)) {
        return null;
    }

    return value;
}

async function deviceAuthRoutes(fastify) {
    // ============================================================
    // START DEVICE AUTH
    // ============================================================

    fastify.post(
        '/auth/device/start',
        async (request, reply) => {
            const challenge = generateCode();
            const exchangeCode = generateCode();

            await pool.query(
                `
                INSERT INTO game_auth_attempts (
                    start_code_hash,
                    callback_code_hash,
                    expires_at,
                    callback_expires_at
                )
                VALUES (
                    $1,
                    $2,
                    NOW() + ($3 * INTERVAL '1 second'),
                    NOW() + ($3 * INTERVAL '1 second')
                )
                `,
                [
                    hashToken(challenge),
                    hashToken(exchangeCode),
                    DEVICE_CHALLENGE_TTL_SECONDS
                ]
            );

            return {
                success: true,
                challenge,
                exchange_code: exchangeCode,
                auth_url:
                    `https://auth.tyaga-game.ru/#challenge=${encodeURIComponent(challenge)}`,
                expires_in:
                    DEVICE_CHALLENGE_TTL_SECONDS
            };
        }
    );

    // ============================================================
    // CHECK DEVICE AUTH
    // ============================================================

    fastify.post(
        '/auth/device/status',
        async (request, reply) => {
            const body = request.body;

            if (
                body === null ||
                typeof body !== 'object' ||
                Array.isArray(body)
            ) {
                return reply.code(400).send({
                    error: 'invalid_request_body'
                });
            }

            const challenge = getRequestCode(
                body.challenge
            );

            if (!challenge) {
                return reply.code(400).send({
                    error: 'invalid_challenge'
                });
            }

            const result =
                await pool.query(
                    `
                    SELECT
                        player_id,
                        expires_at,
                        callback_expires_at,
                        completed_at,
                        consumed_at
                    FROM game_auth_attempts
                    WHERE start_code_hash = $1
                    `,
                    [hashToken(challenge)]
                );

            if (result.rowCount === 0) {
                return reply.code(404).send({
                    error: 'challenge_not_found'
                });
            }

            const row = result.rows[0];

            if (row.consumed_at !== null) {
                return {
                    success: true,
                    status: 'consumed'
                };
            }

            if (
                new Date(row.expires_at).getTime()
                <= Date.now()
            ) {
                return {
                    success: false,
                    status: 'expired'
                };
            }

            if (
                row.callback_expires_at !== null &&
                new Date(row.callback_expires_at).getTime()
                <= Date.now()
            ) {
                return {
                    success: false,
                    status: 'expired'
                };
            }

            if (row.completed_at === null) {
                return {
                    success: true,
                    status: 'pending'
                };
            }

            return {
                success: true,
                status: 'completed'
            };
        }
    );

    // ============================================================
    // EXCHANGE COMPLETED DEVICE AUTH
    // ============================================================

    fastify.post(
        '/auth/device/exchange',
        async (request, reply) => {
            const body = request.body;

            if (
                body === null ||
                typeof body !== 'object' ||
                Array.isArray(body)
            ) {
                return reply.code(400).send({
                    error: 'invalid_request_body'
                });
            }

            const challenge = getRequestCode(
                body.challenge
            );

            const exchangeCode = getRequestCode(
                body.exchange_code
            );

            if (!challenge || !exchangeCode) {
                return reply.code(400).send({
                    error: 'invalid_exchange_request'
                });
            }

            const client =
                await pool.connect();

            try {
                await client.query('BEGIN');

                const result =
                    await client.query(
                        `
                        SELECT
                            id,
                            player_id,
                            expires_at,
                            callback_expires_at,
                            completed_at,
                            consumed_at
                        FROM game_auth_attempts
                        WHERE start_code_hash = $1
                          AND callback_code_hash = $2
                        FOR UPDATE
                        `,
                        [
                            hashToken(challenge),
                            hashToken(exchangeCode)
                        ]
                    );

                if (result.rowCount === 0) {
                    await client.query('ROLLBACK');

                    return reply.code(401).send({
                        error: 'invalid_exchange_code'
                    });
                }

                const attempt =
                    result.rows[0];

                if (attempt.consumed_at !== null) {
                    await client.query('ROLLBACK');

                    return reply.code(409).send({
                        error: 'exchange_already_consumed'
                    });
                }

                if (
                    new Date(attempt.expires_at).getTime()
                    <= Date.now() ||
                    (
                        attempt.callback_expires_at !== null &&
                        new Date(
                            attempt.callback_expires_at
                        ).getTime() <= Date.now()
                    )
                ) {
                    await client.query('ROLLBACK');

                    return reply.code(410).send({
                        error: 'game_auth_attempt_expired'
                    });
                }

                if (
                    attempt.completed_at === null ||
                    attempt.player_id === null
                ) {
                    await client.query('ROLLBACK');

                    return reply.code(409).send({
                        error: 'authentication_pending'
                    });
                }

                const auth =
                    await createAuthSessionWithClient(
                        client,
                        Number(attempt.player_id)
                    );

                const consumedResult =
                    await client.query(
                        `
                        UPDATE game_auth_attempts
                        SET consumed_at = NOW()
                        WHERE id = $1
                          AND consumed_at IS NULL
                        RETURNING consumed_at
                        `,
                        [attempt.id]
                    );

                if (consumedResult.rowCount === 0) {
                    await client.query('ROLLBACK');

                    return reply.code(409).send({
                        error: 'exchange_already_consumed'
                    });
                }

                await client.query('COMMIT');

                return {
                    success: true,
                    player_id: Number(attempt.player_id),
                    token: auth.token,
                    session: auth.session
                };
            } catch (error) {
                try {
                    await client.query('ROLLBACK');
                } catch (rollbackError) {
                    fastify.log.error(rollbackError);
                }

                fastify.log.error(error);

                return reply.code(500).send({
                    error: 'device_auth_exchange_failed'
                });
            } finally {
                client.release();
            }
        }
    );
}

module.exports = deviceAuthRoutes;
