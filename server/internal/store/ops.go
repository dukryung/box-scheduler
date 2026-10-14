package store

import (
	"context"

	"github.com/jackc/pgx/v5"
)

// Edit is one change applied by ApplyEdits; nil fields stay as they are.
type Edit struct {
	Kind          string // create_block, update_block, delete_block, add_item, update_item, delete_item
	BlockID       string
	ItemID        string
	Date          string
	StartSlot     *int
	EndSlot       *int
	Title         *string
	Done          *bool
	Color         *string
	BrainDumpID   *string
	Source        string
	EstimateBoxes *int
	Status        *string
}

// ApplyEdits applies edits in order in one transaction and returns the edits that
// undo them (newest first). Any failure, such as an overlap, rolls everything back.
func (s *Store) ApplyEdits(ctx context.Context, userID string, edits []Edit) ([]Edit, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	undo := make([]Edit, 0, len(edits))
	for _, e := range edits {
		inverse, err := applyEdit(ctx, tx, userID, e)
		if err != nil {
			return nil, mapErr(err)
		}
		undo = append([]Edit{inverse}, undo...)
	}
	return undo, mapErr(tx.Commit(ctx))
}

func applyEdit(ctx context.Context, tx pgx.Tx, userID string, e Edit) (Edit, error) {
	switch e.Kind {
	case "create_block":
		source := e.Source
		if source == "" {
			source = "manual"
		}
		done := e.Done != nil && *e.Done
		var id string
		err := tx.QueryRow(ctx, `
			INSERT INTO time_blocks (user_id, date, start_slot, end_slot, title, color, brain_dump_id, done, source)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id::text`,
			userID, e.Date, e.StartSlot, e.EndSlot, e.Title, e.Color, e.BrainDumpID, done, source).Scan(&id)
		return Edit{Kind: "delete_block", BlockID: id}, err

	case "update_block":
		before, err := scanBlock(tx.QueryRow(ctx, `SELECT `+blockCols+` FROM time_blocks WHERE user_id = $1 AND id = $2 FOR UPDATE`, userID, e.BlockID))
		if err != nil {
			return Edit{}, err
		}
		var date *string
		if e.Date != "" {
			date = &e.Date
		}
		tag, err := tx.Exec(ctx, `
			UPDATE time_blocks SET
				date       = COALESCE($3::date, date),
				start_slot = COALESCE($4::smallint, start_slot),
				end_slot   = COALESCE($5::smallint, end_slot),
				title      = COALESCE($6::text, title),
				done       = COALESCE($7::boolean, done)
			WHERE user_id = $1 AND id = $2`,
			userID, e.BlockID, date, e.StartSlot, e.EndSlot, e.Title, e.Done)
		if err == nil && tag.RowsAffected() == 0 {
			err = ErrNotFound
		}
		return Edit{Kind: "update_block", BlockID: before.ID, Date: before.Date, StartSlot: &before.StartSlot,
			EndSlot: &before.EndSlot, Title: &before.Title, Done: &before.Done}, err

	case "delete_block":
		before, err := scanBlock(tx.QueryRow(ctx, `DELETE FROM time_blocks WHERE user_id = $1 AND id = $2 RETURNING `+blockCols, userID, e.BlockID))
		return Edit{Kind: "create_block", Date: before.Date, StartSlot: &before.StartSlot, EndSlot: &before.EndSlot, Title: &before.Title,
			Done: &before.Done, Color: before.Color, BrainDumpID: before.BrainDumpID, Source: before.Source}, err

	case "add_item":
		status := "open"
		if e.Status != nil {
			status = *e.Status
		}
		var id string
		err := tx.QueryRow(ctx, `
			INSERT INTO brain_dump_items (user_id, date, title, estimate_boxes, status)
			VALUES ($1, $2, $3, $4, $5) RETURNING id::text`,
			userID, e.Date, e.Title, e.EstimateBoxes, status).Scan(&id)
		return Edit{Kind: "delete_item", ItemID: id}, err

	case "update_item":
		before, err := scanBrainDump(tx.QueryRow(ctx, `SELECT `+brainDumpCols+` FROM brain_dump_items WHERE user_id = $1 AND id = $2 FOR UPDATE`, userID, e.ItemID))
		if err != nil {
			return Edit{}, err
		}
		_, err = tx.Exec(ctx, `
			UPDATE brain_dump_items SET
				title          = COALESCE($3::text, title),
				estimate_boxes = COALESCE($4::smallint, estimate_boxes),
				status         = COALESCE($5::text, status)
			WHERE user_id = $1 AND id = $2`,
			userID, e.ItemID, e.Title, e.EstimateBoxes, e.Status)
		return Edit{Kind: "update_item", ItemID: before.ID, Title: &before.Title, EstimateBoxes: before.EstimateBoxes, Status: &before.Status}, err

	case "delete_item":
		before, err := scanBrainDump(tx.QueryRow(ctx, `DELETE FROM brain_dump_items WHERE user_id = $1 AND id = $2 RETURNING `+brainDumpCols, userID, e.ItemID))
		return Edit{Kind: "add_item", Date: before.Date, Title: &before.Title, EstimateBoxes: before.EstimateBoxes, Status: &before.Status}, err

	default:
		return Edit{}, ErrInvalid
	}
}

// ListBrainDumpRange returns items dated within [from, to], oldest first.
func (s *Store) ListBrainDumpRange(ctx context.Context, userID, from, to string) ([]BrainDumpItem, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT `+brainDumpCols+` FROM brain_dump_items
		WHERE user_id = $1 AND date BETWEEN $2 AND $3
		ORDER BY date, created_at`, userID, from, to)
	if err != nil {
		return nil, mapErr(err)
	}
	defer rows.Close()

	items := []BrainDumpItem{}
	for rows.Next() {
		it, err := scanBrainDump(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, it)
	}
	return items, mapErr(rows.Err())
}
