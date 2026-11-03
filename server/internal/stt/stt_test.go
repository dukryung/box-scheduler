package stt

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestSubmitAndWait(t *testing.T) {
	var polls atomic.Int32
	var got []byte
	var query string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/v1/jobs":
			got, _ = io.ReadAll(r.Body)
			query = r.URL.RawQuery
			w.WriteHeader(http.StatusAccepted)
			_ = json.NewEncoder(w).Encode(Job{ID: "j1", Status: "queued", Position: 1})
		case r.URL.Path == "/v1/jobs/j1":
			n := polls.Add(1)
			switch {
			case n == 2:
				// A hiccup is ridden out.
				hj, _ := w.(http.Hijacker)
				c, _, _ := hj.Hijack()
				c.Close()
			case n < 4:
				_ = json.NewEncoder(w).Encode(Job{ID: "j1", Status: "running", Stage: "transcribe"})
			default:
				_ = json.NewEncoder(w).Encode(Job{ID: "j1", Status: "done", Duration: 3, Result: &Result{Speakers: 2, Segments: []Segment{{Speaker: 1, Text: "안녕"}}}})
			}
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	c := New(srv.URL + "/")
	ctx := context.Background()
	j, err := c.Submit(ctx, strings.NewReader("audio"), 5, "audio/webm", Options{Language: "ko", Speakers: 3, Prompt: "참석자"})
	if err != nil || j.ID != "j1" {
		t.Fatalf("submit: %+v %v", j, err)
	}
	if string(got) != "audio" || !strings.Contains(query, "speakers=3") || !strings.Contains(query, "language=ko") {
		t.Fatalf("sent %q ?%s", got, query)
	}
	seen := []string{}
	j, err = c.Wait(ctx, "j1", time.Millisecond, func(j Job) { seen = append(seen, j.Status) })
	if err != nil || j.Status != "done" || j.Result.Segments[0].Text != "안녕" {
		t.Fatalf("wait: %+v %v", j, err)
	}
	if strings.Join(seen, ",") != "running,done" {
		t.Fatalf("seen %v", seen)
	}
	if _, err := c.Job(ctx, "nope"); err == nil {
		t.Fatal("a missing job should fail")
	}
}
