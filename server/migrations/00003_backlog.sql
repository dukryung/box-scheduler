-- +goose Up
-- Backlog ("할 일 보관함"): brain dump items without a date are kept until done.
ALTER TABLE brain_dump_items ALTER COLUMN date DROP NOT NULL;
ALTER TABLE brain_dump_items ADD COLUMN due_date DATE;
ALTER TABLE brain_dump_items ADD COLUMN note TEXT;
-- priority: 1 high, 2 normal, 3 low (NULL reads as normal)
ALTER TABLE brain_dump_items ADD CONSTRAINT brain_dump_items_priority_check CHECK (priority BETWEEN 1 AND 3);
CREATE INDEX brain_dump_items_backlog_idx ON brain_dump_items (user_id, due_date) WHERE date IS NULL;

-- +goose Down
DROP INDEX brain_dump_items_backlog_idx;
ALTER TABLE brain_dump_items DROP CONSTRAINT brain_dump_items_priority_check;
UPDATE brain_dump_items SET date = created_at::date WHERE date IS NULL;
ALTER TABLE brain_dump_items DROP COLUMN note;
ALTER TABLE brain_dump_items DROP COLUMN due_date;
ALTER TABLE brain_dump_items ALTER COLUMN date SET NOT NULL;
