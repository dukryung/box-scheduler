-- +goose Up
-- The break AI plans keep between blocks, in minutes (0: none).
ALTER TABLE users ADD COLUMN plan_break_minutes SMALLINT NOT NULL DEFAULT 0
  CHECK (plan_break_minutes BETWEEN 0 AND 60);

-- +goose Down
ALTER TABLE users DROP COLUMN plan_break_minutes;
