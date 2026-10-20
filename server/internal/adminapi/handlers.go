package adminapi

import (
	"crypto/rand"
	"math/big"
	"net/http"
	"net/mail"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"box-scheduler/server/internal/adminstore"
	"box-scheduler/server/internal/auth"
)

const resetTTL = 24 * time.Hour

func pageParams(r *http.Request) (limit, offset int) {
	limit, _ = strconv.Atoi(r.URL.Query().Get("limit"))
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	offset, _ = strconv.Atoi(r.URL.Query().Get("offset"))
	return limit, max(offset, 0)
}

func trimQuery(s string) string {
	s = strings.TrimSpace(s)
	if len(s) > 100 {
		s = s[:100]
	}
	return s
}

func (a *API) dashboard(w http.ResponseWriter, r *http.Request) {
	d, err := a.store.Dashboard(r.Context())
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, d)
}

func (a *API) users(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	limit, offset := pageParams(r)
	list, total, err := a.store.ListUsers(r.Context(), adminstore.UserQuery{
		Q: trimQuery(q.Get("q")), Filter: q.Get("filter"), Sort: q.Get("sort"), Limit: limit, Offset: offset,
	})
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"users": list, "total": total})
}

func (a *API) userDetail(w http.ResponseWriter, r *http.Request) {
	d, err := a.store.UserDetail(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, d)
}

func (a *API) updateUser(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Status string `json:"status"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	if body.Status != "active" && body.Status != "suspended" {
		writeError(w, http.StatusBadRequest, "status must be active or suspended")
		return
	}
	id := chi.URLParam(r, "id")
	u, err := a.store.User(r.Context(), id)
	if err == nil {
		err = a.store.SetUserStatus(r.Context(), id, body.Status)
	}
	if err != nil {
		writeStoreError(w, err)
		return
	}
	a.record(r, map[string]string{"suspended": "user-suspend", "active": "user-restore"}[body.Status], id, u.Email, "")
	u, _ = a.store.User(r.Context(), id)
	writeJSON(w, http.StatusOK, u)
}

func (a *API) deleteUser(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Password string `json:"password"`
	}
	if !decodeJSON(w, r, &body) || !a.reauth(w, r, body.Password) {
		return
	}
	id := chi.URLParam(r, "id")
	u, err := a.store.User(r.Context(), id)
	if err == nil {
		err = a.store.DeleteUser(r.Context(), id)
	}
	if err != nil {
		writeStoreError(w, err)
		return
	}
	a.record(r, "user-delete", id, u.Email, "")
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) revokeSessions(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Session string `json:"session"` // empty: every session
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	id := chi.URLParam(r, "id")
	u, err := a.store.User(r.Context(), id)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	n, err := a.store.RevokeSessions(r.Context(), id, body.Session)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	detail := "모든 기기"
	if body.Session != "" {
		detail = "기기 1개"
	}
	a.record(r, "user-signout", id, u.Email, detail)
	writeJSON(w, http.StatusOK, map[string]int64{"revoked": n})
}

func (a *API) resetLink(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	u, err := a.store.User(r.Context(), id)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	token, hash, err := auth.NewToken()
	if err == nil {
		err = a.store.CreateReset(r.Context(), hash, id, current(r).Email, time.Now().Add(resetTTL))
	}
	if err != nil {
		writeStoreError(w, err)
		return
	}
	a.record(r, "user-reset-link", id, u.Email, "")
	writeJSON(w, http.StatusOK, map[string]string{"url": strings.TrimRight(a.opts.ServiceURL, "/") + "/reset?token=" + token, "expiresIn": "24시간"})
}

func (a *API) addNote(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Body string `json:"body"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	text := strings.TrimSpace(body.Body)
	if text == "" || len([]rune(text)) > 2000 {
		writeError(w, http.StatusBadRequest, "메모는 1~2000자로 적어 주세요")
		return
	}
	id := chi.URLParam(r, "id")
	n, err := a.store.AddNote(r.Context(), id, current(r).Email, text)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, n)
}

func (a *API) audit(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	limit, offset := pageParams(r)
	list, total, err := a.store.ListAudit(r.Context(), trimQuery(q.Get("q")), q.Get("action"), q.Get("target"), limit, offset)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"entries": list, "total": total})
}

// ---- admin accounts (super only) ----

func (a *API) admins(w http.ResponseWriter, r *http.Request) {
	list, err := a.store.ListAccounts(r.Context())
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"admins": list})
}

// TempPassword is a random 16-character password shown once to whoever creates or resets an admin.
func TempPassword() string {
	const chars = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"
	b := make([]byte, 16)
	for i := range b {
		n, _ := rand.Int(rand.Reader, big.NewInt(int64(len(chars))))
		b[i] = chars[n.Int64()]
	}
	return string(b)
}

func validRole(role string) bool { return role == "super" || role == "operator" }

func (a *API) createAdmin(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Email    string `json:"email"`
		Name     string `json:"name"`
		Role     string `json:"role"`
		Password string `json:"password"` // the creating admin's, re-checked
	}
	if !decodeJSON(w, r, &body) || !a.reauth(w, r, body.Password) {
		return
	}
	addr, err := mail.ParseAddress(strings.TrimSpace(body.Email))
	if err != nil || !validRole(body.Role) || len([]rune(body.Name)) > 40 {
		writeError(w, http.StatusBadRequest, "이메일, 이름(40자 이내), 역할을 확인해 주세요")
		return
	}
	temp := TempPassword()
	hash, err := auth.HashPassword(temp)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	acc, err := a.store.CreateAccount(r.Context(), addr.Address, strings.TrimSpace(body.Name), body.Role, hash)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	a.record(r, "admin-create", acc.ID, acc.Email, acc.Role)
	writeJSON(w, http.StatusCreated, map[string]any{"admin": acc, "tempPassword": temp})
}

func (a *API) updateAdmin(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Role     *string `json:"role"`
		Status   *string `json:"status"`
		Password string  `json:"password"`
	}
	if !decodeJSON(w, r, &body) || !a.reauth(w, r, body.Password) {
		return
	}
	id := chi.URLParam(r, "id")
	if id == current(r).ID {
		writeError(w, http.StatusBadRequest, "내 계정의 역할이나 상태는 여기서 바꿀 수 없어요")
		return
	}
	if (body.Role != nil && !validRole(*body.Role)) || (body.Status != nil && *body.Status != "active" && *body.Status != "disabled") {
		writeError(w, http.StatusBadRequest, "role or status is not valid")
		return
	}
	before, err := a.store.AccountByID(r.Context(), id)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	acc, err := a.store.SetAccount(r.Context(), id, body.Role, body.Status)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if n, err := a.store.CountActiveSupers(r.Context()); err == nil && n == 0 {
		// Never leave the console without an active super admin: undo.
		_, _ = a.store.SetAccount(r.Context(), id, &before.Role, &before.Status)
		writeError(w, http.StatusBadRequest, "최고 관리자가 한 명은 남아 있어야 해요")
		return
	}
	a.record(r, "admin-update", id, acc.Email, before.Role+"/"+before.Status+" → "+acc.Role+"/"+acc.Status)
	writeJSON(w, http.StatusOK, acc)
}

// resetAdmin gives an admin a temporary password and clears their two-factor.
func (a *API) resetAdmin(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Password string `json:"password"`
	}
	if !decodeJSON(w, r, &body) || !a.reauth(w, r, body.Password) {
		return
	}
	id := chi.URLParam(r, "id")
	if id == current(r).ID {
		writeError(w, http.StatusBadRequest, "내 계정은 내 정보에서 비밀번호를 바꿔 주세요")
		return
	}
	acc, err := a.store.AccountByID(r.Context(), id)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	temp := TempPassword()
	hash, err := auth.HashPassword(temp)
	if err == nil {
		err = a.store.ResetAccess(r.Context(), id, hash)
	}
	if err != nil {
		writeStoreError(w, err)
		return
	}
	a.record(r, "admin-reset", id, acc.Email, "")
	writeJSON(w, http.StatusOK, map[string]string{"tempPassword": temp})
}
