package store

import (
	"context"
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
	rows, err := s.pool.Query(ctx, `SELECT a.task_id::text, u.id::text, u.name, u.email, a.boxes
		FROM team_task_assignees a JOIN users u ON u.id = a.user_id
		JOIN team_members m ON m.team_id = a.team_id AND m.user_id = a.user_id
		WHERE `+where+` ORDER BY m.joined_at`, arg)
	if err != nil {
		return nil, mapErr(err)
	}
	defer rows.Close()
	out := map[string][]TaskAssignee{}
	for rows.Next() {
		var taskID string
		var a TaskAssignee
		if err := rows.Scan(&taskID, &a.UserID, &a.Name, &a.Email, &a.Boxes); err != nil {
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
