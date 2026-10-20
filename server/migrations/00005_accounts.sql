-- +goose Up
-- Accounts: the seeded single user becomes the owner, who claims it once with a
-- setup token printed in the server log. Everyone else signs up.
ALTER TABLE users
  ADD COLUMN name          TEXT NOT NULL DEFAULT '',
  ADD COLUMN password_hash TEXT,
  ADD COLUMN role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  ADD COLUMN status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  ADD COLUMN is_owner      BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN last_login_at TIMESTAMPTZ;

UPDATE users SET role = 'admin', is_owner = true WHERE id = '00000000-0000-0000-0000-000000000001';
CREATE UNIQUE INDEX users_one_owner ON users (is_owner) WHERE is_owner;
CREATE UNIQUE INDEX users_email_lower ON users (lower(email));

-- Only a SHA-256 of each session token is stored.
CREATE TABLE sessions (
  token_hash   BYTEA PRIMARY KEY,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  user_agent   TEXT NOT NULL DEFAULT ''
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

-- One-time password reset links, issued by an admin.
CREATE TABLE password_resets (
  token_hash BYTEA PRIMARY KEY,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ
);

-- What admins did, for accountability.
CREATE TABLE admin_audit (
  id         BIGSERIAL PRIMARY KEY,
  admin_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  action     TEXT NOT NULL,
  target_id  UUID,
  target     TEXT NOT NULL DEFAULT '',
  detail     TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- AI calls per user and day, shown to admins (counts only).
CREATE TABLE ai_usage (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day     DATE NOT NULL,
  feature TEXT NOT NULL,
  calls   INT NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day, feature)
);

-- +goose Down
DROP TABLE ai_usage;
DROP TABLE admin_audit;
DROP TABLE password_resets;
DROP TABLE sessions;
DROP INDEX users_email_lower;
DROP INDEX users_one_owner;
ALTER TABLE users DROP COLUMN last_login_at, DROP COLUMN is_owner, DROP COLUMN status,
  DROP COLUMN role, DROP COLUMN password_hash, DROP COLUMN name;
