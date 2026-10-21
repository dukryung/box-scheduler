package httpapi

import (
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"box-scheduler/server/internal/ai"
	"box-scheduler/server/internal/aigate"
	"box-scheduler/server/internal/scheduler"
	"box-scheduler/server/internal/store"
)

const (
	defaultTaskBoxes = 3
	historyDays      = 30
	historyLimit     = 40
	aiBlockColor     = "#8b5cf6"
)

var koreanWeekdays = []string{"일요일", "월요일", "화요일", "수요일", "목요일", "금요일", "토요일"}

type suggestedBlock struct {
	TaskID    string `json:"taskId"`
	Title     string `json:"title"`
	StartSlot int    `json:"startSlot"`
	EndSlot   int    `json:"endSlot"`
	Reason    string `json:"reason"`
}

type unplacedTask struct {
	TaskID string `json:"taskId"`
	Title  string `json:"title"`
	Boxes  int    `json:"boxes"`
}

type taskEstimate struct {
	TaskID        string `json:"taskId"`
	EstimateBoxes int    `json:"estimateBoxes"`
}

type suggestResponse struct {
	Blocks    []suggestedBlock `json:"blocks"`
	Unplaced  []unplacedTask   `json:"unplaced"`
	Estimates []taskEstimate   `json:"estimates"`
	Notes     string           `json:"notes"`
}

// aiSuggest asks the planner for a plan and places it into the day's free time.
// Nothing is saved; the client previews the result and applies what it accepts.
func (a *API) aiSuggest(w http.ResponseWriter, r *http.Request) {
	date := chi.URLParam(r, "date")
	day, ok := parseDate(date)
	if !ok {
		writeError(w, http.StatusBadRequest, "date must be YYYY-MM-DD")
		return
	}
	var body struct {
		FromSlot int `json:"fromSlot"`
		ToSlot   int `json:"toSlot"`
		// Also consider backlog items that are urgent: due within a week, overdue, or high priority.
		IncludeBacklog bool `json:"includeBacklog"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	if !validSlots(body.FromSlot, body.ToSlot) {
		writeError(w, http.StatusBadRequest, "slots must satisfy 0 <= fromSlot < toSlot <= 144")
		return
	}

	uid := userID(r)
	blocks, err := a.store.ListBlocks(r.Context(), uid, date, date)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	items, err := a.store.ListBrainDump(r.Context(), uid, date)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	history, err := a.store.RecentDoneBlocks(r.Context(), uid, date, historyDays, historyLimit)
	if err != nil {
		writeStoreError(w, err)
		return
	}

	candidates := openTasks(items, blocks)
	if body.IncludeBacklog {
		backlog, err := a.store.ListBacklog(r.Context(), uid)
		if err != nil {
			writeStoreError(w, err)
			return
		}
		candidates = append(candidates, urgentBacklog(backlog, day)...)
	}

	req := ai.PlanRequest{
		Date: date, Weekday: koreanWeekdays[day.Weekday()],
		From: body.FromSlot, To: body.ToSlot,
		Tasks: candidates, Blocks: []ai.BlockInput{}, History: []ai.HistoryItem{},
	}
	if len(req.Tasks) == 0 {
		writeError(w, http.StatusBadRequest, "배치할 Brain Dump 항목이 없어요")
		return
	}
	occupied := make([]scheduler.Range, 0, len(blocks))
	for _, b := range blocks {
		req.Blocks = append(req.Blocks, ai.BlockInput{Start: b.StartSlot, End: b.EndSlot, Title: b.Title})
		occupied = append(occupied, scheduler.Range{Start: b.StartSlot, End: b.EndSlot})
	}
	for _, b := range history {
		req.History = append(req.History, ai.HistoryItem{Title: b.Title, Boxes: b.EndSlot - b.StartSlot})
	}

	started := time.Now()
	planner, ok := a.aiFor(w, r, "plan")
	if !ok {
		return
	}
	plan, err := planner.Plan(r.Context(), req)
	if err != nil {
		if errors.Is(err, aigate.ErrBusy) {
			writeErrorCode(w, http.StatusServiceUnavailable, "ai_busy", err.Error())
			return
		}
		if errors.Is(err, ai.ErrNotConfigured) {
			writeError(w, http.StatusServiceUnavailable, "AI 제안이 설정되지 않았어요. .env의 CLAUDE_CODE_OAUTH_TOKEN을 확인해 주세요.")
			return
		}
		slog.Error("ai plan failed", "err", err, "elapsed", time.Since(started))
		writeError(w, http.StatusBadGateway, "AI 제안을 받지 못했어요: "+err.Error())
		return
	}
	slog.Info("ai plan", "tasks", len(plan.Tasks), "elapsed", time.Since(started))

	tasks, estimates, missing := toSchedulerTasks(plan, req.Tasks)
	placed, unplaced := scheduler.Place(tasks, scheduler.Options{From: body.FromSlot, To: body.ToSlot, Occupied: occupied})

	resp := suggestResponse{Blocks: []suggestedBlock{}, Unplaced: missing, Estimates: estimates, Notes: plan.Notes}
	for _, p := range placed {
		resp.Blocks = append(resp.Blocks, suggestedBlock{
			TaskID: p.TaskID, Title: p.Title, StartSlot: p.Range.Start, EndSlot: p.Range.End, Reason: p.Reason,
		})
	}
	for _, u := range unplaced {
		resp.Unplaced = append(resp.Unplaced, unplacedTask{TaskID: u.TaskID, Title: u.Title, Boxes: u.Boxes})
	}
	writeJSON(w, http.StatusOK, resp)
}

// openTasks are the brain dump items that still need time on this day.
func openTasks(items []store.BrainDumpItem, blocks []store.Block) []ai.TaskInput {
	scheduled := map[string]int{}
	for _, b := range blocks {
		if b.BrainDumpID != nil {
			scheduled[*b.BrainDumpID] += b.EndSlot - b.StartSlot
		}
	}
	tasks := []ai.TaskInput{}
	for _, it := range items {
		if it.Status != "open" {
			continue
		}
		if it.EstimateBoxes != nil && scheduled[it.ID] >= *it.EstimateBoxes {
			continue
		}
		tasks = append(tasks, ai.TaskInput{
			ID: it.ID, Title: it.Title, EstimateBoxes: it.EstimateBoxes,
			ScheduledBoxes: scheduled[it.ID], CarriedFrom: it.CarriedFrom,
		})
	}
	return tasks
}

// backlogHorizon is how far ahead a backlog deadline counts as urgent for a day's plan.
const backlogHorizon = 7 * 24 * time.Hour

// urgentBacklog picks open backlog items with work left that are high priority or
// due within backlogHorizon of day (or already overdue).
func urgentBacklog(items []store.BacklogItem, day time.Time) []ai.TaskInput {
	tasks := []ai.TaskInput{}
	for _, it := range items {
		if it.Status != "open" || (it.EstimateBoxes != nil && it.ScheduledBoxes >= *it.EstimateBoxes) {
			continue
		}
		urgent := it.Priority != nil && *it.Priority == 1
		if it.DueDate != nil {
			if due, ok := parseDate(*it.DueDate); ok && due.Sub(day) <= backlogHorizon {
				urgent = true
			}
		}
		if urgent {
			tasks = append(tasks, ai.TaskInput{
				ID: it.ID, Title: it.Title, EstimateBoxes: it.EstimateBoxes, ScheduledBoxes: it.ScheduledBoxes,
				DueDate: it.DueDate, Backlog: true,
			})
		}
	}
	return tasks
}

// toSchedulerTasks validates the model's plan against the real tasks: unknown ids
// are dropped, sizes are clamped, and tasks the model skipped are reported back.
func toSchedulerTasks(plan ai.Plan, inputs []ai.TaskInput) ([]scheduler.Task, []taskEstimate, []unplacedTask) {
	byID := make(map[string]ai.TaskInput, len(inputs))
	for _, t := range inputs {
		byID[t.ID] = t
	}

	tasks := []scheduler.Task{}
	estimates := []taskEstimate{}
	seen := map[string]bool{}
	for _, tp := range plan.Tasks {
		in, ok := byID[tp.TaskID]
		if !ok || seen[tp.TaskID] {
			continue
		}
		seen[tp.TaskID] = true

		estimate := clampBoxes(tp.EstimateBoxes)
		chunks := []scheduler.Chunk{}
		for _, c := range tp.Chunks {
			if c.Boxes < 1 {
				continue
			}
			chunks = append(chunks, scheduler.Chunk{Title: chunkTitle(in.Title, c.Title, len(tp.Chunks)), Boxes: clampBoxes(c.Boxes)})
		}
		if len(chunks) == 0 {
			chunks = []scheduler.Chunk{{Title: in.Title, Boxes: estimate}}
		}

		tasks = append(tasks, scheduler.Task{
			ID: in.ID, Priority: tp.Priority, Window: scheduler.Window(tp.Window), Chunks: chunks, Reason: tp.Reason,
		})
		if in.EstimateBoxes == nil {
			estimates = append(estimates, taskEstimate{TaskID: in.ID, EstimateBoxes: estimate})
		}
	}

	missing := []unplacedTask{}
	for _, in := range inputs {
		if !seen[in.ID] {
			boxes := defaultTaskBoxes
			if in.EstimateBoxes != nil {
				boxes = *in.EstimateBoxes - in.ScheduledBoxes
			}
			missing = append(missing, unplacedTask{TaskID: in.ID, Title: in.Title, Boxes: boxes})
		}
	}
	return tasks, estimates, missing
}

// chunkTitle keeps the task name on each piece of a split task ("기획서 · 초안 작성").
// Models sometimes repeat the task name in the chunk ("기획서 · 기획서 · 초안"); it is dropped.
func chunkTitle(task, chunk string, chunks int) string {
	chunk = strings.TrimSpace(chunk)
	for strings.HasPrefix(chunk, task) {
		chunk = strings.TrimLeft(strings.TrimPrefix(chunk, task), " ·-–—:|/")
	}
	if chunks <= 1 || chunk == "" {
		return task
	}
	return task + " · " + chunk
}

func clampBoxes(n int) int {
	return min(max(n, 1), store.SlotsPerDay)
}

type applyRequest struct {
	Blocks []struct {
		TaskID    string `json:"taskId"`
		Title     string `json:"title"`
		StartSlot int    `json:"startSlot"`
		EndSlot   int    `json:"endSlot"`
	} `json:"blocks"`
	Estimates []taskEstimate `json:"estimates"`
}

func (a *API) aiApply(w http.ResponseWriter, r *http.Request) {
	date := chi.URLParam(r, "date")
	if _, ok := parseDate(date); !ok {
		writeError(w, http.StatusBadRequest, "date must be YYYY-MM-DD")
		return
	}
	var body applyRequest
	if !decodeJSON(w, r, &body) {
		return
	}

	color := aiBlockColor
	blocks := make([]store.Block, 0, len(body.Blocks))
	for _, b := range body.Blocks {
		title := strings.TrimSpace(b.Title)
		if !validSlots(b.StartSlot, b.EndSlot) || title == "" {
			writeError(w, http.StatusBadRequest, "each block needs a title and 0 <= startSlot < endSlot <= 144")
			return
		}
		var taskID *string
		if b.TaskID != "" {
			id := b.TaskID
			taskID = &id
		}
		blocks = append(blocks, store.Block{
			Date: date, StartSlot: b.StartSlot, EndSlot: b.EndSlot, Title: title, Color: &color, BrainDumpID: taskID,
		})
	}
	estimates := map[string]int{}
	for _, e := range body.Estimates {
		estimates[e.TaskID] = clampBoxes(e.EstimateBoxes)
	}

	created, err := a.store.ApplyPlan(r.Context(), userID(r), blocks, estimates)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, created)
}
