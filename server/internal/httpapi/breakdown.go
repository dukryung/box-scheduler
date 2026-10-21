package httpapi

import (
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"

	"box-scheduler/server/internal/ai"
	"box-scheduler/server/internal/aigate"
	"box-scheduler/server/internal/breakdown"
	"box-scheduler/server/internal/store"
)

const maxSubtasks = 12

type breakdownBody struct {
	Today    string          `json:"today"` // the browser's date and time, as for other AI requests
	Now      string          `json:"now"`
	DueDate  string          `json:"dueDate"` // when the item has none
	Subtasks []breakdown.Sub `json:"subtasks"`
	Replace  bool            `json:"replace"`
}

type breakdownPeriod struct {
	From        string `json:"from"`
	To          string `json:"to"`
	WorkingDays int    `json:"workingDays"`
}

type breakdownPolicy struct {
	WorkStart  string `json:"workStart"`
	WorkEnd    string `json:"workEnd"`
	LunchStart string `json:"lunchStart"`
	LunchEnd   string `json:"lunchEnd"`
	Capacity   int    `json:"capacity"`
	PerTaskMax int    `json:"perTaskMax"`
}

type breakdownResponse struct {
	Item     store.BrainDumpItem `json:"item"`
	Subtasks []breakdown.Sub     `json:"subtasks"`
	Reasons  []string            `json:"reasons,omitempty"`
	Notes    string              `json:"notes,omitempty"`
	Plan     breakdown.Result    `json:"plan"`
	Period   breakdownPeriod     `json:"period"`
	Policy   breakdownPolicy     `json:"policy"`
	// Earlier pieces in the period that are still open and unplaced; applying with replace swaps them.
	Existing int `json:"existing"`
}

func slotText(s int) string {
	return time.Date(0, 1, 1, s/6, (s%6)*10, 0, 0, time.UTC).Format("15:04")
}

// loadBreakdown reads the item, works out the period (today, or tomorrow after
// work, up to the due date) and each working day's free time.
func (a *API) loadBreakdown(w http.ResponseWriter, r *http.Request, body breakdownBody) (store.BrainDumpItem, []breakdown.Day, breakdownPeriod, int, bool) {
	u := currentUser(r)
	item, err := a.store.BacklogItemByID(r.Context(), u.ID, chi.URLParam(r, "id"))
	if err != nil {
		writeStoreError(w, err)
		return item, nil, breakdownPeriod{}, 0, false
	}
	today, ok := parseDate(body.Today)
	if !ok {
		writeError(w, http.StatusBadRequest, "today must be YYYY-MM-DD")
		return item, nil, breakdownPeriod{}, 0, false
	}
	due := body.DueDate
	if item.DueDate != nil {
		due = *item.DueDate
	}
	dueDay, ok := parseDate(due)
	if !ok {
		writeError(w, http.StatusBadRequest, "마감일을 정해 주세요")
		return item, nil, breakdownPeriod{}, 0, false
	}
	p := breakdown.Default
	nowSlot := -1
	if t, err := time.Parse("15:04", body.Now); err == nil {
		nowSlot = t.Hour()*6 + t.Minute()/10
	}
	start := today
	if nowSlot >= p.WorkEnd-6 { // less than an hour of work left today
		start = today.AddDate(0, 0, 1)
	}
	if dueDay.Before(start) {
		writeError(w, http.StatusBadRequest, "마감일이 이미 지났어요. 마감일을 바꿔 주세요")
		return item, nil, breakdownPeriod{}, 0, false
	}
	dates := breakdown.WorkingDays(start.Format(dateLayout), dueDay.Format(dateLayout))
	if len(dates) == 0 {
		writeError(w, http.StatusBadRequest, "기간 안에 근무일(월~금)이 없어요")
		return item, nil, breakdownPeriod{}, 0, false
	}
	loads, err := a.store.DayLoads(r.Context(), u.ID, dates[0], dates[len(dates)-1], item.ID)
	if err != nil {
		writeStoreError(w, err)
		return item, nil, breakdownPeriod{}, 0, false
	}
	days := make([]breakdown.Day, len(dates))
	existing := 0
	for i, d := range dates {
		days[i] = breakdown.Day{Date: d, Left: -1}
		if l := loads[d]; l != nil {
			for _, b := range l.Blocks {
				days[i].Busy += p.WorkingOverlap(b[0], b[1])
			}
			days[i].Busy += l.Unplaced
			existing += l.Pieces
		}
		if d == today.Format(dateLayout) && nowSlot >= 0 {
			days[i].Left = p.WorkingOverlap(nowSlot, p.WorkEnd)
		}
	}
	return item, days, breakdownPeriod{From: dates[0], To: dates[len(dates)-1], WorkingDays: len(dates)}, existing, true
}

// formatHours writes boxes as "20시간" or "1시간 30분".
func formatHours(boxes int) string {
	h, m := boxes/6, (boxes%6)*10
	switch {
	case h == 0:
		return strconv.Itoa(m) + "분"
	case m == 0:
		return strconv.Itoa(h) + "시간"
	}
	return strconv.Itoa(h) + "시간 " + strconv.Itoa(m) + "분"
}

func policyView() breakdownPolicy {
	p := breakdown.Default
	return breakdownPolicy{
		WorkStart: slotText(p.WorkStart), WorkEnd: slotText(p.WorkEnd), LunchStart: slotText(p.LunchStart), LunchEnd: slotText(p.LunchEnd),
		Capacity: p.Capacity(), PerTaskMax: p.PerTaskMax,
	}
}

// cleanSubs trims titles (dropping a repeated task name), clamps estimates and drops empty pieces.
func cleanSubs(task string, in []breakdown.Sub) []breakdown.Sub {
	out := []breakdown.Sub{}
	for _, s := range in {
		title := strings.TrimSpace(s.Title)
		for strings.HasPrefix(title, task) && title != task {
			title = strings.TrimLeft(strings.TrimPrefix(title, task), " ·-–—:|/")
		}
		if title == "" || s.Boxes <= 0 {
			continue
		}
		if utf8.RuneCountInString(title) > 80 {
			title = string([]rune(title)[:80])
		}
		out = append(out, breakdown.Sub{Title: title, Boxes: min(s.Boxes, store.SlotsPerDay*5)})
		if len(out) == maxSubtasks {
			break
		}
	}
	return out
}

// breakdownSuggest asks the AI how to split a backlog item and spreads the pieces over the working days.
func (a *API) breakdownSuggest(w http.ResponseWriter, r *http.Request) {
	var body breakdownBody
	if !decodeJSON(w, r, &body) {
		return
	}
	item, days, period, existing, ok := a.loadBreakdown(w, r, body)
	if !ok {
		return
	}
	splitter, ok := a.aiFor(w, r, "breakdown")
	if !ok {
		return
	}
	total := 0
	if item.EstimateBoxes != nil {
		total = *item.EstimateBoxes
	}
	note := ""
	if item.Note != nil {
		note = *item.Note
	}
	started := time.Now()
	plan, err := splitter.Breakdown(r.Context(), ai.BreakdownRequest{
		Title: item.Title, Note: note, Today: body.Today, DueDate: period.To, WorkingDays: period.WorkingDays,
		TotalBoxes: total, MaxPerDay: breakdown.Default.PerTaskMax,
	})
	if err != nil {
		switch {
		case errors.Is(err, aigate.ErrBusy):
			writeErrorCode(w, http.StatusServiceUnavailable, "ai_busy", err.Error())
		case errors.Is(err, ai.ErrNotConfigured):
			writeError(w, http.StatusServiceUnavailable, "AI가 설정되지 않았어요")
		default:
			slog.Error("breakdown failed", "err", err, "elapsed", time.Since(started))
			writeError(w, http.StatusBadGateway, "AI 세분화를 받지 못했어요: "+aiErrorText(err))
		}
		return
	}
	slog.Info("breakdown", "pieces", len(plan.Subtasks), "elapsed", time.Since(started))
	raw := make([]breakdown.Sub, len(plan.Subtasks))
	reasons := []string{}
	for i, s := range plan.Subtasks {
		raw[i] = breakdown.Sub{Title: s.Title, Boxes: s.Boxes}
	}
	subs := cleanSubs(item.Title, raw)
	for _, s := range plan.Subtasks {
		if strings.TrimSpace(s.Title) != "" && s.Boxes > 0 && len(reasons) < len(subs) {
			reasons = append(reasons, strings.TrimSpace(s.Reason))
		}
	}
	if len(subs) == 0 {
		writeError(w, http.StatusBadGateway, "AI가 나눌 일을 제안하지 못했어요. 다시 해 주세요")
		return
	}
	notes := strings.TrimSpace(plan.Notes)
	if scaled, changed := breakdown.ScaleTo(subs, total); changed {
		subs = scaled
		notes = strings.TrimSpace(notes + " (예상 시간 " + formatHours(total) + "에 맞춰 시간을 조정했어요.)")
	}
	writeJSON(w, http.StatusOK, breakdownResponse{
		Item: item, Subtasks: subs, Reasons: reasons, Notes: notes,
		Plan: breakdown.Allocate(subs, days, breakdown.Default), Period: period, Policy: policyView(), Existing: existing,
	})
}

// breakdownAllocate re-spreads edited pieces (no AI), for the preview.
func (a *API) breakdownAllocate(w http.ResponseWriter, r *http.Request) {
	var body breakdownBody
	if !decodeJSON(w, r, &body) {
		return
	}
	item, days, period, existing, ok := a.loadBreakdown(w, r, body)
	if !ok {
		return
	}
	subs := cleanSubs(item.Title, body.Subtasks)
	writeJSON(w, http.StatusOK, breakdownResponse{
		Item: item, Subtasks: subs, Plan: breakdown.Allocate(subs, days, breakdown.Default), Period: period, Policy: policyView(), Existing: existing,
	})
}

// breakdownApply spreads the confirmed pieces again (so the result matches the
// days as they are now) and adds each day's share to that day's Brain Dump.
func (a *API) breakdownApply(w http.ResponseWriter, r *http.Request) {
	var body breakdownBody
	if !decodeJSON(w, r, &body) {
		return
	}
	item, days, _, _, ok := a.loadBreakdown(w, r, body)
	if !ok {
		return
	}
	subs := cleanSubs(item.Title, body.Subtasks)
	if len(subs) == 0 {
		writeError(w, http.StatusBadRequest, "넣을 일이 없어요")
		return
	}
	plan := breakdown.Allocate(subs, days, breakdown.Default)
	pieces := []store.NewPiece{}
	total := 0
	for _, d := range plan.Days {
		for _, p := range d.Pieces {
			pieces = append(pieces, store.NewPiece{Date: d.Date, Title: chunkTitle(item.Title, p.Title, 2), Boxes: p.Boxes})
		}
	}
	for _, s := range subs {
		total += s.Boxes
	}
	var due *string
	if item.DueDate == nil && body.DueDate != "" {
		due = &body.DueDate
	}
	created, removed, err := a.store.AddPieces(r.Context(), currentUser(r).ID, item.ID, pieces, body.Replace, due, total)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"created": created, "removed": removed, "shortage": plan.Shortage, "plan": plan})
}
