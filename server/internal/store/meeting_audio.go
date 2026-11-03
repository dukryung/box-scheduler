package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

// ErrChunkOrder means a recording piece came out of turn; Expected says which one is due.
type ErrChunkOrder struct{ Expected int }

func (e ErrChunkOrder) Error() string { return "recording piece out of order" }

type MeetingAudio struct {
	ID            string    `json:"id"`
	MeetingID     string    `json:"-"`
	Mime          string    `json:"mime"`
	Bytes         int64     `json:"bytes"`
	Chunks        int       `json:"chunks"`
	DurationSec   int       `json:"durationSec"`
	Finished      bool      `json:"finished"`
	CreatedByName string    `json:"createdByName"`
	CreatedAt     time.Time `json:"createdAt"`

	// Transcription on the Mac mini: none, queued, running, done or failed.
	SttStatus      string            `json:"sttStatus"`
	SttStage       string            `json:"sttStage"`
	SttError       string            `json:"sttError"`
	Segments       []Segment         `json:"segments"`
	SpeakerNames   map[string]string `json:"speakerNames"`
	SttThenMinutes bool              `json:"sttThenMinutes"`
	SttStartedAt   *time.Time        `json:"sttStartedAt"`
}

// Segment is one turn of the transcription: who (1, 2, ...) said what, when (seconds in).
type Segment struct {
	Start   float64 `json:"start"`
	End     float64 `json:"end"`
	Speaker int     `json:"speaker"`
	Text    string  `json:"text"`
}

const audioCols = `a.id::text, a.meeting_id::text, a.mime, a.bytes, a.chunks, a.duration_sec, a.finished, coalesce(u.name, ''), a.created_at,
	a.stt_status, a.stt_stage, a.stt_error, a.stt_segments, a.stt_speakers, a.stt_then_minutes, a.stt_started_at`

func scanAudio(row pgx.Row) (MeetingAudio, error) {
	var a MeetingAudio
	err := row.Scan(&a.ID, &a.MeetingID, &a.Mime, &a.Bytes, &a.Chunks, &a.DurationSec, &a.Finished, &a.CreatedByName, &a.CreatedAt,
		&a.SttStatus, &a.SttStage, &a.SttError, &a.Segments, &a.SpeakerNames, &a.SttThenMinutes, &a.SttStartedAt)
	if a.SpeakerNames == nil {
		a.SpeakerNames = map[string]string{}
	}
	return a, mapErr(err)
}

func (s *Store) MeetingAudios(ctx context.Context, meetingID string) ([]MeetingAudio, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+audioCols+` FROM meeting_audio a LEFT JOIN users u ON u.id = a.created_by
		WHERE a.meeting_id = $1 ORDER BY a.created_at`, meetingID)
	if err != nil {
		return nil, mapErr(err)
	}
	defer rows.Close()
	out := []MeetingAudio{}
	for rows.Next() {
		a, err := scanAudio(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, mapErr(rows.Err())
}

func (s *Store) MeetingAudioByID(ctx context.Context, teamID, meetingID, id string) (MeetingAudio, error) {
	return scanAudio(s.pool.QueryRow(ctx, `SELECT `+audioCols+` FROM meeting_audio a LEFT JOIN users u ON u.id = a.created_by
		WHERE a.team_id = $1 AND a.meeting_id = $2 AND a.id = $3`, teamID, meetingID, id))
}

// CreateMeetingAudio starts a recording on a meeting that is still open.
func (s *Store) CreateMeetingAudio(ctx context.Context, teamID, meetingID, userID, mime string) (MeetingAudio, error) {
	var id string
	err := s.pool.QueryRow(ctx, `INSERT INTO meeting_audio (meeting_id, team_id, mime, created_by)
		SELECT id, team_id, $3, $4 FROM meetings WHERE team_id = $1 AND id = $2 AND status IN ('draft', 'ready') RETURNING id::text`,
		teamID, meetingID, mime, userID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return MeetingAudio{}, s.meetingMissingOr(ctx, s.pool, teamID, meetingID)
	}
	if err != nil {
		return MeetingAudio{}, mapErr(err)
	}
	return s.MeetingAudioByID(ctx, teamID, meetingID, id)
}

// AppendMeetingAudio adds piece seq to a recording. write gets the size the
// file should have before the piece (cutting off any bytes from a failed try)
// and returns how many it added; a piece that already arrived is a no-op. A
// recording keeps taking pieces until its meeting is confirmed.
func (s *Store) AppendMeetingAudio(ctx context.Context, teamID, meetingID, id string, seq int, maxBytes int64, write func(size int64) (int64, error)) (MeetingAudio, error) {
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		var chunks int
		var size int64
		var finished bool
		var status string
		err := tx.QueryRow(ctx, `SELECT a.chunks, a.bytes, a.finished, m.status FROM meeting_audio a JOIN meetings m ON m.id = a.meeting_id
			WHERE a.team_id = $1 AND a.meeting_id = $2 AND a.id = $3 FOR UPDATE OF a`, teamID, meetingID, id).Scan(&chunks, &size, &finished, &status)
		if err != nil {
			return mapErr(err)
		}
		switch {
		case seq < chunks:
			return nil
		case seq > chunks:
			return ErrChunkOrder{Expected: chunks}
		case finished || status == "confirmed":
			return ErrMeetingState
		case size >= maxBytes:
			return ErrInvalid
		}
		n, err := write(size)
		if err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `UPDATE meeting_audio SET chunks = chunks + 1, bytes = bytes + $2, updated_at = now() WHERE id = $1`, id, n)
		return mapErr(err)
	})
	if err != nil {
		return MeetingAudio{}, err
	}
	return s.MeetingAudioByID(ctx, teamID, meetingID, id)
}

func (s *Store) FinishMeetingAudio(ctx context.Context, teamID, meetingID, id string, durationSec int) (MeetingAudio, error) {
	tag, err := s.pool.Exec(ctx, `UPDATE meeting_audio SET finished = true, duration_sec = $4, updated_at = now()
		WHERE team_id = $1 AND meeting_id = $2 AND id = $3`, teamID, meetingID, id, durationSec)
	if err != nil {
		return MeetingAudio{}, mapErr(err)
	}
	if tag.RowsAffected() == 0 {
		return MeetingAudio{}, ErrNotFound
	}
	return s.MeetingAudioByID(ctx, teamID, meetingID, id)
}

func (s *Store) DeleteMeetingAudio(ctx context.Context, teamID, meetingID, id string) error {
	tag, err := s.pool.Exec(ctx, `DELETE FROM meeting_audio WHERE team_id = $1 AND meeting_id = $2 AND id = $3`, teamID, meetingID, id)
	if err == nil && tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return mapErr(err)
}

// MeetingIDs lists every meeting, so recordings of deleted ones can be swept from disk.
func (s *Store) MeetingIDs(ctx context.Context) (map[string]bool, error) {
	rows, err := s.pool.Query(ctx, `SELECT id::text FROM meetings`)
	if err != nil {
		return nil, mapErr(err)
	}
	defer rows.Close()
	out := map[string]bool{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out[id] = true
	}
	return out, mapErr(rows.Err())
}

// StartTranscribe queues a finished recording of an open meeting for
// transcription (again, when it was done or failed before).
func (s *Store) StartTranscribe(ctx context.Context, teamID, meetingID, id string, thenMinutes bool) (MeetingAudio, error) {
	tag, err := s.pool.Exec(ctx, `UPDATE meeting_audio a SET stt_status = 'queued', stt_stage = '', stt_error = '', stt_then_minutes = $4,
		stt_started_at = now(), updated_at = now()
		FROM meetings m WHERE m.id = a.meeting_id AND a.team_id = $1 AND a.meeting_id = $2 AND a.id = $3
		AND a.finished AND a.bytes > 0 AND a.stt_status NOT IN ('queued', 'running') AND m.status IN ('draft', 'ready')`,
		teamID, meetingID, id, thenMinutes)
	if err != nil {
		return MeetingAudio{}, mapErr(err)
	}
	if tag.RowsAffected() == 0 {
		if _, err := s.MeetingAudioByID(ctx, teamID, meetingID, id); err != nil {
			return MeetingAudio{}, err
		}
		return MeetingAudio{}, ErrMeetingState
	}
	return s.MeetingAudioByID(ctx, teamID, meetingID, id)
}

// TranscribeStage records how far a transcription is (running: stage is what it is doing).
func (s *Store) TranscribeStage(ctx context.Context, id, status, stage string) error {
	_, err := s.pool.Exec(ctx, `UPDATE meeting_audio SET stt_status = $2, stt_stage = $3 WHERE id = $1 AND stt_status IN ('queued', 'running')`, id, status, stage)
	return mapErr(err)
}

func (s *Store) FinishTranscribe(ctx context.Context, id string, segments []Segment) error {
	if segments == nil {
		segments = []Segment{}
	}
	tag, err := s.pool.Exec(ctx, `UPDATE meeting_audio SET stt_status = 'done', stt_stage = '', stt_segments = $2, updated_at = now()
		WHERE id = $1 AND stt_status IN ('queued', 'running')`, id, segments)
	if err == nil && tag.RowsAffected() == 0 {
		return ErrMeetingState
	}
	return mapErr(err)
}

func (s *Store) FailTranscribe(ctx context.Context, id, msg string) error {
	_, err := s.pool.Exec(ctx, `UPDATE meeting_audio SET stt_status = 'failed', stt_stage = '', stt_error = $2, stt_then_minutes = false, updated_at = now()
		WHERE id = $1 AND stt_status IN ('queued', 'running')`, id, msg)
	return mapErr(err)
}

// ResetTranscribe fails every transcription still marked as going; on start-up
// none can be (the previous process was waiting for them).
func (s *Store) ResetTranscribe(ctx context.Context, msg string) error {
	_, err := s.pool.Exec(ctx, `UPDATE meeting_audio SET stt_status = 'failed', stt_stage = '', stt_error = $1, stt_then_minutes = false
		WHERE stt_status IN ('queued', 'running')`, msg)
	return mapErr(err)
}

// SetSpeakerNames saves who "화자 1", "화자 2", ... are.
func (s *Store) SetSpeakerNames(ctx context.Context, teamID, meetingID, id string, names map[string]string) (MeetingAudio, error) {
	tag, err := s.pool.Exec(ctx, `UPDATE meeting_audio SET stt_speakers = $4, updated_at = now() WHERE team_id = $1 AND meeting_id = $2 AND id = $3`,
		teamID, meetingID, id, names)
	if err != nil {
		return MeetingAudio{}, mapErr(err)
	}
	if tag.RowsAffected() == 0 {
		return MeetingAudio{}, ErrNotFound
	}
	return s.MeetingAudioByID(ctx, teamID, meetingID, id)
}

// SetTranscript replaces an open meeting's text (with the transcription).
func (s *Store) SetTranscript(ctx context.Context, teamID, id, transcript string) error {
	tag, err := s.pool.Exec(ctx, `UPDATE meetings SET transcript = $3, updated_at = now() WHERE team_id = $1 AND id = $2 AND status IN ('draft', 'ready')`,
		teamID, id, transcript)
	if err != nil {
		return mapErr(err)
	}
	if tag.RowsAffected() == 0 {
		return s.meetingMissingOr(ctx, s.pool, teamID, id)
	}
	return nil
}
