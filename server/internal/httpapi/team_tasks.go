package httpapi

import (
	"fmt"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"

	"box-scheduler/server/internal/store"
)

// Team task permissions: everyone in the team sees every task. Members create
// tasks with only themselves on them and edit the ones they created; managers
// and the owner edit any task and assign anyone. Whoever is on a task may move
// its status.

const maxTaskBoxes = 6000

var taskStatuses = map[string]bool{"todo": true, "doing": true, "done": true}

func canEditTask(role, userID string, t store.TeamTask) bool {
	return store.RoleRank(role) >= store.RoleRank("manager") || (t.CreatedBy != "" && t.CreatedBy == userID)
}

func isAssigned(userID string, t store.TeamTask) bool {
	for _, a := range t.Assignees {
		if a.UserID == userID {
			return true
		}
	}
	return false
}

func withPermissions(role, userID string, t store.TeamTask) store.TeamTask {
	t.CanEdit = canEditTask(role, userID, t)
	t.CanSetStatus = t.CanEdit || isAssigned(userID, t)
	t.CanPlan = t.CanSetStatus
	return t
}

// teamTaskBody is shared by create and update; on update a missing field keeps
// its value, and "" (dates) or 0 (estimate) clears it.
type teamTaskBody struct {
	Title         *string                `json:"title"`
	Note          *string                `json:"note"`
	Status        *string                `json:"status"`
	StartDate     *string                `json:"startDate"`
	DueDate       *string                `json:"dueDate"`
	EstimateBoxes *int                   `json:"estimateBoxes"`
	Assignees     *[]store.AssigneeInput `json:"assignees"`
}

func (b teamTaskBody) onlyStatus() bool {
	return b.Status != nil && b.Title == nil && b.Note == nil && b.StartDate == nil && b.DueDate == nil && b.EstimateBoxes == nil && b.Assignees == nil
}

// apply merges the body into f and checks the result; it returns a message for the user when something is off.
func (b teamTaskBody) apply(f *store.TeamTaskFields) string {
	if b.Title != nil {
		f.Title = strings.TrimSpace(*b.Title)
	}
	if n := utf8.RuneCountInString(f.Title); n < 1 || n > 200 {
		return "업무 제목을 1~200자로 적어 주세요"
	}
	if b.Note != nil {
		f.Note = strings.TrimSpace(*b.Note)
	}
	if utf8.RuneCountInString(f.Note) > 4000 {
		return "설명은 4000자까지 적을 수 있어요"
	}
	if b.Status != nil {
		f.Status = *b.Status
	}
	if !taskStatuses[f.Status] {
		return "상태가 올바르지 않아요"
	}
	for _, d := range []struct {
		in  *string
		out **string
	}{{b.StartDate, &f.StartDate}, {b.DueDate, &f.DueDate}} {
		if d.in == nil {
			continue
		}
		if *d.in == "" {
			*d.out = nil
			continue
		}
		if _, ok := parseDate(*d.in); !ok {
			return "날짜 형식이 올바르지 않아요"
		}
		v := *d.in
		*d.out = &v
	}
	if f.StartDate != nil && f.DueDate != nil && *f.StartDate > *f.DueDate {
		return "시작일이 마감일보다 늦어요"
	}
	if b.EstimateBoxes != nil {
		if *b.EstimateBoxes == 0 {
			f.EstimateBoxes = nil
		} else {
			v := *b.EstimateBoxes
			f.EstimateBoxes = &v
		}
	}
	if f.EstimateBoxes != nil && (*f.EstimateBoxes < 1 || *f.EstimateBoxes > maxTaskBoxes) {
		return "예상 시간은 10분에서 1000시간 사이로 정해 주세요"
	}
	return ""
}

// cleanAssignees drops duplicates, checks shares and that everyone is in the team.
func cleanAssignees(in []store.AssigneeInput, members []store.TeamMember) ([]store.AssigneeInput, string) {
	inTeam := map[string]bool{}
	for _, m := range members {
		inTeam[m.UserID] = true
	}
	seen := map[string]bool{}
	out := []store.AssigneeInput{}
	for _, a := range in {
		if seen[a.UserID] {
			continue
		}
		if !inTeam[a.UserID] {
			return nil, "팀 멤버만 담당자로 지정할 수 있어요"
		}
		if a.Boxes != nil && *a.Boxes == 0 {
			a.Boxes = nil
		}
		if a.Boxes != nil && (*a.Boxes < 1 || *a.Boxes > maxTaskBoxes) {
			return nil, "담당 시간은 10분에서 1000시간 사이로 정해 주세요"
		}
		seen[a.UserID] = true
		out = append(out, a)
	}
	return out, ""
}

func (a *API) listTeamTasks(w http.ResponseWriter, r *http.Request) {
	teamID, role, ok := a.teamRole(w, r, "member")
	if !ok {
		return
	}
	tasks, err := a.store.TeamTasks(r.Context(), teamID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	me := currentUser(r).ID
	for i := range tasks {
		tasks[i] = withPermissions(role, me, tasks[i])
	}
	writeJSON(w, http.StatusOK, map[string]any{"tasks": tasks})
}

func (a *API) createTeamTask(w http.ResponseWriter, r *http.Request) {
	teamID, role, ok := a.teamRole(w, r, "member")
	if !ok {
		return
	}
	var body teamTaskBody
	if !decodeJSON(w, r, &body) {
		return
	}
	f := store.TeamTaskFields{Status: "todo"}
	if msg := body.apply(&f); msg != "" {
		writeError(w, http.StatusBadRequest, msg)
		return
	}
	me := currentUser(r).ID
	var assignees []store.AssigneeInput
	if body.Assignees != nil {
		assignees = *body.Assignees
	}
	if store.RoleRank(role) < store.RoleRank("manager") {
		for _, x := range assignees {
			if x.UserID != me {
				writeError(w, http.StatusForbidden, "일반 멤버는 본인만 담당자로 지정할 수 있어요")
				return
			}
		}
		if len(assignees) == 0 {
			assignees = []store.AssigneeInput{{UserID: me}}
		}
	}
	members, err := a.store.TeamMembers(r.Context(), teamID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	assignees, msg := cleanAssignees(assignees, members)
	if msg != "" {
		writeError(w, http.StatusBadRequest, msg)
		return
	}
	t, err := a.store.CreateTeamTask(r.Context(), teamID, me, f, assignees)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	a.notifyAssigned(r, teamID, store.TeamTask{}, t)
	writeJSON(w, http.StatusCreated, withPermissions(role, me, t))
}

func (a *API) updateTeamTask(w http.ResponseWriter, r *http.Request) {
	teamID, role, ok := a.teamRole(w, r, "member")
	if !ok {
		return
	}
	var body teamTaskBody
	if !decodeJSON(w, r, &body) {
		return
	}
	me := currentUser(r).ID
	cur, err := a.store.TeamTaskByID(r.Context(), teamID, chi.URLParam(r, "taskID"))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	cur = withPermissions(role, me, cur)
	if !cur.CanEdit && !(body.onlyStatus() && cur.CanSetStatus) {
		writeError(w, http.StatusForbidden, "이 업무를 고칠 권한이 없어요")
		return
	}
	f := store.TeamTaskFields{Title: cur.Title, Note: cur.Note, Status: cur.Status, StartDate: cur.StartDate, DueDate: cur.DueDate, EstimateBoxes: cur.EstimateBoxes}
	if msg := body.apply(&f); msg != "" {
		writeError(w, http.StatusBadRequest, msg)
		return
	}
	var assignees []store.AssigneeInput
	if body.Assignees != nil {
		assignees = *body.Assignees
		if store.RoleRank(role) < store.RoleRank("manager") {
			// A member only adds, changes or removes themselves; others stay as they were.
			kept := []store.AssigneeInput{}
			for _, x := range cur.Assignees {
				if x.UserID != me {
					kept = append(kept, store.AssigneeInput{UserID: x.UserID, Boxes: x.Boxes})
				}
			}
			for _, x := range assignees {
				if x.UserID != me && !isAssigned(x.UserID, cur) {
					writeError(w, http.StatusForbidden, "일반 멤버는 본인만 담당자로 지정할 수 있어요")
					return
				}
				if x.UserID == me {
					kept = append(kept, x)
				}
			}
			assignees = kept
		}
		members, err := a.store.TeamMembers(r.Context(), teamID)
		if err != nil {
			writeStoreError(w, err)
			return
		}
		var msg string
		if assignees, msg = cleanAssignees(assignees, members); msg != "" {
			writeError(w, http.StatusBadRequest, msg)
			return
		}
	}
	t, err := a.store.UpdateTeamTask(r.Context(), teamID, cur.ID, f, assignees)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	a.notifyAssigned(r, teamID, cur, t)
	writeJSON(w, http.StatusOK, withPermissions(role, me, t))
}

func (a *API) deleteTeamTask(w http.ResponseWriter, r *http.Request) {
	teamID, role, ok := a.teamRole(w, r, "member")
	if !ok {
		return
	}
	cur, err := a.store.TeamTaskByID(r.Context(), teamID, chi.URLParam(r, "taskID"))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if !canEditTask(role, currentUser(r).ID, cur) {
		writeError(w, http.StatusForbidden, "이 업무를 지울 권한이 없어요")
		return
	}
	if err := a.store.DeleteTeamTask(r.Context(), teamID, cur.ID); err != nil {
		writeStoreError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// notifyAssigned tells people newly put on a task by someone else.
func (a *API) notifyAssigned(r *http.Request, teamID string, before, after store.TeamTask) {
	me := currentUser(r)
	var team store.Team
	for _, x := range after.Assignees {
		if x.UserID == me.ID || isAssigned(x.UserID, before) {
			continue
		}
		if team.ID == "" {
			var err error
			if team, err = a.store.TeamByID(r.Context(), teamID, me.ID); err != nil {
				return
			}
		}
		period := ""
		if p := periodLabel(after); p != "" {
			period = " · " + p
		}
		a.notifyTeam(r.Context(), x.UserID, store.Notification{
			Kind:  "assigned",
			Title: fmt.Sprintf("‘%s’ 담당자가 됐어요", after.Title),
			Body:  fmt.Sprintf("%s · %s 님이 지정%s%s", team.Name, displayName(me.Name, me.Email), period, shareText(x.Boxes)),
			Link:  "/team/" + teamID,
		})
	}
}

func periodLabel(t store.TeamTask) string {
	md := func(iso string) string {
		return strings.TrimLeft(iso[5:7], "0") + "/" + strings.TrimLeft(iso[8:10], "0")
	}
	switch {
	case t.StartDate != nil && t.DueDate != nil:
		return md(*t.StartDate) + "~" + md(*t.DueDate)
	case t.DueDate != nil:
		return "~" + md(*t.DueDate)
	}
	return ""
}

func displayName(name, email string) string {
	if name != "" {
		return name
	}
	return strings.SplitN(email, "@", 2)[0]
}
