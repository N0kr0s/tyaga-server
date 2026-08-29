BEGIN;

CREATE TABLE achievement_conditions (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    achievement_id BIGINT NOT NULL
        REFERENCES achievements(id)
        ON DELETE CASCADE,

    type TEXT NOT NULL CHECK (
        type IN (
            'session_count',
            'playtime_seconds',
            'points_earned',
            'skins_owned'
        )
    ),

    value BIGINT NOT NULL CHECK (value > 0),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (achievement_id, type)
);

CREATE INDEX idx_achievement_conditions_achievement_id
    ON achievement_conditions(achievement_id);

COMMIT;
