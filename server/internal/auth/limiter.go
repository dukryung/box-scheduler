package auth

import (
	"sync"
	"time"
)

// Limiter allows at most Max events per key within Window (a fixed window per key).
type Limiter struct {
	Max    int
	Window time.Duration

	mu   sync.Mutex
	hits map[string]*window
}

type window struct {
	start time.Time
	n     int
}

// Allow records one event for key and reports whether it is within the limit.
func (l *Limiter) Allow(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	if l.hits == nil {
		l.hits = map[string]*window{}
	}
	if len(l.hits) > 10000 {
		for k, w := range l.hits {
			if now.Sub(w.start) > l.Window {
				delete(l.hits, k)
			}
		}
	}
	w := l.hits[key]
	if w == nil || now.Sub(w.start) > l.Window {
		w = &window{start: now}
		l.hits[key] = w
	}
	w.n++
	return w.n <= l.Max
}

// Reset forgets a key, e.g. after a successful login.
func (l *Limiter) Reset(key string) {
	l.mu.Lock()
	delete(l.hits, key)
	l.mu.Unlock()
}
