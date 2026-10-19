package store

import (
	"context"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// Every time block belongs to a brain dump item (the day's to-do list; the
// timetable shows the items that got a time). The helpers below are the only
// way blocks and items change, so both sides always agree:
//
//   - a block made without an item gets a new item with its title and length;
//   - checking a block off finishes its item once every block of it is done,
//     and checking an item off checks off all of its blocks (unchecking undoes both);
//   - renaming or moving the only block of an item renames or moves the item too;
//   - deleting a block deletes a dated item left with no blocks (backlog items stay);
//   - deleting an item deletes its blocks (ON DELETE CASCADE).

type dbtx interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// inTx runs fn in a transaction and commits it if fn succeeds.
func (s *Store) inTx(ctx context.Context, fn func(tx pgx.Tx) error) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := fn(tx); err != nil {
		return mapErr(err)
	}
	return mapErr(tx.Commit(ctx))
}

func insertBlock(ctx context.Context, q dbtx, userID string, b Block) (Block, error) {
	if b.Source == "" {
		b.Source = "manual"
	}
	if b.BrainDumpID == nil {
		status := "open"
		if b.Done {
			status = "done"
		}
		var itemID string
		err := q.QueryRow(ctx, `
			INSERT INTO brain_dump_items (user_id, date, title, estimate_boxes, status)
			VALUES ($1, $2, $3, LEAST($4::int, 144), $5) RETURNING id::text`,
			userID, b.Date, b.Title, b.EndSlot-b.StartSlot, status).Scan(&itemID)
		if err != nil {
			return Block{}, err
		}
		b.BrainDumpID = &itemID
	}
	created, err := scanBlock(q.QueryRow(ctx, `
		INSERT INTO time_blocks (user_id, date, start_slot, end_slot, title, color, brain_dump_id, done, source)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		RETURNING `+blockCols,
		userID, b.Date, b.StartSlot, b.EndSlot, b.Title, b.Color, b.BrainDumpID, b.Done, b.Source))
	if err != nil {
		return Block{}, err
	}
	return created, syncItemFromBlocks(ctx, q, userID, *created.BrainDumpID)
}

// updateBlock applies p and carries title, date and done over to the block's item.
func updateBlock(ctx context.Context, q dbtx, userID, id string, p BlockPatch) (before, after Block, err error) {
	before, err = scanBlock(q.QueryRow(ctx, `SELECT `+blockCols+` FROM time_blocks WHERE user_id = $1 AND id = $2 FOR UPDATE`, userID, id))
	if err != nil {
		return before, after, err
	}
	after, err = scanBlock(q.QueryRow(ctx, `
		UPDATE time_blocks SET
			date       = COALESCE($3::date, date),
			start_slot = COALESCE($4::smallint, start_slot),
			end_slot   = COALESCE($5::smallint, end_slot),
			title      = COALESCE($6::text, title),
			color      = COALESCE($7::text, color),
			done       = COALESCE($8::boolean, done)
		WHERE user_id = $1 AND id = $2
		RETURNING `+blockCols,
		userID, id, p.Date, p.StartSlot, p.EndSlot, p.Title, p.Color, p.Done))
	if err != nil {
		return before, after, err
	}

	itemID := *after.BrainDumpID
	if after.Title != before.Title || after.Date != before.Date {
		// Only an item's sole block speaks for the item; split work keeps its own names.
		if _, err = q.Exec(ctx, `
			UPDATE brain_dump_items i SET
				title = CASE WHEN $3 THEN $4 ELSE i.title END,
				date  = CASE WHEN $5 AND i.date IS NOT NULL THEN $6::date ELSE i.date END
			WHERE i.user_id = $1 AND i.id = $2
			  AND (SELECT count(*) FROM time_blocks WHERE brain_dump_id = i.id) = 1`,
			userID, itemID, after.Title != before.Title, after.Title, after.Date != before.Date, after.Date); err != nil {
			return before, after, err
		}
	}
	if after.Done != before.Done {
		err = syncItemFromBlocks(ctx, q, userID, itemID)
	}
	return before, after, err
}

// deleteBlock removes a block, and its dated item when that was the item's last block.
func deleteBlock(ctx context.Context, q dbtx, userID, id string) (deleted Block, itemDeleted bool, err error) {
	deleted, err = scanBlock(q.QueryRow(ctx, `DELETE FROM time_blocks WHERE user_id = $1 AND id = $2 RETURNING `+blockCols, userID, id))
	if err != nil {
		return deleted, false, err
	}
	tag, err := q.Exec(ctx, `
		DELETE FROM brain_dump_items i
		WHERE i.user_id = $1 AND i.id = $2 AND i.date IS NOT NULL
		  AND NOT EXISTS (SELECT 1 FROM time_blocks WHERE brain_dump_id = i.id)`, userID, *deleted.BrainDumpID)
	if err != nil {
		return deleted, false, err
	}
	if tag.RowsAffected() > 0 {
		return deleted, true, nil
	}
	return deleted, false, syncItemFromBlocks(ctx, q, userID, *deleted.BrainDumpID)
}

// syncItemFromBlocks finishes an item when all of its blocks are done (a backlog
// item also needs its estimate covered) and reopens it otherwise. Carried or
// dropped items are left alone.
func syncItemFromBlocks(ctx context.Context, q dbtx, userID, itemID string) error {
	_, err := q.Exec(ctx, `
		UPDATE brain_dump_items i SET status = CASE
			WHEN agg.all_done AND (i.date IS NOT NULL OR i.estimate_boxes IS NULL OR agg.done_boxes >= i.estimate_boxes)
			THEN 'done' ELSE 'open' END
		FROM (
			SELECT bool_and(done) AS all_done,
			       COALESCE(SUM(end_slot - start_slot) FILTER (WHERE done), 0) AS done_boxes,
			       count(*) AS n
			FROM time_blocks WHERE brain_dump_id = $2
		) agg
		WHERE i.user_id = $1 AND i.id = $2 AND i.status IN ('open', 'done') AND agg.n > 0`, userID, itemID)
	return err
}

// updateItem applies p; a new title renames blocks still named after the item,
// and checking the item on or off does the same to all of its blocks.
func updateItem(ctx context.Context, q dbtx, userID, id string, p BrainDumpPatch) (before, after BrainDumpItem, err error) {
	before, err = scanBrainDump(q.QueryRow(ctx, `SELECT `+brainDumpCols+` FROM brain_dump_items WHERE user_id = $1 AND id = $2 FOR UPDATE`, userID, id))
	if err != nil {
		return before, after, err
	}
	after, err = scanBrainDump(q.QueryRow(ctx, `
		UPDATE brain_dump_items SET
			title          = COALESCE($3::text, title),
			estimate_boxes = COALESCE($4::smallint, estimate_boxes),
			priority       = COALESCE($5::smallint, priority),
			category       = COALESCE($6::text, category),
			status         = COALESCE($7::text, status),
			due_date       = CASE WHEN $8::text IS NULL THEN due_date WHEN $8 = '' THEN NULL ELSE $8::date END,
			note           = CASE WHEN $9::text IS NULL THEN note WHEN $9 = '' THEN NULL ELSE $9 END
		WHERE user_id = $1 AND id = $2
		RETURNING `+brainDumpCols,
		userID, id, p.Title, p.EstimateBoxes, p.Priority, p.Category, p.Status, p.DueDate, p.Note))
	if err != nil {
		return before, after, err
	}
	if after.Title != before.Title {
		if _, err = q.Exec(ctx, `UPDATE time_blocks SET title = $4 WHERE user_id = $1 AND brain_dump_id = $2 AND title = $3`,
			userID, id, before.Title, after.Title); err != nil {
			return before, after, err
		}
	}
	if after.Status != before.Status && (after.Status == "done" || after.Status == "open") {
		_, err = q.Exec(ctx, `UPDATE time_blocks SET done = $3 WHERE user_id = $1 AND brain_dump_id = $2`, userID, id, after.Status == "done")
	}
	return before, after, err
}
