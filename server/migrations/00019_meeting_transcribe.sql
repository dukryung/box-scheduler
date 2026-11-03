-- +goose Up
-- Careful transcription of a recording on the Mac mini (Whisper, with the
-- speakers told apart). Segments are [{start, end, speaker, text}]; speaker
-- names are what people chose for "화자 1", "화자 2", ... ({"1": "김민지"}).
ALTER TABLE meeting_audio
  ADD COLUMN stt_status TEXT NOT NULL DEFAULT 'none' CHECK (stt_status IN ('none', 'queued', 'running', 'done', 'failed')),
  ADD COLUMN stt_stage TEXT NOT NULL DEFAULT '',
  ADD COLUMN stt_error TEXT NOT NULL DEFAULT '',
  ADD COLUMN stt_segments JSONB,
  ADD COLUMN stt_speakers JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN stt_then_minutes BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN stt_started_at TIMESTAMPTZ;

-- +goose Down
ALTER TABLE meeting_audio
  DROP COLUMN stt_status, DROP COLUMN stt_stage, DROP COLUMN stt_error, DROP COLUMN stt_segments,
  DROP COLUMN stt_speakers, DROP COLUMN stt_then_minutes, DROP COLUMN stt_started_at;
