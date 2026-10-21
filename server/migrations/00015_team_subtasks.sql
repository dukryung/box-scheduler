-- +goose Up
-- A team task is split once, as a whole, into subtasks that the team can see,
-- each given to one of its people. Each person's subtasks are spread over their
-- own days as Brain Dump pieces (under the backlog item standing for their part
-- of the task); a piece points at its subtask so progress rolls up per subtask.
CREATE TABLE team_subtasks (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id     UUID NOT NULL,
  team_id     UUID NOT NULL,
  title       TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  boxes       INT NOT NULL CHECK (boxes BETWEEN 1 AND 6000),
  assignee_id UUID,
  position    INT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (task_id, team_id) REFERENCES team_tasks (id, team_id) ON DELETE CASCADE,
  -- Someone leaving the team leaves their subtasks without an owner.
  FOREIGN KEY (team_id, assignee_id) REFERENCES team_members (team_id, user_id) ON DELETE SET NULL (assignee_id)
);
CREATE INDEX team_subtasks_task ON team_subtasks (task_id, position);

ALTER TABLE brain_dump_items ADD COLUMN team_subtask_id UUID REFERENCES team_subtasks(id) ON DELETE SET NULL;
CREATE INDEX brain_dump_items_team_subtask ON brain_dump_items (team_subtask_id) WHERE team_subtask_id IS NOT NULL;

ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN ('assigned', 'split', 'subtasks', 'reminder', 'test'));

-- +goose Down
DELETE FROM notifications WHERE kind = 'subtasks';
ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN ('assigned', 'split', 'reminder', 'test'));
DROP INDEX brain_dump_items_team_subtask;
ALTER TABLE brain_dump_items DROP COLUMN team_subtask_id;
DROP TABLE team_subtasks;
