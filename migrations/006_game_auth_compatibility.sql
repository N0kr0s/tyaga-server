BEGIN;

ALTER TABLE game_auth_attempts
    ADD COLUMN IF NOT EXISTS callback_expires_at TIMESTAMPTZ;

UPDATE game_auth_attempts
SET callback_expires_at = expires_at
WHERE callback_expires_at IS NULL;

ALTER TABLE game_auth_attempts
    ALTER COLUMN callback_expires_at SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_game_auth_attempts_callback_expires_at
    ON game_auth_attempts(callback_expires_at);

CREATE TABLE IF NOT EXISTS player_profiles (
    player_id BIGINT PRIMARY KEY
        REFERENCES players(id)
        ON DELETE CASCADE,

    nickname TEXT,
    avatar_url TEXT
);

COMMIT;
