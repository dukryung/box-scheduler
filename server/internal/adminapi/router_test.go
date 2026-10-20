package adminapi

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// Building the router catches chi setup mistakes (middleware after routes panics).
func TestRouterBuilds(t *testing.T) {
	h := NewRouter(nil, Options{})
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/health", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("health: %d", rec.Code)
	}
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/users", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("users without a session: %d", rec.Code)
	}
}
