const pool = require('../db');

async function achievementRoutes(fastify) {

    // Получить список всех активных ачивок
    fastify.get('/achievements', async (request, reply) => {
        const result = await pool.query(
            `
            SELECT
                id,
                name,
                description,
                created_at
            FROM achievements
            WHERE is_active = TRUE
            ORDER BY id
            `
        );

        return result.rows;
    });


    // Получить конкретную ачивку
    fastify.get('/achievements/:id', async (request, reply) => {
        const achievementId = Number(request.params.id);

        if (!Number.isInteger(achievementId) || achievementId <= 0) {
            return reply.code(400).send({
                error: 'invalid_achievement_id'
            });
        }

        const result = await pool.query(
            `
            SELECT
                id,
                name,
                description,
                created_at
            FROM achievements
            WHERE id = $1
              AND is_active = TRUE
            `,
            [achievementId]
        );

        if (result.rowCount === 0) {
            return reply.code(404).send({
                error: 'achievement_not_found'
            });
        }

        return result.rows[0];
    });


    // Получить ачивки игрока
    fastify.get('/players/:id/achievements', async (request, reply) => {
        const playerId = Number(request.params.id);

        if (!Number.isInteger(playerId) || playerId <= 0) {
            return reply.code(400).send({
                error: 'invalid_player_id'
            });
        }

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
                error: 'player_not_found'
            });
        }

        const result = await pool.query(
            `
            SELECT
                a.id,
                a.name,
                a.description,
                pa.obtained_at
            FROM player_achievements pa
            JOIN achievements a
                ON a.id = pa.achievement_id
            WHERE pa.player_id = $1
              AND a.is_active = TRUE
            ORDER BY a.id
            `,
            [playerId]
        );

        return {
            player_id: playerId,
            achievements: result.rows
        };
    });


    // Выдать игроку ачивку
    fastify.post(
        '/players/:id/achievements/:achievementId',
        async (request, reply) => {
            const playerId = Number(request.params.id);
            const achievementId = Number(request.params.achievementId);

            if (!Number.isInteger(playerId) || playerId <= 0) {
                return reply.code(400).send({
                    error: 'invalid_player_id'
                });
            }

            if (!Number.isInteger(achievementId) || achievementId <= 0) {
                return reply.code(400).send({
                    error: 'invalid_achievement_id'
                });
            }

            const client = await pool.connect();

            try {
                await client.query('BEGIN');

                // Проверяем игрока
                const playerResult = await client.query(
                    `
                    SELECT id
                    FROM players
                    WHERE id = $1
                    FOR UPDATE
                    `,
                    [playerId]
                );

                if (playerResult.rowCount === 0) {
                    await client.query('ROLLBACK');

                    return reply.code(404).send({
                        error: 'player_not_found'
                    });
                }

                // Проверяем ачивку
                const achievementResult = await client.query(
                    `
                    SELECT
                        id,
                        name,
                        description
                    FROM achievements
                    WHERE id = $1
                      AND is_active = TRUE
                    FOR UPDATE
                    `,
                    [achievementId]
                );

                if (achievementResult.rowCount === 0) {
                    await client.query('ROLLBACK');

                    return reply.code(404).send({
                        error: 'achievement_not_found'
                    });
                }

                const achievement = achievementResult.rows[0];

                // Проверяем, есть ли уже ачивка
                const ownershipResult = await client.query(
                    `
                    SELECT obtained_at
                    FROM player_achievements
                    WHERE player_id = $1
                      AND achievement_id = $2
                    `,
                    [playerId, achievementId]
                );

                if (ownershipResult.rowCount > 0) {
                    await client.query('ROLLBACK');

                    return reply.code(409).send({
                        error: 'achievement_already_owned',
                        obtained_at: ownershipResult.rows[0].obtained_at
                    });
                }

                // Выдаём ачивку
                const insertResult = await client.query(
                    `
                    INSERT INTO player_achievements (
                        player_id,
                        achievement_id
                    )
                    VALUES ($1, $2)
                    RETURNING obtained_at
                    `,
                    [playerId, achievementId]
                );

                await client.query('COMMIT');

                return {
                    success: true,
                    achievement: {
                        id: achievement.id,
                        name: achievement.name,
                        description: achievement.description
                    },
                    obtained_at: insertResult.rows[0].obtained_at
                };

            } catch (error) {
                await client.query('ROLLBACK');

                fastify.log.error(error);

                return reply.code(500).send({
                    error: 'achievement_grant_failed'
                });
            } finally {
                client.release();
            }
        }
    );


    // Добавить требование ачивки к скину
    fastify.post(
        '/skins/:skinId/requirements/:achievementId',
        async (request, reply) => {
            const skinId = Number(request.params.skinId);
            const achievementId = Number(request.params.achievementId);

            if (!Number.isInteger(skinId) || skinId <= 0) {
                return reply.code(400).send({
                    error: 'invalid_skin_id'
                });
            }

            if (!Number.isInteger(achievementId) || achievementId <= 0) {
                return reply.code(400).send({
                    error: 'invalid_achievement_id'
                });
            }

            const client = await pool.connect();

            try {
                await client.query('BEGIN');

                // Проверяем скин
                const skinResult = await client.query(
                    `
                    SELECT id, name
                    FROM skins
                    WHERE id = $1
                      AND is_active = TRUE
                    FOR UPDATE
                    `,
                    [skinId]
                );

                if (skinResult.rowCount === 0) {
                    await client.query('ROLLBACK');

                    return reply.code(404).send({
                        error: 'skin_not_found'
                    });
                }

                // Проверяем ачивку
                const achievementResult = await client.query(
                    `
                    SELECT id, name
                    FROM achievements
                    WHERE id = $1
                      AND is_active = TRUE
                    FOR UPDATE
                    `,
                    [achievementId]
                );

                if (achievementResult.rowCount === 0) {
                    await client.query('ROLLBACK');

                    return reply.code(404).send({
                        error: 'achievement_not_found'
                    });
                }

                // Добавляем связь
                const insertResult = await client.query(
                    `
                    INSERT INTO skin_requirements (
                        skin_id,
                        achievement_id
                    )
                    VALUES ($1, $2)
                    ON CONFLICT (skin_id, achievement_id)
                    DO NOTHING
                    RETURNING skin_id, achievement_id
                    `,
                    [skinId, achievementId]
                );

                await client.query('COMMIT');

                if (insertResult.rowCount === 0) {
                    return reply.code(409).send({
                        error: 'requirement_already_exists'
                    });
                }

                return {
                    success: true,
                    skin: {
                        id: skinResult.rows[0].id,
                        name: skinResult.rows[0].name
                    },
                    achievement: {
                        id: achievementResult.rows[0].id,
                        name: achievementResult.rows[0].name
                    }
                };

            } catch (error) {
                await client.query('ROLLBACK');

                fastify.log.error(error);

                return reply.code(500).send({
                    error: 'requirement_creation_failed'
                });
            } finally {
                client.release();
            }
        }
    );
}

module.exports = achievementRoutes;
