package aigate

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestGateLimitsAndQueues(t *testing.T) {
	g := New(10, 2*time.Second)
	var now, peak int32
	var wg sync.WaitGroup
	for i := 0; i < 6; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			release, _, err := g.Acquire(context.Background(), 2)
			if err != nil {
				t.Error(err)
				return
			}
			n := atomic.AddInt32(&now, 1)
			for {
				p := atomic.LoadInt32(&peak)
				if n <= p || atomic.CompareAndSwapInt32(&peak, p, n) {
					break
				}
			}
			time.Sleep(30 * time.Millisecond)
			atomic.AddInt32(&now, -1)
			release()
		}()
	}
	wg.Wait()
	if peak != 2 {
		t.Errorf("peak concurrency %d, want 2", peak)
	}
	if r, w := g.Load(); r != 0 || w != 0 {
		t.Errorf("left running=%d waiting=%d", r, w)
	}
}

func TestGateBusy(t *testing.T) {
	g := New(1, 50*time.Millisecond)
	hold, _, _ := g.Acquire(context.Background(), 1)
	done := make(chan error)
	go func() { _, _, err := g.Acquire(context.Background(), 1); done <- err }()
	time.Sleep(10 * time.Millisecond)
	if _, _, err := g.Acquire(context.Background(), 1); err != ErrBusy {
		t.Errorf("queue full: got %v", err)
	}
	if err := <-done; err != ErrBusy {
		t.Errorf("waited too long: got %v", err)
	}
	hold()
	release, _, err := g.Acquire(context.Background(), 1)
	if err != nil {
		t.Fatal(err)
	}
	release()
	release() // twice is harmless
	if r, _ := g.Load(); r != 0 {
		t.Errorf("running %d after double release", r)
	}
}
