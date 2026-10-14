package store

import (
	"context"
	"errors"
)

func (s *Store) GetDayNote(ctx context.Context, userID, date string) (*string, error) {
	var note *string
	err := s.pool.QueryRow(ctx, `SELECT note FROM days WHERE user_id = $1 AND date = $2`, userID, date).Scan(&note)
	if err = mapErr(err); errors.Is(err, ErrNotFound) {
		return nil, nil
	}
	return note, err
}

func (s *Store) SetDayNote(ctx context.Context, userID, date string, note *string) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO days (user_id, date, note) VALUES ($1, $2, $3)
		ON CONFLICT (user_id, date) DO UPDATE SET note = EXCLUDED.note`, userID, date, note)
	return mapErr(err)
}
