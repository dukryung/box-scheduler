package adminapi

import (
	"context"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"

	"box-scheduler/server/internal/adminstore"
	"box-scheduler/server/internal/ai"
	"box-scheduler/server/internal/netguard"
)

// The service AI lives on a machine admins chose (often on the local network),
// so the console's client may reach internal addresses.
var serviceHTTP = netguard.Parse("0.0.0.0/0,::/0").Client(2 * time.Minute)

const sealAD = "service_ai"

func (a *API) serviceAI(w http.ResponseWriter, r *http.Request) {
	cfg, _, err := a.store.ServiceAI(r.Context())
	if err != nil {
		writeStoreError(w, err)
		return
	}
	stats, err := a.store.ServiceAIStats(r.Context(), cfg.DailyLimit)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"config": cfg, "stats": stats, "keysEnabled": a.opts.SecretBox != nil})
}

func (a *API) serviceKey(sealed []byte) (string, error) {
	if len(sealed) == 0 {
		return "", nil
	}
	plain, err := a.opts.SecretBox.Open(sealed, []byte(sealAD))
	return string(plain), err
}

// checkService proves the server answers: its model list has the chosen models,
// and a tiny request to the tidy model comes back in the right shape.
func checkService(ctx context.Context, base, key string, models []string) error {
	ctx, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	if have, err := ai.ListModels(ctx, serviceHTTP, base, key); err == nil {
		for _, m := range models {
			if m != "" && !slices.Contains(have, m) {
				return &modelMissing{m}
			}
		}
	}
	for _, m := range models {
		if m == "" {
			continue
		}
		if _, err := ai.ForOpenAICompatible(base, key, m, serviceHTTP).Tidy(ctx, "음 연결 확인용 요청이에요"); err != nil {
			return err
		}
		break
	}
	return nil
}

type modelMissing struct{ model string }

func (e *modelMissing) Error() string {
	return "서버에 " + e.model + " 모델이 없어요. Mac mini에서 ollama pull " + e.model + " 를 먼저 실행해 주세요"
}

func checkText(err error) string {
	msg := err.Error()
	switch {
	case strings.Contains(msg, "connection refused"), strings.Contains(msg, "no such host"), strings.Contains(msg, "i/o timeout"), strings.Contains(msg, "주소를 찾을 수 없어요"):
		return "AI 서버에 연결하지 못했어요. 주소·포트와 서버가 켜져 있는지, 다른 기기의 접속을 받는지(OLLAMA_HOST=0.0.0.0) 확인해 주세요"
	case strings.Contains(msg, "context deadline exceeded"):
		return "AI 서버가 90초 안에 답하지 않았어요. 모델이 너무 크거나 처음 불러오는 중일 수 있어요"
	}
	if len(msg) > 200 {
		msg = msg[:200]
	}
	return msg
}

func (a *API) saveServiceAI(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Enabled      bool   `json:"enabled"`
		BaseURL      string `json:"baseUrl"`
		APIKey       string `json:"apiKey"` // empty: keep the saved one
		ClearKey     bool   `json:"clearKey"`
		PlanModel    string `json:"planModel"`
		RequestModel string `json:"requestModel"`
		TidyModel    string `json:"tidyModel"`
		Concurrency  int    `json:"concurrency"`
		DailyLimit   int    `json:"dailyLimit"`
		Password     string `json:"password"`
	}
	if !decodeJSON(w, r, &body) || !a.reauth(w, r, body.Password) {
		return
	}
	cfg := adminstore.ServiceAI{
		Enabled: body.Enabled, PlanModel: strings.TrimSpace(body.PlanModel), RequestModel: strings.TrimSpace(body.RequestModel),
		TidyModel: strings.TrimSpace(body.TidyModel), Concurrency: body.Concurrency, DailyLimit: body.DailyLimit,
	}
	if cfg.Concurrency < 1 || cfg.Concurrency > 16 || cfg.DailyLimit < 0 || cfg.DailyLimit > 10000 {
		writeError(w, http.StatusBadRequest, "동시 처리 수는 1~16, 하루 한도는 0~10000이에요 (0은 무제한)")
		return
	}
	if strings.TrimSpace(body.BaseURL) != "" {
		u, err := netguard.CheckURL(body.BaseURL)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		cfg.BaseURL = u.String()
	}
	if cfg.Enabled && (cfg.BaseURL == "" || (cfg.PlanModel == "" && cfg.RequestModel == "" && cfg.TidyModel == "")) {
		writeError(w, http.StatusBadRequest, "켜려면 서버 주소와 모델을 하나 이상 정해 주세요")
		return
	}

	_, oldSealed, err := a.store.ServiceAI(r.Context())
	if err != nil {
		writeStoreError(w, err)
		return
	}
	key := strings.TrimSpace(body.APIKey)
	var sealed []byte // nil: keep
	switch {
	case body.ClearKey:
		sealed = []byte{}
	case key != "":
		if a.opts.SecretBox == nil {
			writeError(w, http.StatusServiceUnavailable, "AI_SECRET_KEY가 없어 키를 저장할 수 없어요")
			return
		}
		if sealed, err = a.opts.SecretBox.Seal([]byte(key), []byte(sealAD)); err != nil {
			writeStoreError(w, err)
			return
		}
		cfg.KeyHint = "…" + key[max(0, len(key)-4):]
	default:
		if key, err = a.serviceKey(oldSealed); err != nil {
			writeError(w, http.StatusServiceUnavailable, "저장된 키를 열지 못했어요. 키를 다시 넣어 주세요")
			return
		}
	}
	if body.ClearKey {
		key = ""
	}
	if cfg.Enabled {
		if err := checkService(r.Context(), cfg.BaseURL, key, []string{cfg.TidyModel, cfg.RequestModel, cfg.PlanModel}); err != nil {
			writeError(w, http.StatusBadRequest, "연결 확인에 실패해서 저장하지 않았어요: "+checkText(err))
			return
		}
	}
	if err := a.store.SaveServiceAI(r.Context(), cfg, sealed, current(r).Email); err != nil {
		writeStoreError(w, err)
		return
	}
	detail := "끔"
	if cfg.Enabled {
		detail = cfg.BaseURL + " · " + strings.Trim(strings.Join([]string{cfg.PlanModel, cfg.RequestModel, cfg.TidyModel}, "/"), "/") +
			" · 동시 " + itoa(cfg.Concurrency) + " · 하루 " + itoa(cfg.DailyLimit)
	}
	a.record(r, "service-ai", "", "서비스 AI", detail)
	a.serviceAI(w, r)
}

func (a *API) testServiceAI(w http.ResponseWriter, r *http.Request) {
	cfg, sealed, err := a.store.ServiceAI(r.Context())
	if err != nil {
		writeStoreError(w, err)
		return
	}
	key, err := a.serviceKey(sealed)
	if err == nil {
		err = checkService(r.Context(), cfg.BaseURL, key, []string{cfg.TidyModel, cfg.RequestModel, cfg.PlanModel})
	}
	msg := ""
	if err != nil {
		msg = checkText(err)
	}
	_ = a.store.MarkServiceAI(r.Context(), msg)
	writeJSON(w, http.StatusOK, map[string]any{"ok": err == nil, "error": msg})
}

// serviceModels lists what an OpenAI-compatible server offers, for the model pickers.
func (a *API) serviceModels(w http.ResponseWriter, r *http.Request) {
	var body struct {
		BaseURL string `json:"baseUrl"`
		APIKey  string `json:"apiKey"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	u, err := netguard.CheckURL(body.BaseURL)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	key := strings.TrimSpace(body.APIKey)
	if key == "" {
		if _, sealed, err := a.store.ServiceAI(r.Context()); err == nil {
			key, _ = a.serviceKey(sealed)
		}
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	models, err := ai.ListModels(ctx, serviceHTTP, u.String(), key)
	if err != nil {
		writeError(w, http.StatusBadRequest, checkText(err))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"models": models})
}

func itoa(n int) string { return strconv.Itoa(n) }
