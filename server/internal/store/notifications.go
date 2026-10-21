package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

type Notification struct {
	ID        string     `json:"id"`
	Kind      string     `json:"kind"` // assigned | split | reminder | test
	Title     string     `json:"title"`
	Body      string     `json:"body"`
	Link      string     `json:"link"`
	CreatedAt time.Time  `json:"createdAt"`
	ReadAt    *time.Time `json:"readAt"`
}

type NotifySettings struct {
	Reminders bool   `json:"reminders"`
	Team      bool   `json:"team"`
	Timezone  string `json:"timezone"`
}

type PushSubscription struct {
	Endpoint string
	UserID   string
	P256dh   string
	Auth     string
}

func (s *Store) AddNotification(ctx context.Context, userID string, n Notification) (Notification, error) {
	err := s.pool.QueryRow(ctx, `INSERT INTO notifications (user_id, kind, title, body, link) VALUES ($1, $2, $3, $4, $5) RETURNING id::text, created_at`,
		userID, n.Kind, n.Title, n.Body, n.Link).Scan(&n.ID, &n.CreatedAt)
	return n, mapErr(err)
}

// Notifications lists the latest notifications and how many are unread.
func (s *Store) Notifications(ctx context.Context, userID string, limit int) ([]Notification, int, error) {
	rows, err := s.pool.Query(ctx, `SELECT id::text, kind, title, body, link, created_at, read_at FROM notifications
		WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`, userID, limit)
	if err != nil {
		return nil, 0, mapErr(err)
	}
	list := []Notification{}
	for rows.Next() {
		var n Notification
		if err := rows.Scan(&n.ID, &n.Kind, &n.Title, &n.Body, &n.Link, &n.CreatedAt, &n.ReadAt); err != nil {
			rows.Close()
			return nil, 0, err
		}
		list = append(list, n)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, 0, mapErr(err)
	}
	var unread int
	err = s.pool.QueryRow(ctx, `SELECT count(*) FROM notifications WHERE user_id = $1 AND read_at IS NULL`, userID).Scan(&unread)
	return list, unread, mapErr(err)
}

// MarkNotificationsRead marks the given ones read, or all when ids is empty.
func (s *Store) MarkNotificationsRead(ctx context.Context, userID string, ids []string) error {
	var err error
	if len(ids) == 0 {
		_, err = s.pool.Exec(ctx, `UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL`, userID)
	} else {
		_, err = s.pool.Exec(ctx, `UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL AND id = ANY($2::uuid[])`, userID, ids)
	}
	return mapErr(err)
}

// PruneNotifications keeps each account's list short: read ones older than 30 days go.
func (s *Store) PruneNotifications(ctx context.Context) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM notifications WHERE read_at IS NOT NULL AND created_at < now() - interval '30 days'`)
	return mapErr(err)
}

func (s *Store) NotifySettings(ctx context.Context, userID string) (NotifySettings, error) {
	var n NotifySettings
	err := s.pool.QueryRow(ctx, `SELECT notify_reminders, notify_team, timezone FROM users WHERE id = $1`, userID).Scan(&n.Reminders, &n.Team, &n.Timezone)
	return n, mapErr(err)
}

func (s *Store) SetNotifySettings(ctx context.Context, userID string, n NotifySettings) error {
	_, err := s.pool.Exec(ctx, `UPDATE users SET notify_reminders = $2, notify_team = $3, timezone = $4 WHERE id = $1`, userID, n.Reminders, n.Team, n.Timezone)
	return mapErr(err)
}

// ---- Web Push ----

// PushKeys returns the stored VAPID key pair (private half sealed), or ErrNotFound.
func (s *Store) PushKeys(ctx context.Context) (string, []byte, error) {
	var pub string
	var sealed []byte
	err := s.pool.QueryRow(ctx, `SELECT public_key, private_sealed FROM push_keys`).Scan(&pub, &sealed)
	return pub, sealed, mapErr(err)
}

// SavePushKeys stores a key pair unless one exists (two servers starting at
// once agree on the first), and returns the one kept.
func (s *Store) SavePushKeys(ctx context.Context, pub string, sealed []byte) (string, []byte, error) {
	if _, err := s.pool.Exec(ctx, `INSERT INTO push_keys (public_key, private_sealed) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`, pub, sealed); err != nil {
		return "", nil, mapErr(err)
	}
	return s.PushKeys(ctx)
}

func (s *Store) SavePushSubscription(ctx context.Context, p PushSubscription, userAgent string) error {
	_, err := s.pool.Exec(ctx, `INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, user_agent) VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, user_agent = EXCLUDED.user_agent`,
		p.Endpoint, p.UserID, p.P256dh, p.Auth, userAgent)
	return mapErr(err)
}

func (s *Store) DeletePushSubscription(ctx context.Context, userID, endpoint string) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2`, userID, endpoint)
	return mapErr(err)
}

// DropPushSubscription forgets an endpoint the push service says is gone.
func (s *Store) DropPushSubscription(ctx context.Context, endpoint string) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM push_subscriptions WHERE endpoint = $1`, endpoint)
	return mapErr(err)
}

func (s *Store) PushDelivered(ctx context.Context, endpoint string) error {
	_, err := s.pool.Exec(ctx, `UPDATE push_subscriptions SET last_ok_at = now() WHERE endpoint = $1`, endpoint)
	return mapErr(err)
}

func (s *Store) PushSubscriptions(ctx context.Context, userID string) ([]PushSubscription, error) {
	rows, err := s.pool.Query(ctx, `SELECT endpoint, user_id::text, p256dh, auth FROM push_subscriptions WHERE user_id = $1`, userID)
	if err != nil {
		return nil, mapErr(err)
	}
	defer rows.Close()
	list := []PushSubscription{}
	for rows.Next() {
		var p PushSubscription
		if err := rows.Scan(&p.Endpoint, &p.UserID, &p.P256dh, &p.Auth); err != nil {
			return nil, err
		}
		list = append(list, p)
	}
	return list, mapErr(rows.Err())
}

// ---- block reminders ----

type DueReminder struct {
	BlockID   string
	UserID    string
	Title     string
	Date      string
	StartSlot int
	EndSlot   int
	StartsAt  time.Time
}

// ClaimReminders finds open blocks starting within lead from now (in each
// account's time zone) that have not been reminded at that start time, and
// records them as reminded, so each goes out once even with several servers.
func (s *Store) ClaimReminders(ctx context.Context, lead time.Duration) ([]DueReminder, error) {
	var out []DueReminder
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `
			WITH due AS (
				SELECT b.id, b.user_id, b.title, b.date::text AS date, b.start_slot, b.end_slot,
				       ((b.date + make_interval(mins => b.start_slot * 10))::timestamp AT TIME ZONE u.timezone) AS starts_at
				FROM time_blocks b JOIN users u ON u.id = b.user_id
				WHERE u.notify_reminders AND u.status = 'active' AND NOT b.done
				  AND b.date BETWEEN current_date - 1 AND current_date + 1
			)
			INSERT INTO block_reminders (block_id, starts_at)
			SELECT id, starts_at FROM due WHERE starts_at > now() AND starts_at <= now() + make_interval(secs => $1)
			ON CONFLICT DO NOTHING
			RETURNING block_id::text, starts_at`, lead.Seconds())
		if err != nil {
			return mapErr(err)
		}
		claimed := map[string]time.Time{}
		for rows.Next() {
			var id string
			var at time.Time
			if err := rows.Scan(&id, &at); err != nil {
				rows.Close()
				return err
			}
			claimed[id] = at
		}
		rows.Close()
		if err := rows.Err(); err != nil || len(claimed) == 0 {
			return mapErr(err)
		}
		ids := make([]string, 0, len(claimed))
		for id := range claimed {
			ids = append(ids, id)
		}
		rows, err = tx.Query(ctx, `SELECT id::text, user_id::text, title, date::text, start_slot, end_slot FROM time_blocks WHERE id = ANY($1::uuid[])`, ids)
		if err != nil {
			return mapErr(err)
		}
		defer rows.Close()
		for rows.Next() {
			var d DueReminder
			if err := rows.Scan(&d.BlockID, &d.UserID, &d.Title, &d.Date, &d.StartSlot, &d.EndSlot); err != nil {
				return err
			}
			d.StartsAt = claimed[d.BlockID]
			out = append(out, d)
		}
		return mapErr(rows.Err())
	})
	return out, err
}

// IsNotFound reports whether err is the store's not-found.
func IsNotFound(err error) bool { return errors.Is(err, ErrNotFound) }
