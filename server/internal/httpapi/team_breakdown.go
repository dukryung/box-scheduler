package httpapi

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"box-scheduler/server/internal/breakdown"
	"box-scheduler/server/internal/store"
)

// AI로 세분화 for a team task: one assignee's share is split into daily pieces
// within the task's period and put in that person's Brain Dump, under an item
// in their backlog that stands for the task. Assignees do it for themselves;
// managers and the owner may do it for anyone on the task.

type teamBreakdownBody struct {
	breakdownBody
	UserID string `json:"userId"` // whose share; empty = the caller's
}

type teamBreakdown struct {
	role   string
	task   store.TeamTask
	userID string
	share  int // boxes; 0 when neither a share nor an estimate is set
	linked string
	days   []breakdown.Day
	period breakdownPeriod
	exist  int
}

func (a *API) loadTeamBreakdown(w http.ResponseWriter, r *http.Request, body teamBreakdownBody) (teamBreakdown, bool) {
	var tb teamBreakdown
	teamID, role, ok := a.teamRole(w, r, "member")
	if !ok {
		return tb, false
	}
	task, err := a.store.TeamTaskByID(r.Context(), teamID, chi.URLParam(r, "taskID"))
	if err != nil {
		writeStoreError(w, err)
		return tb, false
	}
	me := currentUser(r).ID
	target := body.UserID
	if target == "" {
		target = me
	}
	var assignee *store.TaskAssignee
	for i := range task.Assignees {
		if task.Assignees[i].UserID == target {
			assignee = &task.Assignees[i]
		}
	}
	if assignee == nil {
		writeError(w, http.StatusBadRequest, "이 업무의 담당자에게만 세분화할 수 있어요")
		return tb, false
	}
	if target != me && store.RoleRank(role) < store.RoleRank("manager") {
		writeError(w, http.StatusForbidden, "다른 사람 몫은 매니저 이상만 세분화할 수 있어요")
		return tb, false
	}
	if task.DueDate == nil {
		writeError(w, http.StatusBadRequest, "팀 업무에 마감일을 먼저 정해 주세요")
		return tb, false
	}
	share := 0
	if assignee.Boxes != nil {
		share = *assignee.Boxes
	} else if task.EstimateBoxes != nil {
		share = *task.EstimateBoxes / len(task.Assignees)
	}
	linked, err := a.store.TeamTaskItem(r.Context(), target, task.ID)
	if err != nil {
		writeStoreError(w, err)
		return tb, false
	}
	// Work starts no earlier than the task does.
	if task.StartDate != nil && body.Today < *task.StartDate {
		body.Today, body.Now = *task.StartDate, ""
	}
	days, period, exist, ok := a.breakdownDays(w, r, target, body.breakdownBody, *task.DueDate, linked)
	if !ok {
		return tb, false
	}
	return teamBreakdown{role, task, target, share, linked, days, period, exist}, true
}

// item presents the share as the backlog item it becomes, for the dialog.
func (tb teamBreakdown) item() store.BrainDumpItem {
	it := store.BrainDumpItem{ID: tb.linked, Title: tb.task.Title, Status: "open", DueDate: tb.task.DueDate}
	if tb.share > 0 {
		share := tb.share
		it.EstimateBoxes = &share
	}
	if tb.task.Note != "" {
		it.Note = &tb.task.Note
	}
	return it
}

func (a *API) teamBreakdownSuggest(w http.ResponseWriter, r *http.Request) {
	var body teamBreakdownBody
	if !decodeJSON(w, r, &body) {
		return
	}
	tb, ok := a.loadTeamBreakdown(w, r, body)
	if !ok {
		return
	}
	subs, reasons, notes, ok := a.suggestSubs(w, r, tb.task.Title, tb.task.Note, body.Today, tb.period, tb.share)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, breakdownResponse{
		Item: tb.item(), Subtasks: subs, Reasons: reasons, Notes: notes,
		Plan: breakdown.Allocate(subs, tb.days, breakdown.Default), Period: tb.period, Policy: policyView(), Existing: tb.exist,
	})
}

func (a *API) teamBreakdownAllocate(w http.ResponseWriter, r *http.Request) {
	var body teamBreakdownBody
	if !decodeJSON(w, r, &body) {
		return
	}
	tb, ok := a.loadTeamBreakdown(w, r, body)
	if !ok {
		return
	}
	subs := cleanSubs(tb.task.Title, body.Subtasks)
	writeJSON(w, http.StatusOK, breakdownResponse{
		Item: tb.item(), Subtasks: subs, Plan: breakdown.Allocate(subs, tb.days, breakdown.Default), Period: tb.period, Policy: policyView(), Existing: tb.exist,
	})
}

func (a *API) teamBreakdownApply(w http.ResponseWriter, r *http.Request) {
	var body teamBreakdownBody
	if !decodeJSON(w, r, &body) {
		return
	}
	tb, ok := a.loadTeamBreakdown(w, r, body)
	if !ok {
		return
	}
	subs := cleanSubs(tb.task.Title, body.Subtasks)
	if len(subs) == 0 {
		writeError(w, http.StatusBadRequest, "넣을 일이 없어요")
		return
	}
	total := 0
	for _, s := range subs {
		total += s.Boxes
	}
	share := tb.share
	if share == 0 {
		share = total
	}
	itemID, err := a.store.LinkTeamTaskItem(r.Context(), tb.userID, tb.task, share)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	plan := breakdown.Allocate(subs, tb.days, breakdown.Default)
	created, removed, err := a.store.AddPieces(r.Context(), tb.userID, itemID, piecesFor(tb.task.Title, plan), body.Replace, nil, total)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	task, err := a.store.TeamTaskByID(r.Context(), chi.URLParam(r, "teamID"), tb.task.ID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"created": created, "removed": removed, "shortage": plan.Shortage, "plan": plan,
		"task": withPermissions(tb.role, currentUser(r).ID, task),
	})
}
