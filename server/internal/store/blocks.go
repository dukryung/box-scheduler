package store

import "context"

type Block struct {
	ID          string  `json:"id"`
	Date        string  `json:"date"`
	StartSlot   int     `json:"startSlot"`
	EndSlot     int     `json:"endSlot"`
	Title       string  `json:"title"`
	Color       *string `json:"color"`
	BrainDumpID *string `json:"brainDumpId"`
	Done        bool    `json:"done"`
	Source      string  `json:"source"`
}

type BlockPatch struct {
	Date      *string `json:"date"`
	StartSlot *int    `json:"startSlot"`
	EndSlot   *int    `json:"endSlot"`
	Title     *string `json:"title"`
	Color     *string `json:"color"`
	Done      *bool   `json:"done"`
}

const blockCols = `id::text, date::text, start_slot, end_slot, title, color, brain_dump_id::text, done, source`

func scanBlock(row interface{ Scan(...any) error }) (Block, error) {
	var b Block
	err := row.Scan(&b.ID, &b.Date, &b.StartSlot, &b.EndSlot, &b.Title, &b.Color, &b.BrainDumpID, &b.Done, &b.Source)
	return b, err
}

func (s *Store) ListBlocks(ctx context.Context, userID, from, to string) ([]Block, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT `+blockCols+` FROM time_blocks
		WHERE user_id = $1 AND date BETWEEN $2 AND $3
		ORDER BY date, start_slot`, userID, from, to)
	if err != nil {
		return nil, mapErr(err)
	}
	defer rows.Close()

	blocks := []Block{}
	for rows.Next() {
		b, err := scanBlock(rows)
		if err != nil {
			return nil, err
		}
		blocks = append(blocks, b)
	}
	return blocks, mapErr(rows.Err())
}

func (s *Store) CreateBlock(ctx context.Context, userID string, b Block) (Block, error) {
	if b.Source == "" {
		b.Source = "manual"
	}
	row := s.pool.QueryRow(ctx, `
		INSERT INTO time_blocks (user_id, date, start_slot, end_slot, title, color, brain_dump_id, done, source)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		RETURNING `+blockCols,
		userID, b.Date, b.StartSlot, b.EndSlot, b.Title, b.Color, b.BrainDumpID, b.Done, b.Source)
	created, err := scanBlock(row)
	return created, mapErr(err)
}

func (s *Store) UpdateBlock(ctx context.Context, userID, id string, p BlockPatch) (Block, error) {
	row := s.pool.QueryRow(ctx, `
		UPDATE time_blocks SET
			date       = COALESCE($3::date, date),
			start_slot = COALESCE($4::smallint, start_slot),
			end_slot   = COALESCE($5::smallint, end_slot),
			title      = COALESCE($6::text, title),
			color      = COALESCE($7::text, color),
			done       = COALESCE($8::boolean, done)
		WHERE user_id = $1 AND id = $2
		RETURNING `+blockCols,
		userID, id, p.Date, p.StartSlot, p.EndSlot, p.Title, p.Color, p.Done)
	updated, err := scanBlock(row)
	return updated, mapErr(err)
}

func (s *Store) DeleteBlock(ctx context.Context, userID, id string) error {
	tag, err := s.pool.Exec(ctx, `DELETE FROM time_blocks WHERE user_id = $1 AND id = $2`, userID, id)
	if err != nil {
		return mapErr(err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// RecentDoneBlocks returns completed blocks from the `days` days before `before`,
// newest first, as reference for how long similar work really took.
func (s *Store) RecentDoneBlocks(ctx context.Context, userID, before string, days, limit int) ([]Block, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT `+blockCols+` FROM time_blocks
		WHERE user_id = $1 AND done AND date < $2 AND date >= $2::date - $3::int
		ORDER BY date DESC, start_slot
		LIMIT $4`, userID, before, days, limit)
	if err != nil {
		return nil, mapErr(err)
	}
	defer rows.Close()

	blocks := []Block{}
	for rows.Next() {
		b, err := scanBlock(rows)
		if err != nil {
			return nil, err
		}
		blocks = append(blocks, b)
	}
	return blocks, mapErr(rows.Err())
}

// ApplyPlan inserts accepted AI blocks and fills in missing brain dump estimates,
// all or nothing: one overlapping block rejects the whole plan.
func (s *Store) ApplyPlan(ctx context.Context, userID string, blocks []Block, estimates map[string]int) ([]Block, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	created := make([]Block, 0, len(blocks))
	for _, b := range blocks {
		row := tx.QueryRow(ctx, `
			INSERT INTO time_blocks (user_id, date, start_slot, end_slot, title, color, brain_dump_id, source)
			VALUES ($1, $2, $3, $4, $5, $6, $7, 'ai')
			RETURNING `+blockCols,
			userID, b.Date, b.StartSlot, b.EndSlot, b.Title, b.Color, b.BrainDumpID)
		c, err := scanBlock(row)
		if err != nil {
			return nil, mapErr(err)
		}
		created = append(created, c)
	}
	for id, boxes := range estimates {
		if _, err := tx.Exec(ctx, `
			UPDATE brain_dump_items SET estimate_boxes = $3
			WHERE user_id = $1 AND id = $2 AND estimate_boxes IS NULL`, userID, id, boxes); err != nil {
			return nil, mapErr(err)
		}
	}
	return created, mapErr(tx.Commit(ctx))
}
