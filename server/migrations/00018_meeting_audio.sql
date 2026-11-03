-- +goose Up
-- Meeting recordings. The browser uploads a recording in pieces as it goes, so
-- a closed tab loses at most the last few seconds; the file lives on disk
-- (MEETING_AUDIO_DIR) and this row tracks how much of it has arrived.
CREATE TABLE meeting_audio (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id   UUID NOT NULL,
  team_id      UUID NOT NULL,
  mime         TEXT NOT NULL CHECK (length(mime) BETWEEN 1 AND 100),
  bytes        BIGINT NOT NULL DEFAULT 0,
  chunks       INT NOT NULL DEFAULT 0,
  duration_sec INT NOT NULL DEFAULT 0 CHECK (duration_sec >= 0),
  finished     BOOLEAN NOT NULL DEFAULT false,
  created_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (meeting_id, team_id) REFERENCES meetings (id, team_id) ON DELETE CASCADE
);
CREATE INDEX meeting_audio_meeting ON meeting_audio (meeting_id, created_at);

-- +goose Down
DROP TABLE meeting_audio;
