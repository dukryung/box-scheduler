package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

// ErrMeetingState means the meeting is not in a state that allows the change
// (the AI is at work on it, or it was confirmed).
var ErrMeetingState = errors.New("meeting state does not allow this")

// Minutes are what the AI (then a person) writes from a meeting.
type Minutes struct {
	Summary   string         `json:"summary"`
	Decisions []string       `json:"decisions"`
	Topics    []MinutesTopic `json:"topics"`
}

type MinutesTopic struct {
	Title  string   `json:"title"`
	Points []string `json:"points"`
}

type Meeting struct {
	ID              string         `json:"id"`
	Title           string         `json:"title"`
	HeldOn          string         `json:"heldOn"`
	Transcript      string         `json:"transcript,omitempty"`
	Minutes         *Minutes       `json:"minutes"`
	Status          string         `json:"status"` // draft | processing | ready | confirmed
	AIError         string         `json:"aiError"`
	AIDone          int            `json:"aiDone"`
	AIParts         int            `json:"aiParts"`
	CreatedBy       string         `json:"createdBy"` // "" once that account is gone
	CreatedByName   string         `json:"createdByName"`
	ConfirmedByName string         `json:"confirmedByName"`
	ConfirmedAt     *time.Time     `json:"confirmedAt"`
	CreatedAt       time.Time      `json:"createdAt"`
	UpdatedAt       time.Time      `json:"updatedAt"`
	TaskCount       int            `json:"taskCount"`
	Tasks           []MeetingTask  `json:"tasks"`
	Audio           []MeetingAudio `json:"audio"`
	// What the caller may do with it, worked out from their role.
	CanEdit    bool `json:"canEdit"`
	CanConfirm bool `json:"canConfirm"`
	CanDelete  bool `json:"canDelete"`
}

// MeetingTask is a task found in a meeting; once confirmed it points at the team task it became.
type MeetingTask struct {
	ID         string  `json:"id,omitempty"`
	Title      string  `json:"title"`
	Note       string  `json:"note"`
	Evidence   string  `json:"evidence"`
	DueDate    *string `json:"dueDate"`
	AssigneeID string  `json:"assigneeId"` // "": no one yet
	TeamTaskID string  `json:"teamTaskId,omitempty"`
}

const meetingCols = `m.id::text, m.title, to_char(m.held_on, 'YYYY-MM-DD'), m.minutes, m.status, m.ai_error, m.ai_done, m.ai_parts,
	coalesce(m.created_by::text, ''), coalesce(cu.name, ''), coalesce(fu.name, ''), m.confirmed_at, m.created_at, m.updated_at,
	(SELECT count(*) FROM meeting_tasks t WHERE t.meeting_id = m.id)::int`

const meetingFrom = ` FROM meetings m LEFT JOIN users cu ON cu.id = m.created_by LEFT JOIN users fu ON fu.id = m.confirmed_by `

func scanMeeting(row pgx.Row, extra ...any) (Meeting, error) {
	var m Meeting
	err := row.Scan(append([]any{&m.ID, &m.Title, &m.HeldOn, &m.Minutes, &m.Status, &m.AIError, &m.AIDone, &m.AIParts,
		&m.CreatedBy, &m.CreatedByName, &m.ConfirmedByName, &m.ConfirmedAt, &m.CreatedAt, &m.UpdatedAt, &m.TaskCount}, extra...)...)
	m.Tasks = []MeetingTask{}
	m.Audio = []MeetingAudio{}
	return m, err
}

// Meetings lists a team's meetings, latest first, without their text and tasks.
func (s *Store) Meetings(ctx context.Context, teamID string) ([]Meeting, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+meetingCols+meetingFrom+`WHERE m.team_id = $1 ORDER BY m.held_on DESC, m.created_at DESC`, teamID)
	if err != nil {
		return nil, mapErr(err)
	}
	defer rows.Close()
	list := []Meeting{}
	for rows.Next() {
		m, err := scanMeeting(rows)
		if err != nil {
			return nil, err
		}
		list = append(list, m)
	}
	return list, mapErr(rows.Err())
}

func (s *Store) MeetingByID(ctx context.Context, teamID, id string) (Meeting, error) {
	var m Meeting
	var transcript string
	m, err := scanMeeting(s.pool.QueryRow(ctx, `SELECT `+meetingCols+`, m.transcript`+meetingFrom+`WHERE m.team_id = $1 AND m.id = $2`, teamID, id), &transcript)
	if err != nil {
		return m, mapErr(err)
	}
	m.Transcript = transcript
	rows, err := s.pool.Query(ctx, `SELECT id::text, title, note, evidence, to_char(due_date, 'YYYY-MM-DD'), coalesce(assignee_id::text, ''), coalesce(team_task_id::text, '')
		FROM meeting_tasks WHERE meeting_id = $1 ORDER BY position`, id)
	if err != nil {
		return m, mapErr(err)
	}
	defer rows.Close()
	for rows.Next() {
		var t MeetingTask
		if err := rows.Scan(&t.ID, &t.Title, &t.Note, &t.Evidence, &t.DueDate, &t.AssigneeID, &t.TeamTaskID); err != nil {
			return m, err
		}
		m.Tasks = append(m.Tasks, t)
	}
	if err := rows.Err(); err != nil {
		return m, mapErr(err)
	}
	m.Audio, err = s.MeetingAudios(ctx, id)
	return m, err
}

func (s *Store) CreateMeeting(ctx context.Context, teamID, userID, title, heldOn, transcript string) (Meeting, error) {
	var id string
	err := s.pool.QueryRow(ctx, `INSERT INTO meetings (team_id, title, held_on, transcript, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id::text`,
		teamID, title, heldOn, transcript, userID).Scan(&id)
	if err != nil {
		return Meeting{}, mapErr(err)
	}
	return s.MeetingByID(ctx, teamID, id)
}

// MeetingFields are the editable parts of a meeting.
type MeetingFields struct {
	Title      string
	HeldOn     string
	Transcript string
	Minutes    *Minutes
}

// UpdateMeeting saves all fields; tasks are replaced unless nil. Only a meeting
// the AI is not at work on and that is not confirmed can change.
func (s *Store) UpdateMeeting(ctx context.Context, teamID, id string, f MeetingFields, tasks []MeetingTask) (Meeting, error) {
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `UPDATE meetings SET title = $3, held_on = $4, transcript = $5, minutes = $6,
			status = CASE WHEN $6::jsonb IS NULL AND status = 'ready' THEN 'draft' ELSE status END, updated_at = now()
			WHERE team_id = $1 AND id = $2 AND status IN ('draft', 'ready')`, teamID, id, f.Title, f.HeldOn, f.Transcript, f.Minutes)
		if err != nil {
			return mapErr(err)
		}
		if tag.RowsAffected() == 0 {
			return s.meetingMissingOr(ctx, tx, teamID, id)
		}
		if tasks == nil {
			return nil
		}
		return replaceMeetingTasks(ctx, tx, teamID, id, tasks)
	})
	if err != nil {
		return Meeting{}, err
	}
	return s.MeetingByID(ctx, teamID, id)
}

// meetingMissingOr tells a meeting that is not there from one in the wrong state.
func (s *Store) meetingMissingOr(ctx context.Context, q dbtx, teamID, id string) error {
	var n int
	if err := q.QueryRow(ctx, `SELECT count(*) FROM meetings WHERE team_id = $1 AND id = $2`, teamID, id).Scan(&n); err != nil {
		return mapErr(err)
	}
	if n == 0 {
		return ErrNotFound
	}
	return ErrMeetingState
}

func replaceMeetingTasks(ctx context.Context, tx pgx.Tx, teamID, id string, tasks []MeetingTask) error {
	if _, err := tx.Exec(ctx, `DELETE FROM meeting_tasks WHERE meeting_id = $1`, id); err != nil {
		return mapErr(err)
	}
	for i, t := range tasks {
		if _, err := tx.Exec(ctx, `INSERT INTO meeting_tasks (meeting_id, team_id, title, note, evidence, due_date, assignee_id, position, team_task_id)
			VALUES ($1, $2, $3, $4, $5, $6, NULLIF($7, '')::uuid, $8, NULLIF($9, '')::uuid)`,
			id, teamID, t.Title, t.Note, t.Evidence, t.DueDate, t.AssigneeID, i, t.TeamTaskID); err != nil {
			return mapErr(err)
		}
	}
	return nil
}

func (s *Store) DeleteMeeting(ctx context.Context, teamID, id string) error {
	tag, err := s.pool.Exec(ctx, `DELETE FROM meetings WHERE team_id = $1 AND id = $2 AND status <> 'processing'`, teamID, id)
	if err != nil {
		return mapErr(err)
	}
	if tag.RowsAffected() == 0 {
		return s.meetingMissingOr(ctx, s.pool, teamID, id)
	}
	return nil
}

// StartMeetingAI marks the meeting as being written up from parts pieces of text.
func (s *Store) StartMeetingAI(ctx context.Context, teamID, id string, parts int) error {
	tag, err := s.pool.Exec(ctx, `UPDATE meetings SET status = 'processing', ai_error = '', ai_done = 0, ai_parts = $3, updated_at = now()
		WHERE team_id = $1 AND id = $2 AND status IN ('draft', 'ready')`, teamID, id, parts)
	if err != nil {
		return mapErr(err)
	}
	if tag.RowsAffected() == 0 {
		return s.meetingMissingOr(ctx, s.pool, teamID, id)
	}
	return nil
}

func (s *Store) MeetingAIProgress(ctx context.Context, id string, done int) error {
	_, err := s.pool.Exec(ctx, `UPDATE meetings SET ai_done = $2 WHERE id = $1 AND status = 'processing'`, id, done)
	return mapErr(err)
}

// FinishMeetingAI saves the minutes and the tasks found, ready to be checked.
func (s *Store) FinishMeetingAI(ctx context.Context, teamID, id string, minutes Minutes, tasks []MeetingTask) error {
	return s.inTx(ctx, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `UPDATE meetings SET status = 'ready', minutes = $3, ai_done = ai_parts, updated_at = now()
			WHERE team_id = $1 AND id = $2 AND status = 'processing'`, teamID, id, minutes)
		if err != nil {
			return mapErr(err)
		}
		if tag.RowsAffected() == 0 {
			return ErrMeetingState
		}
		return replaceMeetingTasks(ctx, tx, teamID, id, tasks)
	})
}

// FailMeetingAI leaves the meeting as it was before (draft, or ready with the
// earlier minutes) with a message for the person.
func (s *Store) FailMeetingAI(ctx context.Context, id, msg string) error {
	_, err := s.pool.Exec(ctx, `UPDATE meetings SET status = CASE WHEN minutes IS NULL THEN 'draft' ELSE 'ready' END, ai_error = $2, updated_at = now()
		WHERE id = $1 AND status = 'processing'`, id, msg)
	return mapErr(err)
}

// ResetMeetingAI fails every write-up still marked as running; on start-up
// none can be (they ran in the previous process).
func (s *Store) ResetMeetingAI(ctx context.Context, msg string) error {
	_, err := s.pool.Exec(ctx, `UPDATE meetings SET status = CASE WHEN minutes IS NULL THEN 'draft' ELSE 'ready' END, ai_error = $1
		WHERE status = 'processing'`, msg)
	return mapErr(err)
}

// ConfirmMeeting turns tasks into team tasks (each with its one assignee, when
// given) and marks the meeting confirmed. It returns the ids of the tasks made.
func (s *Store) ConfirmMeeting(ctx context.Context, teamID, id, userID string, tasks []MeetingTask) ([]string, error) {
	ids := []string{}
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		var title, heldOn string
		err := tx.QueryRow(ctx, `SELECT title, to_char(held_on, 'YYYY-MM-DD') FROM meetings WHERE team_id = $1 AND id = $2 AND status IN ('draft', 'ready') FOR UPDATE`,
			teamID, id).Scan(&title, &heldOn)
		if errors.Is(err, pgx.ErrNoRows) {
			return s.meetingMissingOr(ctx, tx, teamID, id)
		}
		if err != nil {
			return mapErr(err)
		}
		for i := range tasks {
			t := &tasks[i]
			note := "회의: " + title + " (" + heldOn + ")"
			if t.Note != "" {
				note = t.Note + "\n\n" + note
			}
			var assignees []AssigneeInput
			if t.AssigneeID != "" {
				assignees = []AssigneeInput{{UserID: t.AssigneeID}}
			}
			if t.TeamTaskID, err = insertTeamTask(ctx, tx, teamID, userID, TeamTaskFields{Title: t.Title, Note: note, Status: "todo", DueDate: t.DueDate}, assignees); err != nil {
				return err
			}
			ids = append(ids, t.TeamTaskID)
		}
		if err := replaceMeetingTasks(ctx, tx, teamID, id, tasks); err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `UPDATE meetings SET status = 'confirmed', ai_error = '', confirmed_by = $3, confirmed_at = now(), updated_at = now()
			WHERE team_id = $1 AND id = $2`, teamID, id, userID)
		return mapErr(err)
	})
	return ids, err
}
