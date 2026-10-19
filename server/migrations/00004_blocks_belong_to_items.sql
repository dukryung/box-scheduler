-- +goose Up
-- Every time block belongs to a brain dump item: the brain dump is the day's full
-- to-do list and the timetable shows the ones that got a time.

-- 1. Link loose blocks to a same-day item with the same title, if there is one.
UPDATE time_blocks b SET brain_dump_id = i.id
FROM brain_dump_items i
WHERE b.brain_dump_id IS NULL
  AND i.user_id = b.user_id AND i.date = b.date AND i.title = b.title
  AND i.status IN ('open', 'done');

-- 2. Otherwise create one item per (day, title) and link its blocks.
WITH loose AS (
  SELECT user_id, date, title,
         LEAST(SUM(end_slot - start_slot), 144) AS boxes,
         bool_and(done) AS all_done,
         MIN(created_at) AS created
  FROM time_blocks
  WHERE brain_dump_id IS NULL
  GROUP BY user_id, date, title
), made AS (
  INSERT INTO brain_dump_items (user_id, date, title, estimate_boxes, status, created_at)
  SELECT user_id, date, title, boxes, CASE WHEN all_done THEN 'done' ELSE 'open' END, created
  FROM loose
  RETURNING id, user_id, date, title
)
UPDATE time_blocks b SET brain_dump_id = m.id
FROM made m
WHERE b.brain_dump_id IS NULL AND b.user_id = m.user_id AND b.date = m.date AND b.title = m.title;

-- 3. Keep it that way: a block always has an item, and deleting the item deletes its blocks.
ALTER TABLE time_blocks DROP CONSTRAINT time_blocks_brain_dump_id_fkey;
ALTER TABLE time_blocks ADD CONSTRAINT time_blocks_brain_dump_id_fkey
  FOREIGN KEY (brain_dump_id) REFERENCES brain_dump_items(id) ON DELETE CASCADE;
ALTER TABLE time_blocks ALTER COLUMN brain_dump_id SET NOT NULL;
CREATE INDEX time_blocks_brain_dump_idx ON time_blocks (brain_dump_id);

-- +goose Down
DROP INDEX time_blocks_brain_dump_idx;
ALTER TABLE time_blocks ALTER COLUMN brain_dump_id DROP NOT NULL;
ALTER TABLE time_blocks DROP CONSTRAINT time_blocks_brain_dump_id_fkey;
ALTER TABLE time_blocks ADD CONSTRAINT time_blocks_brain_dump_id_fkey
  FOREIGN KEY (brain_dump_id) REFERENCES brain_dump_items(id) ON DELETE SET NULL;
