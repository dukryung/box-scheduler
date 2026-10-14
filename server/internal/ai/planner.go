// Package ai asks Claude to turn a day's brain dump into a time plan: how long
// each task takes, how to split it, and when in the day it fits best.
package ai

import (
	"context"
	"errors"
	"fmt"
	"os"
	"time"
)

// ErrNotConfigured means no AI provider is set up (e.g. missing token).
var ErrNotConfigured = errors.New("AI provider is not configured")

type TaskInput struct {
	ID             string  `json:"id"`
	Title          string  `json:"title"`
	EstimateBoxes  *int    `json:"estimateBoxes,omitempty"`
	ScheduledBoxes int     `json:"scheduledBoxes"`
	CarriedFrom    *string `json:"carriedFrom,omitempty"`
}

type BlockInput struct {
	Start int    `json:"startSlot"`
	End   int    `json:"endSlot"`
	Title string `json:"title"`
}

// HistoryItem is a recently completed block, to calibrate duration estimates.
type HistoryItem struct {
	Title string `json:"title"`
	Boxes int    `json:"boxes"`
}

type PlanRequest struct {
	Date    string        `json:"date"`
	Weekday string        `json:"weekday"`
	From    int           `json:"fromSlot"`
	To      int           `json:"toSlot"`
	Tasks   []TaskInput   `json:"tasks"`
	Blocks  []BlockInput  `json:"existingBlocks"`
	History []HistoryItem `json:"recentCompleted"`
}

type Chunk struct {
	Title string `json:"title"`
	Boxes int    `json:"boxes"`
}

type TaskPlan struct {
	TaskID        string  `json:"taskId"`
	EstimateBoxes int     `json:"estimateBoxes"`
	Priority      int     `json:"priority"`
	Window        string  `json:"preferredWindow"`
	Chunks        []Chunk `json:"chunks"`
	Reason        string  `json:"reason"`
}

type Plan struct {
	Tasks []TaskPlan `json:"tasks"`
	Notes string     `json:"notes"`
}

type Planner interface {
	Plan(ctx context.Context, req PlanRequest) (Plan, error)
}

// NewFromEnv picks the provider from AI_PROVIDER:
//
//	claude-cli     (default) `claude -p` using the Claude subscription (CLAUDE_CODE_OAUTH_TOKEN)
//	anthropic-api  Messages API using ANTHROPIC_API_KEY
//	fake           deterministic plans, for tests and offline development
//	none           AI suggestions disabled
func NewFromEnv() (Planner, string, error) {
	provider := envOr("AI_PROVIDER", "claude-cli")
	model := envOr("AI_MODEL", "claude-opus-5-5")
	timeout, err := time.ParseDuration(envOr("AI_TIMEOUT", "180s"))
	if err != nil {
		return nil, provider, fmt.Errorf("AI_TIMEOUT: %w", err)
	}

	switch provider {
	case "claude-cli":
		return &CLIPlanner{Bin: envOr("CLAUDE_BIN", "claude"), Model: model, Timeout: timeout}, provider, nil
	case "anthropic-api":
		if os.Getenv("ANTHROPIC_API_KEY") == "" {
			return disabled{}, provider, nil
		}
		return NewAPIPlanner(model, timeout), provider, nil
	case "fake":
		return Fake{}, provider, nil
	case "none":
		return disabled{}, provider, nil
	default:
		return nil, provider, fmt.Errorf("unknown AI_PROVIDER %q", provider)
	}
}

type disabled struct{}

func (disabled) Plan(context.Context, PlanRequest) (Plan, error) { return Plan{}, ErrNotConfigured }

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
