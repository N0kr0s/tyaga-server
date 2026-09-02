BEGIN;

CREATE TABLE game_auth_attempts (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    start_code_hash TEXT NOT NULL UNIQUE,

    player_id BIGINT
        REFERENCES players(id)
        ON DELETE CASCADE,

    callback_code_hash TEXT NOT NULL UNIQUE,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    expires_at TIMESTAMPTZ NOT NULL,

    callback_expires_at TIMESTAMPTZ NOT NULL,

    completed_at TIMESTAMPTZ,

    consumed_at TIMESTAMPTZ,

    CHECK (
        (completed_at IS NULL AND player_id IS NULL)
        OR
        (completed_at IS NOT NULL AND player_id IS NOT NULL)
    ),

    CHECK (
        consumed_at IS NULL
        OR completed_at IS NOT NULL
    )
);

CREATE INDEX idx_game_auth_attempts_expires_at
    ON game_auth_attempts(expires_at);

CREATE INDEX idx_game_auth_attempts_callback_expires_at
    ON game_auth_attempts(callback_expires_at);

CREATE INDEX idx_game_auth_attempts_player_id
    ON game_auth_attempts(player_id);

COMMIT;
