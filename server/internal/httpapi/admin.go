package httpapi

import (
	"crypto/subtle"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"box-scheduler/server/internal/auth"
	"box-scheduler/server/internal/store"
)

func constantEq(a, b string) bool { return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1 }

// Admins see account facts and counts; schedule contents stay private.
func (a *API) adminUsers(w http.ResponseWriter, r *http.Request) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if len(q) > 100 {
		q = q[:100]
	}
	users, err := a.store.ListUsers(r.Context(), q)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"users": users})
}

func (a *API) adminStats(w http.ResponseWriter, r *http.Request) {
	st, err := a.store.AdminStats(r.Context())
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, st)
}

func (a *API) adminAudit(w http.ResponseWriter, r *http.Request) {
	list, err := a.store.ListAudit(r.Context(), 100)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"entries": list})
}

// target loads the account an admin is acting on, refusing the owner and oneself.
func (a *API) adminTarget(w http.ResponseWriter, r *http.Request) (store.User, bool) {
	id := chi.URLParam(r, "id")
	t, err := a.store.AdminUserByID(r.Context(), id)
	if err != nil {
		writeStoreError(w, err)
		return store.User{}, false
	}
	switch {
	case t.IsOwner:
		writeError(w, http.StatusBadRequest, "소유자 계정은 바꿀 수 없어요")
		return store.User{}, false
	case t.ID == currentUser(r).ID:
		writeError(w, http.StatusBadRequest, "내 계정은 여기서 바꿀 수 없어요")
		return store.User{}, false
	}
	return t, true
}

func (a *API) adminUpdateUser(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Role   *string `json:"role"`
		Status *string `json:"status"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	t, ok := a.adminTarget(w, r)
	if !ok {
		return
	}
	me := currentUser(r)
	if body.Role != nil {
		if *body.Role != "user" && *body.Role != "admin" {
			writeError(w, http.StatusBadRequest, "role must be user or admin")
			return
		}
		u, err := a.store.SetRole(r.Context(), t.ID, *body.Role)
		if err != nil {
			writeStoreError(w, err)
			return
		}
		_ = a.store.Audit(r.Context(), me.ID, "role", t.ID, t.Email, t.Role+" → "+u.Role)
		t = u
	}
	if body.Status != nil {
		if *body.Status != "active" && *body.Status != "suspended" {
			writeError(w, http.StatusBadRequest, "status must be active or suspended")
			return
		}
		u, err := a.store.SetStatus(r.Context(), t.ID, *body.Status)
		if err != nil {
			writeStoreError(w, err)
			return
		}
		action := map[string]string{"suspended": "suspend", "active": "restore"}[u.Status]
		_ = a.store.Audit(r.Context(), me.ID, action, t.ID, t.Email, "")
		t = u
	}
	writeJSON(w, http.StatusOK, t)
}

func (a *API) adminDeleteUser(w http.ResponseWriter, r *http.Request) {
	t, ok := a.adminTarget(w, r)
	if !ok {
		return
	}
	if err := a.store.DeleteUser(r.Context(), t.ID); err != nil {
		writeStoreError(w, err)
		return
	}
	_ = a.store.Audit(r.Context(), currentUser(r).ID, "delete", t.ID, t.Email, "")
	w.WriteHeader(http.StatusNoContent)
}

// adminResetLink issues a one-time password link (valid 24 hours) for the admin to pass on.
func (a *API) adminResetLink(w http.ResponseWriter, r *http.Request) {
	t, ok := a.adminTarget(w, r)
	if !ok {
		return
	}
	token, hash, err := auth.NewToken()
	if err == nil {
		err = a.store.CreateReset(r.Context(), hash, t.ID, currentUser(r).ID, time.Now().Add(resetTTL))
	}
	if errors.Is(err, store.ErrNotFound) || err != nil {
		writeStoreError(w, err)
		return
	}
	_ = a.store.Audit(r.Context(), currentUser(r).ID, "reset-link", t.ID, t.Email, "")
	writeJSON(w, http.StatusOK, map[string]string{"path": "/reset?token=" + token, "expiresIn": "24시간"})
}
