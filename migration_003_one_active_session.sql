BEGIN;

CREATE UNIQUE INDEX idx_one_active_session_per_player
ON game_sessions (player_id)
WHERE ended_at IS NULL;

COMMIT;
