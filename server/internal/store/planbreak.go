package store

import "context"

// PlanBreak is the break, in minutes, AI plans keep between blocks.
func (s *Store) PlanBreak(ctx context.Context, userID string) (int, error) {
	var minutes int
	err := s.pool.QueryRow(ctx, `SELECT plan_break_minutes FROM users WHERE id = $1`, userID).Scan(&minutes)
	return minutes, mapErr(err)
}

func (s *Store) SetPlanBreak(ctx context.Context, userID string, minutes int) error {
	_, err := s.pool.Exec(ctx, `UPDATE users SET plan_break_minutes = $2 WHERE id = $1`, userID, minutes)
	return mapErr(err)
}
