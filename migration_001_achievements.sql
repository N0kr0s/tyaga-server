BEGIN;

CREATE TABLE achievements (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE player_achievements (
    player_id BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    achievement_id BIGINT NOT NULL REFERENCES achievements(id) ON DELETE RESTRICT,
    obtained_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    PRIMARY KEY (player_id, achievement_id)
);

CREATE INDEX idx_player_achievements_achievement_id
    ON player_achievements(achievement_id);

CREATE TABLE skin_requirements (
    skin_id BIGINT NOT NULL REFERENCES skins(id) ON DELETE CASCADE,
    achievement_id BIGINT NOT NULL REFERENCES achievements(id) ON DELETE RESTRICT,

    PRIMARY KEY (skin_id, achievement_id)
);

CREATE INDEX idx_skin_requirements_achievement_id
    ON skin_requirements(achievement_id);

COMMIT;
