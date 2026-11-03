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
	"box-scheduler/server/internal/aigate"
	"box-scheduler/server/internal/auth"
	"box-scheduler/server/internal/mail"
	"box-scheduler/server/internal/netguard"
	"box-scheduler/server/internal/notify"
	"box-scheduler/server/internal/secretbox"
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
	// Mail sends team invites (nil or unset: invite links are shown to copy instead).
	Mail *mail.SMTP
	// PublicURL is the app's address in links sent by email.
	PublicURL string
	// Google is the "Google로 계속하기" client; nil or without credentials hides it.
	Google *auth.Google
	// Notify records notifications and sends them as Web Push (nil: none).
	Notify *notify.Notifier
	// SecretBox seals accounts' API keys (nil: keys cannot be saved).
	SecretBox *secretbox.Box
	// AudioDir keeps meeting recordings ("": recording is off).
	AudioDir string
	// NetPolicy decides which internal addresses local LLM connections may reach.
	NetPolicy netguard.Policy
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

	aiHTTP      *http.Client // guarded client (no internal addresses)
	serviceHTTP *http.Client // the admins' service AI, which may be on the local network
	gate        *aigate.Gate // queue in front of the service AI

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
		aiHTTP:       opts.NetPolicy.Client(aiCallTime),
		serviceHTTP:  netguard.Parse("0.0.0.0/0,::/0").Client(aiCallTime),
		gate:         aigate.New(20, 2*time.Minute),
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
			r.Get("/invites/{token}", a.inviteInfo)
		})

		r.Group(func(r chi.Router) {
			r.Use(sameOrigin)
			r.Use(a.requireUser)
			r.Use(timeoutExcept(30*time.Second, slowPaths...))

			r.Get("/days/{date}", a.getDay)
			r.Put("/days/{date}/note", a.putDayNote)
			r.Post("/days/{date}/carry-over", a.carryOver)
			r.Post("/days/{date}/ai-suggest", a.aiSuggest)
			r.Post("/days/{date}/ai-apply", a.aiApply)
			r.Get("/ai/plan-break", a.planBreak)
			r.Put("/ai/plan-break", a.setPlanBreak)
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
			r.Post("/tasks/{id}/breakdown", a.breakdownSuggest)
			r.Post("/tasks/{id}/breakdown/allocate", a.breakdownAllocate)
			r.Post("/tasks/{id}/breakdown/apply", a.breakdownApply)
			r.Post("/brain-dump/{id}/move", a.moveBrainDump)
			r.Post("/brain-dump", a.createBrainDump)
			r.Patch("/brain-dump/{id}", a.updateBrainDump)
			r.Delete("/brain-dump/{id}", a.deleteBrainDump)

			r.Get("/auth/me", a.me)
			r.Patch("/auth/me", a.updateMe)
			r.Delete("/auth/me", a.deleteMe)
			r.Post("/auth/password", a.changePassword)
			r.Post("/auth/google/unlink", a.googleUnlink)

			r.Post("/auth/onboarded", a.finishOnboarding)
			r.Get("/notifications", a.listNotifications)
			r.Post("/notifications/read", a.readNotifications)
			r.Put("/notifications/settings", a.updateNotifySettings)
			r.Get("/push/key", a.pushKey)
			r.Post("/push/subscriptions", a.subscribePush)
			r.Delete("/push/subscriptions", a.unsubscribePush)
			r.Post("/push/test", a.testPush)
			r.Get("/teams", a.listTeams)
			r.Post("/teams", a.createTeam)
			r.Get("/teams/{teamID}", a.getTeam)
			r.Patch("/teams/{teamID}", a.updateTeam)
			r.Delete("/teams/{teamID}", a.deleteTeam)
			r.Post("/teams/{teamID}/invites", a.createInvites)
			r.Post("/teams/{teamID}/invites/{inviteID}/resend", a.resendInvite)
			r.Delete("/teams/{teamID}/invites/{inviteID}", a.revokeInvite)
			r.Patch("/teams/{teamID}/members/{userID}", a.updateMember)
			r.Delete("/teams/{teamID}/members/{userID}", a.removeMember)
			r.Post("/teams/{teamID}/transfer", a.transferTeam)
			r.Get("/teams/{teamID}/tasks", a.listTeamTasks)
			r.Post("/teams/{teamID}/tasks", a.createTeamTask)
			r.Patch("/teams/{teamID}/tasks/{taskID}", a.updateTeamTask)
			r.Delete("/teams/{teamID}/tasks/{taskID}", a.deleteTeamTask)
			r.Post("/teams/{teamID}/tasks/{taskID}/plan", a.teamPlanSuggest)
			r.Post("/teams/{teamID}/tasks/{taskID}/plan/preview", a.teamPlanPreview)
			r.Post("/teams/{teamID}/tasks/{taskID}/plan/apply", a.teamPlanApply)
			r.Get("/teams/{teamID}/meetings", a.listMeetings)
			r.Post("/teams/{teamID}/meetings", a.createMeeting)
			r.Get("/teams/{teamID}/meetings/{meetingID}", a.getMeeting)
			r.Patch("/teams/{teamID}/meetings/{meetingID}", a.updateMeeting)
			r.Delete("/teams/{teamID}/meetings/{meetingID}", a.deleteMeeting)
			r.Post("/teams/{teamID}/meetings/{meetingID}/minutes", a.startMinutes)
			r.Post("/teams/{teamID}/meetings/{meetingID}/confirm", a.confirmMeeting)
			r.Post("/teams/{teamID}/meetings/{meetingID}/audio", a.startAudio)
			r.Post("/teams/{teamID}/meetings/{meetingID}/audio/{audioID}/chunks/{seq}", a.appendAudio)
			r.Post("/teams/{teamID}/meetings/{meetingID}/audio/{audioID}/finish", a.finishAudio)
			r.Get("/teams/{teamID}/meetings/{meetingID}/audio/{audioID}", a.getAudio)
			r.Delete("/teams/{teamID}/meetings/{meetingID}/audio/{audioID}", a.deleteAudio)
			r.Post("/invites/{token}/accept", a.acceptInvite)

			r.Get("/ai", a.aiState)
			r.Post("/ai/connections", a.createAIConnection)
			r.Post("/ai/connections/{id}/test", a.testAIConnection)
			r.Delete("/ai/connections/{id}", a.deleteAIConnection)
			r.Put("/ai/settings", a.putAISettings)
			r.Get("/ai/queue", a.aiQueue)
		})
	})
	return r
}

func userID(r *http.Request) string {
	return r.Context().Value(userIDKey).(string)
}

// timeoutExcept applies a request timeout to every route except those ending in
// one of suffixes (AI calls can take well over a minute).
// slowPaths end the routes that wait on an AI (a local model can take minutes),
// so they are left out of the 30-second request timeout.
var slowPaths = []string{"/ai-suggest", "/assistant/preview", "/assistant/tidy", "/ai/connections", "/test", "/breakdown", "/plan"}

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
