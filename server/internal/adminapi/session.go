package adminapi

import (
	"errors"
	"net/http"
	"time"

	"box-scheduler/server/internal/adminstore"
	"box-scheduler/server/internal/auth"
)

// stageOf is the next sign-in step: change the temporary password, set up
// two-factor, enter a code, or done.
func stageOf(a adminstore.Account, mfa bool) string {
	switch {
	case a.MustChangePassword:
		return "password"
	case !a.TOTPEnabled:
		return "enroll"
	case !mfa:
		return "totp"
	}
	return "ok"
}

func (a *API) clearCookie(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{Name: cookieName, Value: "", Path: "/", MaxAge: -1, HttpOnly: true, Secure: a.secure(r), SameSite: http.SameSiteStrictMode})
}

func (a *API) login(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	if !a.ipLimit.Allow(clientIP(r)) {
		writeError(w, http.StatusTooManyRequests, "시도가 너무 많아요. 15분 뒤에 다시 해 주세요")
		return
	}
	const bad = "이메일 또는 비밀번호가 맞지 않아요"
	c, err := a.store.CredentialsByEmail(r.Context(), body.Email)
	if errors.Is(err, adminstore.ErrNotFound) {
		auth.BurnTime(body.Password)
		_ = a.store.Audit(r.Context(), body.Email, "login-failed", "", "", "unknown email", clientIP(r))
		writeError(w, http.StatusUnauthorized, bad)
		return
	}
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if c.LockedUntil != nil && c.LockedUntil.After(time.Now()) {
		writeError(w, http.StatusLocked, "로그인에 여러 번 실패해서 잠시 잠겼어요. 15분 뒤에 다시 해 주세요")
		return
	}
	if !auth.CheckPassword(c.PasswordHash, body.Password) {
		_ = a.store.LoginFailed(r.Context(), c.ID)
		_ = a.store.Audit(r.Context(), c.Email, "login-failed", c.ID, c.Email, "wrong password", clientIP(r))
		writeError(w, http.StatusUnauthorized, bad)
		return
	}
	if c.Status != "active" {
		writeError(w, http.StatusForbidden, "사용이 중지된 관리자 계정이에요")
		return
	}
	token, hash, err := auth.NewToken()
	if err == nil {
		ua := r.UserAgent()
		if len(ua) > 300 {
			ua = ua[:300]
		}
		err = a.store.CreateSession(r.Context(), hash, c.ID, clientIP(r), ua, time.Now().Add(sessionTTL))
	}
	if err != nil {
		writeStoreError(w, err)
		return
	}
	_ = a.store.LoginSucceeded(r.Context(), c.ID)
	http.SetCookie(w, &http.Cookie{
		Name: cookieName, Value: token, Path: "/", MaxAge: int(sessionTTL.Seconds()),
		HttpOnly: true, Secure: a.secure(r), SameSite: http.SameSiteStrictMode,
	})
	writeJSON(w, http.StatusOK, map[string]any{"account": c.Account, "stage": stageOf(c.Account, false)})
}

func (a *API) logout(w http.ResponseWriter, r *http.Request) {
	if hash := sessionHash(r); hash != nil {
		_ = a.store.DeleteSession(r.Context(), hash)
	}
	a.clearCookie(w, r)
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) sessionMFA(r *http.Request) bool {
	_, mfa, _ := a.store.Session(r.Context(), r.Context().Value(hashKey).([]byte), idleTimeout)
	return mfa
}

func (a *API) me(w http.ResponseWriter, r *http.Request) {
	acc := current(r)
	writeJSON(w, http.StatusOK, map[string]any{"account": acc, "stage": stageOf(acc, a.sessionMFA(r))})
}

func (a *API) changePassword(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Current string `json:"current"`
		New     string `json:"new"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	acc := current(r)
	if !a.ipLimit.Allow("pw:" + acc.ID) {
		writeError(w, http.StatusTooManyRequests, "시도가 너무 많아요. 잠시 후 다시 해 주세요")
		return
	}
	if !a.reauth(w, r, body.Current) {
		return
	}
	if err := auth.ValidPassword(body.New); err != nil || len([]rune(body.New)) < 12 {
		writeError(w, http.StatusBadRequest, "관리자 비밀번호는 12자 이상 128자 이하로 정해 주세요")
		return
	}
	if body.New == body.Current {
		writeError(w, http.StatusBadRequest, "지금과 다른 비밀번호로 정해 주세요")
		return
	}
	hash, err := auth.HashPassword(body.New)
	if err == nil {
		err = a.store.SetPassword(r.Context(), acc.ID, hash, false)
	}
	if err == nil {
		err = a.store.DeleteOtherSessions(r.Context(), acc.ID, r.Context().Value(hashKey).([]byte))
	}
	if err != nil {
		writeStoreError(w, err)
		return
	}
	a.record(r, "password-changed", acc.ID, acc.Email, "")
	acc.MustChangePassword = false
	writeJSON(w, http.StatusOK, map[string]any{"account": acc, "stage": stageOf(acc, a.sessionMFA(r))})
}

// totpSetup issues a new secret to scan, while two-factor is not yet on.
func (a *API) totpSetup(w http.ResponseWriter, r *http.Request) {
	acc := current(r)
	if acc.TOTPEnabled {
		writeError(w, http.StatusConflict, "2단계 인증이 이미 켜져 있어요")
		return
	}
	if acc.MustChangePassword {
		writeError(w, http.StatusForbidden, "먼저 비밀번호를 바꿔 주세요")
		return
	}
	secret, err := auth.NewTOTPSecret()
	if err == nil {
		err = a.store.SetPendingTOTP(r.Context(), acc.ID, secret)
	}
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"secret": secret, "uri": auth.TOTPURI(issuer, acc.Email, secret)})
}

// totpVerify checks a code: it turns two-factor on during enrollment, and
// completes sign-in for this session either way.
func (a *API) totpVerify(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Code string `json:"code"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	acc := current(r)
	if acc.MustChangePassword {
		writeError(w, http.StatusForbidden, "먼저 비밀번호를 바꿔 주세요")
		return
	}
	if !a.ipLimit.Allow("totp:" + acc.ID) {
		writeError(w, http.StatusTooManyRequests, "시도가 너무 많아요. 잠시 후 다시 해 주세요")
		return
	}
	secret, err := a.store.TOTPSecret(r.Context(), acc.ID)
	if errors.Is(err, adminstore.ErrNotFound) {
		writeError(w, http.StatusBadRequest, "먼저 2단계 인증을 설정해 주세요")
		return
	}
	if err != nil {
		writeStoreError(w, err)
		return
	}
	step, ok := auth.CheckTOTP(secret, body.Code, time.Now())
	if ok {
		ok, err = a.store.UseTOTPStep(r.Context(), acc.ID, step, !acc.TOTPEnabled)
		if err != nil {
			writeStoreError(w, err)
			return
		}
	}
	if !ok {
		a.record(r, "totp-failed", acc.ID, acc.Email, "")
		writeError(w, http.StatusUnauthorized, "인증 코드가 맞지 않아요. 앱에 보이는 새 코드를 입력해 주세요")
		return
	}
	if err := a.store.MarkMFA(r.Context(), r.Context().Value(hashKey).([]byte)); err != nil {
		writeStoreError(w, err)
		return
	}
	if !acc.TOTPEnabled {
		a.record(r, "totp-enabled", acc.ID, acc.Email, "")
	}
	a.record(r, "login", acc.ID, acc.Email, "")
	acc.TOTPEnabled = true
	writeJSON(w, http.StatusOK, map[string]any{"account": acc, "stage": "ok"})
}
