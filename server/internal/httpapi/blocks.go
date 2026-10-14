package httpapi

import (
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"box-scheduler/server/internal/store"
)

func (a *API) createBlock(w http.ResponseWriter, r *http.Request) {
	var b store.Block
	if !decodeJSON(w, r, &b) {
		return
	}
	b.Title = strings.TrimSpace(b.Title)
	switch {
	case !isDate(b.Date):
		writeError(w, http.StatusBadRequest, "date must be YYYY-MM-DD")
		return
	case !validSlots(b.StartSlot, b.EndSlot):
		writeError(w, http.StatusBadRequest, "slots must satisfy 0 <= startSlot < endSlot <= 144")
		return
	case b.Title == "":
		writeError(w, http.StatusBadRequest, "title is required")
		return
	}

	created, err := a.store.CreateBlock(r.Context(), userID(r), b)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, created)
}

func (a *API) updateBlock(w http.ResponseWriter, r *http.Request) {
	var p store.BlockPatch
	if !decodeJSON(w, r, &p) {
		return
	}
	if p.Date != nil && !isDate(*p.Date) {
		writeError(w, http.StatusBadRequest, "date must be YYYY-MM-DD")
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
	// Partial slot updates are range-checked by the DB constraints against the stored values.

	updated, err := a.store.UpdateBlock(r.Context(), userID(r), chi.URLParam(r, "id"), p)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, updated)
}

func (a *API) deleteBlock(w http.ResponseWriter, r *http.Request) {
	if err := a.store.DeleteBlock(r.Context(), userID(r), chi.URLParam(r, "id")); err != nil {
		writeStoreError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func isDate(s string) bool {
	_, ok := parseDate(s)
	return ok
}
