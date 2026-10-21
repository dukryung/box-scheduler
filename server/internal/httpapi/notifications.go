package httpapi

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"box-scheduler/server/internal/store"
)

// notifyTeam tells someone about a change a teammate made, if they want team
// notifications. It never fails the request that caused it.
func (a *API) notifyTeam(ctx context.Context, userID string, n store.Notification) {
	if a.opts.Notify == nil {
		return
	}
	s, err := a.store.NotifySettings(ctx, userID)
	if err != nil || !s.Team {
		return
	}
	if _, err := a.opts.Notify.Notify(ctx, userID, n); err != nil {
		slog.Error("notify", "kind", n.Kind, "err", err)
	}
}

func (a *API) listNotifications(w http.ResponseWriter, r *http.Request) {
	u := currentUser(r)
	items, unread, err := a.store.Notifications(r.Context(), u.ID, 30)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	settings, err := a.store.NotifySettings(r.Context(), u.ID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items, "unread": unread, "settings": settings})
}

func (a *API) readNotifications(w http.ResponseWriter, r *http.Request) {
	var body struct {
		IDs []string `json:"ids"` // empty: all
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	if err := a.store.MarkNotificationsRead(r.Context(), currentUser(r).ID, body.IDs); err != nil {
		writeStoreError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) updateNotifySettings(w http.ResponseWriter, r *http.Request) {
	var body store.NotifySettings
	if !decodeJSON(w, r, &body) {
		return
	}
	if _, err := time.LoadLocation(body.Timezone); err != nil || body.Timezone == "" {
		writeError(w, http.StatusBadRequest, "시간대가 올바르지 않아요")
		return
	}
	if err := a.store.SetNotifySettings(r.Context(), currentUser(r).ID, body); err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, body)
}

func (a *API) pushKey(w http.ResponseWriter, r *http.Request) {
	if !a.opts.Notify.PushEnabled() {
		writeJSON(w, http.StatusOK, map[string]any{"enabled": false})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"enabled": true, "publicKey": a.opts.Notify.PublicKey()})
}

type pushSubBody struct {
	Endpoint string `json:"endpoint"`
	Keys     struct {
		P256dh string `json:"p256dh"`
		Auth   string `json:"auth"`
	} `json:"keys"`
	Timezone string `json:"timezone"`
}

func (a *API) subscribePush(w http.ResponseWriter, r *http.Request) {
	if !a.opts.Notify.PushEnabled() {
		writeError(w, http.StatusServiceUnavailable, "이 서버에서는 브라우저 알림을 보낼 수 없어요")
		return
	}
	var body pushSubBody
	if !decodeJSON(w, r, &body) {
		return
	}
	if !a.opts.Notify.AllowedEndpoint(body.Endpoint) || body.Keys.P256dh == "" || body.Keys.Auth == "" || len(body.Endpoint) > 1000 {
		writeError(w, http.StatusBadRequest, "알 수 없는 알림 서비스예요")
		return
	}
	u := currentUser(r)
	if err := a.store.SavePushSubscription(r.Context(), store.PushSubscription{Endpoint: body.Endpoint, UserID: u.ID, P256dh: body.Keys.P256dh, Auth: body.Keys.Auth}, trimUA(r.UserAgent())); err != nil {
		writeStoreError(w, err)
		return
	}
	// Reminders are worked out in the browser's time zone.
	if _, err := time.LoadLocation(body.Timezone); err == nil && body.Timezone != "" {
		if s, err := a.store.NotifySettings(r.Context(), u.ID); err == nil && s.Timezone != body.Timezone {
			s.Timezone = body.Timezone
			_ = a.store.SetNotifySettings(r.Context(), u.ID, s)
		}
	}
	w.WriteHeader(http.StatusCreated)
}

func (a *API) unsubscribePush(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Endpoint string `json:"endpoint"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	if err := a.store.DeletePushSubscription(r.Context(), currentUser(r).ID, body.Endpoint); err != nil {
		writeStoreError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// testPush sends a notification to the caller right away, to check their setup.
func (a *API) testPush(w http.ResponseWriter, r *http.Request) {
	if a.opts.Notify == nil {
		writeError(w, http.StatusServiceUnavailable, "알림이 꺼져 있어요")
		return
	}
	n, err := a.opts.Notify.Notify(r.Context(), currentUser(r).ID, store.Notification{
		Kind: "test", Title: "알림이 잘 와요", Body: "Box Scheduler 알림 테스트예요", Link: "/settings",
	})
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, n)
}

func trimUA(ua string) string {
	if len(ua) > 200 {
		return ua[:200]
	}
	return ua
}

// shareText is "맡은 시간 12시간" when a share is set.
func shareText(boxes *int) string {
	if boxes == nil {
		return ""
	}
	return fmt.Sprintf(" · 맡은 시간 %s", formatHours(*boxes))
}
