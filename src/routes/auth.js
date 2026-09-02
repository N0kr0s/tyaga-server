const pool = require('../db');

const {
    validateInitData
} = require('../services/telegram');

const {
    createAuthSession,
    createAuthSessionWithClient,
    revokeAuthSession,
    getBearerToken,
    requireAuth
} = require('../services/auth');

function getPublicAvatarUrl(playerId, avatarUrl) {
    if (
        typeof avatarUrl !== 'string' ||
        avatarUrl.length === 0
    ) {
        return avatarUrl;
    }

    try {
        const url = new URL(avatarUrl);

        if (
            url.protocol !== 'https:' ||
            url.hostname !== 't.me'
        ) {
            return avatarUrl;
        }

        return (
            'https://auth.tyaga-game.ru/avatar' +
            url.pathname
        );
    } catch {
        return avatarUrl;
    }
}

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
            // Telegram initData
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

            const provider = 'telegram';
            const providerId =
                String(telegramUser.id);

            const client =
                await pool.connect();

            try {

                await client.query('BEGIN');

                // ------------------------------------------------
                // Find existing identity
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

                    if (playerCheck.rowCount === 0) {
                        await client.query('ROLLBACK');

                        return reply.code(500).send({
                            error: 'identity_player_not_found'
                        });
                    }

                } else {

                    // ------------------------------------------------
                    // Create new player
                    // ------------------------------------------------

                    const playerResult =
                        await client.query(
                            `
                            INSERT INTO players
                            DEFAULT VALUES
                            RETURNING id
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
                // Telegram profile data
                //
                // Telegram can fill only missing fields.
                // Existing custom values are never overwritten.
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
                // Player
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

                if (playerResult.rowCount === 0) {
                    await client.query('ROLLBACK');

                    return reply.code(500).send({
                        error: 'player_not_found'
                    });
                }

                // ------------------------------------------------
                // Create API session
                // ------------------------------------------------

                const auth =
                    await createAuthSessionWithClient(
                        client,
                        playerId
                    );

                // ------------------------------------------------
                // Profile
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

                profile.avatar_url =
                    getPublicAvatarUrl(
                        playerId,
                        profile.avatar_url
                    );

                await client.query('COMMIT');

                // ------------------------------------------------
                // Response
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
                    await client.query('ROLLBACK');
                } catch (rollbackError) {
                    fastify.log.error(rollbackError);
                }

                fastify.log.error(error);

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
    // CURRENT PLAYER
    // ============================================================

    fastify.get(
        '/auth/me',
        {
            preHandler: requireAuth
        },
        async (request, reply) => {

            const playerResult =
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

            if (playerResult.rowCount === 0) {
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

            const profile =
                profileResult.rows[0] || {
                    nickname: null,
                    avatar_url: null
                };

            profile.avatar_url =
                getPublicAvatarUrl(
                    request.playerId,
                    profile.avatar_url
                );

            return {
                player:
                    playerResult.rows[0],

                profile,

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

            await revokeAuthSession(token);

            return {
                success: true
            };
        }
    );

    // ============================================================
    // TEMPORARY TEST AUTH
    // ============================================================

    fastify.post(
        '/auth/test/:playerId',
        async (request, reply) => {

            const playerId =
                Number(request.params.playerId);

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

            if (playerResult.rowCount === 0) {
                return reply.code(404).send({
                    error: 'player_not_found'
                });
            }

            const auth =
                await createAuthSession(playerId);

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

module.exports = authRoutes;
