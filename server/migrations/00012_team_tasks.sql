-- +goose Up
-- Team tasks: work the whole team can see, with a period, an estimate in
-- 10-minute boxes and any number of assignees, each with their own share.
CREATE TABLE team_tasks (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id        UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  title          TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  note           TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 4000),
  status         TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'doing', 'done')),
  start_date     DATE,
  due_date       DATE,
  estimate_boxes INT CHECK (estimate_boxes BETWEEN 1 AND 6000),
  created_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  done_at        TIMESTAMPTZ,
  CHECK (start_date IS NULL OR due_date IS NULL OR start_date <= due_date),
  UNIQUE (id, team_id)
);
CREATE INDEX team_tasks_team ON team_tasks (team_id, status);

-- An assignee must be a member of the task's team; leaving the team drops the
-- assignment and the task stays (then possibly with no one on it).
CREATE TABLE team_task_assignees (
  task_id UUID NOT NULL,
  team_id UUID NOT NULL,
  user_id UUID NOT NULL,
  boxes   INT CHECK (boxes BETWEEN 1 AND 6000),
  PRIMARY KEY (task_id, user_id),
  FOREIGN KEY (task_id, team_id) REFERENCES team_tasks (id, team_id) ON DELETE CASCADE,
  FOREIGN KEY (team_id, user_id) REFERENCES team_members (team_id, user_id) ON DELETE CASCADE
);
CREATE INDEX team_task_assignees_user ON team_task_assignees (user_id);

-- +goose Down
DROP TABLE team_task_assignees;
DROP TABLE team_tasks;
