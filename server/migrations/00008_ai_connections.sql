-- +goose Up
-- Each account's own AI: an Anthropic API key or an OpenAI-compatible local
-- server (Ollama, LM Studio). Keys are stored sealed (AES-GCM, AI_SECRET_KEY).
CREATE TABLE ai_connections (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('anthropic', 'openai')),
  label      TEXT NOT NULL DEFAULT '',
  base_url   TEXT,
  model      TEXT NOT NULL,
  key_sealed BYTEA,
  key_hint   TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  checked_at TIMESTAMPTZ,
  last_error TEXT NOT NULL DEFAULT ''
);
CREATE INDEX ai_connections_user ON ai_connections (user_id);

-- Which AI each feature uses: 'server' (the owner's subscription), a connection id, or '' (none).
CREATE TABLE ai_settings (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  plan    TEXT NOT NULL DEFAULT '',
  request TEXT NOT NULL DEFAULT '',
  tidy    TEXT NOT NULL DEFAULT ''
);

-- Admins see how many connections an account has, never the keys.
CREATE OR REPLACE VIEW admin.user_counts AS
SELECT u.id AS user_id,
       (SELECT count(*) FROM public.time_blocks b WHERE b.user_id = u.id)      AS blocks,
       (SELECT count(*) FROM public.brain_dump_items i WHERE i.user_id = u.id) AS items,
       COALESCE((SELECT sum(calls) FROM public.ai_usage a WHERE a.user_id = u.id AND a.day > current_date - 30), 0) AS ai_calls_30d,
       (SELECT count(*) FROM public.ai_connections c WHERE c.user_id = u.id) AS ai_connections
  FROM public.users u;

-- +goose Down
CREATE OR REPLACE VIEW admin.user_counts AS
SELECT u.id AS user_id,
       (SELECT count(*) FROM public.time_blocks b WHERE b.user_id = u.id)      AS blocks,
       (SELECT count(*) FROM public.brain_dump_items i WHERE i.user_id = u.id) AS items,
       COALESCE((SELECT sum(calls) FROM public.ai_usage a WHERE a.user_id = u.id AND a.day > current_date - 30), 0) AS ai_calls_30d
  FROM public.users u;
DROP TABLE ai_settings;
DROP TABLE ai_connections;
