package auth

import (
	"testing"
	"time"
)

// RFC 6238 appendix B, SHA-1 key "12345678901234567890" (last 6 digits).
func TestTOTPVectors(t *testing.T) {
	key := []byte("12345678901234567890")
	for unix, want := range map[int64]string{59: "287082", 1111111109: "081804", 1234567890: "005924", 2000000000: "279037"} {
		if got := totpCode(key, unix/30); got != want {
			t.Errorf("t=%d: got %s want %s", unix, got, want)
		}
	}
}

func TestCheckTOTP(t *testing.T) {
	secret := b32.EncodeToString([]byte("12345678901234567890"))
	now := time.Unix(1111111109, 0)
	if step, ok := CheckTOTP(secret, "081804", now); !ok || step != 1111111109/30 {
		t.Error("current code rejected")
	}
	if _, ok := CheckTOTP(secret, "081804", now.Add(30*time.Second)); !ok {
		t.Error("previous step not accepted (drift)")
	}
	if _, ok := CheckTOTP(secret, "081804", now.Add(90*time.Second)); ok {
		t.Error("old code accepted")
	}
	if _, ok := CheckTOTP(secret, "12345", now); ok {
		t.Error("short code accepted")
	}
	s, _ := NewTOTPSecret()
	if len(s) != 32 {
		t.Errorf("secret length %d", len(s))
	}
}
