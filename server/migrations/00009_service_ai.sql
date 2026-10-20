-- +goose Up
-- The service's own AI (e.g. a local LLM on a Mac mini), set up by admins and
-- used by every account by default. One row; the app server only reads it.
CREATE TABLE service_ai (
  id            INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled       BOOLEAN NOT NULL DEFAULT false,
  base_url      TEXT NOT NULL DEFAULT '',
  key_sealed    BYTEA,
  key_hint      TEXT NOT NULL DEFAULT '',
  plan_model    TEXT NOT NULL DEFAULT '',
  request_model TEXT NOT NULL DEFAULT '',
  tidy_model    TEXT NOT NULL DEFAULT '',
  concurrency   INT NOT NULL DEFAULT 1 CHECK (concurrency BETWEEN 1 AND 16),
  daily_limit   INT NOT NULL DEFAULT 30 CHECK (daily_limit BETWEEN 0 AND 10000),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by    TEXT NOT NULL DEFAULT '',
  checked_at    TIMESTAMPTZ,
  last_error    TEXT NOT NULL DEFAULT ''
);
INSERT INTO service_ai (id) VALUES (1);

-- One row per AI call, for limits and the admin dashboard (kept 90 days).
CREATE TABLE ai_calls (
  id      BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  feature TEXT NOT NULL,
  source  TEXT NOT NULL CHECK (source IN ('service', 'own', 'server')),
  ms      INT NOT NULL DEFAULT 0,
  ok      BOOLEAN NOT NULL,
  waited_ms INT NOT NULL DEFAULT 0
);
CREATE INDEX ai_calls_user_at ON ai_calls (user_id, at DESC);
CREATE INDEX ai_calls_at ON ai_calls (at DESC);

-- Personal local LLM connections are replaced by the service AI.
DELETE FROM ai_connections WHERE kind = 'openai';

-- +goose Down
DROP TABLE ai_calls;
DROP TABLE service_ai;
