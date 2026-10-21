package httpapi

import (
	"fmt"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"

	"box-scheduler/server/internal/breakdown"
	"box-scheduler/server/internal/store"
)

// Splitting a team task ("AI로 업무 나누기"): the whole task is split once into
// subtasks the team can see, each given to one of the task's people (proposed
// to fit their shares, then edited). On confirming, each person's subtasks are
// spread over their own working days into their Brain Dump. The task's
// creator, its assignees, and managers and the owner may do it. Splitting again
// replaces only the subtasks nobody has started.

const maxTeamSubtasks = 20

type planBody struct {
	Today    string    `json:"today"`
	Now      string    `json:"now"`
	Subtasks []planSub `json:"subtasks"`
}

type planSub struct {
	Title      string `json:"title"`
	Boxes      int    `json:"boxes"`
	AssigneeID string `json:"assigneeId"` // "": no one yet
	Reason     string `json:"reason,omitempty"`
}

// planPerson is one assignee's side of the plan.
type planPerson struct {
	UserID   string `json:"userId"`
	Name     string `json:"name"`
	Share    int    `json:"share"`    // boxes meant for them (0: not set)
	Kept     int    `json:"kept"`     // in subtasks already started
	New      int    `json:"new"`      // in the subtasks being planned
	Days     int    `json:"days"`     // working days the new pieces land on
	From     string `json:"from"`     // first of those days
	To       string `json:"to"`       // last of those days
	Shortage int    `json:"shortage"` // did not fit before the due date

	idx  []int // the plan's subtasks that are theirs
	plan breakdown.Result
}

type planResponse struct {
	Subtasks []planSub           `json:"subtasks"`
	Kept     []store.TeamSubtask `json:"kept"`
	People   []planPerson        `json:"people"`
	Notes    string              `json:"notes,omitempty"`
	Period   breakdownPeriod     `json:"period"`
	Policy   breakdownPolicy     `json:"policy"`
}

type teamPlan struct {
	role      string
	task      store.TeamTask
	body      planBody
	kept      []store.TeamSubtask
	replacing []string
	period    breakdownPeriod
}

func canPlanTask(role, userID string, t store.TeamTask) bool {
	return canEditTask(role, userID, t) || isAssigned(userID, t)
}

func (a *API) loadTeamPlan(w http.ResponseWriter, r *http.Request) (teamPlan, bool) {
	var tp teamPlan
	if !decodeJSON(w, r, &tp.body) {
		return tp, false
	}
	teamID, role, ok := a.teamRole(w, r, "member")
	if !ok {
		return tp, false
	}
	task, err := a.store.TeamTaskByID(r.Context(), teamID, chi.URLParam(r, "taskID"))
	if err != nil {
		writeStoreError(w, err)
		return tp, false
	}
	if !canPlanTask(role, currentUser(r).ID, task) {
		writeError(w, http.StatusForbidden, "업무를 만든 사람과 담당자만 업무를 나눌 수 있어요")
		return tp, false
	}
	if task.DueDate == nil {
		writeError(w, http.StatusBadRequest, "팀 업무에 마감일을 먼저 정해 주세요")
		return tp, false
	}
	if len(task.Assignees) == 0 {
		writeError(w, http.StatusBadRequest, "담당자를 먼저 정해 주세요")
		return tp, false
	}
	if _, ok := parseDate(tp.body.Today); !ok {
		writeError(w, http.StatusBadRequest, "today must be YYYY-MM-DD")
		return tp, false
	}
	// Work starts no earlier than the task does.
	if task.StartDate != nil && tp.body.Today < *task.StartDate {
		tp.body.Today, tp.body.Now = *task.StartDate, ""
	}
	dates := breakdown.WorkingDays(tp.body.Today, *task.DueDate)
	if len(dates) == 0 {
		writeError(w, http.StatusBadRequest, "마감일까지 남은 근무일(월~금)이 없어요. 마감일을 바꿔 주세요")
		return tp, false
	}
	tp.period = breakdownPeriod{From: dates[0], To: dates[len(dates)-1], WorkingDays: len(dates)}
	for _, x := range task.Subtasks {
		if x.Started {
			tp.kept = append(tp.kept, x)
		} else {
			tp.replacing = append(tp.replacing, x.ID)
		}
	}
	if tp.kept == nil {
		tp.kept = []store.TeamSubtask{}
	}
	tp.role, tp.task = role, task
	return tp, true
}

// shares are what each assignee is meant to take: their own share, else an
// even part of the estimate (0 when neither is known).
func (tp teamPlan) shares() []breakdown.Share {
	out := []breakdown.Share{}
	for _, x := range tp.task.Assignees {
		s := breakdown.Share{UserID: x.UserID}
		if x.Boxes != nil {
			s.Boxes = *x.Boxes
		} else if tp.task.EstimateBoxes != nil {
			s.Boxes = *tp.task.EstimateBoxes / len(tp.task.Assignees)
		}
		out = append(out, s)
	}
	return out
}

func (tp teamPlan) keptBy() map[string]int {
	m := map[string]int{}
	for _, x := range tp.kept {
		if x.AssigneeID != "" {
			m[x.AssigneeID] += x.Boxes
		}
	}
	return m
}

// cleanPlan trims the subtasks and checks each is given to one of the task's people.
func (tp teamPlan) cleanPlan(w http.ResponseWriter, in []planSub) ([]planSub, bool) {
	out := []planSub{}
	for _, x := range in {
		subs := cleanSubs(tp.task.Title, []breakdown.Sub{{Title: x.Title, Boxes: x.Boxes}})
		if len(subs) == 0 {
			continue
		}
		if x.AssigneeID != "" && !isAssigned(x.AssigneeID, tp.task) {
			writeError(w, http.StatusBadRequest, "하위 업무는 이 업무의 담당자에게만 줄 수 있어요")
			return nil, false
		}
		reason := x.Reason
		if utf8.RuneCountInString(reason) > 200 {
			reason = string([]rune(reason)[:200])
		}
		out = append(out, planSub{Title: subs[0].Title, Boxes: subs[0].Boxes, AssigneeID: x.AssigneeID, Reason: reason})
		if len(out) == maxTeamSubtasks {
			break
		}
	}
	return out, true
}

// people spreads each assignee's subtasks over their own free working days.
func (a *API) planPeople(w http.ResponseWriter, r *http.Request, tp teamPlan, subs []planSub) ([]planPerson, bool) {
	shares := map[string]int{}
	for _, s := range tp.shares() {
		shares[s.UserID] = s.Boxes
	}
	kept := tp.keptBy()
	people := []planPerson{}
	for _, x := range tp.task.Assignees {
		p := planPerson{UserID: x.UserID, Name: displayName(x.Name, x.Email), Share: shares[x.UserID], Kept: kept[x.UserID]}
		mine := []breakdown.Sub{}
		for i, s := range subs {
			if s.AssigneeID == x.UserID {
				p.idx = append(p.idx, i)
				p.New += s.Boxes
				mine = append(mine, breakdown.Sub{Title: s.Title, Boxes: s.Boxes})
			}
		}
		if len(mine) > 0 {
			linked, err := a.store.TeamTaskItem(r.Context(), x.UserID, tp.task.ID)
			if err != nil {
				writeStoreError(w, err)
				return nil, false
			}
			days, _, _, ok := a.breakdownDays(w, r, x.UserID, breakdownBody{Today: tp.body.Today, Now: tp.body.Now}, *tp.task.DueDate, linked, tp.replacing)
			if !ok {
				return nil, false
			}
			p.plan = breakdown.Allocate(mine, days, breakdown.Default)
			p.Shortage = p.plan.Shortage
			for _, d := range p.plan.Days {
				if d.Total > 0 {
					if p.From == "" {
						p.From = d.Date
					}
					p.To = d.Date
					p.Days++
				}
			}
		}
		people = append(people, p)
	}
	return people, true
}

func (a *API) respondPlan(w http.ResponseWriter, r *http.Request, tp teamPlan, subs []planSub, notes string) {
	people, ok := a.planPeople(w, r, tp, subs)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, planResponse{Subtasks: subs, Kept: tp.kept, People: people, Notes: notes, Period: tp.period, Policy: policyView()})
}

// teamPlanSuggest asks the AI to split what is left of the task and proposes who takes each part.
func (a *API) teamPlanSuggest(w http.ResponseWriter, r *http.Request) {
	tp, ok := a.loadTeamPlan(w, r)
	if !ok {
		return
	}
	total := 0
	if tp.task.EstimateBoxes != nil {
		total = *tp.task.EstimateBoxes
	} else {
		for _, s := range tp.shares() {
			total += s.Boxes
		}
	}
	note := tp.task.Note
	if len(tp.kept) > 0 {
		done := []string{}
		for _, x := range tp.kept {
			done = append(done, x.Title)
			total -= x.Boxes
		}
		note = strings.TrimSpace(note + "\n이미 진행 중이거나 끝난 하위 업무(다시 넣지 마세요): " + strings.Join(done, ", "))
	}
	subs, reasons, notes, ok := a.suggestSubs(w, r, tp.task.Title, note, tp.body.Today, tp.period, max(total, 0))
	if !ok {
		return
	}
	owners := breakdown.Assign(subs, tp.shares(), tp.keptBy())
	plan := make([]planSub, len(subs))
	for i, s := range subs {
		plan[i] = planSub{Title: s.Title, Boxes: s.Boxes, AssigneeID: owners[i]}
		if i < len(reasons) {
			plan[i].Reason = reasons[i]
		}
	}
	a.respondPlan(w, r, tp, plan, notes)
}

// teamPlanPreview re-spreads an edited plan (no AI).
func (a *API) teamPlanPreview(w http.ResponseWriter, r *http.Request) {
	tp, ok := a.loadTeamPlan(w, r)
	if !ok {
		return
	}
	subs, ok := tp.cleanPlan(w, tp.body.Subtasks)
	if !ok {
		return
	}
	a.respondPlan(w, r, tp, subs, "")
}

// teamPlanApply saves the subtasks and puts each person's pieces in their Brain Dump.
func (a *API) teamPlanApply(w http.ResponseWriter, r *http.Request) {
	tp, ok := a.loadTeamPlan(w, r)
	if !ok {
		return
	}
	subs, ok := tp.cleanPlan(w, tp.body.Subtasks)
	if !ok {
		return
	}
	people, ok := a.planPeople(w, r, tp, subs)
	if !ok {
		return
	}
	saved := make([]store.NewSubtask, len(subs))
	for i, s := range subs {
		saved[i] = store.NewSubtask{Title: s.Title, Boxes: s.Boxes, AssigneeID: s.AssigneeID}
	}
	shares := map[string]int{}
	for _, p := range people {
		shares[p.UserID] = p.Share
		if p.Share == 0 {
			shares[p.UserID] = p.Kept + p.New
		}
		for _, d := range p.plan.Days {
			for _, piece := range d.Pieces {
				k := p.idx[piece.Sub]
				saved[k].Pieces = append(saved[k].Pieces, store.NewPiece{Date: d.Date, Title: chunkTitle(tp.task.Title, subs[k].Title, 2), Boxes: piece.Boxes})
			}
		}
	}
	created, err := a.store.ReplaceSubtasks(r.Context(), tp.task, saved, shares)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	teamID := chi.URLParam(r, "teamID")
	task, err := a.store.TeamTaskByID(r.Context(), teamID, tp.task.ID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	me := currentUser(r)
	for _, p := range people {
		if p.UserID == me.ID || len(p.idx) == 0 {
			continue
		}
		titles := []string{}
		for _, k := range p.idx {
			titles = append(titles, subs[k].Title)
		}
		list := strings.Join(titles, ", ")
		if utf8.RuneCountInString(list) > 60 {
			list = string([]rune(list)[:60]) + "…"
		}
		when := ""
		if p.From != "" {
			when = " · " + strings.TrimLeft(p.From[5:7], "0") + "/" + strings.TrimLeft(p.From[8:10], "0") + "부터"
		}
		a.notifyTeam(r.Context(), p.UserID, store.Notification{
			Kind:  "subtasks",
			Title: fmt.Sprintf("‘%s’ 하위 업무 %d개를 맡았어요", tp.task.Title, len(p.idx)),
			Body:  fmt.Sprintf("%s 님이 업무를 나눔 · %s%s", displayName(me.Name, me.Email), list, when),
			Link:  "/team/" + teamID,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"created": created, "people": people, "task": withPermissions(tp.role, me.ID, task)})
}
