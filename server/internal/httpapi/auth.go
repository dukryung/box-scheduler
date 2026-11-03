package httpapi

import (
	"context"
	"crypto/subtle"
	"errors"
	"log/slog"
	"net/http"
	"net/mail"
	"strings"
	"time"

	"box-scheduler/server/internal/auth"
	"box-scheduler/server/internal/store"
)

const (
	sessionCookie = "bs_session"
	sessionTTL    = 30 * 24 * time.Hour
	resetTTL      = 24 * time.Hour
	maxNameLen    = 40
)

var errBadLogin = "이메일 또는 비밀번호가 맞지 않아요"

func currentUser(r *http.Request) store.User {
	return r.Context().Value(userKey).(store.User)
}

func normEmail(s string) (string, bool) {
	s = strings.ToLower(strings.TrimSpace(s))
	addr, err := mail.ParseAddress(s)
	if err != nil || addr.Address != s || len(s) > 254 || !strings.Contains(s[strings.LastIndex(s, "@"):], ".") {
		return "", false
	}
	return s, true
}

func cleanName(s string) (string, bool) {
	s = strings.TrimSpace(s)
	return s, len([]rune(s)) <= maxNameLen
}

// clientIP is the address chi's RealIP middleware settled on.
func clientIP(r *http.Request) string {
	host := r.RemoteAddr
	if i := strings.LastIndex(host, ":"); i > 0 {
		host = host[:i]
	}
	return host
}

func (a *API) secureCookie(r *http.Request) bool {
	return a.opts.CookieSecure || r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https"
}

// startSession creates a session for u and sets its cookie.
func (a *API) startSession(w http.ResponseWriter, r *http.Request, u store.User) error {
	token, hash, err := auth.NewToken()
	if err != nil {
		return err
	}
	ua := r.UserAgent()
	if len(ua) > 300 {
		ua = ua[:300]
	}
	if err := a.store.CreateSession(r.Context(), hash, u.ID, ua, time.Now().Add(sessionTTL)); err != nil {
		return err
	}
	_ = a.store.TouchLogin(r.Context(), u.ID)
	http.SetCookie(w, &http.Cookie{
		Name: sessionCookie, Value: token, Path: "/", MaxAge: int(sessionTTL.Seconds()),
		HttpOnly: true, Secure: a.secureCookie(r), SameSite: http.SameSiteLaxMode,
	})
	return nil
}

func (a *API) clearCookie(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{Name: sessionCookie, Value: "", Path: "/", MaxAge: -1, HttpOnly: true, Secure: a.secureCookie(r), SameSite: http.SameSiteLaxMode})
}

func sessionHash(r *http.Request) []byte {
	c, err := r.Cookie(sessionCookie)
	if err != nil || c.Value == "" || len(c.Value) > 100 {
		return nil
	}
	return auth.HashToken(c.Value)
}

// requireUser loads the signed-in user from the session cookie or answers 401.
func (a *API) requireUser(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hash := sessionHash(r)
		if hash == nil {
			writeError(w, http.StatusUnauthorized, "로그인이 필요해요")
			return
		}
		u, err := a.store.SessionUser(r.Context(), hash, sessionTTL)
		if errors.Is(err, store.ErrNotFound) {
			a.clearCookie(w, r)
			writeError(w, http.StatusUnauthorized, "로그인이 필요해요")
			return
		}
		if err != nil {
			writeStoreError(w, err)
			return
		}
		if u.Status != "active" {
			_ = a.store.DeleteSession(r.Context(), hash)
			a.clearCookie(w, r)
			writeError(w, http.StatusForbidden, "이용이 정지된 계정이에요")
			return
		}
		a.markActive(r, u.ID)
		ctx := context.WithValue(r.Context(), userKey, u)
		ctx = context.WithValue(ctx, userIDKey, u.ID)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func constantEq(a, b string) bool { return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1 }

// markActive records the account's use once a day, for the admin dashboard.
func (a *API) markActive(r *http.Request, userID string) {
	today := time.Now().Format(dateLayout)
	if prev, ok := a.active.Load(userID); ok && prev == today {
		return
	}
	if err := a.store.MarkActive(r.Context(), userID); err == nil {
		a.active.Store(userID, today)
	}
}

// sameOrigin blocks cross-site writes: browsers mark them with Sec-Fetch-Site, and
// a plain cross-site form cannot send the JSON content type every write here needs.
func sameOrigin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet, http.MethodHead, http.MethodOptions:
		default:
			if r.Header.Get("Sec-Fetch-Site") == "cross-site" || !allowedBody(r) {
				writeError(w, http.StatusForbidden, "허용되지 않은 요청이에요")
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

// allowedBody accepts JSON, and raw bytes for a recording piece. Neither can be
// sent by another site's form: a page elsewhere would need a CORS preflight,
// which this server never answers.
func allowedBody(r *http.Request) bool {
	ct := r.Header.Get("Content-Type")
	if strings.HasPrefix(ct, "application/json") {
		return true
	}
	return ct == "application/octet-stream" && r.Method == http.MethodPost && strings.Contains(r.URL.Path, "/audio/") && strings.Contains(r.URL.Path, "/chunks/")
}

type credentials struct {
	Email    string `json:"email"`
	Password string `json:"password"`
	Name     string `json:"name"`
	Token    string `json:"token"`
}

func (a *API) signup(w http.ResponseWriter, r *http.Request) {
	var c credentials
	if !decodeJSON(w, r, &c) {
		return
	}
	if !a.signupLimit.Allow(clientIP(r)) {
		writeError(w, http.StatusTooManyRequests, "가입 시도가 너무 많아요. 잠시 후 다시 해 주세요")
		return
	}
	email, ok := normEmail(c.Email)
	if !ok {
		writeError(w, http.StatusBadRequest, "이메일 주소를 확인해 주세요")
		return
	}
	name, ok := cleanName(c.Name)
	if !ok {
		writeError(w, http.StatusBadRequest, "이름은 40자 이내로 적어 주세요")
		return
	}
	if err := auth.ValidPassword(c.Password); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	hash, err := auth.HashPassword(c.Password)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	u, err := a.store.CreateUser(r.Context(), email, name, hash)
	if errors.Is(err, store.ErrTaken) {
		writeError(w, http.StatusConflict, "이미 가입된 이메일이에요")
		return
	}
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if err := a.startSession(w, r, u); err != nil {
		writeStoreError(w, err)
		return
	}
	slog.Info("signup", "user", u.ID)
	writeJSON(w, http.StatusCreated, u)
}

func (a *API) login(w http.ResponseWriter, r *http.Request) {
	var c credentials
	if !decodeJSON(w, r, &c) {
		return
	}
	email := strings.ToLower(strings.TrimSpace(c.Email))
	ipKey, emailKey := "ip:"+clientIP(r), "email:"+email
	if !a.loginIPLimit.Allow(ipKey) || !a.loginLimit.Allow(emailKey) {
		writeError(w, http.StatusTooManyRequests, "로그인 시도가 너무 많아요. 15분 뒤에 다시 해 주세요")
		return
	}
	u, hash, err := a.store.UserByEmail(r.Context(), email)
	if errors.Is(err, store.ErrNotFound) || (err == nil && hash == "") {
		auth.BurnTime(c.Password)
		writeError(w, http.StatusUnauthorized, errBadLogin)
		return
	}
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if !auth.CheckPassword(hash, c.Password) {
		writeError(w, http.StatusUnauthorized, errBadLogin)
		return
	}
	if u.Status != "active" {
		writeError(w, http.StatusForbidden, "이용이 정지된 계정이에요")
		return
	}
	a.loginLimit.Reset(emailKey)
	if err := a.startSession(w, r, u); err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, u)
}

func (a *API) logout(w http.ResponseWriter, r *http.Request) {
	if hash := sessionHash(r); hash != nil {
		_ = a.store.DeleteSession(r.Context(), hash)
	}
	a.clearCookie(w, r)
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) me(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, currentUser(r))
}

func (a *API) updateMe(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name string `json:"name"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	name, ok := cleanName(body.Name)
	if !ok {
		writeError(w, http.StatusBadRequest, "이름은 40자 이내로 적어 주세요")
		return
	}
	u, err := a.store.SetName(r.Context(), currentUser(r).ID, name)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, u)
}

// changePassword needs the current password (unless the account has none yet, e.g.
// signed up with Google) and signs out the account's other sessions.
func (a *API) changePassword(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Current string `json:"current"`
		New     string `json:"new"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	u := currentUser(r)
	if !a.loginLimit.Allow("pw:" + u.ID) {
		writeError(w, http.StatusTooManyRequests, "시도가 너무 많아요. 잠시 후 다시 해 주세요")
		return
	}
	hash, err := a.store.PasswordHash(r.Context(), u.ID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if hash != "" && !auth.CheckPassword(hash, body.Current) {
		writeError(w, http.StatusUnauthorized, "지금 비밀번호가 맞지 않아요")
		return
	}
	if err := auth.ValidPassword(body.New); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	newHash, err := auth.HashPassword(body.New)
	if err == nil {
		err = a.store.SetPassword(r.Context(), u.ID, newHash)
	}
	if err == nil {
		err = a.store.DeleteUserSessions(r.Context(), u.ID, sessionHash(r))
	}
	if err != nil {
		writeStoreError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// deleteMe removes the account and everything in it, after checking the password
// (or, for an account without one, the typed email).
func (a *API) deleteMe(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Password string `json:"password"`
		Confirm  string `json:"confirm"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	u := currentUser(r)
	if u.IsOwner {
		writeError(w, http.StatusBadRequest, "소유자 계정은 삭제할 수 없어요")
		return
	}
	hash, err := a.store.PasswordHash(r.Context(), u.ID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if hash == "" {
		if !strings.EqualFold(strings.TrimSpace(body.Confirm), u.Email) {
			writeError(w, http.StatusBadRequest, "확인용 이메일이 맞지 않아요")
			return
		}
	} else if !auth.CheckPassword(hash, body.Password) {
		writeError(w, http.StatusUnauthorized, "비밀번호가 맞지 않아요")
		return
	}
	if err := a.store.DeleteUser(r.Context(), u.ID); err != nil {
		writeStoreError(w, err)
		return
	}
	a.clearCookie(w, r)
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) setupStatus(w http.ResponseWriter, r *http.Request) {
	needed, err := a.store.OwnerNeedsSetup(r.Context())
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"needed": needed})
}

// setupOwner claims the owner account (which holds the data from before accounts
// existed) with the one-time token printed in the server log.
func (a *API) setupOwner(w http.ResponseWriter, r *http.Request) {
	var c credentials
	if !decodeJSON(w, r, &c) {
		return
	}
	if !a.loginIPLimit.Allow("setup:" + clientIP(r)) {
		writeError(w, http.StatusTooManyRequests, "시도가 너무 많아요. 잠시 후 다시 해 주세요")
		return
	}
	if a.opts.SetupToken == "" || !constantEq(c.Token, a.opts.SetupToken) {
		writeError(w, http.StatusForbidden, "설정 링크가 맞지 않아요. 서버 로그에 나온 링크로 열어 주세요")
		return
	}
	email, ok := normEmail(c.Email)
	if !ok {
		writeError(w, http.StatusBadRequest, "이메일 주소를 확인해 주세요")
		return
	}
	name, ok := cleanName(c.Name)
	if !ok {
		writeError(w, http.StatusBadRequest, "이름은 40자 이내로 적어 주세요")
		return
	}
	if err := auth.ValidPassword(c.Password); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	hash, err := auth.HashPassword(c.Password)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	u, err := a.store.ClaimOwner(r.Context(), email, name, hash)
	switch {
	case errors.Is(err, store.ErrConflict):
		writeError(w, http.StatusConflict, "이미 설정을 마쳤어요. 로그인해 주세요")
		return
	case errors.Is(err, store.ErrTaken):
		writeError(w, http.StatusConflict, "이미 가입된 이메일이에요")
		return
	case err != nil:
		writeStoreError(w, err)
		return
	}
	if err := a.startSession(w, r, u); err != nil {
		writeStoreError(w, err)
		return
	}
	slog.Info("owner account claimed", "user", u.ID)
	writeJSON(w, http.StatusOK, u)
}

// resetPassword sets a new password with an admin-issued link.
func (a *API) resetPassword(w http.ResponseWriter, r *http.Request) {
	var c credentials
	if !decodeJSON(w, r, &c) {
		return
	}
	if !a.loginIPLimit.Allow("reset:" + clientIP(r)) {
		writeError(w, http.StatusTooManyRequests, "시도가 너무 많아요. 잠시 후 다시 해 주세요")
		return
	}
	if err := auth.ValidPassword(c.Password); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	hash, err := auth.HashPassword(c.Password)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	u, err := a.store.UseReset(r.Context(), auth.HashToken(c.Token), hash)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusBadRequest, "만료됐거나 이미 쓴 링크예요. 어드민에게 새 링크를 받아 주세요")
		return
	}
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if u.Status == "active" {
		if err := a.startSession(w, r, u); err != nil {
			writeStoreError(w, err)
			return
		}
	}
	writeJSON(w, http.StatusOK, u)
}
