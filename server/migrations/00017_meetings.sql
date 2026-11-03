-- +goose Up
-- Team meetings: what was said (pasted or, later, transcribed), the minutes the
-- AI writes from it, and the tasks it finds there. A manager (or the owner)
-- gives each task to someone and confirms, which turns them into team tasks.
-- status: draft (text only) → processing (AI at work) → ready (minutes and
-- tasks to check) → confirmed (tasks created; the meeting is read-only).
CREATE TABLE meetings (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id      UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  title        TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  held_on      DATE NOT NULL,
  transcript   TEXT NOT NULL DEFAULT '' CHECK (length(transcript) <= 100000),
  -- {summary, decisions[], topics[{title, points[]}]}; NULL until written
  minutes      JSONB,
  status       TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'processing', 'ready', 'confirmed')),
  ai_error     TEXT NOT NULL DEFAULT '',
  -- How far the AI is through the transcript, in parts.
  ai_done      INT NOT NULL DEFAULT 0,
  ai_parts     INT NOT NULL DEFAULT 0,
  created_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  confirmed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  confirmed_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, team_id)
);
CREATE INDEX meetings_team ON meetings (team_id, held_on DESC);

-- The tasks found in a meeting, before and after confirming. Confirmed ones
-- point at the team task they became.
CREATE TABLE meeting_tasks (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id   UUID NOT NULL,
  team_id      UUID NOT NULL,
  title        TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  note         TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 1000),
  -- The words in the transcript the task comes from ('' when none were found).
  evidence     TEXT NOT NULL DEFAULT '' CHECK (length(evidence) <= 500),
  due_date     DATE,
  assignee_id  UUID,
  position     INT NOT NULL,
  team_task_id UUID REFERENCES team_tasks(id) ON DELETE SET NULL,
  FOREIGN KEY (meeting_id, team_id) REFERENCES meetings (id, team_id) ON DELETE CASCADE,
  FOREIGN KEY (team_id, assignee_id) REFERENCES team_members (team_id, user_id) ON DELETE SET NULL (assignee_id)
);
CREATE INDEX meeting_tasks_meeting ON meeting_tasks (meeting_id, position);

-- "회의록 정리가 끝났어요", for whoever asked for it.
ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN ('assigned', 'split', 'subtasks', 'reminder', 'test', 'meeting'));

-- +goose Down
DELETE FROM notifications WHERE kind = 'meeting';
ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN ('assigned', 'split', 'subtasks', 'reminder', 'test'));
DROP TABLE meeting_tasks;
DROP TABLE meetings;
