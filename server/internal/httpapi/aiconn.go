package httpapi

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"

	"box-scheduler/server/internal/ai"
	"box-scheduler/server/internal/netguard"
	"box-scheduler/server/internal/store"
)

const (
	choiceServer  = "server"  // the owner's subscription on this server
	choiceService = "service" // the service's own AI, set up by admins
	aiCallTime    = 3 * time.Minute
	aiCheckTime   = 60 * time.Second
)

var aiFeatures = []string{"plan", "request", "tidy"}

func featureChoice(s store.AISettings, feature string) string {
	switch feature {
	case "plan", "breakdown": // splitting a task uses the planning AI
		return s.Plan
	case "request":
		return s.Request
	}
	return s.Tidy
}

// effectiveSettings is what each feature uses: the saved choice, or by default
// the server subscription for the owner and the first connection for others.
func (a *API) effectiveSettings(ctx context.Context, u store.User, conns []store.AIConnection) (store.AISettings, error) {
	s, saved, err := a.store.GetAISettings(ctx, u.ID)
	if err != nil || saved {
		return s, err
	}
	def := ""
	switch svc, err := a.store.ServiceAI(ctx); {
	case u.IsOwner:
		def = choiceServer
	case err == nil && svc.Enabled:
		def = choiceService
	case len(conns) > 0:
		def = conns[0].ID
	}
	return store.AISettings{Plan: def, Request: def, Tidy: def}, nil
}

// providerFor builds the AI for one of the account's connections.
func (a *API) providerFor(c store.AIConnection) (ai.Provider, error) {
	key := ""
	if len(c.KeySealed) > 0 {
		plain, err := a.opts.SecretBox.Open(c.KeySealed, []byte(c.ID))
		if err != nil {
			return nil, err
		}
		key = string(plain)
	}
	if c.Kind == "anthropic" {
		return ai.ForAnthropicKey(key, c.Model, aiCallTime), nil
	}
	base := ""
	if c.BaseURL != nil {
		base = *c.BaseURL
	}
	return ai.ForOpenAICompatible(base, key, c.Model, a.aiHTTP), nil
}

// aiFor picks the AI this account set for feature, checks the service AI's
// daily limit, and wraps it so each call is queued (service AI) and logged.
func (a *API) aiFor(w http.ResponseWriter, r *http.Request, feature string) (ai.Provider, bool) {
	u := currentUser(r)
	conns, err := a.store.ListAIConnections(r.Context(), u.ID)
	if err != nil {
		writeStoreError(w, err)
		return nil, false
	}
	s, err := a.effectiveSettings(r.Context(), u, conns)
	if err != nil {
		writeStoreError(w, err)
		return nil, false
	}
	t := &trackedAI{a: a, userID: u.ID, feature: feature}
	switch choice := featureChoice(s, feature); {
	case choice == choiceServer && u.IsOwner:
		t.p, t.source = a.planner, "server"
	case choice == choiceService:
		svc, err := a.store.ServiceAI(r.Context())
		if err != nil {
			writeStoreError(w, err)
			return nil, false
		}
		if !svc.Enabled || svc.Model(feature) == "" {
			writeErrorCode(w, http.StatusForbidden, "ai_not_connected", "서비스 AI를 지금은 쓸 수 없어요. 설정 → AI 연결에서 내 API 키를 연결할 수 있어요")
			return nil, false
		}
		if !u.IsOwner && svc.DailyLimit > 0 {
			used, err := a.store.ServiceCallsToday(r.Context(), u.ID)
			if err != nil {
				writeStoreError(w, err)
				return nil, false
			}
			if used >= svc.DailyLimit {
				writeErrorCode(w, http.StatusTooManyRequests, "ai_limit",
					"오늘 서비스 AI를 "+itoa(svc.DailyLimit)+"회 모두 썼어요. 내일 다시 쓰거나, 설정 → AI 연결에서 내 API 키를 연결하면 계속 쓸 수 있어요")
				return nil, false
			}
		}
		if t.p, err = a.serviceProvider(svc, feature); err != nil {
			slog.Error("open service ai", "err", err)
			writeErrorCode(w, http.StatusServiceUnavailable, "ai_not_connected", "서비스 AI 설정을 열지 못했어요. 관리자에게 알려 주세요")
			return nil, false
		}
		t.source, t.gated, t.limit = "service", true, svc.Concurrency
	case choice != "":
		if i := slices.IndexFunc(conns, func(c store.AIConnection) bool { return c.ID == choice }); i >= 0 {
			if t.p, err = a.providerFor(conns[i]); err != nil {
				slog.Error("open ai connection", "err", err)
				writeErrorCode(w, http.StatusForbidden, "ai_not_connected", "저장된 AI 연결을 열지 못했어요. 설정에서 다시 연결해 주세요")
				return nil, false
			}
			t.source = "own"
		}
	}
	if t.p == nil {
		writeErrorCode(w, http.StatusForbidden, "ai_not_connected", "AI 기능은 설정 → AI 연결에서 AI를 고르면 쓸 수 있어요")
		return nil, false
	}
	if err := a.store.CountAICall(r.Context(), u.ID, feature); err != nil {
		slog.Warn("count ai call", "err", err)
	}
	return t, true
}

func itoa(n int) string { return strconv.Itoa(n) }

// serviceProvider builds the service AI for a feature. Its address was set by an
// admin, so internal addresses (the Mac mini on the local network) are allowed.
func (a *API) serviceProvider(svc store.ServiceAI, feature string) (ai.Provider, error) {
	key := ""
	if len(svc.KeySealed) > 0 {
		plain, err := a.opts.SecretBox.Open(svc.KeySealed, []byte("service_ai"))
		if err != nil {
			return nil, err
		}
		key = string(plain)
	}
	return ai.ForOpenAICompatible(svc.BaseURL, key, svc.Model(feature), a.serviceHTTP), nil
}

// trackedAI queues calls to the service AI behind its concurrency limit and logs
// every call (source, time, success) for limits and the admin dashboard.
type trackedAI struct {
	a       *API
	p       ai.Provider
	userID  string
	feature string
	source  string
	gated   bool
	limit   int
}

func (t *trackedAI) run(ctx context.Context, fn func(context.Context) error) error {
	var waited time.Duration
	if t.gated {
		release, w, err := t.a.gate.Acquire(ctx, t.limit)
		waited = w
		if err != nil {
			_ = t.a.store.RecordAICall(context.WithoutCancel(ctx), t.userID, t.feature, t.source, 0, waited, false)
			return err
		}
		defer release()
	}
	start := time.Now()
	err := fn(ctx)
	_ = t.a.store.RecordAICall(context.WithoutCancel(ctx), t.userID, t.feature, t.source, time.Since(start), waited, err == nil)
	return err
}

func (t *trackedAI) Plan(ctx context.Context, req ai.PlanRequest) (plan ai.Plan, err error) {
	err = t.run(ctx, func(ctx context.Context) error { plan, err = t.p.Plan(ctx, req); return err })
	return plan, err
}

func (t *trackedAI) Interpret(ctx context.Context, req ai.AssistantRequest) (reply ai.AssistantReply, err error) {
	err = t.run(ctx, func(ctx context.Context) error { reply, err = t.p.Interpret(ctx, req); return err })
	return reply, err
}

func (t *trackedAI) Breakdown(ctx context.Context, req ai.BreakdownRequest) (plan ai.BreakdownPlan, err error) {
	err = t.run(ctx, func(ctx context.Context) error { plan, err = t.p.Breakdown(ctx, req); return err })
	return plan, err
}

func (t *trackedAI) Tidy(ctx context.Context, text string) (out string, err error) {
	err = t.run(ctx, func(ctx context.Context) error { out, err = t.p.Tidy(ctx, text); return err })
	return out, err
}

// aiQueue tells a waiting screen how busy the service AI is.
func (a *API) aiQueue(w http.ResponseWriter, _ *http.Request) {
	running, waiting := a.gate.Load()
	writeJSON(w, http.StatusOK, map[string]int{"running": running, "waiting": waiting})
}

// aiErrorText turns a provider error into something a person can act on.
func aiErrorText(err error) string {
	msg := err.Error()
	switch {
	case errors.Is(err, netguard.ErrBlocked) || strings.Contains(msg, netguard.ErrBlocked.Error()):
		return "이 주소는 서버 안쪽 주소라 연결할 수 없어요. 서버 관리자가 AI_ALLOW_PRIVATE에 허용해야 해요"
	case strings.Contains(msg, "401") || strings.Contains(msg, "authentication"):
		return "API 키가 맞지 않아요"
	case strings.Contains(msg, "credit") || strings.Contains(msg, "billing"):
		return "Anthropic 계정의 크레딧이나 결제를 확인해 주세요"
	case strings.Contains(msg, "주소를 찾을 수 없어요"), strings.Contains(msg, "connection refused"), strings.Contains(msg, "i/o timeout"), strings.Contains(msg, "no such host"):
		return "AI 서버에 연결하지 못했어요. 주소와 포트, 서버가 켜져 있는지 확인해 주세요"
	case strings.Contains(msg, "did not match"):
		return "모델이 정해진 형식으로 답하지 못했어요. 더 큰 모델을 골라 보세요"
	}
	if len(msg) > 160 {
		msg = msg[:160]
	}
	return "AI가 답하지 않았어요: " + msg
}

// checkProvider sends one tiny request to prove the connection works.
func checkProvider(ctx context.Context, p ai.Provider) error {
	ctx, cancel := context.WithTimeout(ctx, aiCheckTime)
	defer cancel()
	_, err := p.Tidy(ctx, "음 연결 확인용 요청이에요")
	return err
}

type serviceState struct {
	Enabled    bool              `json:"enabled"`
	Models     map[string]string `json:"models"` // per feature; "" when not offered
	DailyLimit int               `json:"dailyLimit"`
	UsedToday  int               `json:"usedToday"`
	Unlimited  bool              `json:"unlimited"` // the owner
}

type aiState struct {
	Connections     []store.AIConnection `json:"connections"`
	Settings        store.AISettings     `json:"settings"`
	ServerAvailable bool                 `json:"serverAvailable"`
	Service         serviceState         `json:"service"`
	AnthropicModels []string             `json:"anthropicModels"`
	KeysEnabled     bool                 `json:"keysEnabled"`
}

func (a *API) aiState(w http.ResponseWriter, r *http.Request) {
	u := currentUser(r)
	conns, err := a.store.ListAIConnections(r.Context(), u.ID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	s, err := a.effectiveSettings(r.Context(), u, conns)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	svc, err := a.store.ServiceAI(r.Context())
	if err != nil {
		writeStoreError(w, err)
		return
	}
	used, err := a.store.ServiceCallsToday(r.Context(), u.ID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, aiState{
		Connections: conns, Settings: s, ServerAvailable: u.IsOwner,
		Service: serviceState{
			Enabled: svc.Enabled, DailyLimit: svc.DailyLimit, UsedToday: used, Unlimited: u.IsOwner,
			Models: map[string]string{"plan": svc.PlanModel, "request": svc.RequestModel, "tidy": svc.TidyModel},
		},
		AnthropicModels: ai.AnthropicModels, KeysEnabled: a.opts.SecretBox != nil,
	})
}

type newConnection struct {
	Kind    string `json:"kind"`
	Label   string `json:"label"`
	BaseURL string `json:"baseUrl"`
	Model   string `json:"model"`
	APIKey  string `json:"apiKey"`
}

func (a *API) createAIConnection(w http.ResponseWriter, r *http.Request) {
	var body newConnection
	if !decodeJSON(w, r, &body) {
		return
	}
	u := currentUser(r)
	if !a.loginLimit.Allow("ai-connect:" + u.ID) {
		writeError(w, http.StatusTooManyRequests, "시도가 너무 많아요. 잠시 후 다시 해 주세요")
		return
	}
	body.Label = strings.TrimSpace(body.Label)
	body.Model = strings.TrimSpace(body.Model)
	body.APIKey = strings.TrimSpace(body.APIKey)
	if utf8.RuneCountInString(body.Label) > 40 || body.Model == "" || len(body.Model) > 200 || len(body.APIKey) > 500 {
		writeError(w, http.StatusBadRequest, "이름(40자 이내)과 모델을 확인해 주세요")
		return
	}
	c := store.AIConnection{Kind: body.Kind, Label: body.Label, Model: body.Model}
	switch body.Kind {
	case "anthropic":
		if !slices.Contains(ai.AnthropicModels, body.Model) {
			writeError(w, http.StatusBadRequest, "모델을 목록에서 골라 주세요")
			return
		}
		if !strings.HasPrefix(body.APIKey, "sk-ant-") {
			writeError(w, http.StatusBadRequest, "Anthropic API 키는 sk-ant-로 시작해요")
			return
		}
	default:
		// Local LLMs are the service's (set up by admins); accounts bring only API keys.
		writeError(w, http.StatusBadRequest, "내 AI로는 Anthropic API 키만 연결할 수 있어요")
		return
	}
	if body.APIKey != "" && a.opts.SecretBox == nil {
		writeError(w, http.StatusServiceUnavailable, "서버에 AI_SECRET_KEY가 설정되지 않아 키를 저장할 수 없어요")
		return
	}
	if c.Label == "" {
		c.Label = "Anthropic API"
	}

	id, err := a.store.NewAIConnectionID(r.Context())
	if err != nil {
		writeStoreError(w, err)
		return
	}
	c.ID = id
	if body.APIKey != "" {
		if c.KeySealed, err = a.opts.SecretBox.Seal([]byte(body.APIKey), []byte(id)); err != nil {
			writeStoreError(w, err)
			return
		}
		c.KeyHint = "…" + body.APIKey[max(0, len(body.APIKey)-4):]
	}
	p, err := a.providerFor(c)
	if err == nil {
		err = checkProvider(r.Context(), p)
	}
	if err != nil {
		slog.Info("ai connection check failed", "kind", c.Kind, "err", err)
		writeError(w, http.StatusBadRequest, aiErrorText(err))
		return
	}
	saved, err := a.store.CreateAIConnection(r.Context(), u.ID, c)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	// A first connection becomes the AI for every feature (the owner keeps the server's).
	if _, had, err := a.store.GetAISettings(r.Context(), u.ID); err == nil && !had && !u.IsOwner {
		_ = a.store.SetAISettings(r.Context(), u.ID, store.AISettings{Plan: saved.ID, Request: saved.ID, Tidy: saved.ID})
	}
	writeJSON(w, http.StatusCreated, saved)
}

func (a *API) testAIConnection(w http.ResponseWriter, r *http.Request) {
	u := currentUser(r)
	c, err := a.store.AIConnection(r.Context(), u.ID, chi.URLParam(r, "id"))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	p, err := a.providerFor(c)
	if err == nil {
		err = checkProvider(r.Context(), p)
	}
	msg := ""
	if err != nil {
		msg = aiErrorText(err)
	}
	_ = a.store.MarkAIConnection(r.Context(), u.ID, c.ID, msg)
	writeJSON(w, http.StatusOK, map[string]any{"ok": err == nil, "error": msg})
}

func (a *API) deleteAIConnection(w http.ResponseWriter, r *http.Request) {
	if err := a.store.DeleteAIConnection(r.Context(), currentUser(r).ID, chi.URLParam(r, "id")); err != nil {
		writeStoreError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) putAISettings(w http.ResponseWriter, r *http.Request) {
	var body store.AISettings
	if !decodeJSON(w, r, &body) {
		return
	}
	u := currentUser(r)
	conns, err := a.store.ListAIConnections(r.Context(), u.ID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	svc, err := a.store.ServiceAI(r.Context())
	if err != nil {
		writeStoreError(w, err)
		return
	}
	svcOn := svc.Enabled
	for _, f := range aiFeatures {
		v := featureChoice(body, f)
		ok := v == "" || (v == choiceServer && u.IsOwner) || (v == choiceService && svcOn) ||
			slices.ContainsFunc(conns, func(c store.AIConnection) bool { return c.ID == v })
		if !ok {
			writeError(w, http.StatusBadRequest, "고를 수 없는 AI예요")
			return
		}
	}
	if err := a.store.SetAISettings(r.Context(), u.ID, body); err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, body)
}
