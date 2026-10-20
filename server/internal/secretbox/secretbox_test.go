package secretbox

import (
	"strings"
	"testing"
)

func TestSealOpen(t *testing.T) {
	b, err := New(strings.Repeat("ab", 32))
	if err != nil {
		t.Fatal(err)
	}
	s, _ := b.Seal([]byte("sk-ant-secret"), []byte("row-1"))
	if strings.Contains(string(s), "sk-ant") {
		t.Fatal("not sealed")
	}
	got, err := b.Open(s, []byte("row-1"))
	if err != nil || string(got) != "sk-ant-secret" {
		t.Fatalf("open: %q %v", got, err)
	}
	if _, err := b.Open(s, []byte("row-2")); err == nil {
		t.Error("opened with another row's data")
	}
	s2, _ := b.Seal([]byte("sk-ant-secret"), []byte("row-1"))
	if string(s) == string(s2) {
		t.Error("nonce reused")
	}
	if nb, _ := New(""); nb != nil {
		t.Error("empty key should give no box")
	}
	if _, err := New("short"); err == nil {
		t.Error("bad key accepted")
	}
	var none *Box
	if _, err := none.Seal([]byte("x"), nil); err != ErrNoKey {
		t.Error("nil box sealed")
	}
}
