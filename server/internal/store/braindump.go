package store

import (
	"context"
	"strings"

	"github.com/jackc/pgx/v5"
)

type BrainDumpItem struct {
	ID string `json:"id"`
	// Date is nil for backlog items ("할 일 보관함"), which stay until done.
	Date          *string `json:"date"`
	Title         string  `json:"title"`
	EstimateBoxes *int    `json:"estimateBoxes"`
	Priority      *int    `json:"priority"`
	Category      *string `json:"category"`
	Status        string  `json:"status"`
	CarriedFrom   *string `json:"carriedFrom"`
	DueDate       *string `json:"dueDate"`
	Note          *string `json:"note"`
	// ParentID is the backlog item this is a piece of (AI로 세분화), if any.
	ParentID *string `json:"parentId"`
}

// BrainDumpPatch changes only the fields that are set. For DueDate and Note an
// empty string clears the value.
type BrainDumpPatch struct {
	Title         *string `json:"title"`
	EstimateBoxes *int    `json:"estimateBoxes"`
	Priority      *int    `json:"priority"`
	Category      *string `json:"category"`
	Status        *string `json:"status"`
	DueDate       *string `json:"dueDate"`
	Note          *string `json:"note"`
}

const brainDumpCols = `id::text, date::text, title, estimate_boxes, priority, category, status, carried_from::text, due_date::text, note, parent_id::text`

func scanBrainDump(row interface{ Scan(...any) error }) (BrainDumpItem, error) {
	var it BrainDumpItem
	err := row.Scan(&it.ID, &it.Date, &it.Title, &it.EstimateBoxes, &it.Priority, &it.Category, &it.Status, &it.CarriedFrom, &it.DueDate, &it.Note, &it.ParentID)
	return it, err
}

func (s *Store) ListBrainDump(ctx context.Context, userID, date string) ([]BrainDumpItem, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT `+brainDumpCols+` FROM brain_dump_items
		WHERE user_id = $1 AND date = $2
		ORDER BY created_at`, userID, date)
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

func (s *Store) CreateBrainDump(ctx context.Context, userID string, it BrainDumpItem) (BrainDumpItem, error) {
	if it.Status == "" {
		it.Status = "open"
	}
	row := s.pool.QueryRow(ctx, `
		INSERT INTO brain_dump_items (user_id, date, title, estimate_boxes, priority, category, status, due_date, note)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		RETURNING `+brainDumpCols,
		userID, it.Date, it.Title, it.EstimateBoxes, it.Priority, it.Category, it.Status, it.DueDate, it.Note)
	created, err := scanBrainDump(row)
	return created, mapErr(err)
}

// UpdateBrainDump changes an item and keeps its blocks in step (see sync.go).
func (s *Store) UpdateBrainDump(ctx context.Context, userID, id string, p BrainDumpPatch) (updated BrainDumpItem, err error) {
	err = s.inTx(ctx, func(tx pgx.Tx) error {
		_, updated, err = updateItem(ctx, tx, userID, id, p)
		return err
	})
	return updated, err
}

func (s *Store) DeleteBrainDump(ctx context.Context, userID, id string) error {
	tag, err := s.pool.Exec(ctx, `DELETE FROM brain_dump_items WHERE user_id = $1 AND id = $2`, userID, id)
	if err != nil {
		return mapErr(err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// CarryOver copies every open item of `from` into `to` as a new open item and
// marks the originals 'carried', so each day keeps its own history.
func (s *Store) CarryOver(ctx context.Context, userID, from, to string) ([]BrainDumpItem, error) {
	rows, err := s.pool.Query(ctx, `
		WITH src AS (
			UPDATE brain_dump_items SET status = 'carried'
			WHERE user_id = $1 AND date = $2 AND status = 'open'
			RETURNING *
		)
		INSERT INTO brain_dump_items (user_id, date, title, estimate_boxes, priority, category, status, carried_from, created_at, due_date, parent_id)
		SELECT user_id, $3, title, estimate_boxes, priority, category, 'open', COALESCE(carried_from, date), created_at, due_date, parent_id
		FROM src
		RETURNING `+brainDumpCols, userID, from, to)
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

// BrainDumpStatusCounts counts items by status for dates in [from, to].
func (s *Store) BrainDumpStatusCounts(ctx context.Context, userID, from, to string) (map[string]int, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT status, count(*) FROM brain_dump_items
		WHERE user_id = $1 AND date BETWEEN $2 AND $3
		GROUP BY status`, userID, from, to)
	if err != nil {
		return nil, mapErr(err)
	}
	defer rows.Close()

	counts := map[string]int{"open": 0, "done": 0, "carried": 0, "dropped": 0}
	for rows.Next() {
		var status string
		var n int
		if err := rows.Scan(&status, &n); err != nil {
			return nil, err
		}
		counts[status] = n
	}
	return counts, mapErr(rows.Err())
}

// MoveBrainDump puts an item on a day (date) or back into the backlog (nil).
func (s *Store) MoveBrainDump(ctx context.Context, userID, id string, date *string) (BrainDumpItem, error) {
	row := s.pool.QueryRow(ctx, `
		UPDATE brain_dump_items SET date = $3::date
		WHERE user_id = $1 AND id = $2
		RETURNING `+brainDumpCols, userID, id, date)
	it, err := scanBrainDump(row)
	return it, mapErr(err)
}

// BacklogItem is a backlog entry with its progress across every day it was scheduled on.
type BacklogItem struct {
	BrainDumpItem
	ScheduledBoxes int `json:"scheduledBoxes"`
	DoneBoxes      int `json:"doneBoxes"`
	// BlockCount is how many timetable blocks deleting the item would also delete.
	BlockCount int `json:"blockCount"`
	// Pieces are the day items it was split into (AI로 세분화); their blocks count above.
	Pieces     int `json:"pieces"`
	PiecesDone int `json:"piecesDone"`
}

// ListBacklog returns open backlog items plus the most recently finished ones.
func (s *Store) ListBacklog(ctx context.Context, userID string) ([]BacklogItem, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT `+prefixed("i.", brainDumpCols)+`,
			COALESCE(SUM(b.end_slot - b.start_slot), 0)::int,
			COALESCE(SUM(b.end_slot - b.start_slot) FILTER (WHERE b.done), 0)::int,
			count(b.id) FILTER (WHERE b.brain_dump_id = i.id)::int,
			(SELECT count(*) FROM brain_dump_items c WHERE c.parent_id = i.id AND c.status <> 'carried')::int,
			(SELECT count(*) FROM brain_dump_items c WHERE c.parent_id = i.id AND c.status = 'done')::int
		FROM brain_dump_items i
		LEFT JOIN time_blocks b ON b.user_id = i.user_id
		     AND (b.brain_dump_id = i.id OR b.brain_dump_id IN (SELECT c.id FROM brain_dump_items c WHERE c.parent_id = i.id))
		WHERE i.user_id = $1 AND i.date IS NULL AND i.status IN ('open', 'done')
		GROUP BY i.id
		ORDER BY i.status, i.created_at
		LIMIT 500`, userID)
	if err != nil {
		return nil, mapErr(err)
	}
	defer rows.Close()

	items := []BacklogItem{}
	for rows.Next() {
		var it BacklogItem
		if err := rows.Scan(&it.ID, &it.Date, &it.Title, &it.EstimateBoxes, &it.Priority, &it.Category, &it.Status,
			&it.CarriedFrom, &it.DueDate, &it.Note, &it.ParentID, &it.ScheduledBoxes, &it.DoneBoxes, &it.BlockCount, &it.Pieces, &it.PiecesDone); err != nil {
			return nil, err
		}
		items = append(items, it)
	}
	return items, mapErr(rows.Err())
}

// prefixed qualifies each column of a select list with a table alias.
func prefixed(alias, cols string) string {
	parts := strings.Split(cols, ", ")
	for i, p := range parts {
		parts[i] = alias + p
	}
	return strings.Join(parts, ", ")
}

// BacklogDueDates maps each date in [from, to] to the titles of open backlog items due that day.
func (s *Store) BacklogDueDates(ctx context.Context, userID, from, to string) (map[string][]string, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT due_date::text, title FROM brain_dump_items
		WHERE user_id = $1 AND date IS NULL AND status = 'open' AND due_date BETWEEN $2 AND $3
		ORDER BY due_date, priority NULLS LAST, created_at`, userID, from, to)
	if err != nil {
		return nil, mapErr(err)
	}
	defer rows.Close()

	dues := map[string][]string{}
	for rows.Next() {
		var date, title string
		if err := rows.Scan(&date, &title); err != nil {
			return nil, err
		}
		dues[date] = append(dues[date], title)
	}
	return dues, mapErr(rows.Err())
}

// ListLinkedItems returns items from other days or the backlog that have a block
// on date, so the day's brain dump can show everything on its timetable.
func (s *Store) ListLinkedItems(ctx context.Context, userID, date string) ([]BrainDumpItem, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT `+prefixed("i.", brainDumpCols)+` FROM brain_dump_items i
		WHERE i.user_id = $1 AND i.date IS DISTINCT FROM $2::date
		  AND EXISTS (SELECT 1 FROM time_blocks b WHERE b.brain_dump_id = i.id AND b.date = $2::date)
		ORDER BY i.created_at`, userID, date)
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
