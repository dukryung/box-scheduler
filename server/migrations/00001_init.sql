-- +goose Up
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE users (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email      TEXT UNIQUE NOT NULL,
  timezone   TEXT NOT NULL DEFAULT 'Asia/Seoul',
  prefs      JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Single-user mode: every request runs as this user until auth is added.
INSERT INTO users (id, email) VALUES ('00000000-0000-0000-0000-000000000001', 'local@box-scheduler');

CREATE TABLE days (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date    DATE NOT NULL,
  note    TEXT,
  PRIMARY KEY (user_id, date)
);

CREATE TABLE brain_dump_items (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date           DATE NOT NULL,
  title          TEXT NOT NULL CHECK (title <> ''),
  estimate_boxes SMALLINT CHECK (estimate_boxes BETWEEN 1 AND 144),
  priority       SMALLINT,
  category       TEXT,
  status         TEXT NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open', 'scheduled', 'done', 'dropped')),
  carried_from   DATE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX brain_dump_items_user_date_idx ON brain_dump_items (user_id, date);

-- A block covers slots [start_slot, end_slot); one slot = 10 minutes, 144 per day.
CREATE TABLE time_blocks (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date          DATE NOT NULL,
  start_slot    SMALLINT NOT NULL CHECK (start_slot BETWEEN 0 AND 143),
  end_slot      SMALLINT NOT NULL CHECK (end_slot BETWEEN 1 AND 144),
  title         TEXT NOT NULL CHECK (title <> ''),
  color         TEXT,
  brain_dump_id UUID REFERENCES brain_dump_items(id) ON DELETE SET NULL,
  done          BOOLEAN NOT NULL DEFAULT false,
  source        TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'ai')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_slot > start_slot),
  CONSTRAINT time_blocks_no_overlap EXCLUDE USING gist (
    user_id WITH =,
    date WITH =,
    int4range(start_slot, end_slot) WITH &&
  )
);

CREATE INDEX time_blocks_user_date_idx ON time_blocks (user_id, date);

-- +goose Down
DROP TABLE time_blocks;
DROP TABLE brain_dump_items;
DROP TABLE days;
DROP TABLE users;
