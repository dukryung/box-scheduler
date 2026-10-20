// Package netguard makes HTTP clients for addresses that users type in (their
// local LLM), refusing the server's own network: loopback, private, link-local
// (cloud metadata) and other internal addresses, unless explicitly allowed.
package netguard

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"time"
)

var ErrBlocked = errors.New("이 주소에는 연결할 수 없어요 (내부 주소)")

// Policy allows internal addresses only when listed: CIDRs ("192.168.0.0/16")
// or host names ("mac-mini.local"), as in AI_ALLOW_PRIVATE.
type Policy struct {
	prefixes []netip.Prefix
	hosts    map[string]bool
}

func Parse(list string) Policy {
	p := Policy{hosts: map[string]bool{}}
	for _, item := range strings.Split(list, ",") {
		item = strings.TrimSpace(strings.ToLower(item))
		switch {
		case item == "":
		case strings.Contains(item, "/"):
			if pre, err := netip.ParsePrefix(item); err == nil {
				p.prefixes = append(p.prefixes, pre)
			}
		default:
			if ip, err := netip.ParseAddr(item); err == nil {
				p.prefixes = append(p.prefixes, netip.PrefixFrom(ip, ip.BitLen()))
			} else {
				p.hosts[item] = true
			}
		}
	}
	return p
}

func internal(ip netip.Addr) bool {
	ip = ip.Unmap()
	return ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() ||
		ip.IsUnspecified() || ip.IsMulticast() || ip.IsInterfaceLocalMulticast() ||
		netip.MustParsePrefix("100.64.0.0/10").Contains(ip) || // carrier-grade NAT (also Tailscale)
		netip.MustParsePrefix("0.0.0.0/8").Contains(ip)
}

// Allowed reports whether host (as typed) resolving to ip may be dialed.
func (p Policy) Allowed(host string, ip netip.Addr) bool {
	if !internal(ip) {
		return true
	}
	if p.hosts[strings.ToLower(strings.TrimSuffix(host, "."))] {
		return true
	}
	for _, pre := range p.prefixes {
		if pre.Contains(ip.Unmap()) {
			return true
		}
	}
	return false
}

// CheckURL validates a user-supplied base URL before it is saved.
func CheckURL(raw string) (*url.URL, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil {
		return nil, errors.New("주소는 http:// 또는 https://로 시작해야 해요 (예: http://mac-mini.local:11434)")
	}
	u.Path = strings.TrimRight(u.Path, "/")
	u.RawQuery, u.Fragment = "", ""
	return u, nil
}

// Client returns an HTTP client whose every connection is checked against the
// policy after DNS resolution (so a name cannot be re-pointed inside), and that
// does not follow redirects.
func (p Policy) Client(timeout time.Duration) *http.Client {
	dialer := &net.Dialer{Timeout: 10 * time.Second}
	transport := &http.Transport{
		Proxy: nil,
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			host, port, err := net.SplitHostPort(addr)
			if err != nil {
				return nil, err
			}
			ips, err := net.DefaultResolver.LookupNetIP(ctx, "ip", host)
			if err != nil {
				return nil, fmt.Errorf("주소를 찾을 수 없어요: %s", host)
			}
			var lastErr error = ErrBlocked
			for _, ip := range ips {
				if !p.Allowed(host, ip) {
					continue
				}
				conn, err := dialer.DialContext(ctx, network, net.JoinHostPort(ip.String(), port))
				if err == nil {
					return conn, nil
				}
				lastErr = err
			}
			return nil, lastErr
		},
		TLSHandshakeTimeout:   10 * time.Second,
		ResponseHeaderTimeout: timeout,
		MaxIdleConnsPerHost:   2,
	}
	return &http.Client{
		Timeout:       timeout,
		Transport:     transport,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
}
