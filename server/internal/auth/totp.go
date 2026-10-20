package auth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base32"
	"encoding/binary"
	"fmt"
	"net/url"
	"strings"
	"time"
)

// TOTP (RFC 6238): 30-second steps, 6 digits, HMAC-SHA1 — what Google
// Authenticator, 1Password and the like expect by default.
const totpPeriod = 30

var b32 = base32.StdEncoding.WithPadding(base32.NoPadding)

// NewTOTPSecret returns a random 160-bit secret in base32.
func NewTOTPSecret() (string, error) {
	raw := make([]byte, 20)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return b32.EncodeToString(raw), nil
}

// TOTPURI is the otpauth:// link an authenticator app reads from a QR code.
func TOTPURI(issuer, account, secret string) string {
	label := url.PathEscape(issuer + ":" + account)
	q := url.Values{"secret": {secret}, "issuer": {issuer}, "period": {"30"}, "digits": {"6"}, "algorithm": {"SHA1"}}
	return "otpauth://totp/" + label + "?" + q.Encode()
}

func totpCode(key []byte, step int64) string {
	var msg [8]byte
	binary.BigEndian.PutUint64(msg[:], uint64(step))
	mac := hmac.New(sha1.New, key)
	mac.Write(msg[:])
	sum := mac.Sum(nil)
	off := sum[len(sum)-1] & 0x0f
	n := binary.BigEndian.Uint32(sum[off:off+4]) & 0x7fffffff
	return fmt.Sprintf("%06d", n%1_000_000)
}

// CheckTOTP accepts a code for the current step or one step either side (clock
// drift) and returns the matched step, so the caller can refuse it if reused.
func CheckTOTP(secret, code string, now time.Time) (step int64, ok bool) {
	key, err := b32.DecodeString(strings.ToUpper(strings.TrimSpace(secret)))
	code = strings.ReplaceAll(strings.TrimSpace(code), " ", "")
	if err != nil || len(code) != 6 {
		return 0, false
	}
	cur := now.Unix() / totpPeriod
	for _, s := range []int64{cur, cur - 1, cur + 1} {
		if hmac.Equal([]byte(totpCode(key, s)), []byte(code)) {
			return s, true
		}
	}
	return 0, false
}
