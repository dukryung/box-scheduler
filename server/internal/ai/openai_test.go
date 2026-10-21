package ai

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestOpenAICallerStripsThinkingAndFallsBack(t *testing.T) {
	var prompts []string
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		var body struct {
			Messages        []map[string]string `json:"messages"`
			ResponseFormat  map[string]any      `json:"response_format"`
			ReasoningEffort *string             `json:"reasoning_effort"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		effort := "-"
		if body.ReasoningEffort != nil {
			effort = *body.ReasoningEffort
		}
		prompts = append(prompts, effort)
		if body.ResponseFormat["type"] == "json_schema" {
			w.WriteHeader(http.StatusBadRequest) // an older server
			_, _ = w.Write([]byte(`{"error":{"message":"json_schema not supported"}}`))
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{
			"message": map[string]string{"content": "<think>hmm</think>\n```json\n{\"text\":\"회의 완료\"}\n```"}, "finish_reason": "stop",
		}}})
	}))
	defer srv.Close()
	p := ForOpenAICompatible(srv.URL, "", "qwen3:8b", srv.Client())
	got, err := p.Tidy(context.Background(), "음 회의 완료")
	if err != nil || got != "회의 완료" {
		t.Fatalf("got %q %v", got, err)
	}
	// First try: thinking off with a JSON schema; the retry drops both.
	if calls != 2 || prompts[0] != "none" || prompts[1] != "-" {
		t.Errorf("calls=%d prompts=%q", calls, prompts)
	}
}
