package httpapi

import (
	"errors"
	"log/slog"
	"net/http"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"

	"box-scheduler/server/internal/ai"
	"box-scheduler/server/internal/aigate"
	"box-scheduler/server/internal/breakdown"
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
	// Shifted: the time the person asked for was taken; this is the nearest free one.
	Shifted bool `json:"shifted,omitempty"`
}

// reviseRequest asks for changes to a suggestion the person is looking at.
type reviseRequest struct {
	Previous []shownBlock `json:"previous"`
	Earlier  []string     `json:"earlier"`
	Request  string       `json:"request"`
}

// shownBlock is a block of the suggestion on screen; unchecked ones were switched off.
type shownBlock struct {
	TaskID    string `json:"taskId"`
	Title     string `json:"title"`
	StartSlot int    `json:"startSlot"`
	EndSlot   int    `json:"endSlot"`
	Unchecked bool   `json:"unchecked"`
}

const (
	maxReviseText    = 300
	maxReviseEarlier = 20
	maxReviseBlocks  = 100
)

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
	// BreakMinutes is the break kept between blocks in this suggestion.
	BreakMinutes int `json:"breakMinutes"`
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
		// Revise asks for changes to the suggestion the person was shown.
		Revise *reviseRequest `json:"revise"`
		// BreakMinutes between blocks; the account's setting when left out.
		BreakMinutes *int `json:"breakMinutes"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	if !validSlots(body.FromSlot, body.ToSlot) {
		writeError(w, http.StatusBadRequest, "slots must satisfy 0 <= fromSlot < toSlot <= 144")
		return
	}
	revision, msg := toRevision(body.Revise)
	if msg != "" {
		writeError(w, http.StatusBadRequest, msg)
		return
	}

	uid := userID(r)
	var breakMinutes int
	switch {
	case body.BreakMinutes == nil:
		var err error
		if breakMinutes, err = a.store.PlanBreak(r.Context(), uid); err != nil {
			writeStoreError(w, err)
			return
		}
	case validBreak(*body.BreakMinutes):
		breakMinutes = *body.BreakMinutes
	default:
		writeError(w, http.StatusBadRequest, breakRule)
		return
	}
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
		Revision: revision, BreakMinutes: breakMinutes,
	}
	if len(req.Tasks) == 0 {
		writeError(w, http.StatusBadRequest, "배치할 Brain Dump 항목이 없어요")
		return
	}
	for _, b := range blocks {
		req.Blocks = append(req.Blocks, ai.BlockInput{Start: b.StartSlot, End: b.EndSlot, Title: b.Title})
	}
	for _, b := range history {
		req.History = append(req.History, ai.HistoryItem{Title: b.Title, Boxes: b.EndSlot - b.StartSlot, Start: slotText(b.StartSlot)})
	}

	started := time.Now()
	feature := "plan"
	if revision != nil {
		feature = "revise" // asking for changes is not counted against the service AI's daily limit
	}
	planner, ok := a.aiFor(w, r, feature)
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

	// The AI can take a minute, and the day may have changed meanwhile (a block
	// moved or added), so the plan is placed around the day as it is now.
	if blocks, err = a.store.ListBlocks(r.Context(), uid, date, date); err != nil {
		writeStoreError(w, err)
		return
	}
	// A revision may ask for another break between blocks; the whole plan is spaced again.
	respace := revision != nil && plan.BreakMinutes >= 0 && plan.BreakMinutes != breakMinutes && asksForBreak(revision.Request)
	if respace {
		breakMinutes = min(plan.BreakMinutes, maxBreakMinutes)
	}
	tasks, estimates, missing := toSchedulerTasks(plan, req.Tasks, body.Revise, respace)
	placed, unplaced := scheduler.Place(tasks, scheduler.Options{
		From: body.FromSlot, To: body.ToSlot, Occupied: occupiedBy(blocks), Gap: breakBoxes(breakMinutes),
	})

	resp := suggestResponse{Blocks: []suggestedBlock{}, Unplaced: missing, Estimates: estimates, Notes: plan.Notes, BreakMinutes: breakMinutes}
	for _, p := range placed {
		resp.Blocks = append(resp.Blocks, suggestedBlock{
			TaskID: p.TaskID, Title: p.Title, StartSlot: p.Range.Start, EndSlot: p.Range.End, Reason: p.Reason, Shifted: p.Shifted,
		})
	}
	for _, u := range unplaced {
		resp.Unplaced = append(resp.Unplaced, unplacedTask{TaskID: u.TaskID, Title: u.Title, Boxes: u.Boxes})
	}
	writeJSON(w, http.StatusOK, resp)
}

func occupiedBy(blocks []store.Block) []scheduler.Range {
	occupied := make([]scheduler.Range, 0, len(blocks))
	for _, b := range blocks {
		occupied = append(occupied, scheduler.Range{Start: b.StartSlot, End: b.EndSlot})
	}
	return occupied
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

const (
	maxBreakMinutes = scheduler.MaxGap * 10
	breakRule       = "쉬는 시간은 0~60분 사이로 10분 단위로 정해 주세요"
)

func validBreak(minutes int) bool {
	return minutes >= 0 && minutes <= maxBreakMinutes && minutes%10 == 0
}

// breakBoxes rounds a break up to whole 10-minute boxes.
func breakBoxes(minutes int) int {
	return (max(minutes, 0) + 9) / 10
}

// breakWords are how people ask about breaks between blocks. A small model
// sometimes fills breakMinutes for requests about something else, so a new
// break is only taken when the request talks about one.
var breakWords = []string{"쉬", "휴식", "간격", "틈", "여유", "텀", "붙여", "break", "rest", "gap"}

func asksForBreak(request string) bool {
	request = strings.ToLower(request)
	for _, w := range breakWords {
		if strings.Contains(request, w) {
			return true
		}
	}
	return false
}

// toRevision checks a revise request and turns it into what the AI is shown.
func toRevision(rv *reviseRequest) (*ai.Revision, string) {
	if rv == nil {
		return nil, ""
	}
	rv.Request = strings.TrimSpace(rv.Request)
	if rv.Request == "" || utf8.RuneCountInString(rv.Request) > maxReviseText {
		return nil, "수정 요청은 1~" + itoa(maxReviseText) + "자로 적어 주세요"
	}
	if len(rv.Previous) > maxReviseBlocks || len(rv.Earlier) > maxReviseEarlier {
		return nil, "수정할 제안이 너무 길어요"
	}
	out := &ai.Revision{Previous: []ai.SuggestedInput{}, Request: rv.Request}
	for _, e := range rv.Earlier {
		if e = strings.TrimSpace(e); e != "" && utf8.RuneCountInString(e) <= maxReviseText {
			out.Earlier = append(out.Earlier, e)
		}
	}
	for _, b := range rv.Previous {
		if !validSlots(b.StartSlot, b.EndSlot) || utf8.RuneCountInString(b.Title) > 200 {
			return nil, "수정할 제안의 블록이 올바르지 않아요"
		}
		out.Previous = append(out.Previous, ai.SuggestedInput{
			TaskID: b.TaskID, Title: b.Title, Start: slotText(b.StartSlot), End: slotText(b.EndSlot), Unchecked: b.Unchecked,
		})
	}
	return out, ""
}

// clockSlot reads "HH:MM" as a slot, rounding down to the 10-minute box.
func clockSlot(s string) (int, bool) {
	t, err := time.Parse("15:04", strings.TrimSpace(s))
	if err != nil {
		return 0, false
	}
	return t.Hour()*6 + t.Minute()/10, true
}

// toSchedulerTasks validates the model's plan against the real tasks: unknown ids
// are dropped, sizes are clamped, and tasks the model skipped are reported back.
// When revising, tasks the model kept stay exactly as they were shown, tasks it
// was asked to leave out are dropped, and asked-for start times are honoured.
// With respace (a new break between blocks), kept tasks keep their order and
// part of the day but are spaced again instead of staying exactly where they were.
func toSchedulerTasks(plan ai.Plan, inputs []ai.TaskInput, rv *reviseRequest, respace bool) ([]scheduler.Task, []taskEstimate, []unplacedTask) {
	shown := map[string][]scheduler.Chunk{}
	pins := map[string][]scheduler.Range{}
	if rv != nil {
		for _, b := range rv.Previous {
			shown[b.TaskID] = append(shown[b.TaskID], scheduler.Chunk{Title: b.Title, Boxes: b.EndSlot - b.StartSlot})
			pins[b.TaskID] = append(pins[b.TaskID], scheduler.Range{Start: b.StartSlot, End: b.EndSlot})
		}
	}

	byID := make(map[string]ai.TaskInput, len(inputs))
	for _, t := range inputs {
		byID[t.ID] = t
	}

	titles := make([]string, len(inputs))
	for i, t := range inputs {
		titles[i] = t.Title
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
		// A task the model gave a new time is not one the request takes out
		// ("회의 취소된 자리로 옮겨줘").
		if rv != nil && (tp.Skip || tp.StartAt == "" && asksToSkip(rv.Request, in.Title, titles)) {
			continue
		}
		// Kept as it was: where it was shown, or still left out (taken out by an
		// earlier request, or it did not fit) when it was not on screen. When only
		// the break changes, a small model tends to restate every task (its current
		// start as an asked-for time, a new length), so tasks the request does not
		// name are kept as they were.
		if rv != nil && (tp.Keep || respace && !mentions(rv.Request, in.Title)) {
			if len(shown[in.ID]) == 0 {
				continue
			}
			kept := scheduler.Task{ID: in.ID, Priority: tp.Priority, Chunks: shown[in.ID], Pinned: pins[in.ID], Reason: tp.Reason}
			if respace {
				start := pins[in.ID][0].Start
				kept.Pinned, kept.Prefer = nil, &start
			}
			tasks = append(tasks, kept)
			if in.EstimateBoxes == nil {
				boxes := 0
				for _, c := range shown[in.ID] {
					boxes += c.Boxes
				}
				estimates = append(estimates, taskEstimate{TaskID: in.ID, EstimateBoxes: clampBoxes(boxes)})
			}
			continue
		}

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

		// Only what is left of a task the person sized: a small model tends to plan
		// the whole estimate again when part of it is already on the calendar.
		if rv == nil && in.EstimateBoxes != nil && in.ScheduledBoxes > 0 {
			if left := *in.EstimateBoxes - in.ScheduledBoxes; left > 0 && chunkBoxes(chunks) > left {
				chunks = scaleChunks(chunks, left)
			}
		}

		t := scheduler.Task{ID: in.ID, Priority: tp.Priority, Window: scheduler.Window(tp.Window), Chunks: chunks, Reason: tp.Reason}
		at, timed := clockSlot(tp.StartAt)
		if timed && rv == nil {
			// The AI's own choice: a starting point, not a promise. A small model
			// may name the evening for an errand and then start it at 12:50; the
			// part of the day it named wins over a time outside it.
			if part, ok := t.Window.Part(); ok && (at < part.Start || at >= part.End) {
				at = part.Start
			}
			t.Prefer = &at
		}
		if timed && rv != nil {
			t.StartAt = &at
			// "9시에서 9시 30분까지": the asked-for span sets the length.
			if end, ok := clockSlot(tp.EndAt); ok && end > at && end-at != chunkBoxes(chunks) {
				estimate = end - at
				t.Chunks = []scheduler.Chunk{{Title: in.Title, Boxes: estimate}}
			} else if len(shown[in.ID]) > 0 && !asksForLength(rv.Request) {
				// Only moved: it keeps the length it was shown with, which a small
				// model tends to forget ("8시로 옮겨줘" coming back 30 minutes long).
				t.Chunks = shown[in.ID]
			}
		}
		tasks = append(tasks, t)
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

// scaleChunks shrinks or stretches the chunks to add up to total, keeping their
// order and proportions.
func scaleChunks(chunks []scheduler.Chunk, total int) []scheduler.Chunk {
	subs := make([]breakdown.Sub, len(chunks))
	for i, c := range chunks {
		subs[i] = breakdown.Sub{Title: c.Title, Boxes: c.Boxes}
	}
	if total < len(subs) { // too short to keep every piece: one block
		return []scheduler.Chunk{{Title: chunks[0].Title, Boxes: total}}
	}
	scaled, _ := breakdown.ScaleTo(subs, total)
	out := make([]scheduler.Chunk, len(scaled))
	for i, s := range scaled {
		out[i] = scheduler.Chunk{Title: s.Title, Boxes: s.Boxes}
	}
	return out
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

// skipWords are how people take a task out of a plan; lengthWords how they
// change how long one takes.
var (
	skipWords   = []string{"빼", "취소", "지워", "제외", "없애"}
	lengthWords = []string{"분", "시간", "길게", "짧게", "늘려", "줄여"}
)

// asksToSkip reports whether the part of request about title, from where it is
// named up to where another task is named, asks to leave it out: "운동은 빼고
// 독서는 10시로" takes out 운동, not 독서. A small model misses the first of
// two changes asked at once.
func asksToSkip(request, title string, titles []string) bool {
	at := nameAt(request, title, titles)
	if at < 0 {
		return false
	}
	end := len(request)
	for _, other := range titles {
		if i := nameAt(request, other, titles); other != title && i > at && i < end {
			end = i
		}
	}
	part := request[at:end]
	return slices.ContainsFunc(skipWords, func(w string) bool { return strings.Contains(part, w) })
}

func asksForLength(request string) bool {
	return slices.ContainsFunc(lengthWords, func(w string) bool { return strings.Contains(request, w) })
}

// nameAt is where request first names the task: its whole title, or else a
// word of it (two or more letters) that no other task's title has, since
// "E2E 운동" and "E2E 메일" are not told apart by "E2E". -1 when not named.
func nameAt(request, title string, titles []string) int {
	request, title = strings.ToLower(request), strings.ToLower(title)
	if i := strings.Index(request, title); i >= 0 {
		return i
	}
	at := -1
	for _, w := range strings.Fields(title) {
		shared := slices.ContainsFunc(titles, func(o string) bool {
			o = strings.ToLower(o)
			return o != title && slices.Contains(strings.Fields(o), w)
		})
		if utf8.RuneCountInString(w) < 2 || shared {
			continue
		}
		if i := strings.Index(request, w); i >= 0 && (at < 0 || i < at) {
			at = i
		}
	}
	return at
}

// mentions reports whether request names the task: a word of its title (two or
// more letters) appears in it, e.g. "box는 1시간만" names "box scheduler 고도화".
func mentions(request, title string) bool {
	request = strings.ToLower(request)
	for _, w := range strings.Fields(strings.ToLower(title)) {
		if utf8.RuneCountInString(w) >= 2 && strings.Contains(request, w) {
			return true
		}
	}
	return false
}

func chunkBoxes(chunks []scheduler.Chunk) int {
	n := 0
	for _, c := range chunks {
		n += c.Boxes
	}
	return n
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

	// The day may have changed since the plan was made: blocks that now overlap
	// something move to the nearest free time, and ones that fit nowhere are left out.
	current, err := a.store.ListBlocks(r.Context(), userID(r), date, date)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	want := make([]scheduler.Range, len(blocks))
	for i, b := range blocks {
		want[i] = scheduler.Range{Start: b.StartSlot, End: b.EndSlot}
	}
	got, ok := scheduler.Fit(want, occupiedBy(current))
	res := applyResponse{}
	fitted := make([]store.Block, 0, len(blocks))
	for i, b := range blocks {
		switch {
		case !ok[i]:
			res.Skipped++
			continue
		case got[i] != want[i]:
			res.Moved++
		}
		b.StartSlot, b.EndSlot = got[i].Start, got[i].End
		fitted = append(fitted, b)
	}

	if res.Blocks, err = a.store.ApplyPlan(r.Context(), userID(r), fitted, estimates); err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, res)
}

type applyResponse struct {
	Blocks  []store.Block `json:"blocks"`
	Moved   int           `json:"moved"`   // put at another time, as the day had changed
	Skipped int           `json:"skipped"` // no free time left for them
}

// planBreak is the break AI plans keep between blocks, chosen in the AI panel.
func (a *API) planBreak(w http.ResponseWriter, r *http.Request) {
	minutes, err := a.store.PlanBreak(r.Context(), userID(r))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]int{"breakMinutes": minutes})
}

func (a *API) setPlanBreak(w http.ResponseWriter, r *http.Request) {
	var body struct {
		BreakMinutes int `json:"breakMinutes"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	if !validBreak(body.BreakMinutes) {
		writeError(w, http.StatusBadRequest, breakRule)
		return
	}
	if err := a.store.SetPlanBreak(r.Context(), userID(r), body.BreakMinutes); err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]int{"breakMinutes": body.BreakMinutes})
}
