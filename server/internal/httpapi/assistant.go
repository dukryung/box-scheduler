package httpapi

import (
	"errors"
	"log/slog"
	"net/http"
	"slices"
	"strings"
	"time"

	"box-scheduler/server/internal/ai"
	"box-scheduler/server/internal/aigate"
	"box-scheduler/server/internal/assistant"
	"box-scheduler/server/internal/store"
)

const (
	assistantDaysBefore = 1
	assistantDaysAfter  = 7
	maxHistoryTurns     = 6
	maxMessageLen       = 500
)

type assistantPreviewRequest struct {
	Message  string    `json:"message"`
	History  []ai.Turn `json:"history"`
	ViewDate string    `json:"viewDate"`
	// The browser's local date and time, so "오늘" and "지금" match the person's clock.
	Today string `json:"today"`
	Now   string `json:"now"`
}

type assistantPreviewResponse struct {
	Reply         string             `json:"reply"`
	Clarification string             `json:"clarification"`
	Ops           []assistant.Op     `json:"ops"`
	Changes       []assistant.Change `json:"changes"`
	Warnings      []string           `json:"warnings"`
}

// assistantPreview asks Claude to turn a request into edits and returns them,
// checked and described, without saving anything.
func (a *API) assistantPreview(w http.ResponseWriter, r *http.Request) {
	var body assistantPreviewRequest
	if !decodeJSON(w, r, &body) {
		return
	}
	body.Message = strings.TrimSpace(body.Message)
	view, ok1 := parseDate(body.ViewDate)
	today, ok2 := parseDate(body.Today)
	switch {
	case body.Message == "" || len([]rune(body.Message)) > maxMessageLen:
		writeError(w, http.StatusBadRequest, "요청을 500자 이내로 입력해 주세요")
		return
	case !ok1 || !ok2:
		writeError(w, http.StatusBadRequest, "viewDate and today must be YYYY-MM-DD")
		return
	}
	if len(body.History) > maxHistoryTurns {
		body.History = body.History[len(body.History)-maxHistoryTurns:]
	}

	uid := userID(r)
	from := minTime(view, today).AddDate(0, 0, -assistantDaysBefore)
	to := maxTime(view, today).AddDate(0, 0, assistantDaysAfter)
	blocks, err := a.store.ListBlocks(r.Context(), uid, from.Format(dateLayout), to.Format(dateLayout))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	items, err := a.store.ListBrainDumpRange(r.Context(), uid, from.Format(dateLayout), to.Format(dateLayout))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	items = slices.DeleteFunc(items, func(it store.BrainDumpItem) bool { return it.Status == "carried" || it.Status == "dropped" })

	snap := assistant.Snapshot{Blocks: blocks, Items: items}
	refs := assistant.NewRefs(snap)
	req := ai.AssistantRequest{
		Now:      body.Today + " (" + string([]rune(koreanWeekdays[today.Weekday()])[0]) + ") " + body.Now,
		Today:    body.Today,
		ViewDate: body.ViewDate,
		Message:  body.Message,
		History:  body.History,
		Days:     contextDays(from, to, blocks, items, refs),
	}

	started := time.Now()
	assist, ok := a.aiFor(w, r, "request")
	if !ok {
		return
	}
	reply, err := assist.Interpret(r.Context(), req)
	if err != nil {
		if errors.Is(err, aigate.ErrBusy) {
			writeErrorCode(w, http.StatusServiceUnavailable, "ai_busy", err.Error())
			return
		}
		if errors.Is(err, ai.ErrNotConfigured) {
			writeError(w, http.StatusServiceUnavailable, "AI가 설정되지 않았어요. .env의 CLAUDE_CODE_OAUTH_TOKEN을 확인해 주세요.")
			return
		}
		slog.Error("assistant failed", "err", err, "elapsed", time.Since(started))
		writeError(w, http.StatusBadGateway, "AI 응답을 받지 못했어요: "+err.Error())
		return
	}
	slog.Info("assistant", "ops", len(reply.Ops), "elapsed", time.Since(started))

	// Ops may name days outside the window (e.g. "다음 주 금요일"); load them so overlaps are checked there too.
	for _, d := range opDates(reply.Ops) {
		if t, ok := parseDate(d); ok && (t.Before(from) || t.After(to)) {
			extra, err := a.store.ListBlocks(r.Context(), uid, d, d)
			if err != nil {
				writeStoreError(w, err)
				return
			}
			snap.Blocks = append(snap.Blocks, extra...)
		}
	}

	res := assistant.Build(reply.Ops, refs, snap, body.ViewDate)
	writeJSON(w, http.StatusOK, assistantPreviewResponse{
		Reply: reply.Reply, Clarification: reply.Clarification,
		Ops: res.Ops, Changes: res.Changes, Warnings: res.Warnings,
	})
}

// assistantTidy rewrites a dictated transcript into a short request. Nothing is
// sent or saved: the text goes back into the field for the person to check.
func (a *API) assistantTidy(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Text string `json:"text"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	body.Text = strings.TrimSpace(body.Text)
	if body.Text == "" || len([]rune(body.Text)) > 2*maxMessageLen {
		writeError(w, http.StatusBadRequest, "정리할 내용을 1000자 이내로 보내 주세요")
		return
	}
	started := time.Now()
	tidier, ok := a.aiFor(w, r, "tidy")
	if !ok {
		return
	}
	text, err := tidier.Tidy(r.Context(), body.Text)
	if err != nil {
		if errors.Is(err, aigate.ErrBusy) {
			writeErrorCode(w, http.StatusServiceUnavailable, "ai_busy", err.Error())
			return
		}
		if errors.Is(err, ai.ErrNotConfigured) {
			writeError(w, http.StatusServiceUnavailable, "AI가 설정되지 않았어요.")
			return
		}
		slog.Error("tidy failed", "err", err, "elapsed", time.Since(started))
		writeError(w, http.StatusBadGateway, "AI 응답을 받지 못했어요: "+err.Error())
		return
	}
	if text == "" {
		text = body.Text
	}
	if len([]rune(text)) > maxMessageLen {
		text = string([]rune(text)[:maxMessageLen])
	}
	slog.Info("tidy", "elapsed", time.Since(started))
	writeJSON(w, http.StatusOK, map[string]string{"text": text})
}

// assistantApply saves previewed ops (or an undo list) all at once and returns
// the ops that undo them.
func (a *API) assistantApply(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Ops []assistant.Op `json:"ops"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	if len(body.Ops) == 0 || len(body.Ops) > 50 {
		writeError(w, http.StatusBadRequest, "ops must have 1 to 50 entries")
		return
	}
	edits := make([]store.Edit, len(body.Ops))
	for i, op := range body.Ops {
		if op.Date != "" && !isDate(op.Date) {
			writeError(w, http.StatusBadRequest, "date must be YYYY-MM-DD")
			return
		}
		edits[i] = store.Edit{
			Kind: op.Kind, BlockID: op.BlockID, ItemID: op.ItemID, Date: op.Date,
			StartSlot: op.StartSlot, EndSlot: op.EndSlot, Title: op.Title, Done: op.Done, Color: op.Color,
			BrainDumpID: op.BrainDumpID, Source: op.Source, EstimateBoxes: op.EstimateBoxes, Status: op.Status,
		}
	}

	undo, err := a.store.ApplyEdits(r.Context(), userID(r), edits)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	ops := make([]assistant.Op, len(undo))
	for i, e := range undo {
		ops[i] = assistant.Op{
			Kind: e.Kind, BlockID: e.BlockID, ItemID: e.ItemID, Date: e.Date,
			StartSlot: e.StartSlot, EndSlot: e.EndSlot, Title: e.Title, Done: e.Done, Color: e.Color,
			BrainDumpID: e.BrainDumpID, Source: e.Source, EstimateBoxes: e.EstimateBoxes, Status: e.Status,
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"undo": ops})
}

// contextDays describes each day in the window with refs the model can use.
func contextDays(from, to time.Time, blocks []store.Block, items []store.BrainDumpItem, refs assistant.Refs) []ai.ContextDay {
	days := []ai.ContextDay{}
	for d := from; !d.After(to); d = d.AddDate(0, 0, 1) {
		date := d.Format(dateLayout)
		cd := ai.ContextDay{Date: date, Weekday: koreanWeekdays[d.Weekday()]}
		for _, b := range blocks {
			if b.Date == date {
				cd.Blocks = append(cd.Blocks, ai.ContextBlock{
					Ref: refs.RefOf(b.ID), Start: assistant.FormatTime(b.StartSlot), End: assistant.FormatTime(b.EndSlot), Title: b.Title, Done: b.Done,
				})
			}
		}
		for _, it := range items {
			if it.Date != nil && *it.Date == date {
				est := 0
				if it.EstimateBoxes != nil {
					est = *it.EstimateBoxes * 10
				}
				cd.Items = append(cd.Items, ai.ContextItem{Ref: refs.RefOf(it.ID), Title: it.Title, EstimateMinutes: est, Status: it.Status})
			}
		}
		slices.SortFunc(cd.Blocks, func(a, b ai.ContextBlock) int { return strings.Compare(a.Start, b.Start) })
		days = append(days, cd)
	}
	return days
}

func opDates(ops []ai.RawOp) []string {
	dates := []string{}
	for _, op := range ops {
		if op.Date != "" && !slices.Contains(dates, op.Date) {
			dates = append(dates, op.Date)
		}
	}
	return dates
}

func minTime(a, b time.Time) time.Time {
	if a.Before(b) {
		return a
	}
	return b
}

func maxTime(a, b time.Time) time.Time {
	if a.After(b) {
		return a
	}
	return b
}
