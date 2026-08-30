const crypto = require('crypto');
const pool = require('../db');

const {
    validateInitData
} = require('../services/telegram');

const {
    createAuthSession,
    revokeAuthSession,
    getBearerToken,
    requireAuth
} = require('../services/auth');


async function authRoutes(fastify) {

    // ============================================================
    // TELEGRAM MINI APP AUTH
    // ============================================================

    fastify.post(
        '/auth/telegram/app',
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

            const initData = body.initData;

            if (
                typeof initData !== 'string' ||
                initData.length === 0
            ) {
                return reply.code(400).send({
                    error: 'init_data_required'
                });
            }

            // ----------------------------------------------------
            // Проверяем Telegram initData
            // ----------------------------------------------------

            let telegramAuth;

            try {
                telegramAuth =
                    validateInitData(initData);
            } catch (error) {

                fastify.log.error(error);

                return reply.code(500).send({
                    error: 'telegram_auth_configuration_error'
                });
            }

            if (!telegramAuth.valid) {
                return reply.code(401).send({
                    error: telegramAuth.error
                });
            }

            const telegramUser =
                telegramAuth.user;

            /*
             * Для identity используем только Telegram user.id.
             *
             * username, first_name и т.д. НЕ являются
             * идентификатором аккаунта.
             */

            const provider = 'telegram';

            const providerId =
                String(telegramUser.id);

            const client =
                await pool.connect();

            try {

                await client.query('BEGIN');

                // ------------------------------------------------
                // Ищем существующую Telegram identity
                // ------------------------------------------------

                const identityResult =
                    await client.query(
                        `
                        SELECT
                            player_id
                        FROM player_identities
                        WHERE provider = $1
                          AND provider_id = $2
                        FOR UPDATE
                        `,
                        [
                            provider,
                            providerId
                        ]
                    );

                let playerId;

                if (identityResult.rowCount > 0) {

                    // ------------------------------------------------
                    // Уже зарегистрированный Telegram
                    // ------------------------------------------------

                    playerId =
                        Number(
                            identityResult.rows[0].player_id
                        );

                    const playerCheck =
                        await client.query(
                            `
                            SELECT
                                id
                            FROM players
                            WHERE id = $1
                            FOR UPDATE
                            `,
                            [playerId]
                        );

                    if (
                        playerCheck.rowCount === 0
                    ) {

                        await client.query(
                            'ROLLBACK'
                        );

                        return reply.code(500).send({
                            error: 'identity_player_not_found'
                        });
                    }

                } else {

                    // ------------------------------------------------
                    // Новый Telegram пользователь
                    // ------------------------------------------------

                    const playerResult =
                        await client.query(
                            `
                            INSERT INTO players
                            DEFAULT VALUES
                            RETURNING
                                id
                            `
                        );

                    playerId =
                        Number(
                            playerResult.rows[0].id
                        );

                    await client.query(
                        `
                        INSERT INTO player_identities (
                            player_id,
                            provider,
                            provider_id
                        )
                        VALUES (
                            $1,
                            $2,
                            $3
                        )
                        `,
                        [
                            playerId,
                            provider,
                            providerId
                        ]
                    );
                }

                // ------------------------------------------------
                // Telegram → player_profiles
                //
                // Telegram может только ЗАПОЛНИТЬ отсутствующие
                // данные.
                //
                // Уже существующие nickname/avatar_url
                // никогда не перезаписываются.
                // ------------------------------------------------

                const telegramNickname =
                    typeof telegramUser.username === 'string' &&
                    telegramUser.username.trim().length > 0
                        ? telegramUser.username.trim()
                        : null;

                const telegramAvatarUrl =
                    typeof telegramUser.photo_url === 'string' &&
                    telegramUser.photo_url.trim().length > 0
                        ? telegramUser.photo_url.trim()
                        : null;

                await client.query(
                    `
                    INSERT INTO player_profiles (
                        player_id,
                        nickname,
                        avatar_url
                    )
                    VALUES (
                        $1,
                        $2,
                        $3
                    )
                    ON CONFLICT (player_id)
                    DO UPDATE SET
                        nickname = COALESCE(
                            player_profiles.nickname,
                            EXCLUDED.nickname
                        ),
                        avatar_url = COALESCE(
                            player_profiles.avatar_url,
                            EXCLUDED.avatar_url
                        )
                    `,
                    [
                        playerId,
                        telegramNickname,
                        telegramAvatarUrl
                    ]
                );

                // ------------------------------------------------
                // Получаем игрока
                // ------------------------------------------------

                const playerResult =
                    await client.query(
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

                if (
                    playerResult.rowCount === 0
                ) {

                    await client.query(
                        'ROLLBACK'
                    );

                    return reply.code(500).send({
                        error: 'player_not_found'
                    });
                }

                // ------------------------------------------------
                // Создаём API auth session
                //
                // createAuthSession использует pool,
                // поэтому здесь используем client.
                // ------------------------------------------------

                const auth =
                    await createAuthSessionWithClient(
                        client,
                        playerId
                    );

                // ------------------------------------------------
                // Получаем профиль
                // ------------------------------------------------

                const profileResult =
                    await client.query(
                        `
                        SELECT
                            nickname,
                            avatar_url
                        FROM player_profiles
                        WHERE player_id = $1
                        `,
                        [playerId]
                    );

                const profile =
                    profileResult.rows[0] || {
                        nickname: null,
                        avatar_url: null
                    };

                await client.query(
                    'COMMIT'
                );

                // ------------------------------------------------
                // Ответ клиенту
                // ------------------------------------------------

                return {
                    success: true,

                    token:
                        auth.token,

                    player:
                        playerResult.rows[0],

                    profile,

                    identity: {
                        provider,
                        provider_id: providerId
                    },

                    session:
                        auth.session
                };

            } catch (error) {

                try {
                    await client.query(
                        'ROLLBACK'
                    );
                } catch (rollbackError) {
                    fastify.log.error(
                        rollbackError
                    );
                }

                fastify.log.error(error);

                /*
                 * UNIQUE violation.
                 */

                if (error.code === '23505') {

                    return reply.code(409).send({
                        error: 'telegram_identity_already_exists'
                    });
                }

                return reply.code(500).send({
                    error: 'telegram_auth_failed'
                });

            } finally {

                client.release();
            }
        }
    );


    // ============================================================
    // CURRENT AUTHENTICATED PLAYER
    // ============================================================

    fastify.get(
        '/auth/me',
        {
            preHandler: requireAuth
        },
        async (request, reply) => {

            const result =
                await pool.query(
                    `
                    SELECT
                        id,
                        points,
                        created_at
                    FROM players
                    WHERE id = $1
                    `,
                    [request.playerId]
                );

            if (
                result.rowCount === 0
            ) {

                return reply.code(404).send({
                    error: 'player_not_found'
                });
            }

            const profileResult =
                await pool.query(
                    `
                    SELECT
                        nickname,
                        avatar_url
                    FROM player_profiles
                    WHERE player_id = $1
                    `,
                    [request.playerId]
                );

            const identitiesResult =
                await pool.query(
                    `
                    SELECT
                        provider,
                        provider_id,
                        created_at
                    FROM player_identities
                    WHERE player_id = $1
                    ORDER BY provider
                    `,
                    [request.playerId]
                );

            return {
                player:
                    result.rows[0],

                profile:
                    profileResult.rows[0] || {
                        nickname: null,
                        avatar_url: null
                    },

                identities:
                    identitiesResult.rows
            };
        }
    );


    // ============================================================
    // LOGOUT
    // ============================================================

    fastify.post(
        '/auth/logout',
        {
            preHandler: requireAuth
        },
        async (request, reply) => {

            const token =
                getBearerToken(request);

            await revokeAuthSession(
                token
            );

            return {
                success: true
            };
        }
    );


    // ============================================================
    // TEMPORARY TEST AUTH
    //
    // Удалим после успешного Telegram теста.
    // ============================================================

    fastify.post(
        '/auth/test/:playerId',
        async (request, reply) => {

            const playerId =
                Number(
                    request.params.playerId
                );

            if (
                !Number.isInteger(playerId) ||
                playerId <= 0
            ) {

                return reply.code(400).send({
                    error: 'invalid_player_id'
                });
            }

            const playerResult =
                await pool.query(
                    `
                    SELECT
                        id
                    FROM players
                    WHERE id = $1
                    `,
                    [playerId]
                );

            if (
                playerResult.rowCount === 0
            ) {

                return reply.code(404).send({
                    error: 'player_not_found'
                });
            }

            const auth =
                await createAuthSession(
                    playerId
                );

            return {
                success: true,

                player_id:
                    playerId,

                token:
                    auth.token,

                session:
                    auth.session
            };
        }
    );
}


// ================================================================
// CREATE AUTH SESSION INSIDE EXISTING TRANSACTION
// ================================================================

async function createAuthSessionWithClient(
    client,
    playerId
) {

    const AUTH_SESSION_DAYS =
        Number(
            process.env.AUTH_SESSION_DAYS || 30
        );

    const token =
        crypto
            .randomBytes(32)
            .toString('hex');

    const tokenHash =
        crypto
            .createHash('sha256')
            .update(token)
            .digest('hex');

    const result =
        await client.query(
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

        session:
            result.rows[0]
    };
}


module.exports = authRoutes;
