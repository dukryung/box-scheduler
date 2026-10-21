-- +goose Up
-- A team task split for one assignee ("AI로 세분화") becomes an item in that
-- person's backlog, linked to the task; its daily pieces hang off that item as
-- for any split, and their progress rolls up to the team task.
ALTER TABLE brain_dump_items ADD COLUMN team_task_id UUID REFERENCES team_tasks(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX brain_dump_items_team_task ON brain_dump_items (user_id, team_task_id) WHERE team_task_id IS NOT NULL;
-- A person's share of a team task can be more than a day's work.
ALTER TABLE brain_dump_items DROP CONSTRAINT brain_dump_items_estimate_boxes_check;
ALTER TABLE brain_dump_items ADD CONSTRAINT brain_dump_items_estimate_boxes_check CHECK (estimate_boxes BETWEEN 1 AND 6000);

-- +goose Down
UPDATE brain_dump_items SET estimate_boxes = 144 WHERE estimate_boxes > 144;
ALTER TABLE brain_dump_items DROP CONSTRAINT brain_dump_items_estimate_boxes_check;
ALTER TABLE brain_dump_items ADD CONSTRAINT brain_dump_items_estimate_boxes_check CHECK (estimate_boxes BETWEEN 1 AND 144);
DROP INDEX brain_dump_items_team_task;
ALTER TABLE brain_dump_items DROP COLUMN team_task_id;
