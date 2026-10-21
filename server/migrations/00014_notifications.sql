-- +goose Up
-- Notifications: what happened to you in a team (assigned, your share split) and
-- a reminder 10 minutes before each timetable block. They are listed in the app
-- and, for browsers that subscribed, sent as Web Push.
CREATE TABLE notifications (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('assigned', 'split', 'reminder', 'test')),
  title      TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  link       TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at    TIMESTAMPTZ
);
CREATE INDEX notifications_user ON notifications (user_id, created_at DESC);

-- One row per browser that allowed notifications.
CREATE TABLE push_subscriptions (
  endpoint   TEXT PRIMARY KEY,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  user_agent TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_ok_at TIMESTAMPTZ
);
CREATE INDEX push_subscriptions_user ON push_subscriptions (user_id);

-- The service's VAPID key pair, made on first start; the private half sealed.
CREATE TABLE push_keys (
  id             BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
  public_key     TEXT NOT NULL,
  private_sealed BYTEA NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A block's reminder goes out once per start time (moving the block reminds again).
CREATE TABLE block_reminders (
  block_id  UUID NOT NULL REFERENCES time_blocks(id) ON DELETE CASCADE,
  starts_at TIMESTAMPTZ NOT NULL,
  sent_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (block_id, starts_at)
);

ALTER TABLE users ADD COLUMN notify_reminders BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE users ADD COLUMN notify_team BOOLEAN NOT NULL DEFAULT true;

-- +goose Down
ALTER TABLE users DROP COLUMN notify_team;
ALTER TABLE users DROP COLUMN notify_reminders;
DROP TABLE block_reminders;
DROP TABLE push_keys;
DROP TABLE push_subscriptions;
DROP TABLE notifications;
