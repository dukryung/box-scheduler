package httpapi

import (
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"box-scheduler/server/internal/store"
)

// listTasks returns the backlog ("할 일 보관함") with each item's scheduled/done time.
func (a *API) listTasks(w http.ResponseWriter, r *http.Request) {
	items, err := a.store.ListBacklog(r.Context(), userID(r))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (a *API) createTask(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Title         string  `json:"title"`
		EstimateBoxes *int    `json:"estimateBoxes"`
		DueDate       *string `json:"dueDate"`
		Priority      *int    `json:"priority"`
		Note          *string `json:"note"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	title := strings.TrimSpace(body.Title)
	if title == "" {
		writeError(w, http.StatusBadRequest, "title is required")
		return
	}
	if msg := validateTaskFields(body.DueDate, body.Priority, true); msg != "" {
		writeError(w, http.StatusBadRequest, msg)
		return
	}
	created, err := a.store.CreateBrainDump(r.Context(), userID(r), store.BrainDumpItem{
		Title: title, EstimateBoxes: body.EstimateBoxes, DueDate: body.DueDate, Priority: body.Priority, Note: body.Note,
	})
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, store.BacklogItem{BrainDumpItem: created})
}

// moveBrainDump puts an item on a day ({"date": "YYYY-MM-DD"}) or into the backlog ({"date": null}).
func (a *API) moveBrainDump(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Date *string `json:"date"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	if body.Date != nil && !isDate(*body.Date) {
		writeError(w, http.StatusBadRequest, "date must be YYYY-MM-DD or null")
		return
	}
	moved, err := a.store.MoveBrainDump(r.Context(), userID(r), chi.URLParam(r, "id"), body.Date)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, moved)
}

// validateTaskFields checks a due date (empty clears it when allowed) and a 1–3 priority.
func validateTaskFields(due *string, priority *int, creating bool) string {
	if due != nil && !isDate(*due) && !(*due == "" && !creating) {
		return "dueDate must be YYYY-MM-DD"
	}
	if priority != nil && (*priority < 1 || *priority > 3) {
		return "priority must be 1 (high), 2 (normal), or 3 (low)"
	}
	return ""
}
