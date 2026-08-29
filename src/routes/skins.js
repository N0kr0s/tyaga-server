const pool = require('../db');

async function skinsRoutes(fastify) {
    // Получить список всех активных скинов
    fastify.get('/skins', async (request, reply) => {
        const result = await pool.query(
            `
            SELECT
                id,
                name,
                price,
                is_free,
                requires_identity,
                requires_achievement,
                is_secret
            FROM skins
            WHERE is_active = TRUE
            ORDER BY id
            `
        );

        return result.rows;
    });

    // Получить информацию о конкретном скине
    fastify.get('/skins/:id', async (request, reply) => {
        const skinId = Number(request.params.id);

        if (!Number.isInteger(skinId) || skinId <= 0) {
            return reply.code(400).send({
                error: 'invalid_skin_id',
            });
        }

        const result = await pool.query(
            `
            SELECT
                id,
                name,
                price,
                is_free,
                requires_identity,
                requires_achievement,
                is_secret
            FROM skins
            WHERE id = $1
              AND is_active = TRUE
            `,
            [skinId]
        );

        if (result.rowCount === 0) {
            return reply.code(404).send({
                error: 'skin_not_found',
            });
        }

        return result.rows[0];
    });

    // Получить требования конкретного скина
    fastify.get('/skins/:id/requirements', async (request, reply) => {
        const skinId = Number(request.params.id);

        if (!Number.isInteger(skinId) || skinId <= 0) {
            return reply.code(400).send({
                error: 'invalid_skin_id',
            });
        }

        // Проверяем, существует ли скин
        const skinResult = await pool.query(
            `
            SELECT
                id,
                name
            FROM skins
            WHERE id = $1
              AND is_active = TRUE
            `,
            [skinId]
        );

        if (skinResult.rowCount === 0) {
            return reply.code(404).send({
                error: 'skin_not_found',
            });
        }

        // Получаем все требования-ачивки
        const requirementsResult = await pool.query(
            `
            SELECT
                a.id,
                a.name,
                a.description
            FROM skin_requirements sr
            JOIN achievements a
                ON a.id = sr.achievement_id
            WHERE sr.skin_id = $1
              AND a.is_active = TRUE
            ORDER BY a.id
            `,
            [skinId]
        );

        return {
            skin_id: skinId,
            skin_name: skinResult.rows[0].name,
            requirements: requirementsResult.rows,
        };
    });

    // Получить конкретный скин игрока
    fastify.get(
        '/players/:playerId/skins/:skinId',
        async (request, reply) => {
            const playerId = Number(request.params.playerId);
            const skinId = Number(request.params.skinId);

            if (!Number.isInteger(playerId) || playerId <= 0) {
                return reply.code(400).send({
                    error: 'invalid_player_id',
                });
            }

            if (!Number.isInteger(skinId) || skinId <= 0) {
                return reply.code(400).send({
                    error: 'invalid_skin_id',
                });
            }

            // Проверяем игрока
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

            // Получаем скин и проверяем владение
            const skinResult = await pool.query(
                `
                SELECT
                    s.id,
                    s.name,
                    s.price,
                    s.is_free,
                    s.requires_identity,
                    s.requires_achievement,
                    s.is_secret,
                    ps.source,
                    ps.obtained_at
                FROM player_skins ps
                JOIN skins s
                    ON s.id = ps.skin_id
                WHERE ps.player_id = $1
                  AND ps.skin_id = $2
                  AND s.is_active = TRUE
                `,
                [playerId, skinId]
            );

            if (skinResult.rowCount === 0) {
                return reply.code(404).send({
                    error: 'skin_not_owned',
                });
            }

            const skin = skinResult.rows[0];

            // Получаем требования скина
            const requirementsResult = await pool.query(
                `
                SELECT
                    a.id,
                    a.name,
                    a.description
                FROM skin_requirements sr
                JOIN achievements a
                    ON a.id = sr.achievement_id
                WHERE sr.skin_id = $1
                  AND a.is_active = TRUE
                ORDER BY a.id
                `,
                [skinId]
            );

            // Получаем ачивки игрока, которые относятся к требованиям
            const playerAchievementsResult = await pool.query(
                `
                SELECT
                    pa.achievement_id,
                    pa.obtained_at
                FROM player_achievements pa
                JOIN skin_requirements sr
                    ON sr.achievement_id = pa.achievement_id
                WHERE pa.player_id = $1
                  AND sr.skin_id = $2
                `,
                [playerId, skinId]
            );

            const ownedAchievements = new Map(
                playerAchievementsResult.rows.map((row) => [
                    String(row.achievement_id),
                    row.obtained_at,
                ])
            );

            const requirements = requirementsResult.rows.map(
                (achievement) => ({
                    id: achievement.id,
                    name: achievement.name,
                    description: achievement.description,
                    obtained: ownedAchievements.has(
                        String(achievement.id)
                    ),
                    obtained_at:
                        ownedAchievements.get(String(achievement.id)) ||
                        null,
                })
            );

            return {
                player_id: playerId,
                skin: {
                    id: skin.id,
                    name: skin.name,
                    price: skin.price,
                    is_free: skin.is_free,
                    requires_identity: skin.requires_identity,
                    requires_achievement: skin.requires_achievement,
                    is_secret: skin.is_secret,
                    source: skin.source,
                    obtained_at: skin.obtained_at,
                },
                requirements,
            };
        }
    );

    // Купить / получить скин
    fastify.post(
        '/players/:playerId/skins/:skinId/purchase',
        async (request, reply) => {
            const playerId = Number(request.params.playerId);
            const skinId = Number(request.params.skinId);

            if (!Number.isInteger(playerId) || playerId <= 0) {
                return reply.code(400).send({
                    error: 'invalid_player_id',
                });
            }

            if (!Number.isInteger(skinId) || skinId <= 0) {
                return reply.code(400).send({
                    error: 'invalid_skin_id',
                });
            }

            const client = await pool.connect();

            try {
                await client.query('BEGIN');

                // Проверяем игрока и блокируем его строку
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

                // Получаем скин
                const skinResult = await client.query(
                    `
                    SELECT
                        id,
                        name,
                        price,
                        is_free,
                        requires_identity,
                        requires_achievement,
                        is_secret
                    FROM skins
                    WHERE id = $1
                      AND is_active = TRUE
                    `,
                    [skinId]
                );

                if (skinResult.rowCount === 0) {
                    await client.query('ROLLBACK');

                    return reply.code(404).send({
                        error: 'skin_not_found',
                    });
                }

                const skin = skinResult.rows[0];

                // Проверяем, нет ли у игрока этого скина
                const ownedResult = await client.query(
                    `
                    SELECT 1
                    FROM player_skins
                    WHERE player_id = $1
                      AND skin_id = $2
                    `,
                    [playerId, skinId]
                );

                if (ownedResult.rowCount > 0) {
                    await client.query('ROLLBACK');

                    return reply.code(409).send({
                        error: 'skin_already_owned',
                    });
                }

                // Получаем ВСЕ требования скина
                const requirementsResult = await client.query(
                    `
                    SELECT
                        sr.achievement_id,
                        a.name
                    FROM skin_requirements sr
                    JOIN achievements a
                        ON a.id = sr.achievement_id
                    WHERE sr.skin_id = $1
                      AND a.is_active = TRUE
                    ORDER BY sr.achievement_id
                    `,
                    [skinId]
                );

                // Проверяем каждую требуемую ачивку
                if (requirementsResult.rowCount > 0) {
                    const achievementIds = requirementsResult.rows.map(
                        (row) => row.achievement_id
                    );

                    const ownedAchievementsResult = await client.query(
                        `
                        SELECT achievement_id
                        FROM player_achievements
                        WHERE player_id = $1
                          AND achievement_id = ANY($2::bigint[])
                        `,
                        [playerId, achievementIds]
                    );

                    const ownedAchievementIds = new Set(
                        ownedAchievementsResult.rows.map(
                            (row) => String(row.achievement_id)
                        )
                    );

                    const missingAchievements =
                        requirementsResult.rows.filter(
                            (row) =>
                                !ownedAchievementIds.has(
                                    String(row.achievement_id)
                                )
                        );

                    if (missingAchievements.length > 0) {
                        await client.query('ROLLBACK');

                        return reply.code(403).send({
                            error: 'achievement_required',
                            missing_achievements:
                                missingAchievements.map((row) => ({
                                    id: row.achievement_id,
                                    name: row.name,
                                })),
                        });
                    }
                }

                // Бесплатный скин не требует списания очков
                if (!skin.is_free) {
                    const price = Number(skin.price);
                    const currentPoints = Number(player.points);

                    if (currentPoints < price) {
                        await client.query('ROLLBACK');

                        return reply.code(400).send({
                            error: 'not_enough_points',
                            required: price,
                            current: currentPoints,
                        });
                    }

                    // Списываем очки
                    await client.query(
                        `
                        UPDATE players
                        SET points = points - $1
                        WHERE id = $2
                        `,
                        [skin.price, playerId]
                    );

                    // Записываем операцию с очками
                    await client.query(
                        `
                        INSERT INTO points_transactions (
                            player_id,
                            amount,
                            type
                        )
                        VALUES ($1, $2, 'skin_purchase')
                        `,
                        [playerId, -skin.price]
                    );
                }

                // Выдаём скин игроку
                await client.query(
                    `
                    INSERT INTO player_skins (
                        player_id,
                        skin_id,
                        source
                    )
                    VALUES ($1, $2, 'purchase')
                    `,
                    [playerId, skinId]
                );

                await client.query('COMMIT');

                return {
                    message: 'skin_purchased',
                    skin: {
                        id: skin.id,
                        name: skin.name,
                    },
                };
            } catch (error) {
                await client.query('ROLLBACK');

                fastify.log.error(error);

                return reply.code(500).send({
                    error: 'internal_server_error',
                });
            } finally {
                client.release();
            }
        }
    );
}

module.exports = skinsRoutes;
