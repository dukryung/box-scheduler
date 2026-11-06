// Package notify records notifications for accounts and delivers them as Web
// Push to the browsers they subscribed, and sends timetable reminders.
package notify

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"

	webpush "github.com/SherClockHolmes/webpush-go"

	"box-scheduler/server/internal/secretbox"
	"box-scheduler/server/internal/store"
)

// Push services browsers subscribe with. Only these get our requests, so a
// subscription cannot point the server at anything else.
var pushHosts = []string{"fcm.googleapis.com", ".push.services.mozilla.com", ".push.apple.com", ".notify.windows.com"}

const keyAD = "vapid-private-key"

type Notifier struct {
	store      *store.Store
	pub, priv  string
	subscriber string
	client     *http.Client
	extra      map[string]bool // host:port also allowed, over http too (test stacks)
}

// New loads the service's VAPID keys, making them on first start. Without a
// secret box nothing can be sealed: notifications then stay in the app only.
func New(ctx context.Context, st *store.Store, box *secretbox.Box, subscriber, allow string) (*Notifier, error) {
	n := &Notifier{store: st, subscriber: subscriber, client: &http.Client{Timeout: 15 * time.Second}, extra: map[string]bool{}}
	for _, h := range strings.Split(allow, ",") {
		if h = strings.TrimSpace(h); h != "" {
			n.extra[h] = true
		}
	}
	if box == nil {
		return n, nil
	}
	pub, sealed, err := st.PushKeys(ctx)
	if store.IsNotFound(err) {
		priv, p, err := webpush.GenerateVAPIDKeys()
		if err != nil {
			return nil, err
		}
		s, err := box.Seal([]byte(priv), []byte(keyAD))
		if err != nil {
			return nil, err
		}
		if pub, sealed, err = st.SavePushKeys(ctx, p, s); err != nil {
			return nil, err
		}
	} else if err != nil {
		return nil, err
	}
	priv, err := box.Open(sealed, []byte(keyAD))
	if err != nil {
		return nil, fmt.Errorf("push keys: %w", err)
	}
	n.pub, n.priv = pub, string(priv)
	return n, nil
}

func (n *Notifier) PushEnabled() bool { return n != nil && n.pub != "" }
func (n *Notifier) PublicKey() string { return n.pub }

// AllowedEndpoint says whether a browser's push endpoint is one we will post to.
func (n *Notifier) AllowedEndpoint(endpoint string) bool {
	u, err := url.Parse(endpoint)
	if err != nil || u.Host == "" {
		return false
	}
	if n.extra[u.Host] {
		return u.Scheme == "http" || u.Scheme == "https"
	}
	if u.Scheme != "https" || u.Port() != "" {
		return false
	}
	for _, h := range pushHosts {
		if u.Hostname() == h || (strings.HasPrefix(h, ".") && strings.HasSuffix(u.Hostname(), h)) {
			return true
		}
	}
	return false
}

// Notify records a notification for userID and pushes it to their browsers in
// the background.
func (n *Notifier) Notify(ctx context.Context, userID string, note store.Notification) (store.Notification, error) {
	saved, err := n.store.AddNotification(ctx, userID, note)
	if err != nil {
		return saved, err
	}
	if n.PushEnabled() {
		go n.push(userID, saved)
	}
	return saved, nil
}

type payload struct {
	Title string `json:"title"`
	Body  string `json:"body"`
	URL   string `json:"url"`
	Tag   string `json:"tag"`
	Kind  string `json:"kind"`
}

func (n *Notifier) push(userID string, note store.Notification) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	subs, err := n.store.PushSubscriptions(ctx, userID)
	if err != nil {
		slog.Error("push: subscriptions", "err", err)
		return
	}
	msg, _ := json.Marshal(payload{Title: note.Title, Body: note.Body, URL: note.Link, Tag: note.ID, Kind: note.Kind})
	for _, s := range subs {
		if !n.AllowedEndpoint(s.Endpoint) {
			_ = n.store.DropPushSubscription(ctx, s.Endpoint)
			continue
		}
		resp, err := webpush.SendNotificationWithContext(ctx, msg, &webpush.Subscription{Endpoint: s.Endpoint, Keys: webpush.Keys{P256dh: s.P256dh, Auth: s.Auth}}, &webpush.Options{
			HTTPClient: n.client, Subscriber: n.subscriber, TTL: 600, Urgency: webpush.UrgencyHigh,
			VAPIDPublicKey: n.pub, VAPIDPrivateKey: n.priv,
		})
		if err != nil {
			slog.Warn("push failed", "err", err)
			continue
		}
		resp.Body.Close()
		switch {
		case resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusGone:
			_ = n.store.DropPushSubscription(ctx, s.Endpoint) // the browser unsubscribed
		case resp.StatusCode < 300:
			_ = n.store.PushDelivered(ctx, s.Endpoint)
		default:
			slog.Warn("push refused", "status", resp.StatusCode)
		}
	}
}

// endLead is how long before a block ends its owner is asked whether it is done.
const endLead = 5 * time.Minute

// RunReminders checks every `every` for blocks starting within `lead`, and for
// blocks under way ending within endLead, and notifies their owners, until ctx ends.
func (n *Notifier) RunReminders(ctx context.Context, every, lead time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	prune := time.Now()
	for {
		due, err := n.store.ClaimReminders(ctx, lead)
		if err != nil && ctx.Err() == nil {
			slog.Error("reminders", "err", err)
		}
		for _, d := range due {
			mins := int(time.Until(d.StartsAt).Round(time.Minute).Minutes())
			_, err := n.Notify(ctx, d.UserID, store.Notification{
				Kind:  "reminder",
				Title: fmt.Sprintf("%d분 뒤 시작: %s", max(mins, 1), d.Title),
				Body:  fmt.Sprintf("%s–%s", slotTime(d.StartSlot), slotTime(d.EndSlot)),
				Link:  "/day/" + d.Date,
			})
			if err != nil {
				slog.Error("reminder", "err", err)
			}
		}
		ending, err := n.store.ClaimEndReminders(ctx, endLead)
		if err != nil && ctx.Err() == nil {
			slog.Error("end reminders", "err", err)
		}
		for _, d := range ending {
			mins := int(time.Until(d.StartsAt).Round(time.Minute).Minutes())
			_, err := n.Notify(ctx, d.UserID, store.Notification{
				Kind:  "ending",
				Title: fmt.Sprintf("%d분 뒤 끝나요: %s", max(mins, 1), d.Title),
				Body:  "끝냈다면 시간표에서 완료로 표시해요",
				Link:  "/day/" + d.Date,
			})
			if err != nil {
				slog.Error("end reminder", "err", err)
			}
		}
		if time.Since(prune) > 24*time.Hour {
			_ = n.store.PruneNotifications(ctx)
			prune = time.Now()
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

func slotTime(s int) string { return fmt.Sprintf("%02d:%02d", s/6, (s%6)*10) }
