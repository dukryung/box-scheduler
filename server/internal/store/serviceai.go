package store

import (
	"context"
	"time"
)

// ServiceAI is the service's own AI as admins set it up. The app server only reads it.
type ServiceAI struct {
	Enabled      bool
	BaseURL      string
	KeySealed    []byte
	PlanModel    string
	RequestModel string
	TidyModel    string
	Concurrency  int
	DailyLimit   int
	UpdatedAt    time.Time
}

// Model is the model for a feature ("" when that feature is not offered).
func (s ServiceAI) Model(feature string) string {
	switch feature {
	case "plan", "breakdown":
		return s.PlanModel
	case "request":
		return s.RequestModel
	}
	return s.TidyModel
}

func (s *Store) ServiceAI(ctx context.Context) (ServiceAI, error) {
	var a ServiceAI
	err := s.pool.QueryRow(ctx,
		`SELECT enabled, base_url, key_sealed, plan_model, request_model, tidy_model, concurrency, daily_limit, updated_at FROM service_ai WHERE id = 1`).
		Scan(&a.Enabled, &a.BaseURL, &a.KeySealed, &a.PlanModel, &a.RequestModel, &a.TidyModel, &a.Concurrency, &a.DailyLimit, &a.UpdatedAt)
	return a, mapErr(err)
}

// ServiceCallsToday counts an account's service-AI calls since local midnight (Asia/Seoul).
func (s *Store) ServiceCallsToday(ctx context.Context, userID string) (int, error) {
	var n int
	err := s.pool.QueryRow(ctx,
		`SELECT count(*) FROM ai_calls WHERE user_id = $1 AND source = 'service'
		    AND at >= date_trunc('day', now() AT TIME ZONE 'Asia/Seoul') AT TIME ZONE 'Asia/Seoul'`, userID).Scan(&n)
	return n, mapErr(err)
}

// RecordAICall logs one AI call (and prunes the log past 90 days now and then).
func (s *Store) RecordAICall(ctx context.Context, userID, feature, source string, took, waited time.Duration, ok bool) error {
	_, err := s.pool.Exec(ctx,
		`INSERT INTO ai_calls (user_id, feature, source, ms, waited_ms, ok) VALUES ($1, $2, $3, $4, $5, $6)`,
		userID, feature, source, took.Milliseconds(), waited.Milliseconds(), ok)
	if err == nil && time.Now().UnixNano()%200 == 0 {
		_, _ = s.pool.Exec(ctx, `DELETE FROM ai_calls WHERE at < now() - interval '90 days'`)
	}
	return mapErr(err)
}
