const pool = require('../db');
const { requireAuth } = require('../middleware/auth');

async function playerRoutes(fastify) {
    // Получить текущего игрока
    fastify.get(
        '/me',
        {
            preHandler: requireAuth,
        },
        async (request, reply) => {
            const playerId = request.playerId;

            const result = await pool.query(
                `
                SELECT
                    id,
                    points,
                    created_at
                FROM players
                WHERE id = $1
                `,
                [playerId]
            );

            if (result.rowCount === 0) {
                return reply.code(404).send({
                    error: 'player_not_found',
                });
            }

            return result.rows[0];
        }
    );

    // Получить скины текущего игрока
    fastify.get(
        '/me/skins',
        {
            preHandler: requireAuth,
        },
        async (request) => {
            const playerId = request.playerId;

            const result = await pool.query(
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
                ORDER BY s.id
                `,
                [playerId]
            );

            return {
                player_id: playerId,
                skins: result.rows,
            };
        }
    );
}

module.exports = playerRoutes;
