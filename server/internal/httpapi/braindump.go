package httpapi

import (
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"box-scheduler/server/internal/store"
)

func (a *API) createBrainDump(w http.ResponseWriter, r *http.Request) {
	var it store.BrainDumpItem
	if !decodeJSON(w, r, &it) {
		return
	}
	it.Title = strings.TrimSpace(it.Title)
	switch {
	case !isDate(it.Date):
		writeError(w, http.StatusBadRequest, "date must be YYYY-MM-DD")
		return
	case it.Title == "":
		writeError(w, http.StatusBadRequest, "title is required")
		return
	}

	created, err := a.store.CreateBrainDump(r.Context(), userID(r), it)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, created)
}

func (a *API) updateBrainDump(w http.ResponseWriter, r *http.Request) {
	var p store.BrainDumpPatch
	if !decodeJSON(w, r, &p) {
		return
	}
	if p.Title != nil {
		t := strings.TrimSpace(*p.Title)
		if t == "" {
			writeError(w, http.StatusBadRequest, "title cannot be empty")
			return
		}
		p.Title = &t
	}

	updated, err := a.store.UpdateBrainDump(r.Context(), userID(r), chi.URLParam(r, "id"), p)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, updated)
}

func (a *API) deleteBrainDump(w http.ResponseWriter, r *http.Request) {
	if err := a.store.DeleteBrainDump(r.Context(), userID(r), chi.URLParam(r, "id")); err != nil {
		writeStoreError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) carryOver(w http.ResponseWriter, r *http.Request) {
	from := chi.URLParam(r, "date")
	var body struct {
		To string `json:"to"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	fromDate, ok := parseDate(from)
	toDate, ok2 := parseDate(body.To)
	if !ok || !ok2 || !toDate.After(fromDate) {
		writeError(w, http.StatusBadRequest, "to must be a YYYY-MM-DD date after the source date")
		return
	}

	items, err := a.store.CarryOver(r.Context(), userID(r), from, body.To)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, items)
}
