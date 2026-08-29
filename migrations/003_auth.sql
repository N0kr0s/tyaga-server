BEGIN;

CREATE TABLE auth_sessions (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    player_id BIGINT NOT NULL
        REFERENCES players(id)
        ON DELETE CASCADE,

    token_hash TEXT NOT NULL UNIQUE,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,

    last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_auth_sessions_player_id
    ON auth_sessions(player_id);

CREATE INDEX idx_auth_sessions_expires_at
    ON auth_sessions(expires_at);

COMMIT;
