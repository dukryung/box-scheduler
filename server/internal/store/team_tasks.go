package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

type TeamTask struct {
	ID            string         `json:"id"`
	Title         string         `json:"title"`
	Note          string         `json:"note"`
	Status        string         `json:"status"` // todo | doing | done
	StartDate     *string        `json:"startDate"`
	DueDate       *string        `json:"dueDate"`
	EstimateBoxes *int           `json:"estimateBoxes"`
	CreatedBy     string         `json:"createdBy"` // "" once that account is gone
	CreatedByName string         `json:"createdByName"`
	CreatedAt     time.Time      `json:"createdAt"`
	UpdatedAt     time.Time      `json:"updatedAt"`
	DoneAt        *time.Time     `json:"doneAt"`
	Assignees     []TaskAssignee `json:"assignees"`
	// What the caller may do with it, worked out from their role.
	CanEdit      bool `json:"canEdit"`
	CanSetStatus bool `json:"canSetStatus"`
}

type TaskAssignee struct {
	UserID string `json:"userId"`
	Name   string `json:"name"`
	Email  string `json:"email"`
	Boxes  *int   `json:"boxes"`
	// From the pieces in their Brain Dump once the task was split for them.
	PlannedBoxes int  `json:"plannedBoxes"`
	DoneBoxes    int  `json:"doneBoxes"`
	Split        bool `json:"split"`
}

// TeamTaskFields are the editable parts of a team task.
type TeamTaskFields struct {
	Title         string
	Note          string
	Status        string
	StartDate     *string
	DueDate       *string
	EstimateBoxes *int
}

type AssigneeInput struct {
	UserID string `json:"userId"`
	Boxes  *int   `json:"boxes"`
}

const teamTaskCols = `t.id::text, t.title, t.note, t.status, to_char(t.start_date, 'YYYY-MM-DD'), to_char(t.due_date, 'YYYY-MM-DD'),
	t.estimate_boxes, coalesce(t.created_by::text, ''), coalesce(u.name, ''), t.created_at, t.updated_at, t.done_at`

func scanTeamTask(row pgx.Row) (TeamTask, error) {
	var t TeamTask
	err := row.Scan(&t.ID, &t.Title, &t.Note, &t.Status, &t.StartDate, &t.DueDate, &t.EstimateBoxes, &t.CreatedBy, &t.CreatedByName, &t.CreatedAt, &t.UpdatedAt, &t.DoneAt)
	t.Assignees = []TaskAssignee{}
	return t, err
}

// TeamTasks lists a team's tasks: open ones by due date first, done ones last.
func (s *Store) TeamTasks(ctx context.Context, teamID string) ([]TeamTask, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+teamTaskCols+` FROM team_tasks t LEFT JOIN users u ON u.id = t.created_by
		WHERE t.team_id = $1
		ORDER BY t.status = 'done', t.due_date NULLS LAST, t.created_at`, teamID)
	if err != nil {
		return nil, mapErr(err)
	}
	list := []TeamTask{}
	byID := map[string]int{}
	for rows.Next() {
		t, err := scanTeamTask(rows)
		if err != nil {
			rows.Close()
			return nil, err
		}
		byID[t.ID] = len(list)
		list = append(list, t)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, mapErr(err)
	}
	as, err := s.taskAssignees(ctx, `a.team_id = $1`, teamID)
	if err != nil {
		return nil, err
	}
	for taskID, a := range as {
		if i, ok := byID[taskID]; ok {
			list[i].Assignees = a
		}
	}
	return list, nil
}

func (s *Store) TeamTaskByID(ctx context.Context, teamID, taskID string) (TeamTask, error) {
	t, err := scanTeamTask(s.pool.QueryRow(ctx, `SELECT `+teamTaskCols+` FROM team_tasks t LEFT JOIN users u ON u.id = t.created_by
		WHERE t.team_id = $1 AND t.id = $2`, teamID, taskID))
	if err != nil {
		return t, mapErr(err)
	}
	as, err := s.taskAssignees(ctx, `a.task_id = $1`, taskID)
	if a, ok := as[taskID]; ok {
		t.Assignees = a
	}
	return t, err
}

func (s *Store) taskAssignees(ctx context.Context, where string, arg string) (map[string][]TaskAssignee, error) {
	// Carried pieces live on as their copy on the next day; dropped ones are not work.
	rows, err := s.pool.Query(ctx, `SELECT a.task_id::text, u.id::text, u.name, u.email, a.boxes,
			COALESCE(pr.planned, 0), COALESCE(pr.done, 0), pr.linked IS NOT NULL
		FROM team_task_assignees a JOIN users u ON u.id = a.user_id
		JOIN team_members m ON m.team_id = a.team_id AND m.user_id = a.user_id
		LEFT JOIN LATERAL (
			SELECT p.id AS linked,
				(SELECT SUM(c.estimate_boxes) FROM brain_dump_items c WHERE c.parent_id = p.id AND c.status IN ('open', 'scheduled', 'done'))::int AS planned,
				(SELECT SUM(c.estimate_boxes) FROM brain_dump_items c WHERE c.parent_id = p.id AND c.status = 'done')::int AS done
			FROM brain_dump_items p WHERE p.user_id = a.user_id AND p.team_task_id = a.task_id
		) pr ON true
		WHERE `+where+` ORDER BY m.joined_at`, arg)
	if err != nil {
		return nil, mapErr(err)
	}
	defer rows.Close()
	out := map[string][]TaskAssignee{}
	for rows.Next() {
		var taskID string
		var a TaskAssignee
		if err := rows.Scan(&taskID, &a.UserID, &a.Name, &a.Email, &a.Boxes, &a.PlannedBoxes, &a.DoneBoxes, &a.Split); err != nil {
			return nil, err
		}
		out[taskID] = append(out[taskID], a)
	}
	return out, mapErr(rows.Err())
}

func (s *Store) CreateTeamTask(ctx context.Context, teamID, userID string, f TeamTaskFields, assignees []AssigneeInput) (TeamTask, error) {
	var id string
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		if err := tx.QueryRow(ctx, `INSERT INTO team_tasks (team_id, title, note, status, start_date, due_date, estimate_boxes, created_by, done_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CASE WHEN $4 = 'done' THEN now() END) RETURNING id::text`,
			teamID, f.Title, f.Note, f.Status, f.StartDate, f.DueDate, f.EstimateBoxes, userID).Scan(&id); err != nil {
			return mapErr(err)
		}
		return setAssignees(ctx, tx, teamID, id, assignees)
	})
	if err != nil {
		return TeamTask{}, err
	}
	return s.TeamTaskByID(ctx, teamID, id)
}

// UpdateTeamTask saves all fields; assignees are replaced unless nil.
func (s *Store) UpdateTeamTask(ctx context.Context, teamID, taskID string, f TeamTaskFields, assignees []AssigneeInput) (TeamTask, error) {
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `UPDATE team_tasks SET title = $3, note = $4, status = $5, start_date = $6, due_date = $7, estimate_boxes = $8,
			done_at = CASE WHEN $5 = 'done' THEN coalesce(done_at, now()) END, updated_at = now()
			WHERE team_id = $1 AND id = $2`, teamID, taskID, f.Title, f.Note, f.Status, f.StartDate, f.DueDate, f.EstimateBoxes)
		if err != nil {
			return mapErr(err)
		}
		if tag.RowsAffected() == 0 {
			return ErrNotFound
		}
		if assignees == nil {
			return nil
		}
		if _, err := tx.Exec(ctx, `DELETE FROM team_task_assignees WHERE task_id = $1`, taskID); err != nil {
			return mapErr(err)
		}
		return setAssignees(ctx, tx, teamID, taskID, assignees)
	})
	if err != nil {
		return TeamTask{}, err
	}
	return s.TeamTaskByID(ctx, teamID, taskID)
}

func setAssignees(ctx context.Context, tx pgx.Tx, teamID, taskID string, assignees []AssigneeInput) error {
	for _, a := range assignees {
		if _, err := tx.Exec(ctx, `INSERT INTO team_task_assignees (task_id, team_id, user_id, boxes) VALUES ($1, $2, $3, $4)`,
			taskID, teamID, a.UserID, a.Boxes); err != nil {
			return mapErr(err)
		}
	}
	return nil
}

func (s *Store) DeleteTeamTask(ctx context.Context, teamID, taskID string) error {
	tag, err := s.pool.Exec(ctx, `DELETE FROM team_tasks WHERE team_id = $1 AND id = $2`, teamID, taskID)
	if err == nil && tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return mapErr(err)
}

// TeamTaskItem is the backlog item a team task became for userID when it was
// split for them, or "" when it has not been.
func (s *Store) TeamTaskItem(ctx context.Context, userID, taskID string) (string, error) {
	var id string
	err := s.pool.QueryRow(ctx, `SELECT id::text FROM brain_dump_items WHERE user_id = $1 AND team_task_id = $2`, userID, taskID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	return id, mapErr(err)
}

// LinkTeamTaskItem makes (or refreshes) the backlog item standing for userID's
// share of a team task, so its split pieces have a parent; returns its id.
func (s *Store) LinkTeamTaskItem(ctx context.Context, userID string, t TeamTask, share int) (string, error) {
	var id string
	err := s.pool.QueryRow(ctx, `
		INSERT INTO brain_dump_items (user_id, date, title, estimate_boxes, status, due_date, note, team_task_id)
		VALUES ($1, NULL, $2, NULLIF($3, 0), 'open', $4::date, NULLIF($5, ''), $6)
		ON CONFLICT (user_id, team_task_id) WHERE team_task_id IS NOT NULL DO UPDATE SET
			title = EXCLUDED.title, estimate_boxes = EXCLUDED.estimate_boxes, due_date = EXCLUDED.due_date, date = NULL,
			status = CASE WHEN brain_dump_items.status IN ('open', 'done') THEN 'open' ELSE brain_dump_items.status END
		RETURNING id::text`, userID, t.Title, share, t.DueDate, t.Note, t.ID).Scan(&id)
	return id, mapErr(err)
}
