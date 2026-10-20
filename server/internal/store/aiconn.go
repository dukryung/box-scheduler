package store

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

// AIConnection is an account's own AI. The sealed key never leaves the server;
// only its last four characters (KeyHint) are shown.
type AIConnection struct {
	ID        string     `json:"id"`
	Kind      string     `json:"kind"` // anthropic | openai
	Label     string     `json:"label"`
	BaseURL   *string    `json:"baseUrl"`
	Model     string     `json:"model"`
	KeyHint   string     `json:"keyHint"`
	CreatedAt time.Time  `json:"createdAt"`
	CheckedAt *time.Time `json:"checkedAt"`
	LastError string     `json:"lastError"`
	KeySealed []byte     `json:"-"`
}

const aiConnCols = `id, kind, label, base_url, model, key_hint, created_at, checked_at, last_error, key_sealed`

func scanAIConn(row pgx.Row) (AIConnection, error) {
	var c AIConnection
	err := row.Scan(&c.ID, &c.Kind, &c.Label, &c.BaseURL, &c.Model, &c.KeyHint, &c.CreatedAt, &c.CheckedAt, &c.LastError, &c.KeySealed)
	return c, mapErr(err)
}

// NewAIConnectionID reserves an id first, so the key can be sealed bound to it.
func (s *Store) NewAIConnectionID(ctx context.Context) (string, error) {
	var id string
	err := s.pool.QueryRow(ctx, `SELECT gen_random_uuid()`).Scan(&id)
	return id, err
}

func (s *Store) CreateAIConnection(ctx context.Context, userID string, c AIConnection) (AIConnection, error) {
	return scanAIConn(s.pool.QueryRow(ctx,
		`INSERT INTO ai_connections (id, user_id, kind, label, base_url, model, key_sealed, key_hint, checked_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now()) RETURNING `+aiConnCols,
		c.ID, userID, c.Kind, c.Label, c.BaseURL, c.Model, c.KeySealed, c.KeyHint))
}

func (s *Store) ListAIConnections(ctx context.Context, userID string) ([]AIConnection, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+aiConnCols+` FROM ai_connections WHERE user_id = $1 ORDER BY created_at`, userID)
	if err != nil {
		return nil, mapErr(err)
	}
	defer rows.Close()
	list := []AIConnection{}
	for rows.Next() {
		c, err := scanAIConn(rows)
		if err != nil {
			return nil, err
		}
		list = append(list, c)
	}
	return list, mapErr(rows.Err())
}

func (s *Store) AIConnection(ctx context.Context, userID, id string) (AIConnection, error) {
	return scanAIConn(s.pool.QueryRow(ctx, `SELECT `+aiConnCols+` FROM ai_connections WHERE user_id = $1 AND id = $2`, userID, id))
}

func (s *Store) DeleteAIConnection(ctx context.Context, userID, id string) error {
	return s.inTx(ctx, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `DELETE FROM ai_connections WHERE user_id = $1 AND id = $2`, userID, id)
		if err != nil {
			return mapErr(err)
		}
		if tag.RowsAffected() == 0 {
			return ErrNotFound
		}
		// Features that used it fall back to nothing.
		_, err = tx.Exec(ctx,
			`UPDATE ai_settings SET plan = CASE WHEN plan = $2 THEN '' ELSE plan END,
			        request = CASE WHEN request = $2 THEN '' ELSE request END,
			        tidy = CASE WHEN tidy = $2 THEN '' ELSE tidy END
			  WHERE user_id = $1`, userID, id)
		return mapErr(err)
	})
}

// MarkAIConnection records the latest check: ok clears the error.
func (s *Store) MarkAIConnection(ctx context.Context, userID, id, lastError string) error {
	_, err := s.pool.Exec(ctx, `UPDATE ai_connections SET checked_at = now(), last_error = $3 WHERE user_id = $1 AND id = $2`, userID, id, lastError)
	return mapErr(err)
}

// AISettings maps each AI feature to "server", a connection id, or "" (none).
type AISettings struct {
	Plan    string `json:"plan"`
	Request string `json:"request"`
	Tidy    string `json:"tidy"`
}

// GetAISettings returns the saved choice, or ok=false when nothing was saved yet.
func (s *Store) GetAISettings(ctx context.Context, userID string) (AISettings, bool, error) {
	var a AISettings
	err := s.pool.QueryRow(ctx, `SELECT plan, request, tidy FROM ai_settings WHERE user_id = $1`, userID).Scan(&a.Plan, &a.Request, &a.Tidy)
	if err == pgx.ErrNoRows {
		return AISettings{}, false, nil
	}
	return a, err == nil, mapErr(err)
}

func (s *Store) SetAISettings(ctx context.Context, userID string, a AISettings) error {
	_, err := s.pool.Exec(ctx,
		`INSERT INTO ai_settings (user_id, plan, request, tidy) VALUES ($1, $2, $3, $4)
		 ON CONFLICT (user_id) DO UPDATE SET plan = $2, request = $3, tidy = $4`, userID, a.Plan, a.Request, a.Tidy)
	return mapErr(err)
}
