package httpapi

import (
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"

	"box-scheduler/server/internal/auth"
	"box-scheduler/server/internal/store"
)

const oauthCookie = "bs_oauth"

func safeNext(next string) string {
	if strings.HasPrefix(next, "/") && !strings.HasPrefix(next, "//") && !strings.HasPrefix(next, "/\\") && len(next) < 300 {
		return next
	}
	return ""
}

func (a *API) providers(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]bool{"google": a.opts.Google.Enabled()})
}

// googleStart sends the browser to Google. ?setup=<token> claims the owner
// account, ?link=1 attaches Google to the signed-in account, ?next= is where to return.
func (a *API) googleStart(w http.ResponseWriter, r *http.Request) {
	g := a.opts.Google
	if !g.Enabled() {
		http.Redirect(w, r, "/login?error=google_off", http.StatusFound)
		return
	}
	q := r.URL.Query()
	p := auth.Pending{Next: safeNext(q.Get("next"))}
	switch {
	case q.Get("setup") != "":
		if a.opts.SetupToken == "" || !constantEq(q.Get("setup"), a.opts.SetupToken) {
			http.Redirect(w, r, "/setup?error=token", http.StatusFound)
			return
		}
		p.Setup = true
	case q.Get("link") == "1":
		hash := sessionHash(r)
		if hash == nil {
			http.Redirect(w, r, "/login", http.StatusFound)
			return
		}
		u, err := a.store.SessionUser(r.Context(), hash, sessionTTL)
		if err != nil {
			http.Redirect(w, r, "/login", http.StatusFound)
			return
		}
		p.LinkUser = u.ID
	}
	redirect, state, err := g.Start(p)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	// The state also rides in a cookie, so a callback started in another browser is refused.
	http.SetCookie(w, &http.Cookie{
		Name: oauthCookie, Value: state, Path: "/api/auth/google", MaxAge: int((10 * time.Minute).Seconds()),
		HttpOnly: true, Secure: a.secureCookie(r), SameSite: http.SameSiteLaxMode,
	})
	http.Redirect(w, r, redirect, http.StatusFound)
}

func (a *API) googleCallback(w http.ResponseWriter, r *http.Request) {
	fail := func(code string) { http.Redirect(w, r, "/login?error="+url.QueryEscape(code), http.StatusFound) }
	http.SetCookie(w, &http.Cookie{Name: oauthCookie, Value: "", Path: "/api/auth/google", MaxAge: -1, HttpOnly: true, Secure: a.secureCookie(r), SameSite: http.SameSiteLaxMode})

	q := r.URL.Query()
	state := q.Get("state")
	c, err := r.Cookie(oauthCookie)
	if err != nil || state == "" || !constantEq(c.Value, state) {
		fail("google_state")
		return
	}
	p, ok := a.opts.Google.Take(state)
	if !ok {
		fail("google_state")
		return
	}
	if q.Get("error") != "" || q.Get("code") == "" {
		if p.LinkUser != "" {
			http.Redirect(w, r, "/profile", http.StatusFound)
			return
		}
		fail("google_cancel")
		return
	}
	id, err := a.opts.Google.Finish(r.Context(), q.Get("code"), p)
	if err != nil {
		slog.Warn("google sign-in", "err", err)
		fail("google_failed")
		return
	}
	next := p.Next
	if next == "" {
		next = "/"
	}

	switch {
	case p.LinkUser != "":
		_, err := a.store.LinkGoogle(r.Context(), p.LinkUser, id.Sub)
		result := "linked"
		if errors.Is(err, store.ErrTaken) {
			result = "taken"
		} else if err != nil {
			writeStoreError(w, err)
			return
		}
		http.Redirect(w, r, "/profile?google="+result, http.StatusFound)
		return

	case p.Setup:
		u, err := a.store.ClaimOwnerGoogle(r.Context(), id.Email, id.Name, id.Sub)
		switch {
		case errors.Is(err, store.ErrConflict):
			fail("setup_done")
			return
		case errors.Is(err, store.ErrTaken):
			fail("google_email_exists")
			return
		case err != nil:
			writeStoreError(w, err)
			return
		}
		slog.Info("owner account claimed with google", "user", u.ID)
		a.finishGoogle(w, r, u, next)
		return
	}

	u, err := a.store.UserByGoogle(r.Context(), id.Sub)
	if err == nil {
		if u.Status != "active" {
			fail("suspended")
			return
		}
		a.finishGoogle(w, r, u, next)
		return
	}
	if !errors.Is(err, store.ErrNotFound) {
		writeStoreError(w, err)
		return
	}
	// A new Google account. An existing account with the same email is not joined
	// automatically: its email was never verified, so whoever made it might not own it.
	if _, _, err := a.store.UserByEmail(r.Context(), id.Email); err == nil {
		fail("google_email_exists")
		return
	}
	if !a.signupLimit.Allow(clientIP(r)) {
		fail("too_many")
		return
	}
	u, err = a.store.CreateGoogleUser(r.Context(), id.Email, id.Name, id.Sub)
	if errors.Is(err, store.ErrTaken) {
		fail("google_email_exists")
		return
	}
	if err != nil {
		writeStoreError(w, err)
		return
	}
	slog.Info("signup with google", "user", u.ID)
	a.finishGoogle(w, r, u, next)
}

func (a *API) finishGoogle(w http.ResponseWriter, r *http.Request, u store.User, next string) {
	if err := a.startSession(w, r, u); err != nil {
		writeStoreError(w, err)
		return
	}
	http.Redirect(w, r, next, http.StatusFound)
}

// googleUnlink detaches Google while the account still has a password to sign in with.
func (a *API) googleUnlink(w http.ResponseWriter, r *http.Request) {
	u, err := a.store.UnlinkGoogle(r.Context(), currentUser(r).ID)
	if errors.Is(err, store.ErrConflict) {
		writeError(w, http.StatusBadRequest, "비밀번호를 먼저 정해야 Google 연결을 끊을 수 있어요")
		return
	}
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, u)
}
