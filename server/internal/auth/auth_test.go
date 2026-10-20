package auth

import (
	"testing"
	"time"
)

func TestPassword(t *testing.T) {
	h, err := HashPassword("correct horse")
	if err != nil {
		t.Fatal(err)
	}
	if !CheckPassword(h, "correct horse") {
		t.Error("right password rejected")
	}
	if CheckPassword(h, "correct horsE") {
		t.Error("wrong password accepted")
	}
	h2, _ := HashPassword("correct horse")
	if h == h2 {
		t.Error("salt not random")
	}
	if CheckPassword("garbage", "x") {
		t.Error("garbage hash accepted")
	}
}

func TestToken(t *testing.T) {
	a, ha, _ := NewToken()
	b, _, _ := NewToken()
	if a == b || len(a) < 40 {
		t.Errorf("weak tokens %q %q", a, b)
	}
	if string(HashToken(a)) != string(ha) {
		t.Error("hash mismatch")
	}
}

func TestLimiter(t *testing.T) {
	l := &Limiter{Max: 2, Window: 50 * time.Millisecond}
	if !l.Allow("k") || !l.Allow("k") || l.Allow("k") {
		t.Error("limit not applied")
	}
	if !l.Allow("other") {
		t.Error("keys not separate")
	}
	time.Sleep(60 * time.Millisecond)
	if !l.Allow("k") {
		t.Error("window did not reset")
	}
}
