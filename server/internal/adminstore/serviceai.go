package adminstore

import (
	"context"
	"time"
)

// ServiceAI is the service's own AI as the console shows it (never the key).
type ServiceAI struct {
	Enabled      bool       `json:"enabled"`
	BaseURL      string     `json:"baseUrl"`
	KeyHint      string     `json:"keyHint"`
	PlanModel    string     `json:"planModel"`
	RequestModel string     `json:"requestModel"`
	TidyModel    string     `json:"tidyModel"`
	Concurrency  int        `json:"concurrency"`
	DailyLimit   int        `json:"dailyLimit"`
	UpdatedAt    time.Time  `json:"updatedAt"`
	UpdatedBy    string     `json:"updatedBy"`
	CheckedAt    *time.Time `json:"checkedAt"`
	LastError    string     `json:"lastError"`
}

func (s *Store) ServiceAI(ctx context.Context) (ServiceAI, []byte, error) {
	var a ServiceAI
	var sealed []byte
	err := s.pool.QueryRow(ctx,
		`SELECT enabled, base_url, key_hint, plan_model, request_model, tidy_model, concurrency, daily_limit,
		        updated_at, updated_by, checked_at, last_error, key_sealed FROM public.service_ai WHERE id = 1`).
		Scan(&a.Enabled, &a.BaseURL, &a.KeyHint, &a.PlanModel, &a.RequestModel, &a.TidyModel, &a.Concurrency, &a.DailyLimit,
			&a.UpdatedAt, &a.UpdatedBy, &a.CheckedAt, &a.LastError, &sealed)
	return a, sealed, mapErr(err)
}

// SaveServiceAI stores the settings; sealed replaces the key when non-nil (empty clears it).
func (s *Store) SaveServiceAI(ctx context.Context, a ServiceAI, sealed []byte, by string) error {
	_, err := s.pool.Exec(ctx,
		`UPDATE public.service_ai SET enabled = $1, base_url = $2, plan_model = $3, request_model = $4, tidy_model = $5,
		        concurrency = $6, daily_limit = $7, updated_at = now(), updated_by = $8,
		        key_sealed = CASE WHEN $9::bytea IS NULL THEN key_sealed WHEN length($9::bytea) = 0 THEN NULL ELSE $9::bytea END,
		        key_hint = CASE WHEN $9::bytea IS NULL THEN key_hint ELSE $10 END,
		        checked_at = now(), last_error = ''
		  WHERE id = 1`,
		a.Enabled, a.BaseURL, a.PlanModel, a.RequestModel, a.TidyModel, a.Concurrency, a.DailyLimit, by, sealed, a.KeyHint)
	return err
}

func (s *Store) MarkServiceAI(ctx context.Context, lastError string) error {
	_, err := s.pool.Exec(ctx, `UPDATE public.service_ai SET checked_at = now(), last_error = $1 WHERE id = 1`, lastError)
	return err
}

// ServiceAIStats summarises the last 24 hours of service-AI calls.
type ServiceAIStats struct {
	Calls24h      int     `json:"calls24h"`
	Failed24h     int     `json:"failed24h"`
	Busy24h       int     `json:"busy24h"` // refused because the queue was full or too slow
	AvgMs24h      int     `json:"avgMs24h"`
	AvgWaitMs24h  int     `json:"avgWaitMs24h"`
	UsersToday    int     `json:"usersToday"`
	UsersAtLimit  int     `json:"usersAtLimit"`
	SuccessRate   float64 `json:"successRate"`
	CallsByDay    []int   `json:"callsByDay"` // last 14 days, oldest first
	OwnCalls24h   int     `json:"ownCalls24h"`
	ServerCalls24 int     `json:"serverCalls24h"`
}

func (s *Store) ServiceAIStats(ctx context.Context, dailyLimit int) (ServiceAIStats, error) {
	var st ServiceAIStats
	err := s.pool.QueryRow(ctx,
		`WITH day AS (SELECT * FROM public.ai_calls WHERE at > now() - interval '24 hours'),
		      today AS (SELECT user_id, count(*) n FROM public.ai_calls
		                 WHERE source = 'service' AND at >= date_trunc('day', now() AT TIME ZONE 'Asia/Seoul') AT TIME ZONE 'Asia/Seoul'
		                 GROUP BY user_id)
		 SELECT (SELECT count(*) FROM day WHERE source = 'service'),
		        (SELECT count(*) FROM day WHERE source = 'service' AND NOT ok AND ms > 0),
		        (SELECT count(*) FROM day WHERE source = 'service' AND NOT ok AND ms = 0),
		        COALESCE((SELECT avg(ms)::int FROM day WHERE source = 'service' AND ok), 0),
		        COALESCE((SELECT avg(waited_ms)::int FROM day WHERE source = 'service' AND ms > 0), 0),
		        (SELECT count(*) FROM today),
		        (SELECT count(*) FROM today WHERE $1 > 0 AND n >= $1),
		        (SELECT count(*) FROM day WHERE source = 'own'),
		        (SELECT count(*) FROM day WHERE source = 'server')`, dailyLimit).
		Scan(&st.Calls24h, &st.Failed24h, &st.Busy24h, &st.AvgMs24h, &st.AvgWaitMs24h, &st.UsersToday, &st.UsersAtLimit, &st.OwnCalls24h, &st.ServerCalls24)
	if err != nil {
		return st, err
	}
	if st.Calls24h > 0 {
		st.SuccessRate = float64(st.Calls24h-st.Failed24h-st.Busy24h) / float64(st.Calls24h)
	}
	rows, err := s.pool.Query(ctx,
		`SELECT (SELECT count(*) FROM public.ai_calls c WHERE c.source = 'service' AND (c.at AT TIME ZONE 'Asia/Seoul')::date = g.day::date)
		   FROM generate_series((now() AT TIME ZONE 'Asia/Seoul')::date - 13, (now() AT TIME ZONE 'Asia/Seoul')::date, interval '1 day') g(day)
		  ORDER BY g.day`)
	if err != nil {
		return st, err
	}
	defer rows.Close()
	for rows.Next() {
		var n int
		if err := rows.Scan(&n); err != nil {
			return st, err
		}
		st.CallsByDay = append(st.CallsByDay, n)
	}
	return st, rows.Err()
}

// ServiceCallsToday is one account's service-AI use today, for the user page.
func (s *Store) ServiceCallsToday(ctx context.Context, userID string) (int, error) {
	var n int
	err := s.pool.QueryRow(ctx,
		`SELECT count(*) FROM public.ai_calls WHERE user_id = $1 AND source = 'service'
		    AND at >= date_trunc('day', now() AT TIME ZONE 'Asia/Seoul') AT TIME ZONE 'Asia/Seoul'`, userID).Scan(&n)
	return n, err
}
