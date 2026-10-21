-- +goose Up
-- Pieces of a backlog item split across days ("AI로 세분화") point back to it,
-- so its progress counts their blocks.
ALTER TABLE brain_dump_items ADD COLUMN parent_id UUID REFERENCES brain_dump_items(id) ON DELETE SET NULL;
CREATE INDEX brain_dump_items_parent ON brain_dump_items (parent_id) WHERE parent_id IS NOT NULL;

-- +goose Down
DROP INDEX brain_dump_items_parent;
ALTER TABLE brain_dump_items DROP COLUMN parent_id;
