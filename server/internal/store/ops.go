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
		created, err := insertBlock(ctx, tx, userID, Block{
			Date: e.Date, StartSlot: deref(e.StartSlot), EndSlot: deref(e.EndSlot), Title: deref(e.Title),
			Color: e.Color, BrainDumpID: e.BrainDumpID, Done: e.Done != nil && *e.Done, Source: e.Source,
		})
		return Edit{Kind: "delete_block", BlockID: created.ID}, err

	case "update_block":
		var date *string
		if e.Date != "" {
			date = &e.Date
		}
		before, _, err := updateBlock(ctx, tx, userID, e.BlockID, BlockPatch{
			Date: date, StartSlot: e.StartSlot, EndSlot: e.EndSlot, Title: e.Title, Done: e.Done,
		})
		return Edit{Kind: "update_block", BlockID: before.ID, Date: before.Date, StartSlot: &before.StartSlot,
			EndSlot: &before.EndSlot, Title: &before.Title, Done: &before.Done}, err

	case "delete_block":
		before, itemDeleted, err := deleteBlock(ctx, tx, userID, e.BlockID)
		inverse := Edit{Kind: "create_block", Date: before.Date, StartSlot: &before.StartSlot, EndSlot: &before.EndSlot, Title: &before.Title,
			Done: &before.Done, Color: before.Color, BrainDumpID: before.BrainDumpID, Source: before.Source}
		if itemDeleted {
			inverse.BrainDumpID = nil // undo recreates the item along with the block
		}
		return inverse, err

	case "add_item":
		status := "open"
		if e.Status != nil {
			status = *e.Status
		}
		var date *string // empty means the backlog
		if e.Date != "" {
			date = &e.Date
		}
		var id string
		err := tx.QueryRow(ctx, `
			INSERT INTO brain_dump_items (user_id, date, title, estimate_boxes, status)
			VALUES ($1, $2, $3, $4, $5) RETURNING id::text`,
			userID, date, e.Title, e.EstimateBoxes, status).Scan(&id)
		return Edit{Kind: "delete_item", ItemID: id}, err

	case "update_item":
		before, _, err := updateItem(ctx, tx, userID, e.ItemID, BrainDumpPatch{Title: e.Title, EstimateBoxes: e.EstimateBoxes, Status: e.Status})
		return Edit{Kind: "update_item", ItemID: before.ID, Title: &before.Title, EstimateBoxes: before.EstimateBoxes, Status: &before.Status}, err

	case "delete_item":
		before, err := scanBrainDump(tx.QueryRow(ctx, `DELETE FROM brain_dump_items WHERE user_id = $1 AND id = $2 RETURNING `+brainDumpCols, userID, e.ItemID))
		date := ""
		if before.Date != nil {
			date = *before.Date
		}
		return Edit{Kind: "add_item", Date: date, Title: &before.Title, EstimateBoxes: before.EstimateBoxes, Status: &before.Status}, err

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

func deref[T any](p *T) T {
	var zero T
	if p == nil {
		return zero
	}
	return *p
}
