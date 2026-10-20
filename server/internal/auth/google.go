package auth

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// Google is an OpenID Connect client for "Google로 계속하기" (authorization code + PKCE).
type Google struct {
	ClientID     string
	ClientSecret string
	RedirectURL  string // PUBLIC_URL + /api/auth/google/callback
	AuthURL      string // overridable so tests can stand in for Google
	TokenURL     string
	HTTP         *http.Client

	mu      sync.Mutex
	pending map[string]Pending
}

// Pending is what a sign-in started with, kept until Google sends the person back.
type Pending struct {
	Verifier string
	Nonce    string
	Next     string // where to go afterwards
	Setup    bool   // claiming the owner account
	LinkUser string // linking Google to this signed-in account
	expires  time.Time
}

// Identity is the verified Google account.
type Identity struct {
	Sub   string
	Email string
	Name  string
}

const pendingTTL = 10 * time.Minute

func (g *Google) Enabled() bool { return g != nil && g.ClientID != "" && g.ClientSecret != "" }

// Start returns the Google URL to send the browser to, and the state that the
// browser must also carry in a cookie when it comes back.
func (g *Google) Start(p Pending) (redirect, state string, err error) {
	state, _, err = NewToken()
	if err != nil {
		return "", "", err
	}
	if p.Verifier, _, err = NewToken(); err != nil {
		return "", "", err
	}
	if p.Nonce, _, err = NewToken(); err != nil {
		return "", "", err
	}
	p.expires = time.Now().Add(pendingTTL)
	g.mu.Lock()
	if g.pending == nil {
		g.pending = map[string]Pending{}
	}
	for k, v := range g.pending {
		if time.Now().After(v.expires) {
			delete(g.pending, k)
		}
	}
	g.pending[state] = p
	g.mu.Unlock()

	challenge := sha256.Sum256([]byte(p.Verifier))
	q := url.Values{
		"client_id":             {g.ClientID},
		"redirect_uri":          {g.RedirectURL},
		"response_type":         {"code"},
		"scope":                 {"openid email profile"},
		"state":                 {state},
		"nonce":                 {p.Nonce},
		"code_challenge":        {base64.RawURLEncoding.EncodeToString(challenge[:])},
		"code_challenge_method": {"S256"},
		"prompt":                {"select_account"},
	}
	return g.AuthURL + "?" + q.Encode(), state, nil
}

// Take removes and returns the pending sign-in for state, if it is still fresh.
func (g *Google) Take(state string) (Pending, bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	p, ok := g.pending[state]
	delete(g.pending, state)
	if !ok || time.Now().After(p.expires) {
		return Pending{}, false
	}
	return p, true
}

var ErrGoogle = errors.New("google sign-in failed")

// Finish trades the code for an ID token and checks it. The token comes straight
// from Google's token endpoint over TLS with our client secret, so (per OpenID
// Connect Core 3.1.3.7) its issuer, audience, expiry and nonce are checked here
// instead of its signature.
func (g *Google) Finish(ctx context.Context, code string, p Pending) (Identity, error) {
	form := url.Values{
		"code":          {code},
		"client_id":     {g.ClientID},
		"client_secret": {g.ClientSecret},
		"redirect_uri":  {g.RedirectURL},
		"grant_type":    {"authorization_code"},
		"code_verifier": {p.Verifier},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, g.TokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return Identity{}, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	client := g.HTTP
	if client == nil {
		client = &http.Client{Timeout: 15 * time.Second}
	}
	res, err := client.Do(req)
	if err != nil {
		return Identity{}, fmt.Errorf("%w: %v", ErrGoogle, err)
	}
	defer res.Body.Close()
	var tok struct {
		IDToken string `json:"id_token"`
		Error   string `json:"error"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(nil, res.Body, 1<<20)).Decode(&tok); err != nil || res.StatusCode != http.StatusOK || tok.IDToken == "" {
		return Identity{}, fmt.Errorf("%w: token endpoint %d %s", ErrGoogle, res.StatusCode, tok.Error)
	}
	parts := strings.Split(tok.IDToken, ".")
	if len(parts) != 3 {
		return Identity{}, fmt.Errorf("%w: malformed id token", ErrGoogle)
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return Identity{}, fmt.Errorf("%w: id token payload", ErrGoogle)
	}
	var c struct {
		Iss           string          `json:"iss"`
		Aud           json.RawMessage `json:"aud"`
		Exp           int64           `json:"exp"`
		Nonce         string          `json:"nonce"`
		Sub           string          `json:"sub"`
		Email         string          `json:"email"`
		EmailVerified bool            `json:"email_verified"`
		Name          string          `json:"name"`
	}
	if err := json.Unmarshal(payload, &c); err != nil {
		return Identity{}, fmt.Errorf("%w: id token claims", ErrGoogle)
	}
	switch {
	case c.Iss != "https://accounts.google.com" && c.Iss != "accounts.google.com":
		return Identity{}, fmt.Errorf("%w: issuer %q", ErrGoogle, c.Iss)
	case !audienceIs(c.Aud, g.ClientID):
		return Identity{}, fmt.Errorf("%w: audience", ErrGoogle)
	case time.Now().Unix() > c.Exp:
		return Identity{}, fmt.Errorf("%w: expired", ErrGoogle)
	case c.Nonce != p.Nonce:
		return Identity{}, fmt.Errorf("%w: nonce", ErrGoogle)
	case c.Sub == "" || c.Email == "" || !c.EmailVerified:
		return Identity{}, fmt.Errorf("%w: no verified email", ErrGoogle)
	}
	return Identity{Sub: c.Sub, Email: strings.ToLower(c.Email), Name: c.Name}, nil
}

func audienceIs(raw json.RawMessage, clientID string) bool {
	var one string
	if json.Unmarshal(raw, &one) == nil {
		return one == clientID
	}
	var many []string
	if json.Unmarshal(raw, &many) == nil {
		for _, a := range many {
			if a == clientID {
				return true
			}
		}
	}
	return false
}
