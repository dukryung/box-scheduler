package netguard

import (
	"net/netip"
	"testing"
)

func TestPolicy(t *testing.T) {
	p := Parse("192.168.0.0/16, mac-mini.local, 10.1.2.3")
	cases := []struct {
		host, ip string
		ok       bool
	}{
		{"api.example.com", "93.184.216.34", true},
		{"x", "127.0.0.1", false},
		{"x", "169.254.169.254", false}, // cloud metadata
		{"x", "10.0.0.5", false},
		{"x", "10.1.2.3", true},
		{"x", "192.168.1.20", true},
		{"mac-mini.local", "172.20.0.4", true},
		{"MAC-MINI.LOCAL.", "172.20.0.4", true},
		{"other.local", "172.20.0.4", false},
		{"x", "::1", false},
		{"x", "fd00::1", false},
		{"x", "100.100.1.1", false},
		{"x", "0.0.0.0", false},
	}
	for _, c := range cases {
		if got := p.Allowed(c.host, netip.MustParseAddr(c.ip)); got != c.ok {
			t.Errorf("%s %s: got %v want %v", c.host, c.ip, got, c.ok)
		}
	}
	if _, err := CheckURL("ftp://x"); err == nil {
		t.Error("ftp accepted")
	}
	if _, err := CheckURL("http://user:pw@host"); err == nil {
		t.Error("userinfo accepted")
	}
	if u, err := CheckURL(" http://mac-mini.local:11434/v1/ "); err != nil || u.String() != "http://mac-mini.local:11434/v1" {
		t.Errorf("normalize: %v %v", u, err)
	}
}
