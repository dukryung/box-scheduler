// Package adminapi is the admin console's API, served by its own process
// (cmd/admin) apart from the app server.
package adminapi

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"box-scheduler/server/internal/adminstore"
	"box-scheduler/server/internal/auth"
)

const (
	cookieName  = "bs_admin"
	sessionTTL  = 8 * time.Hour
	idleTimeout = 30 * time.Minute
	issuer      = "Box Scheduler Admin"
)

type Options struct {
	CookieSecure bool
	// ServiceURL is the app's public address, used in password reset links.
	ServiceURL string
	// LoginPerIP caps sign-in attempts per address per 15 minutes (0 = 30).
	LoginPerIP int
}

type API struct {
	store   *adminstore.Store
	opts    Options
	ipLimit *auth.Limiter
}

type ctxKey int

const (
	accountKey ctxKey = iota
	hashKey
)

func NewRouter(s *adminstore.Store, opts Options) http.Handler {
	limit := opts.LoginPerIP
	if limit <= 0 {
		limit = 30
	}
	a := &API{store: s, opts: opts, ipLimit: &auth.Limiter{Max: limit, Window: 15 * time.Minute}}
	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)
	r.Use(middleware.Timeout(30 * time.Second))
	r.Use(noStore)

	r.Route("/api", func(r chi.Router) {
		r.Use(sameOrigin)
		r.Get("/health", func(w http.ResponseWriter, _ *http.Request) {
			writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
		})
		r.Post("/auth/login", a.login)
		r.Post("/auth/logout", a.logout)

		// Sign-in steps: a session that still has to change its password or pass two-factor.
		r.Group(func(r chi.Router) {
			r.Use(a.requireSession(false))
			r.Get("/auth/me", a.me)
			r.Post("/auth/password", a.changePassword)
			r.Post("/auth/totp/setup", a.totpSetup)
			r.Post("/auth/totp/verify", a.totpVerify)
		})

		r.Group(func(r chi.Router) {
			r.Use(a.requireSession(true))
			r.Get("/dashboard", a.dashboard)
			r.Get("/users", a.users)
			r.Get("/users/{id}", a.userDetail)
			r.Patch("/users/{id}", a.updateUser)
			r.Delete("/users/{id}", a.deleteUser)
			r.Post("/users/{id}/sessions/revoke", a.revokeSessions)
			r.Post("/users/{id}/reset-link", a.resetLink)
			r.Post("/users/{id}/notes", a.addNote)
			r.Get("/audit", a.audit)

			r.Group(func(r chi.Router) {
				r.Use(requireSuper)
				r.Get("/admins", a.admins)
				r.Post("/admins", a.createAdmin)
				r.Patch("/admins/{id}", a.updateAdmin)
				r.Post("/admins/{id}/reset", a.resetAdmin)
			})
		})
	})
	return r
}

// ---- helpers ----

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func writeStoreError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, adminstore.ErrNotFound):
		writeError(w, http.StatusNotFound, "찾을 수 없어요")
	case errors.Is(err, adminstore.ErrTaken):
		writeError(w, http.StatusConflict, "이미 있는 이메일이에요")
	case errors.Is(err, adminstore.ErrProtected):
		writeError(w, http.StatusBadRequest, "소유자 계정은 여기서 바꿀 수 없어요")
	default:
		slog.Error("admin store", "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
	}
}

func decodeJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16))
	if err := dec.Decode(v); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON")
		return false
	}
	return true
}

func constantEq(a, b string) bool { return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1 }

func clientIP(r *http.Request) string {
	host := r.RemoteAddr
	if i := strings.LastIndex(host, ":"); i > 0 {
		host = host[:i]
	}
	return host
}

func current(r *http.Request) adminstore.Account {
	return r.Context().Value(accountKey).(adminstore.Account)
}

func (a *API) secure(r *http.Request) bool {
	return a.opts.CookieSecure || r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https"
}

func (a *API) record(r *http.Request, action, targetID, target, detail string) {
	actor := "system"
	if v, ok := r.Context().Value(accountKey).(adminstore.Account); ok {
		actor = v.Email
	}
	if err := a.store.Audit(r.Context(), actor, action, targetID, target, detail, clientIP(r)); err != nil {
		slog.Error("audit", "err", err)
	}
}

// noStore keeps admin answers out of browser and proxy caches.
func noStore(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		next.ServeHTTP(w, r)
	})
}

// sameOrigin refuses cross-site writes, as the app server does.
func sameOrigin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			if r.Header.Get("Sec-Fetch-Site") == "cross-site" || !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
				writeError(w, http.StatusForbidden, "허용되지 않은 요청이에요")
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func sessionHash(r *http.Request) []byte {
	c, err := r.Cookie(cookieName)
	if err != nil || c.Value == "" || len(c.Value) > 100 {
		return nil
	}
	return auth.HashToken(c.Value)
}

// requireSession loads the admin; full=true also needs the password changed and two-factor passed.
func (a *API) requireSession(full bool) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			hash := sessionHash(r)
			if hash == nil {
				writeError(w, http.StatusUnauthorized, "로그인이 필요해요")
				return
			}
			acc, mfa, err := a.store.Session(r.Context(), hash, idleTimeout)
			if errors.Is(err, adminstore.ErrNotFound) || (err == nil && acc.Status != "active") {
				a.clearCookie(w, r)
				writeError(w, http.StatusUnauthorized, "로그인이 필요해요")
				return
			}
			if err != nil {
				writeStoreError(w, err)
				return
			}
			if full && (!mfa || acc.MustChangePassword) {
				writeJSON(w, http.StatusForbidden, map[string]string{"error": "로그인 단계를 마쳐 주세요", "stage": stageOf(acc, mfa)})
				return
			}
			ctx := context.WithValue(r.Context(), accountKey, acc)
			ctx = context.WithValue(ctx, hashKey, hash)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

func requireSuper(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if current(r).Role != "super" {
			writeError(w, http.StatusForbidden, "최고 관리자만 할 수 있어요")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// reauth checks the admin's password again before a destructive action.
func (a *API) reauth(w http.ResponseWriter, r *http.Request, password string) bool {
	hash, err := a.store.PasswordHash(r.Context(), current(r).ID)
	if err != nil {
		writeStoreError(w, err)
		return false
	}
	if !auth.CheckPassword(hash, password) {
		// 403, not 401: the session is fine, only this confirmation failed.
		writeError(w, http.StatusForbidden, "비밀번호를 다시 확인해 주세요")
		return false
	}
	return true
}
