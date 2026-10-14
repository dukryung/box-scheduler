-- +goose Up
-- 'carried' marks an item that was copied forward to a later day; the copy is a new 'open' row.
ALTER TABLE brain_dump_items DROP CONSTRAINT brain_dump_items_status_check;
ALTER TABLE brain_dump_items ADD CONSTRAINT brain_dump_items_status_check
  CHECK (status IN ('open', 'scheduled', 'done', 'dropped', 'carried'));

-- +goose Down
UPDATE brain_dump_items SET status = 'dropped' WHERE status = 'carried';
ALTER TABLE brain_dump_items DROP CONSTRAINT brain_dump_items_status_check;
ALTER TABLE brain_dump_items ADD CONSTRAINT brain_dump_items_status_check
  CHECK (status IN ('open', 'scheduled', 'done', 'dropped'));
