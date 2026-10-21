package ai

import (
	"context"
	"fmt"
	"strings"
)

// Breakdowner suggests how to split one task into ordered pieces with estimates.
// When each piece happens is decided by the server (internal/breakdown).
type Breakdowner interface {
	Breakdown(ctx context.Context, req BreakdownRequest) (BreakdownPlan, error)
}

type BreakdownRequest struct {
	Title       string
	Note        string
	Today       string
	DueDate     string
	WorkingDays int
	TotalBoxes  int // the task's estimate in 10-minute boxes; 0 = unknown
	MaxPerDay   int // boxes of this task per day at most
}

type BreakdownPiece struct {
	Title  string `json:"title"`
	Boxes  int    `json:"boxes"`
	Reason string `json:"reason"`
}

type BreakdownPlan struct {
	Subtasks []BreakdownPiece `json:"subtasks"`
	Notes    string           `json:"notes"`
}

const breakdownSystemPrompt = `You help a person plan one task in a timeboxing app. Time is counted in 10-minute boxes (6 boxes = 1 hour).
Split the task into 3 to 8 concrete pieces of work, in the order they should be done (earlier pieces first when later ones depend on them).
- Each piece: a short title in Korean naming the actual work (e.g. "로그인 API 문서 작성", not "1단계"), do not repeat the task title in it, an estimate in boxes (at least 1), and a one-sentence reason in Korean.
- If a total estimate is given, the pieces should add up to about that total. If none is given, estimate realistically for one person.
- Keep the plan inside the period: working days × the daily maximum is the most that fits.
- Include a short final piece for review or wrap-up when the task produces something others will use.
- notes: one or two sentences in Korean about the plan (what to do first, risks).
Write only what is asked; no markdown.`

var breakdownSchema = map[string]any{
	"type": "object",
	"properties": map[string]any{
		"subtasks": map[string]any{
			"type": "array",
			"items": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"title":  map[string]any{"type": "string"},
					"boxes":  map[string]any{"type": "integer"},
					"reason": map[string]any{"type": "string"},
				},
				"required":             []string{"title", "boxes", "reason"},
				"additionalProperties": false,
			},
		},
		"notes": map[string]any{"type": "string"},
	},
	"required":             []string{"subtasks", "notes"},
	"additionalProperties": false,
}

func breakdownPrompt(r BreakdownRequest) string {
	var b strings.Builder
	fmt.Fprintf(&b, "Task: %s\n", r.Title)
	if strings.TrimSpace(r.Note) != "" {
		fmt.Fprintf(&b, "Details: %s\n", r.Note)
	}
	fmt.Fprintf(&b, "Today: %s\nDue: %s (%d working days)\n", r.Today, r.DueDate, r.WorkingDays)
	if r.TotalBoxes > 0 {
		fmt.Fprintf(&b, "Total estimate: %d boxes (%.1f hours)\n", r.TotalBoxes, float64(r.TotalBoxes)/6)
	} else {
		b.WriteString("Total estimate: not given\n")
	}
	fmt.Fprintf(&b, "At most %d boxes of this task per day.\n", r.MaxPerDay)
	return b.String()
}

func (p claudeProvider) Breakdown(ctx context.Context, req BreakdownRequest) (BreakdownPlan, error) {
	var plan BreakdownPlan
	err := p.c.call(ctx, breakdownSystemPrompt, breakdownPrompt(req), breakdownSchema, &plan)
	return plan, err
}

func (disabled) Breakdown(context.Context, BreakdownRequest) (BreakdownPlan, error) {
	return BreakdownPlan{}, ErrNotConfigured
}

// Breakdown (fake) splits into 준비 / 본 작업 / 정리, about 20/60/20 of the total (or 6 hours).
func (Fake) Breakdown(_ context.Context, req BreakdownRequest) (BreakdownPlan, error) {
	total := req.TotalBoxes
	if total <= 0 {
		total = 36
	}
	prep, wrap := max(1, total/5), max(1, total/5)
	main := max(1, total-prep-wrap)
	return BreakdownPlan{
		Subtasks: []BreakdownPiece{
			{Title: "자료 정리", Boxes: prep, Reason: "먼저 필요한 내용을 모아요."},
			{Title: "본 작업", Boxes: main, Reason: "가장 시간이 많이 드는 부분이에요."},
			{Title: "검토와 마무리", Boxes: wrap, Reason: "마지막에 확인해요."},
		},
		Notes: "테스트용 세분화예요.",
	}, nil
}
