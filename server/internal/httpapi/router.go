// Package httpapi exposes the scheduler over a JSON REST API.
package httpapi

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"box-scheduler/server/internal/ai"
	"box-scheduler/server/internal/store"
)

// DefaultUserID is the seeded single user; replaced by real auth later.
const DefaultUserID = "00000000-0000-0000-0000-000000000001"

type ctxKey int

const userIDKey ctxKey = iota

type API struct {
	store   *store.Store
	planner ai.Planner
}

func NewRouter(s *store.Store, planner ai.Planner) http.Handler {
	a := &API{store: s, planner: planner}

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
			r.Use(singleUser)
			r.Use(timeoutExcept("/ai-suggest", 30*time.Second))

			r.Get("/days/{date}", a.getDay)
			r.Put("/days/{date}/note", a.putDayNote)
			r.Post("/days/{date}/carry-over", a.carryOver)
			r.Post("/days/{date}/ai-suggest", a.aiSuggest)
			r.Post("/days/{date}/ai-apply", a.aiApply)
			r.Get("/calendar", a.getCalendar)

			r.Post("/blocks", a.createBlock)
			r.Patch("/blocks/{id}", a.updateBlock)
			r.Delete("/blocks/{id}", a.deleteBlock)

			r.Post("/brain-dump", a.createBrainDump)
			r.Patch("/brain-dump/{id}", a.updateBrainDump)
			r.Delete("/brain-dump/{id}", a.deleteBrainDump)
		})
	})
	return r
}

func singleUser(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := context.WithValue(r.Context(), userIDKey, DefaultUserID)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func userID(r *http.Request) string {
	return r.Context().Value(userIDKey).(string)
}

// timeoutExcept applies a request timeout to every route except those ending in
// suffix (AI planning can take well over a minute).
func timeoutExcept(suffix string, d time.Duration) func(http.Handler) http.Handler {
	withTimeout := middleware.Timeout(d)
	return func(next http.Handler) http.Handler {
		timed := withTimeout(next)
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if strings.HasSuffix(r.URL.Path, suffix) {
				next.ServeHTTP(w, r)
				return
			}
			timed.ServeHTTP(w, r)
		})
	}
}
