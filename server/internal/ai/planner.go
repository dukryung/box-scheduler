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
	DueDate        *string `json:"dueDate,omitempty"`
	// Backlog marks an item from the backlog: optional for this day unless urgent.
	Backlog bool `json:"backlog,omitempty"`
}

type BlockInput struct {
	Start int    `json:"startSlot"`
	End   int    `json:"endSlot"`
	Title string `json:"title"`
}

// HistoryItem is a recently completed block, to calibrate duration estimates
// and see when in the day the person usually does such work.
type HistoryItem struct {
	Title string `json:"title"`
	Boxes int    `json:"boxes"`
	Start string `json:"start"` // HH:MM
}

type PlanRequest struct {
	Date    string        `json:"date"`
	Weekday string        `json:"weekday"`
	From    int           `json:"fromSlot"`
	To      int           `json:"toSlot"`
	Tasks   []TaskInput   `json:"tasks"`
	Blocks  []BlockInput  `json:"existingBlocks"`
	History []HistoryItem `json:"recentCompleted"`
	// BreakMinutes is the break the person wants between blocks; the scheduler keeps it.
	BreakMinutes int `json:"breakMinutes"`
	// Revision is set when the person asks for changes to a plan they were shown.
	Revision *Revision `json:"revision,omitempty"`
}

// SuggestedInput is one block of the plan the person was shown.
type SuggestedInput struct {
	TaskID    string `json:"taskId"`
	Title     string `json:"title"`
	Start     string `json:"start"` // HH:MM
	End       string `json:"end"`
	Unchecked bool   `json:"uncheckedByUser,omitempty"`
}

type Revision struct {
	Previous []SuggestedInput `json:"previousSuggestion"`
	Earlier  []string         `json:"earlierRequests,omitempty"`
	Request  string           `json:"request"`
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
	// StartAt is when the task should start ("HH:MM"): the AI's choice in a
	// first plan, a time the person asked for when revising.
	StartAt string `json:"startAt"`
	// Set only when revising: an asked-for end time, a task they asked to leave
	// out, or a task the request does not touch.
	EndAt string `json:"endAt"`
	Skip  bool   `json:"skip"`
	Keep  bool   `json:"keep"`
}

type Plan struct {
	Tasks []TaskPlan `json:"tasks"`
	Notes string     `json:"notes"`
	// BreakMinutes is a new break between blocks asked for in a revision, or -1.
	BreakMinutes int `json:"breakMinutes"`
}

type Planner interface {
	Plan(ctx context.Context, req PlanRequest) (Plan, error)
}

// Provider is everything the app asks of Claude.
type Provider interface {
	Planner
	Assistant
	Tidier
	Breakdowner
}

// caller makes one Claude call whose output is constrained to schema and
// decoded into out. The subscription CLI and the API key client implement it.
type caller interface {
	call(ctx context.Context, system, prompt string, schema map[string]any, out any) error
}

// claudeProvider uses c for planning and requests, and the quicker fast caller
// (AI_TIDY_MODEL) for tidying dictation, where waiting matters more than depth.
type claudeProvider struct{ c, fast caller }

func (p claudeProvider) Plan(ctx context.Context, req PlanRequest) (Plan, error) {
	var plan Plan
	err := p.c.call(ctx, systemPrompt, userPrompt(req), planSchema, &plan)
	return plan, err
}

func (p claudeProvider) Interpret(ctx context.Context, req AssistantRequest) (AssistantReply, error) {
	var reply AssistantReply
	err := p.c.call(ctx, assistantSystemPrompt, assistantPrompt(req), assistantSchema, &reply)
	return reply, err
}

// NewFromEnv picks the provider from AI_PROVIDER:
//
//	claude-cli     (default) `claude -p` using the Claude subscription (CLAUDE_CODE_OAUTH_TOKEN)
//	anthropic-api  Messages API using ANTHROPIC_API_KEY
//	fake           deterministic answers, for tests and offline development
//	none           AI features disabled
func NewFromEnv() (Provider, string, error) {
	provider := envOr("AI_PROVIDER", "claude-cli")
	model := envOr("AI_MODEL", "claude-opus-5-5")
	tidyModel := envOr("AI_TIDY_MODEL", "claude-haiku-5-5")
	timeout, err := time.ParseDuration(envOr("AI_TIMEOUT", "180s"))
	if err != nil {
		return nil, provider, fmt.Errorf("AI_TIMEOUT: %w", err)
	}

	switch provider {
	case "claude-cli":
		bin := envOr("CLAUDE_BIN", "claude")
		return claudeProvider{
			c:    &cliCaller{Bin: bin, Model: model, Timeout: timeout},
			fast: &cliCaller{Bin: bin, Model: tidyModel, Timeout: timeout},
		}, provider, nil
	case "anthropic-api":
		if os.Getenv("ANTHROPIC_API_KEY") == "" {
			return disabled{}, provider, nil
		}
		return claudeProvider{c: newAPICaller(model, timeout), fast: newAPICaller(tidyModel, timeout)}, provider, nil
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

func (disabled) Interpret(context.Context, AssistantRequest) (AssistantReply, error) {
	return AssistantReply{}, ErrNotConfigured
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
