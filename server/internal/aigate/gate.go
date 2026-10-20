// Package aigate limits how many requests reach the service's own AI at once
// (a local LLM handles only a few), queueing the rest for a while.
package aigate

import (
	"context"
	"errors"
	"sync"
	"time"
)

var ErrBusy = errors.New("AI 요청이 많아 지금은 처리할 수 없어요. 잠시 후 다시 해 주세요")

type Gate struct {
	mu      sync.Mutex
	running int
	waiting int
	wake    chan struct{}
	// MaxWaiting is how many may queue; MaxWait how long one waits.
	MaxWaiting int
	MaxWait    time.Duration
}

func New(maxWaiting int, maxWait time.Duration) *Gate {
	return &Gate{wake: make(chan struct{}), MaxWaiting: maxWaiting, MaxWait: maxWait}
}

// Acquire waits for one of limit slots. Call release when done.
func (g *Gate) Acquire(ctx context.Context, limit int) (release func(), waited time.Duration, err error) {
	start := time.Now()
	deadline := time.NewTimer(g.MaxWait)
	defer deadline.Stop()
	queued := false
	for {
		g.mu.Lock()
		if g.running < max(limit, 1) {
			g.running++
			if queued {
				g.waiting--
			}
			g.mu.Unlock()
			var once sync.Once
			return func() { once.Do(g.release) }, time.Since(start), nil
		}
		if !queued {
			if g.waiting >= g.MaxWaiting {
				g.mu.Unlock()
				return nil, 0, ErrBusy
			}
			g.waiting++
			queued = true
		}
		wake := g.wake
		g.mu.Unlock()

		select {
		case <-wake:
		case <-deadline.C:
			g.leave()
			return nil, time.Since(start), ErrBusy
		case <-ctx.Done():
			g.leave()
			return nil, time.Since(start), ctx.Err()
		}
	}
}

func (g *Gate) leave() {
	g.mu.Lock()
	g.waiting--
	g.mu.Unlock()
}

func (g *Gate) release() {
	g.mu.Lock()
	g.running--
	close(g.wake)
	g.wake = make(chan struct{})
	g.mu.Unlock()
}

// Load reports how many requests are running and waiting now.
func (g *Gate) Load() (running, waiting int) {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.running, g.waiting
}
