const crypto = require('crypto');
const pool = require('../db');

const {
    checkAndGrantAchievements
} = require('../services/achievements');

async function sessionRoutes(fastify) {
    const sessionRewardPoints = Number(
        process.env.SESSION_REWARD_POINTS || 10
    );

    // ============================================================
    // Начать игровую сессию
    // POST /me/sessions
    // ============================================================

    fastify.post(
        '/me/sessions',
        {
            preHandler: fastify.authenticate,
        },
        async (request, reply) => {
            const playerId = request.playerId;

            // Проверяем существование игрока.
            const playerResult = await pool.query(
                `
                SELECT id
                FROM players
                WHERE id = $1
                `,
                [playerId]
            );

            if (playerResult.rowCount === 0) {
                return reply.code(404).send({
                    error: 'player_not_found',
                });
            }

            const sessionId = crypto.randomUUID();

            try {
                /*
                 * В PostgreSQL установлен частичный UNIQUE INDEX:
                 *
                 * idx_one_active_session_per_player
                 *
                 * Он гарантирует, что у игрока может быть только
                 * одна сессия с ended_at IS NULL.
                 */
                const result = await pool.query(
                    `
                    INSERT INTO game_sessions (
                        id,
                        player_id
                    )
                    VALUES ($1, $2)
                    RETURNING
                        id,
                        player_id,
                        started_at,
                        ended_at
                    `,
                    [sessionId, playerId]
                );

                return {
                    success: true,
                    session: result.rows[0],
                };
            } catch (error) {
                /*
                 * PostgreSQL error code 23505 =
                 * unique_violation.
                 *
                 * В данном INSERT это означает, что игрок уже
                 * имеет активную игровую сессию.
                 */
                if (error.code === '23505') {
                    const activeResult = await pool.query(
                        `
                        SELECT
                            id,
                            player_id,
                            started_at,
                            ended_at
                        FROM game_sessions
                        WHERE player_id = $1
                          AND ended_at IS NULL
                        ORDER BY started_at DESC
                        LIMIT 1
                        `,
                        [playerId]
                    );

                    return reply.code(409).send({
                        error: 'session_already_active',
                        session: activeResult.rows[0] || null,
                    });
                }

                fastify.log.error(error);

                return reply.code(500).send({
                    error: 'session_start_failed',
                });
            }
        }
    );

    // ============================================================
    // Завершить игровую сессию
    // POST /me/sessions/:sessionId/end
    // ============================================================

    fastify.post(
        '/me/sessions/:sessionId/end',
        {
            preHandler: fastify.authenticate,
        },
        async (request, reply) => {
            const playerId = request.playerId;
            const sessionId = request.params.sessionId;

            // Проверяем UUID сессии.
            if (
                typeof sessionId !== 'string' ||
                !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
                    sessionId
                )
            ) {
                return reply.code(400).send({
                    error: 'invalid_session_id',
                });
            }

            const client = await pool.connect();

            try {
                await client.query('BEGIN');

                // Блокируем игрока на время операции.
                //
                // Это защищает баланс от параллельных операций.
                const playerResult = await client.query(
                    `
                    SELECT
                        id,
                        points
                    FROM players
                    WHERE id = $1
                    FOR UPDATE
                    `,
                    [playerId]
                );

                if (playerResult.rowCount === 0) {
                    await client.query('ROLLBACK');

                    return reply.code(404).send({
                        error: 'player_not_found',
                    });
                }

                const player = playerResult.rows[0];

                /*
                 * Закрываем только:
                 *
                 * 1. сессию с указанным ID;
                 * 2. принадлежащую текущему игроку;
                 * 3. которая ещё активна.
                 */
                const sessionResult = await client.query(
                    `
                    UPDATE game_sessions
                    SET ended_at = NOW()
                    WHERE id = $1
                      AND player_id = $2
                      AND ended_at IS NULL
                    RETURNING
                        id,
                        player_id,
                        started_at,
                        ended_at
                    `,
                    [sessionId, playerId]
                );

                if (sessionResult.rowCount === 0) {
                    await client.query('ROLLBACK');

                    return reply.code(404).send({
                        error: 'active_session_not_found',
                    });
                }

                const session = sessionResult.rows[0];

                // ====================================================
                // Начисляем награду за игровую сессию.
                // ====================================================

                const newPoints =
                    Number(player.points) + sessionRewardPoints;

                await client.query(
                    `
                    UPDATE players
                    SET points = $1
                    WHERE id = $2
                    `,
                    [newPoints, playerId]
                );

                // Записываем изменение баланса.
                await client.query(
                    `
                    INSERT INTO points_transactions (
                        player_id,
                        amount,
                        type
                    )
                    VALUES ($1, $2, 'session_reward')
                    `,
                    [playerId, sessionRewardPoints]
                );

                // ====================================================
                // Проверяем автоматические достижения.
                // ====================================================

                /*
                 * Все условия одной ачивки должны быть выполнены.
                 *
                 * Логика находится в:
                 * src/services/achievements.js
                 */
                const newlyObtainedAchievements =
                    await checkAndGrantAchievements(
                        client,
                        playerId
                    );

                await client.query('COMMIT');

                return {
                    success: true,
                    session,
                    reward: {
                        points: sessionRewardPoints,
                    },
                    points: newPoints,
                    achievements: newlyObtainedAchievements,
                };
            } catch (error) {
                await client.query('ROLLBACK');

                fastify.log.error(error);

                return reply.code(500).send({
                    error: 'session_end_failed',
                });
            } finally {
                client.release();
            }
        }
    );

    // ============================================================
    // Получить активную игровую сессию
    // GET /me/sessions/active
    // ============================================================

    fastify.get(
        '/me/sessions/active',
        {
            preHandler: fastify.authenticate,
        },
        async (request, reply) => {
            const playerId = request.playerId;

            const result = await pool.query(
                `
                SELECT
                    id,
                    player_id,
                    started_at,
                    ended_at
                FROM game_sessions
                WHERE player_id = $1
                  AND ended_at IS NULL
                ORDER BY started_at DESC
                LIMIT 1
                `,
                [playerId]
            );

            return {
                player_id: playerId,
                session: result.rows[0] || null,
            };
        }
    );
}

module.exports = sessionRoutes;
