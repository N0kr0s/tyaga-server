const pool = require('../db');

/**
 * Проверяет и выдаёт все ачивки, условия которых выполнены игроком.
 *
 * Все условия одной ачивки работают по принципу AND:
 * игрок должен выполнить ВСЕ условия.
 */
async function checkAndGrantAchievements(client, playerId) {
    // Получаем все активные ачивки и их условия.
    const result = await client.query(
        `
        SELECT
            a.id,
            a.name,
            a.description,
            ac.type,
            ac.value
        FROM achievements a
        JOIN achievement_conditions ac
            ON ac.achievement_id = a.id
        WHERE a.is_active = TRUE
        ORDER BY a.id, ac.id
        `
    );

    // Группируем условия по achievement_id.
    const achievements = new Map();

    for (const row of result.rows) {
        if (!achievements.has(row.id)) {
            achievements.set(row.id, {
                id: row.id,
                name: row.name,
                description: row.description,
                conditions: []
            });
        }

        achievements.get(row.id).conditions.push({
            type: row.type,
            value: Number(row.value)
        });
    }

    // Получаем уже полученные ачивки игрока.
    const ownedResult = await client.query(
        `
        SELECT achievement_id
        FROM player_achievements
        WHERE player_id = $1
        `,
        [playerId]
    );

    const ownedAchievements = new Set(
        ownedResult.rows.map(row => String(row.achievement_id))
    );

    // Получаем статистику игрока.
    const statsResult = await client.query(
        `
        SELECT
            (
                SELECT COUNT(*)
                FROM game_sessions
                WHERE player_id = $1
                  AND ended_at IS NOT NULL
            ) AS session_count,

            (
                SELECT COALESCE(
                    SUM(
                        EXTRACT(
                            EPOCH FROM (ended_at - started_at)
                        )
                    ),
                    0
                )
                FROM game_sessions
                WHERE player_id = $1
                  AND ended_at IS NOT NULL
            ) AS playtime_seconds,

            (
                SELECT COALESCE(
                    SUM(amount) FILTER (WHERE amount > 0),
                    0
                )
                FROM points_transactions
                WHERE player_id = $1
            ) AS points_earned,

            (
                SELECT COUNT(*)
                FROM player_skins
                WHERE player_id = $1
            ) AS skins_owned
        `,
        [playerId]
    );

    const stats = {
        session_count: Number(statsResult.rows[0].session_count),
        playtime_seconds: Number(statsResult.rows[0].playtime_seconds),
        points_earned: Number(statsResult.rows[0].points_earned),
        skins_owned: Number(statsResult.rows[0].skins_owned)
    };

    const grantedAchievements = [];

    // Проверяем каждую ачивку.
    for (const achievement of achievements.values()) {
        // Уже есть — повторно не выдаём.
        if (ownedAchievements.has(String(achievement.id))) {
            continue;
        }

        // ВСЕ условия должны быть выполнены.
        const allConditionsMet = achievement.conditions.every(
            condition => {
                const currentValue = stats[condition.type];

                if (currentValue === undefined) {
                    return false;
                }

                return currentValue >= condition.value;
            }
        );

        if (!allConditionsMet) {
            continue;
        }

        // Выдаём ачивку.
        const insertResult = await client.query(
            `
            INSERT INTO player_achievements (
                player_id,
                achievement_id
            )
            VALUES ($1, $2)
            ON CONFLICT (player_id, achievement_id)
            DO NOTHING
            RETURNING obtained_at
            `,
            [playerId, achievement.id]
        );

        if (insertResult.rowCount === 0) {
            continue;
        }

        grantedAchievements.push({
            id: achievement.id,
            name: achievement.name,
            description: achievement.description,
            obtained_at: insertResult.rows[0].obtained_at
        });
    }

    return grantedAchievements;
}

module.exports = {
    checkAndGrantAchievements
};
