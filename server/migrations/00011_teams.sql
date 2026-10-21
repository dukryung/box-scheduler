-- +goose Up
-- Teams: shared spaces on top of each account's own space. Roles: owner (one
-- per team), manager, member. People join only through an email invite.
CREATE TABLE teams (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE team_members (
  team_id   UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role      TEXT NOT NULL CHECK (role IN ('owner', 'manager', 'member')),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, user_id)
);
CREATE UNIQUE INDEX team_members_one_owner ON team_members (team_id) WHERE role = 'owner';
CREATE INDEX team_members_user ON team_members (user_id);

-- Only a SHA-256 of each invite token is kept; the link is in the email.
CREATE TABLE team_invites (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id     UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('manager', 'member')),
  token_hash  BYTEA NOT NULL UNIQUE,
  invited_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  sent_at     TIMESTAMPTZ,
  accepted_at TIMESTAMPTZ,
  accepted_by UUID REFERENCES users(id) ON DELETE SET NULL,
  revoked_at  TIMESTAMPTZ
);
-- One live invite per address per team.
CREATE UNIQUE INDEX team_invites_live ON team_invites (team_id, lower(email)) WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- New accounts choose personal or team use once; existing ones already have.
ALTER TABLE users ADD COLUMN onboarded BOOLEAN NOT NULL DEFAULT false;
UPDATE users SET onboarded = true;

-- +goose Down
ALTER TABLE users DROP COLUMN onboarded;
DROP TABLE team_invites;
DROP TABLE team_members;
DROP TABLE teams;
