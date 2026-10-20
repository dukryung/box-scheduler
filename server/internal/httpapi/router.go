// Package httpapi exposes the scheduler over a JSON REST API.
package httpapi

import (
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"box-scheduler/server/internal/ai"
	"box-scheduler/server/internal/auth"
	"box-scheduler/server/internal/store"
)

// OwnerID is the seeded account that owns the data from before accounts existed.
const OwnerID = "00000000-0000-0000-0000-000000000001"

type ctxKey int

const (
	userIDKey ctxKey = iota
	userKey
)

type Options struct {
	// SetupToken unlocks claiming the owner account once; empty when it is claimed.
	SetupToken string
	// CookieSecure forces the Secure flag on session cookies (set it behind HTTPS).
	CookieSecure bool
	// Google is the "Google로 계속하기" client; nil or without credentials hides it.
	Google *auth.Google
	// Per-IP limits: log-in attempts per 15 minutes and sign-ups per hour (0 = default).
	LoginPerIP  int
	SignupPerIP int
}

type API struct {
	store   *store.Store
	planner ai.Provider
	opts    Options

	loginLimit   *auth.Limiter // per email (reset on success) and per account
	loginIPLimit *auth.Limiter
	signupLimit  *auth.Limiter

	// active remembers who was already marked active today ("userID" → "YYYY-MM-DD").
	active sync.Map
}

func orDefault(n, d int) int {
	if n > 0 {
		return n
	}
	return d
}

func NewRouter(s *store.Store, planner ai.Provider, opts Options) http.Handler {
	a := &API{
		store: s, planner: planner, opts: opts,
		loginLimit:   &auth.Limiter{Max: 10, Window: 15 * time.Minute},
		loginIPLimit: &auth.Limiter{Max: orDefault(opts.LoginPerIP, 60), Window: 15 * time.Minute},
		signupLimit:  &auth.Limiter{Max: orDefault(opts.SignupPerIP, 10), Window: time.Hour},
	}

	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)

	r.Route("/api", func(r chi.Router) {
		r.Get("/health", func(w http.ResponseWriter, _ *http.Request) {
			writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
		})

		r.Group(func(r chi.Router) {
			r.Use(sameOrigin)
			r.Use(middleware.Timeout(30 * time.Second))
			r.Post("/auth/signup", a.signup)
			r.Post("/auth/login", a.login)
			r.Post("/auth/logout", a.logout)
			r.Get("/auth/setup", a.setupStatus)
			r.Post("/auth/setup", a.setupOwner)
			r.Post("/auth/reset", a.resetPassword)
			r.Get("/auth/providers", a.providers)
			r.Get("/auth/google/start", a.googleStart)
			r.Get("/auth/google/callback", a.googleCallback)
		})

		r.Group(func(r chi.Router) {
			r.Use(sameOrigin)
			r.Use(a.requireUser)
			r.Use(timeoutExcept(30*time.Second, "/ai-suggest", "/assistant/preview", "/assistant/tidy"))

			r.Get("/days/{date}", a.getDay)
			r.Put("/days/{date}/note", a.putDayNote)
			r.Post("/days/{date}/carry-over", a.carryOver)
			r.Post("/days/{date}/ai-suggest", a.aiSuggest)
			r.Post("/days/{date}/ai-apply", a.aiApply)
			r.Post("/assistant/preview", a.assistantPreview)
			r.Post("/assistant/apply", a.assistantApply)
			r.Post("/assistant/tidy", a.assistantTidy)
			r.Get("/calendar", a.getCalendar)
			r.Get("/stats", a.getStats)

			r.Post("/blocks", a.createBlock)
			r.Patch("/blocks/{id}", a.updateBlock)
			r.Delete("/blocks/{id}", a.deleteBlock)

			r.Get("/tasks", a.listTasks)
			r.Post("/tasks", a.createTask)
			r.Post("/brain-dump/{id}/move", a.moveBrainDump)
			r.Post("/brain-dump", a.createBrainDump)
			r.Patch("/brain-dump/{id}", a.updateBrainDump)
			r.Delete("/brain-dump/{id}", a.deleteBrainDump)

			r.Get("/auth/me", a.me)
			r.Patch("/auth/me", a.updateMe)
			r.Delete("/auth/me", a.deleteMe)
			r.Post("/auth/password", a.changePassword)
			r.Post("/auth/google/unlink", a.googleUnlink)
		})
	})
	return r
}

func userID(r *http.Request) string {
	return r.Context().Value(userIDKey).(string)
}

// timeoutExcept applies a request timeout to every route except those ending in
// one of suffixes (AI calls can take well over a minute).
func timeoutExcept(d time.Duration, suffixes ...string) func(http.Handler) http.Handler {
	withTimeout := middleware.Timeout(d)
	return func(next http.Handler) http.Handler {
		timed := withTimeout(next)
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if slices.ContainsFunc(suffixes, func(s string) bool { return strings.HasSuffix(r.URL.Path, s) }) {
				next.ServeHTTP(w, r)
				return
			}
			timed.ServeHTTP(w, r)
		})
	}
}
