package httpapi

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"regexp"
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
	// The parts' minutes are merged a few at a time, so that what one merge
	// reads (about 2,200 tokens) leaves room for its answer; the merged
	// minutes are merged again until one is left.
	mergeRunes     = 3000
	mergeMostParts = 4 // parts one merge takes at most, when estimating the steps
	meetingAITime  = 40 * time.Minute
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

func (a *API) withMeetingPermissions(role, userID string, m store.Meeting) store.Meeting {
	m = withMeetingPermissions(role, userID, m)
	m.CanTranscribe = m.CanEdit && a.opts.STT != nil && a.opts.AudioDir != ""
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
		if (t.Title != "" || len(t.Points) > 0) && len(out.Topics) < 60 {
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
		list[i] = a.withMeetingPermissions(role, me, list[i])
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
	writeJSON(w, http.StatusCreated, a.withMeetingPermissions(role, me, m))
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
	return teamID, role, a.withMeetingPermissions(role, currentUser(r).ID, m), true
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
	writeJSON(w, http.StatusOK, a.withMeetingPermissions(role, currentUser(r).ID, m))
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
	if transcribing(cur) {
		writeError(w, http.StatusConflict, "녹음을 받아쓰고 있어요. 끝나면 그 내용으로 회의록을 정리할 수 있어요")
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
	if err := a.beginMinutes(r.Context(), me.ID, teamID, cur, members, p); err != nil {
		writeMeetingError(w, err)
		return
	}
	m, err := a.store.MeetingByID(r.Context(), teamID, cur.ID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, a.withMeetingPermissions(role, me.ID, m))
}

// beginMinutes marks the meeting as being written up and starts the work.
func (a *API) beginMinutes(ctx context.Context, userID, teamID string, m store.Meeting, members []store.TeamMember, p ai.Provider) error {
	parts := splitTranscript(m.Transcript, meetingPartRunes)
	steps := len(parts) + mergeSteps(len(parts))
	if err := a.store.StartMeetingAI(ctx, teamID, m.ID, steps); err != nil {
		return err
	}
	go a.writeMinutes(userID, teamID, m, members, parts, p)
	return nil
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
		part, err := retryAI(ctx, func(ctx context.Context) (ai.MeetingPart, error) { return p.MeetingPart(ctx, req) })
		if err != nil {
			fail(err)
			return
		}
		results = append(results, part)
		_ = a.store.MeetingAIProgress(ctx, m.ID, i+1)
	}
	done, steps := len(parts), len(parts)+mergeSteps(len(parts))
	partMinutes := make([]ai.MeetingMinutes, len(results))
	for i, x := range results {
		partMinutes[i] = x.MeetingMinutes
	}
	minutes, err := mergeMinutes(ctx, p, m.Title, m.HeldOn, partMinutes, func() {
		done = min(done+1, steps-1) // the estimate can fall short; the save finishes it
		_ = a.store.MeetingAIProgress(ctx, m.ID, done)
	})
	if err != nil {
		fail(err)
		return
	}
	saved := cleanMinutes(store.Minutes{Summary: minutes.Summary, Decisions: minutes.Decisions, Topics: topicsOf(minutes.Topics)})
	tasks := foundTasks(results, members, m.Transcript, m.HeldOn)
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
// not come out right; a third failure is final. The first try asks for the
// model's steadiest answer.
func retryAI[T any](ctx context.Context, fn func(context.Context) (T, error)) (T, error) {
	var out T
	var err error
	for try := 0; try < 3; try++ {
		c := ctx
		if try == 0 {
			c = ai.Steady(ctx)
		}
		if out, err = fn(c); err == nil || errors.Is(err, ai.ErrNotConfigured) || ctx.Err() != nil {
			return out, err
		}
	}
	return out, err
}

// mergeMinutes merges the parts' minutes into the whole meeting's. The model
// writes the summary and decisions, a few parts at a time, in order, then from
// those merges again, until one is left; the topics are the parts' own, joined
// here, so none is lost and the model has less to write.
func mergeMinutes(ctx context.Context, p ai.Minuter, title, heldOn string, parts []ai.MeetingMinutes, merged func()) (ai.MeetingMinutes, error) {
	topics := joinTopics(parts)
	for len(parts) > 1 {
		next := []ai.MeetingMinutes{}
		for _, group := range mergeGroups(parts, mergeRunes) {
			if len(group) == 1 {
				next = append(next, group[0])
				continue
			}
			req := ai.MergeRequest{Title: title, HeldOn: heldOn, Parts: group}
			out, err := retryAI(ctx, func(ctx context.Context) (ai.MeetingMinutes, error) { return p.MergeMinutes(ctx, req) })
			if err != nil {
				return ai.MeetingMinutes{}, err
			}
			next = append(next, out)
			merged()
		}
		parts = next
	}
	out := parts[0]
	out.Topics = topics
	return out, nil
}

// joinTopics lists the parts' topics in order, the same subject once: a topic
// that goes on into the next part, or comes back later, gets its points added
// to the first.
func joinTopics(parts []ai.MeetingMinutes) []ai.MeetingTopic {
	out := []ai.MeetingTopic{}
	for _, p := range parts {
		for _, t := range p.Topics {
			i := slices.IndexFunc(out, func(x ai.MeetingTopic) bool { return sameWork(x.Title, t.Title) })
			if i < 0 {
				out = append(out, ai.MeetingTopic{Title: t.Title, Points: []string{}})
				i = len(out) - 1
			}
			for _, x := range t.Points {
				if !slices.ContainsFunc(out[i].Points, func(y string) bool { return squash(y) == squash(x) }) {
					out[i].Points = append(out[i].Points, x)
				}
			}
		}
	}
	return out
}

// mergeGroups cuts the parts, in order, into groups that fit in a merge of
// budget runes. A group holds two parts at least, so each round merges.
func mergeGroups(parts []ai.MeetingMinutes, budget int) [][]ai.MeetingMinutes {
	groups := [][]ai.MeetingMinutes{}
	var cur []ai.MeetingMinutes
	n := 0
	for _, x := range parts {
		size := ai.MergeRunes(x)
		if len(cur) >= 2 && n+size > budget {
			groups = append(groups, cur)
			cur, n = nil, 0
		}
		cur = append(cur, x)
		n += size
	}
	if len(cur) > 0 {
		groups = append(groups, cur) // a part left over alone waits for the next round
	}
	return groups
}

// mergeSteps estimates how many merges n parts take, for the progress shown.
func mergeSteps(n int) int {
	steps := 0
	for n > 1 {
		groups := (n + mergeMostParts - 1) / mergeMostParts
		steps += groups
		n = groups
	}
	return steps
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
// evidence the transcript does not have (made up) is dropped, and so are an
// assignee and a deadline the evidence does not bear out: a task goes to
// someone only when they took it on or were named for it, and is due only when
// a time was said.
func foundTasks(parts []ai.MeetingPart, members []store.TeamMember, transcript, heldOn string) []store.MeetingTask {
	said := squash(transcript)
	lines := strings.Split(transcript, "\n")
	out := []store.MeetingTask{}
	for _, p := range parts {
		for _, t := range p.Tasks {
			title := clip(t.Title, 200)
			if title == "" {
				continue
			}
			x := store.MeetingTask{Title: title, Note: clip(t.Note, 1000)}
			if ev := clip(strings.Trim(t.Evidence, `"'“”‘’`), 500); ev != "" && strings.Contains(said, squash(strings.TrimRight(ev, ".?!。"))) {
				if noWork(ev) {
					continue
				}
				x.Evidence = ev
				if id := matchMember(t.Assignee, members); id != "" && tookOn(evidenceLine(lines, ev), ev, memberByID(members, id), members) {
					x.AssigneeID = id
				}
				x.DueDate = taskDue(ev, strings.TrimSpace(t.DueDate), heldOn)
			}
			if i := slices.IndexFunc(out, func(y store.MeetingTask) bool { return sameTask(y, x) }); i >= 0 {
				if out[i].AssigneeID == "" {
					out[i].AssigneeID = x.AssigneeID
				}
				if out[i].DueDate == nil {
					out[i].DueDate = x.DueDate
				}
				if out[i].Note == "" {
					out[i].Note = x.Note
				}
				if out[i].Evidence == "" {
					out[i].Evidence = x.Evidence
				}
				continue
			}
			if len(out) == maxMeetingTasks {
				return out
			}
			out = append(out, x)
		}
	}
	return out
}

var (
	// What is said of work already done, or put off on purpose.
	doneWork = regexp.MustCompile(`끝났|끝냈|마쳤|완료(됐|했|되었)|반영(됐|되었|했)|해\s*놨|해\s*놓았|붙여\s*놨|다음\s*버전에서|나중에|다음에\s*다시`)
	// A question that asks someone to do something ("~해 주실 수 있어요?").
	askingFor = regexp.MustCompile(`주실\s*수|줄\s*수|주시겠|주시면|주세요|맡아\s*줄|해\s*볼래|할\s*수\s*있(을까|어)`)
)

// noWork tells whether the words a task came from show there is nothing to do:
// the work is done or put off, or it was a question that asked no one for work
// ("화면 공유가 잘 되고 있나요?"). A small model lists such lines as tasks when
// a long meeting has a lot of talk.
func noWork(evidence string) bool {
	return doneWork.MatchString(evidence) || (strings.ContainsAny(evidence, "?？") && !askingFor.MatchString(evidence))
}

// sameTask tells whether two tasks are the same work: their titles say so, or
// they are due the same day and share two words of what is done ("서버 비용
// 정리", "서버 비용 절감 방안 정리"), as when the end of a meeting goes over
// its work again.
func sameTask(a, b store.MeetingTask) bool {
	if sameWork(a.Title, b.Title) {
		return true
	}
	if a.DueDate == nil || b.DueDate == nil || *a.DueDate != *b.DueDate {
		return false
	}
	shared := 0
	for _, w := range strings.Fields(a.Title) {
		if utf8.RuneCountInString(w) >= 2 && !plainWord[w] && slices.Contains(strings.Fields(b.Title), w) {
			shared++
		}
	}
	return shared >= 2
}

// Words many task titles have, which say little of what the work is.
var plainWord = map[string]bool{"기능": true, "작성": true, "정리": true, "수정": true, "추가": true, "개발": true, "진행": true, "검토": true, "준비": true, "논의": true, "확인": true, "방안": true}

// Words a small model ends a title with, which leave the work the same: how
// it was talked over ("~ 방안 논의") and the plain verbs of building something
// ("~ 기능 추가", "~ 기능 개발").
var workSuffix = regexp.MustCompile(`\s*(에\s*대한|에\s*대해|관련|방안|방향|방법|계획|논의|검토|협의|진행|작업|하기|추가|개발|구현|도입|적용)$`)

// sameWork tells whether two task titles name the same work, as the parts of a
// long meeting say it in their own words: "sweep 녹음 기능 추가" and "sweep 프로젝트
// 녹음 기능 개발 방안 논의", or "결제 오류 수정" and "결제 오류 수정하기". A title
// is the same work when the other only adds words inside it; a word changed
// ("앱 다크 모드", "웹 다크 모드") or added at the end ("로그인 기능 테스트") is
// other work.
func sameWork(a, b string) bool {
	a, b = workKey(a), workKey(b)
	if a == "" || b == "" {
		return false
	}
	if utf8.RuneCountInString(a) > utf8.RuneCountInString(b) {
		a, b = b, a
	}
	return a == b || (utf8.RuneCountInString(a) >= 4 && inOrder(a, b) && lastRunes(a, 2) == lastRunes(b, 2) && dice(a, b) >= 0.5)
}

func workKey(title string) string {
	t := strings.ToLower(strings.TrimSpace(title))
	for {
		cut := workSuffix.ReplaceAllString(t, "")
		if cut == t || cut == "" {
			break
		}
		t = cut
	}
	return squash(t)
}

// inOrder tells whether every letter of a is in b, in the same order.
func inOrder(a, b string) bool {
	rb := []rune(b)
	j := 0
	for _, r := range a {
		for j < len(rb) && rb[j] != r {
			j++
		}
		if j == len(rb) {
			return false
		}
		j++
	}
	return true
}

func lastRunes(s string, n int) string {
	rs := []rune(s)
	return string(rs[max(0, len(rs)-n):])
}

// dice is how much of two strings' letter pairs they share, from 0 to 1.
func dice(a, b string) float64 {
	pairs := func(s string) map[string]int {
		rs := []rune(s)
		m := map[string]int{}
		for i := 0; i+1 < len(rs); i++ {
			m[string(rs[i:i+2])]++
		}
		return m
	}
	pa, pb := pairs(a), pairs(b)
	total, shared := 0, 0
	for k, n := range pa {
		total += n
		shared += min(n, pb[k])
	}
	for _, n := range pb {
		total += n
	}
	if total == 0 {
		return 0
	}
	return 2 * float64(shared) / float64(total)
}

var (
	speakerLine = regexp.MustCompile(`^\s*([^:：]{1,20})[:：]\s*(.*)$`)
	// What a person says when they take work on themselves.
	firstPerson = regexp.MustCompile(`제가|저는|저도|저희가|내가|제 쪽|맡을게|맡겠|할게요|볼게요|드릴게요|둘게요|놓을게요|해 올게요`)
)

// evidenceLine is the transcript line the evidence was said in.
func evidenceLine(lines []string, evidence string) string {
	ev := squash(strings.TrimRight(evidence, ".?!。"))
	for _, l := range lines {
		if strings.Contains(squash(l), ev) {
			return l
		}
	}
	return ""
}

func memberByID(members []store.TeamMember, id string) store.TeamMember {
	for _, m := range members {
		if m.UserID == id {
			return m
		}
	}
	return store.TeamMember{}
}

// tookOn tells whether the line bears out that m does the work: m is named in
// what was said ("가격표는 민지 님이 봐 주세요"), or m said it and took it on
// ("민지: 네, 제가 정리할게요").
func tookOn(line, evidence string, m store.TeamMember, members []store.TeamMember) bool {
	if line == "" || m.UserID == "" {
		return false
	}
	who, words := "", line
	if x := speakerLine.FindStringSubmatch(line); x != nil {
		who, words = x[1], x[2]
	}
	if namesMember(words, m) {
		return true
	}
	return who != "" && matchMember(who, members) == m.UserID && firstPerson.MatchString(evidence)
}

// namesMember tells whether text names m: their whole name, or the given name of
// a Korean name ("서준" for "박서준").
func namesMember(text string, m store.TeamMember) bool {
	text = squash(text)
	full := []rune(squash(displayName(m.Name, m.Email)))
	if len(full) >= 2 && strings.Contains(text, string(full)) {
		return true
	}
	return len(full) == 3 && unicode.Is(unicode.Hangul, full[0]) && strings.Contains(text, string(full[1:]))
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
	writeJSON(w, http.StatusOK, a.withMeetingPermissions(role, me.ID, m))
}
