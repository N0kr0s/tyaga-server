BEGIN;

CREATE TABLE players (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    points BIGINT NOT NULL DEFAULT 0 CHECK (points >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE player_identities (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    player_id BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    provider TEXT NOT NULL CHECK (
        provider IN ('telegram', 'twitch', 'email')
    ),
    provider_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (provider, provider_id)
);

CREATE INDEX idx_player_identities_player_id
    ON player_identities(player_id);

CREATE TABLE skins (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    price BIGINT NOT NULL DEFAULT 0 CHECK (price >= 0),

    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    is_free BOOLEAN NOT NULL DEFAULT FALSE,
    requires_identity BOOLEAN NOT NULL DEFAULT FALSE,
    requires_achievement BOOLEAN NOT NULL DEFAULT FALSE,
    is_secret BOOLEAN NOT NULL DEFAULT FALSE,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE player_skins (
    player_id BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    skin_id BIGINT NOT NULL REFERENCES skins(id) ON DELETE RESTRICT,
    source TEXT NOT NULL CHECK (
        source IN (
            'purchase',
            'identity',
            'achievement',
            'starter',
            'admin'
        )
    ),
    obtained_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    PRIMARY KEY (player_id, skin_id)
);

CREATE TABLE points_transactions (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    player_id BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    amount BIGINT NOT NULL CHECK (amount <> 0),
    type TEXT NOT NULL CHECK (
        type IN (
            'session_reward',
            'session_sync',
            'skin_purchase',
            'admin',
            'other'
        )
    ),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_points_transactions_player_id
    ON points_transactions(player_id);

CREATE TABLE game_sessions (
    id UUID PRIMARY KEY,
    player_id BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at TIMESTAMPTZ
);

CREATE INDEX idx_game_sessions_player_id
    ON game_sessions(player_id);

COMMIT;
