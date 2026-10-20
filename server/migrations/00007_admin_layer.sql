-- +goose Up
-- Admin layer: operators have their own accounts, sessions and audit log in the
-- admin schema, apart from app users. The admin server reads app data through
-- the views below; the database roles that enforce this are set up by cmd/migrate.
CREATE SCHEMA admin;

CREATE TABLE admin.accounts (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email                TEXT NOT NULL,
  name                 TEXT NOT NULL DEFAULT '',
  password_hash        TEXT NOT NULL,
  role                 TEXT NOT NULL CHECK (role IN ('super', 'operator')),
  status               TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  must_change_password BOOLEAN NOT NULL DEFAULT true,
  totp_secret          TEXT,
  totp_enabled         BOOLEAN NOT NULL DEFAULT false,
  totp_last_step       BIGINT NOT NULL DEFAULT 0,
  failed_logins        INT NOT NULL DEFAULT 0,
  locked_until         TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at        TIMESTAMPTZ
);
CREATE UNIQUE INDEX admin_accounts_email ON admin.accounts (lower(email));

-- mfa_ok turns true once the second factor is checked; until then only the
-- sign-in steps (password change, 2FA enrollment or code) are allowed.
CREATE TABLE admin.sessions (
  token_hash   BYTEA PRIMARY KEY,
  admin_id     UUID NOT NULL REFERENCES admin.accounts(id) ON DELETE CASCADE,
  mfa_ok       BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  ip           TEXT NOT NULL DEFAULT '',
  user_agent   TEXT NOT NULL DEFAULT ''
);
CREATE INDEX admin_sessions_admin ON admin.sessions (admin_id);

CREATE TABLE admin.audit (
  id         BIGSERIAL PRIMARY KEY,
  actor      TEXT NOT NULL,
  action     TEXT NOT NULL,
  target_id  UUID,
  target     TEXT NOT NULL DEFAULT '',
  detail     TEXT NOT NULL DEFAULT '',
  ip         TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX admin_audit_created ON admin.audit (created_at DESC);

INSERT INTO admin.audit (actor, action, target_id, target, detail, created_at)
SELECT COALESCE(u.email, '(삭제된 계정)'), a.action, a.target_id, a.target, a.detail, a.created_at
  FROM public.admin_audit a LEFT JOIN public.users u ON u.id = a.admin_id;
DROP TABLE public.admin_audit;

-- Operators' notes about an app account.
CREATE TABLE admin.notes (
  id         BIGSERIAL PRIMARY KEY,
  user_id    UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  author     TEXT NOT NULL,
  body       TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX admin_notes_user ON admin.notes (user_id, created_at DESC);

-- Which days each app account was used, for the dashboard's activity chart.
CREATE TABLE public.user_activity (
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  day     DATE NOT NULL,
  PRIMARY KEY (user_id, day)
);
INSERT INTO public.user_activity (user_id, day)
SELECT DISTINCT user_id, last_seen_at::date FROM public.sessions;

-- Reset links are now issued by operators, not app accounts.
ALTER TABLE public.password_resets DROP COLUMN created_by, ADD COLUMN issued_by TEXT NOT NULL DEFAULT '';

-- App accounts no longer carry admin rights.
ALTER TABLE public.users DROP COLUMN role;

-- Counts the admin server may see: how much each account has, never what.
CREATE VIEW admin.user_counts AS
SELECT u.id AS user_id,
       (SELECT count(*) FROM public.time_blocks b WHERE b.user_id = u.id)      AS blocks,
       (SELECT count(*) FROM public.brain_dump_items i WHERE i.user_id = u.id) AS items,
       COALESCE((SELECT sum(calls) FROM public.ai_usage a WHERE a.user_id = u.id AND a.day > current_date - 30), 0) AS ai_calls_30d
  FROM public.users u;

-- The account facts the admin server may read (no password hashes or Google ids).
CREATE VIEW admin.user_accounts AS
SELECT id, email, name, status, is_owner, created_at, last_login_at,
       password_hash IS NOT NULL AS has_password, google_sub IS NOT NULL AS google
  FROM public.users;

-- +goose Down
DROP VIEW admin.user_accounts;
DROP VIEW admin.user_counts;
ALTER TABLE public.users ADD COLUMN role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin'));
UPDATE public.users SET role = 'admin' WHERE is_owner;
ALTER TABLE public.password_resets DROP COLUMN issued_by, ADD COLUMN created_by UUID REFERENCES public.users(id) ON DELETE SET NULL;
DROP TABLE public.user_activity;
CREATE TABLE public.admin_audit (
  id         BIGSERIAL PRIMARY KEY,
  admin_id   UUID REFERENCES public.users(id) ON DELETE SET NULL,
  action     TEXT NOT NULL,
  target_id  UUID,
  target     TEXT NOT NULL DEFAULT '',
  detail     TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
DROP SCHEMA admin CASCADE;
