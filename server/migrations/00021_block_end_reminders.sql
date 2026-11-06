-- +goose Up
-- "끝냈나요?" a few minutes before a block ends, sent once per end time.
CREATE TABLE block_end_reminders (
  block_id UUID NOT NULL REFERENCES time_blocks(id) ON DELETE CASCADE,
  ends_at  TIMESTAMPTZ NOT NULL,
  sent_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (block_id, ends_at)
);
ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN ('assigned', 'split', 'subtasks', 'reminder', 'ending', 'test', 'meeting'));

-- +goose Down
DELETE FROM notifications WHERE kind = 'ending';
ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN ('assigned', 'split', 'subtasks', 'reminder', 'test', 'meeting'));
DROP TABLE block_end_reminders;
