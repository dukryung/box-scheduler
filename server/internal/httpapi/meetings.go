package httpapi

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"slices"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"

	"box-scheduler/server/internal/ai"
	"box-scheduler/server/internal/aigate"
	"box-scheduler/server/internal/store"
)

// Meetings ("회의"): someone pastes what was said, the AI writes the minutes and
// finds the tasks in it (in the background: a local model can take minutes on
// a long meeting), and a manager or the owner gives each task to someone and
// confirms, which makes them team tasks. Everyone in the team sees every
// meeting; its creator and managers edit it until it is confirmed.

const (
	maxTranscript   = 100000 // runes
	maxMeetingTasks = 50
	// A small local model reads about 4,000 tokens at once, prompt and answer
	// together; 1,800 Korean characters are about 1,300 of them.
	meetingPartRunes = 1800
	meetingAITime    = 40 * time.Minute
)

func canEditMeeting(role, userID string, m store.Meeting) bool {
	return store.RoleRank(role) >= store.RoleRank("manager") || (m.CreatedBy != "" && m.CreatedBy == userID)
}

func withMeetingPermissions(role, userID string, m store.Meeting) store.Meeting {
	open := m.Status == "draft" || m.Status == "ready"
	m.CanEdit = open && canEditMeeting(role, userID, m)
	m.CanConfirm = open && store.RoleRank(role) >= store.RoleRank("manager")
	m.CanDelete = m.Status != "processing" && canEditMeeting(role, userID, m)
	return m
}

type meetingBody struct {
	Title      *string              `json:"title"`
	HeldOn     *string              `json:"heldOn"`
	Transcript *string              `json:"transcript"`
	Minutes    *store.Minutes       `json:"minutes"`
	Tasks      *[]store.MeetingTask `json:"tasks"`
}

// apply merges the body into f and checks the result; it returns a message for the user when something is off.
func (b meetingBody) apply(f *store.MeetingFields) string {
	if b.Title != nil {
		f.Title = strings.TrimSpace(*b.Title)
	}
	if n := utf8.RuneCountInString(f.Title); n < 1 || n > 120 {
		return "회의 제목을 1~120자로 적어 주세요"
	}
	if b.HeldOn != nil {
		f.HeldOn = *b.HeldOn
	}
	if !isDate(f.HeldOn) {
		return "회의 날짜 형식이 올바르지 않아요"
	}
	if b.Transcript != nil {
		f.Transcript = strings.TrimSpace(*b.Transcript)
	}
	if utf8.RuneCountInString(f.Transcript) > maxTranscript {
		return "회의 내용은 10만 자까지 넣을 수 있어요"
	}
	if b.Minutes != nil {
		m := cleanMinutes(*b.Minutes)
		f.Minutes = &m
	}
	return ""
}

func clip(s string, n int) string {
	s = strings.TrimSpace(s)
	if utf8.RuneCountInString(s) > n {
		return strings.TrimSpace(string([]rune(s)[:n]))
	}
	return s
}

func cleanLines(in []string, most, runes int) []string {
	out := []string{}
	for _, s := range in {
		if s = clip(s, runes); s != "" && len(out) < most {
			out = append(out, s)
		}
	}
	return out
}

func cleanMinutes(m store.Minutes) store.Minutes {
	out := store.Minutes{Summary: clip(m.Summary, 2000), Decisions: cleanLines(m.Decisions, 30, 300), Topics: []store.MinutesTopic{}}
	for _, t := range m.Topics {
		t := store.MinutesTopic{Title: clip(t.Title, 120), Points: cleanLines(t.Points, 12, 300)}
		if (t.Title != "" || len(t.Points) > 0) && len(out.Topics) < 30 {
			out.Topics = append(out.Topics, t)
		}
	}
	return out
}

// cleanTasks trims the tasks and checks each is given to someone in the team.
func cleanTasks(in []store.MeetingTask, members []store.TeamMember) ([]store.MeetingTask, string) {
	if len(in) > maxMeetingTasks {
		return nil, fmt.Sprintf("할 일은 %d개까지 둘 수 있어요", maxMeetingTasks)
	}
	out := []store.MeetingTask{}
	for _, t := range in {
		t.Title = clip(t.Title, 200)
		if t.Title == "" {
			continue
		}
		t.Note, t.Evidence = clip(t.Note, 1000), clip(t.Evidence, 500)
		if t.DueDate != nil && *t.DueDate == "" {
			t.DueDate = nil
		}
		if t.DueDate != nil && !isDate(*t.DueDate) {
			return nil, "마감일 형식이 올바르지 않아요"
		}
		if t.AssigneeID != "" && !slices.ContainsFunc(members, func(m store.TeamMember) bool { return m.UserID == t.AssigneeID }) {
			return nil, "팀 멤버만 담당자로 지정할 수 있어요"
		}
		t.ID, t.TeamTaskID = "", ""
		out = append(out, t)
	}
	return out, ""
}

func (a *API) listMeetings(w http.ResponseWriter, r *http.Request) {
	teamID, role, ok := a.teamRole(w, r, "member")
	if !ok {
		return
	}
	list, err := a.store.Meetings(r.Context(), teamID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	me := currentUser(r).ID
	for i := range list {
		list[i] = withMeetingPermissions(role, me, list[i])
	}
	writeJSON(w, http.StatusOK, map[string]any{"meetings": list})
}

func (a *API) createMeeting(w http.ResponseWriter, r *http.Request) {
	teamID, role, ok := a.teamRole(w, r, "member")
	if !ok {
		return
	}
	var body meetingBody
	if !decodeJSON(w, r, &body) {
		return
	}
	var f store.MeetingFields
	if msg := body.apply(&f); msg != "" {
		writeError(w, http.StatusBadRequest, msg)
		return
	}
	me := currentUser(r).ID
	m, err := a.store.CreateMeeting(r.Context(), teamID, me, f.Title, f.HeldOn, f.Transcript)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, withMeetingPermissions(role, me, m))
}

// loadMeeting reads the meeting in the URL for someone in its team.
func (a *API) loadMeeting(w http.ResponseWriter, r *http.Request) (string, string, store.Meeting, bool) {
	teamID, role, ok := a.teamRole(w, r, "member")
	if !ok {
		return "", "", store.Meeting{}, false
	}
	m, err := a.store.MeetingByID(r.Context(), teamID, chi.URLParam(r, "meetingID"))
	if err != nil {
		writeStoreError(w, err)
		return "", "", m, false
	}
	return teamID, role, withMeetingPermissions(role, currentUser(r).ID, m), true
}

func writeMeetingError(w http.ResponseWriter, err error) {
	if errors.Is(err, store.ErrMeetingState) {
		writeError(w, http.StatusConflict, "AI가 정리 중이거나 이미 확정된 회의예요")
		return
	}
	writeStoreError(w, err)
}

func (a *API) getMeeting(w http.ResponseWriter, r *http.Request) {
	if _, _, m, ok := a.loadMeeting(w, r); ok {
		writeJSON(w, http.StatusOK, m)
	}
}

func (a *API) updateMeeting(w http.ResponseWriter, r *http.Request) {
	var body meetingBody
	if !decodeJSON(w, r, &body) {
		return
	}
	teamID, role, cur, ok := a.loadMeeting(w, r)
	if !ok {
		return
	}
	if !canEditMeeting(role, currentUser(r).ID, cur) {
		writeError(w, http.StatusForbidden, "회의를 만든 사람과 매니저만 고칠 수 있어요")
		return
	}
	f := store.MeetingFields{Title: cur.Title, HeldOn: cur.HeldOn, Transcript: cur.Transcript, Minutes: cur.Minutes}
	if msg := body.apply(&f); msg != "" {
		writeError(w, http.StatusBadRequest, msg)
		return
	}
	var tasks []store.MeetingTask
	if body.Tasks != nil {
		members, err := a.store.TeamMembers(r.Context(), teamID)
		if err != nil {
			writeStoreError(w, err)
			return
		}
		var msg string
		if tasks, msg = cleanTasks(*body.Tasks, members); msg != "" {
			writeError(w, http.StatusBadRequest, msg)
			return
		}
	}
	m, err := a.store.UpdateMeeting(r.Context(), teamID, cur.ID, f, tasks)
	if err != nil {
		writeMeetingError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, withMeetingPermissions(role, currentUser(r).ID, m))
}

func (a *API) deleteMeeting(w http.ResponseWriter, r *http.Request) {
	teamID, role, cur, ok := a.loadMeeting(w, r)
	if !ok {
		return
	}
	if !canEditMeeting(role, currentUser(r).ID, cur) {
		writeError(w, http.StatusForbidden, "회의를 만든 사람과 매니저만 지울 수 있어요")
		return
	}
	if err := a.store.DeleteMeeting(r.Context(), teamID, cur.ID); err != nil {
		writeMeetingError(w, err)
		return
	}
	a.removeMeetingAudio(cur.ID)
	w.WriteHeader(http.StatusNoContent)
}

// startMinutes has the AI write the minutes and find the tasks. It answers at
// once; the meeting shows "processing" until the work is done.
func (a *API) startMinutes(w http.ResponseWriter, r *http.Request) {
	teamID, role, cur, ok := a.loadMeeting(w, r)
	if !ok {
		return
	}
	me := currentUser(r)
	if !canEditMeeting(role, me.ID, cur) {
		writeError(w, http.StatusForbidden, "회의를 만든 사람과 매니저만 AI로 정리할 수 있어요")
		return
	}
	if strings.TrimSpace(cur.Transcript) == "" {
		writeError(w, http.StatusBadRequest, "회의 내용을 먼저 넣어 주세요")
		return
	}
	members, err := a.store.TeamMembers(r.Context(), teamID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	p, ok := a.aiFor(w, r, "minutes")
	if !ok {
		return
	}
	parts := splitTranscript(cur.Transcript, meetingPartRunes)
	steps := len(parts)
	if steps > 1 {
		steps++ // merging the parts' minutes
	}
	if err := a.store.StartMeetingAI(r.Context(), teamID, cur.ID, steps); err != nil {
		writeMeetingError(w, err)
		return
	}
	go a.writeMinutes(me.ID, teamID, cur, members, parts, p)
	m, err := a.store.MeetingByID(r.Context(), teamID, cur.ID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, withMeetingPermissions(role, me.ID, m))
}

// writeMinutes reads the meeting part by part, merges the parts, and saves the
// minutes with the tasks found (each matched to someone in the team).
func (a *API) writeMinutes(userID, teamID string, m store.Meeting, members []store.TeamMember, parts []string, p ai.Provider) {
	ctx, cancel := context.WithTimeout(context.Background(), meetingAITime)
	defer cancel()
	started := time.Now()
	names := make([]string, len(members))
	for i, x := range members {
		names[i] = displayName(x.Name, x.Email)
	}
	fail := func(err error) {
		msg := "AI가 회의록을 정리하지 못했어요: " + aiErrorText(err)
		switch {
		case errors.Is(err, aigate.ErrBusy):
			msg = "AI를 쓰는 사람이 많아 정리를 마치지 못했어요. 잠시 뒤 다시 해 주세요"
		case errors.Is(err, ai.ErrNotConfigured):
			msg = "AI가 설정되지 않았어요"
		case errors.Is(err, context.DeadlineExceeded):
			msg = "회의록 정리가 너무 오래 걸려 멈췄어요. 내용을 나눠서 다시 해 주세요"
		}
		slog.Error("minutes failed", "meeting", m.ID, "err", err, "elapsed", time.Since(started))
		if err := a.store.FailMeetingAI(context.WithoutCancel(ctx), m.ID, msg); err != nil {
			slog.Error("save minutes failure", "err", err)
		}
		a.notifyMinutes(ctx, userID, teamID, m, "회의록을 정리하지 못했어요", msg)
	}
	results := make([]ai.MeetingPart, 0, len(parts))
	for i, text := range parts {
		req := ai.MeetingRequest{Title: m.Title, HeldOn: m.HeldOn, Members: names, Part: i + 1, Parts: len(parts), Text: text}
		part, err := retryAI(ctx, func() (ai.MeetingPart, error) { return p.MeetingPart(ctx, req) })
		if err != nil {
			fail(err)
			return
		}
		results = append(results, part)
		_ = a.store.MeetingAIProgress(ctx, m.ID, i+1)
	}
	minutes := results[0].MeetingMinutes
	if len(results) > 1 {
		req := ai.MergeRequest{Title: m.Title, HeldOn: m.HeldOn}
		for _, x := range results {
			req.Parts = append(req.Parts, x.MeetingMinutes)
		}
		merged, err := retryAI(ctx, func() (ai.MeetingMinutes, error) { return p.MergeMinutes(ctx, req) })
		if err != nil {
			fail(err)
			return
		}
		minutes = merged
	}
	saved := cleanMinutes(store.Minutes{Summary: minutes.Summary, Decisions: minutes.Decisions, Topics: topicsOf(minutes.Topics)})
	tasks := foundTasks(results, members, m.Transcript)
	if err := a.store.FinishMeetingAI(ctx, teamID, m.ID, saved, tasks); err != nil {
		slog.Error("save minutes", "meeting", m.ID, "err", err)
		return
	}
	slog.Info("minutes", "meeting", m.ID, "parts", len(parts), "tasks", len(tasks), "elapsed", time.Since(started))
	a.notifyMinutes(ctx, userID, teamID, m, "회의록 정리가 끝났어요", fmt.Sprintf("할 일 %d개를 찾았어요. 담당자를 정해 확정해 주세요", len(tasks)))
}

func (a *API) notifyMinutes(ctx context.Context, userID, teamID string, m store.Meeting, title, body string) {
	a.notifyTeam(context.WithoutCancel(ctx), userID, store.Notification{
		Kind:  "meeting",
		Title: fmt.Sprintf("‘%s’ %s", m.Title, title),
		Body:  body,
		Link:  "/team/" + teamID + "?tab=meetings&meeting=" + m.ID,
	})
}

// retryAI tries again when the queue was full or a small model's answer did
// not come out right; a third failure is final.
func retryAI[T any](ctx context.Context, fn func() (T, error)) (T, error) {
	var out T
	var err error
	for try := 0; try < 3; try++ {
		if out, err = fn(); err == nil || errors.Is(err, ai.ErrNotConfigured) || ctx.Err() != nil {
			return out, err
		}
	}
	return out, err
}

func topicsOf(in []ai.MeetingTopic) []store.MinutesTopic {
	out := make([]store.MinutesTopic, len(in))
	for i, t := range in {
		out[i] = store.MinutesTopic{Title: t.Title, Points: t.Points}
	}
	return out
}

// splitTranscript cuts text into parts of at most size runes, at line ends
// where it can and else at sentence ends.
func splitTranscript(text string, size int) []string {
	pieces := []string{}
	for _, line := range strings.Split(strings.TrimSpace(text), "\n") {
		for utf8.RuneCountInString(line) > size {
			rs := []rune(line)
			cut := size
			for i := size - 1; i > size/2; i-- {
				if strings.ContainsRune(".?!。", rs[i]) && (i+1 == len(rs) || unicode.IsSpace(rs[i+1])) {
					cut = i + 1
					break
				}
			}
			pieces = append(pieces, string(rs[:cut]))
			line = strings.TrimSpace(string(rs[cut:]))
		}
		pieces = append(pieces, line)
	}
	parts := []string{}
	var cur strings.Builder
	n := 0
	for _, p := range pieces {
		l := utf8.RuneCountInString(p)
		if n > 0 && n+1+l > size {
			parts = append(parts, strings.TrimSpace(cur.String()))
			cur.Reset()
			n = 0
		}
		if n > 0 {
			cur.WriteString("\n")
			n++
		}
		cur.WriteString(p)
		n += l
	}
	if s := strings.TrimSpace(cur.String()); s != "" {
		parts = append(parts, s)
	}
	return parts
}

// foundTasks gathers the parts' tasks: the same work named twice is kept once,
// assignees are matched to the team's people, and evidence the transcript does
// not have (made up) is dropped.
func foundTasks(parts []ai.MeetingPart, members []store.TeamMember, transcript string) []store.MeetingTask {
	said := squash(transcript)
	out := []store.MeetingTask{}
	seen := map[string]int{}
	for _, p := range parts {
		for _, t := range p.Tasks {
			title := clip(t.Title, 200)
			if title == "" {
				continue
			}
			x := store.MeetingTask{Title: title, Note: clip(t.Note, 1000), AssigneeID: matchMember(t.Assignee, members)}
			if ev := clip(strings.Trim(t.Evidence, `"'“”‘’`), 500); ev != "" && strings.Contains(said, squash(strings.TrimRight(ev, ".?!。"))) {
				x.Evidence = ev
			}
			if d := strings.TrimSpace(t.DueDate); isDate(d) {
				x.DueDate = &d
			}
			key := squash(title)
			if i, ok := seen[key]; ok {
				if out[i].AssigneeID == "" {
					out[i].AssigneeID = x.AssigneeID
				}
				if out[i].DueDate == nil {
					out[i].DueDate = x.DueDate
				}
				continue
			}
			if len(out) == maxMeetingTasks {
				return out
			}
			seen[key] = len(out)
			out = append(out, x)
		}
	}
	return out
}

// squash drops spaces, so text compares the same however it was spaced.
func squash(s string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsSpace(r) {
			return -1
		}
		return r
	}, s)
}

// matchMember finds the one team member a name from the minutes means: by
// their whole name, else by a name that holds the other ("민지" for "김민지").
func matchMember(name string, members []store.TeamMember) string {
	name = squash(name)
	for _, suffix := range []string{"님", "씨", "매니저", "팀장", "대리", "주임", "과장", "차장", "부장"} {
		name = strings.TrimSuffix(name, suffix)
	}
	if utf8.RuneCountInString(name) < 2 {
		return ""
	}
	match := ""
	for _, m := range members {
		full := squash(displayName(m.Name, m.Email))
		if full == name {
			return m.UserID
		}
		if utf8.RuneCountInString(full) >= 2 && (strings.Contains(full, name) || strings.Contains(name, full)) {
			if match != "" {
				return "" // more than one fits
			}
			match = m.UserID
		}
	}
	return match
}

// confirmMeeting makes the tasks team tasks (with their assignees) and closes
// the meeting. Managers and the owner do it.
func (a *API) confirmMeeting(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Tasks []store.MeetingTask `json:"tasks"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	teamID, role, cur, ok := a.loadMeeting(w, r)
	if !ok {
		return
	}
	if store.RoleRank(role) < store.RoleRank("manager") {
		writeError(w, http.StatusForbidden, "매니저 이상만 회의 할 일을 확정할 수 있어요")
		return
	}
	members, err := a.store.TeamMembers(r.Context(), teamID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	tasks, msg := cleanTasks(body.Tasks, members)
	if msg != "" {
		writeError(w, http.StatusBadRequest, msg)
		return
	}
	me := currentUser(r)
	ids, err := a.store.ConfirmMeeting(r.Context(), teamID, cur.ID, me.ID, tasks)
	if err != nil {
		writeMeetingError(w, err)
		return
	}
	for _, id := range ids {
		if t, err := a.store.TeamTaskByID(r.Context(), teamID, id); err == nil {
			a.notifyAssigned(r, teamID, store.TeamTask{}, t)
		}
	}
	m, err := a.store.MeetingByID(r.Context(), teamID, cur.ID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, withMeetingPermissions(role, me.ID, m))
}
