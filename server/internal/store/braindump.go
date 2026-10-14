package store

import "context"

type BrainDumpItem struct {
	ID            string  `json:"id"`
	Date          string  `json:"date"`
	Title         string  `json:"title"`
	EstimateBoxes *int    `json:"estimateBoxes"`
	Priority      *int    `json:"priority"`
	Category      *string `json:"category"`
	Status        string  `json:"status"`
	CarriedFrom   *string `json:"carriedFrom"`
}

type BrainDumpPatch struct {
	Title         *string `json:"title"`
	EstimateBoxes *int    `json:"estimateBoxes"`
	Priority      *int    `json:"priority"`
	Category      *string `json:"category"`
	Status        *string `json:"status"`
}

const brainDumpCols = `id::text, date::text, title, estimate_boxes, priority, category, status, carried_from::text`

func scanBrainDump(row interface{ Scan(...any) error }) (BrainDumpItem, error) {
	var it BrainDumpItem
	err := row.Scan(&it.ID, &it.Date, &it.Title, &it.EstimateBoxes, &it.Priority, &it.Category, &it.Status, &it.CarriedFrom)
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
		INSERT INTO brain_dump_items (user_id, date, title, estimate_boxes, priority, category, status)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		RETURNING `+brainDumpCols,
		userID, it.Date, it.Title, it.EstimateBoxes, it.Priority, it.Category, it.Status)
	created, err := scanBrainDump(row)
	return created, mapErr(err)
}

func (s *Store) UpdateBrainDump(ctx context.Context, userID, id string, p BrainDumpPatch) (BrainDumpItem, error) {
	row := s.pool.QueryRow(ctx, `
		UPDATE brain_dump_items SET
			title          = COALESCE($3::text, title),
			estimate_boxes = COALESCE($4::smallint, estimate_boxes),
			priority       = COALESCE($5::smallint, priority),
			category       = COALESCE($6::text, category),
			status         = COALESCE($7::text, status)
		WHERE user_id = $1 AND id = $2
		RETURNING `+brainDumpCols,
		userID, id, p.Title, p.EstimateBoxes, p.Priority, p.Category, p.Status)
	updated, err := scanBrainDump(row)
	return updated, mapErr(err)
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
		INSERT INTO brain_dump_items (user_id, date, title, estimate_boxes, priority, category, status, carried_from, created_at)
		SELECT user_id, $3, title, estimate_boxes, priority, category, 'open', COALESCE(carried_from, date), created_at
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
