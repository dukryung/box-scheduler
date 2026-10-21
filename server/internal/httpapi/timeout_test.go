package httpapi

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// Every route that calls an AI must be exempt from the request timeout.
func TestAIRoutesSkipTimeout(t *testing.T) {
	// Like an AI call: gives up when the request's time runs out.
	slow := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-time.After(30 * time.Millisecond):
			w.WriteHeader(http.StatusOK)
		case <-r.Context().Done():
		}
	})
	h := timeoutExcept(10*time.Millisecond, slowPaths...)(slow)
	for _, path := range []string{
		"/api/ai-suggest",
		"/api/assistant/preview",
		"/api/assistant/tidy",
		"/api/tasks/1/breakdown",
		"/api/teams/1/tasks/2/plan",
		"/api/ai/connections/1/test",
	} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, path, nil))
		if rec.Code != http.StatusOK {
			t.Errorf("%s: cut off by the timeout (%d)", path, rec.Code)
		}
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/teams/1/tasks", nil))
	if rec.Code != http.StatusGatewayTimeout {
		t.Errorf("ordinary routes keep the timeout, got %d", rec.Code)
	}
}
