package store

import (
	"context"

	"github.com/jackc/pgx/v5"
)

// BacklogItem returns one of the account's backlog items (no date).
func (s *Store) BacklogItemByID(ctx context.Context, userID, id string) (BrainDumpItem, error) {
	it, err := scanBrainDump(s.pool.QueryRow(ctx,
		`SELECT `+brainDumpCols+` FROM brain_dump_items WHERE user_id = $1 AND id = $2 AND date IS NULL`, userID, id))
	return it, mapErr(err)
}

// DayLoad is one day's already-planned time: its blocks, and open items that
// have an estimate but no block yet (they will need time too).
type DayLoad struct {
	Blocks   [][2]int // start, end slots
	Unplaced int      // boxes
	Pieces   int      // open pieces of the task being split (not counted as busy)
}

// DayLoads collects the load of each date in [from, to]. Open, unplaced pieces
// of exceptParent are left out (splitting again replaces them); every block counts.
func (s *Store) DayLoads(ctx context.Context, userID, from, to, exceptParent string) (map[string]*DayLoad, error) {
	loads := map[string]*DayLoad{}
	get := func(d string) *DayLoad {
		if loads[d] == nil {
			loads[d] = &DayLoad{}
		}
		return loads[d]
	}
	rows, err := s.pool.Query(ctx,
		`SELECT date::text, start_slot, end_slot FROM time_blocks WHERE user_id = $1 AND date BETWEEN $2 AND $3`, userID, from, to)
	if err != nil {
		return nil, mapErr(err)
	}
	for rows.Next() {
		var d string
		var a, b int
		if err := rows.Scan(&d, &a, &b); err != nil {
			rows.Close()
			return nil, err
		}
		get(d).Blocks = append(get(d).Blocks, [2]int{a, b})
	}
	rows.Close()
	rows, err = s.pool.Query(ctx,
		`SELECT i.date::text, COALESCE(i.estimate_boxes, 0), (i.parent_id IS NOT DISTINCT FROM NULLIF($4, '')::uuid) FROM brain_dump_items i
		  WHERE i.user_id = $1 AND i.date BETWEEN $2 AND $3 AND i.status = 'open'
		    AND NOT EXISTS (SELECT 1 FROM time_blocks b WHERE b.brain_dump_id = i.id)`, userID, from, to, exceptParent)
	if err != nil {
		return nil, mapErr(err)
	}
	defer rows.Close()
	for rows.Next() {
		var d string
		var n int
		var mine bool
		if err := rows.Scan(&d, &n, &mine); err != nil {
			return nil, err
		}
		if mine && exceptParent != "" {
			get(d).Pieces++
			continue
		}
		get(d).Unplaced += n
	}
	return loads, mapErr(rows.Err())
}

// NewPiece is one day's share of a split backlog item.
type NewPiece struct {
	Date  string
	Title string
	Boxes int
}

// AddPieces puts a split backlog item's pieces into each day's Brain Dump. With
// replace, its earlier open pieces that have no blocks yet are removed first.
// dueDate and estimate fill the item's own fields when it had none.
func (s *Store) AddPieces(ctx context.Context, userID, parentID string, pieces []NewPiece, replace bool, dueDate *string, estimate int) (created, removed int, err error) {
	err = s.inTx(ctx, func(tx pgx.Tx) error {
		var due *string
		if err := tx.QueryRow(ctx,
			`UPDATE brain_dump_items SET due_date = COALESCE(due_date, $3::date), estimate_boxes = COALESCE(estimate_boxes, NULLIF($4, 0))
			  WHERE user_id = $1 AND id = $2 AND date IS NULL RETURNING due_date::text`,
			userID, parentID, dueDate, estimate).Scan(&due); err != nil {
			return mapErr(err)
		}
		if replace {
			tag, err := tx.Exec(ctx,
				`DELETE FROM brain_dump_items i WHERE i.user_id = $1 AND i.parent_id = $2 AND i.status = 'open'
				   AND NOT EXISTS (SELECT 1 FROM time_blocks b WHERE b.brain_dump_id = i.id)`, userID, parentID)
			if err != nil {
				return mapErr(err)
			}
			removed = int(tag.RowsAffected())
		}
		for _, p := range pieces {
			if _, err := tx.Exec(ctx,
				`INSERT INTO brain_dump_items (user_id, date, title, estimate_boxes, status, due_date, parent_id)
				 VALUES ($1, $2, $3, $4, 'open', $5, $6)`, userID, p.Date, p.Title, p.Boxes, due, parentID); err != nil {
				return mapErr(err)
			}
			created++
		}
		return nil
	})
	return created, removed, err
}
