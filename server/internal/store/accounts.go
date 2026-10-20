package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// ErrTaken means the email already belongs to another account.
var ErrTaken = errors.New("email already registered")

type User struct {
	ID          string     `json:"id"`
	Email       string     `json:"email"`
	Name        string     `json:"name"`
	Role        string     `json:"role"`
	Status      string     `json:"status"`
	IsOwner     bool       `json:"isOwner"`
	CreatedAt   time.Time  `json:"createdAt"`
	LastLoginAt *time.Time `json:"lastLoginAt"`
	HasPassword bool       `json:"hasPassword"`
	Google      bool       `json:"google"` // a Google account is linked
}

const userCols = `id, email, name, role, status, is_owner, created_at, last_login_at, password_hash IS NOT NULL, google_sub IS NOT NULL`

func scanUser(row pgx.Row, extra ...any) (User, error) {
	var u User
	dest := append([]any{&u.ID, &u.Email, &u.Name, &u.Role, &u.Status, &u.IsOwner, &u.CreatedAt, &u.LastLoginAt, &u.HasPassword, &u.Google}, extra...)
	err := row.Scan(dest...)
	return u, mapErr(err)
}

func takenErr(err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" {
		return ErrTaken
	}
	return mapErr(err)
}

func (s *Store) CreateUser(ctx context.Context, email, name, passwordHash string) (User, error) {
	u, err := scanUser(s.pool.QueryRow(ctx,
		`INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING `+userCols,
		email, name, passwordHash))
	if err != nil {
		return User{}, takenErr(err)
	}
	return u, nil
}

// UserByEmail returns the account and its password hash ("" when it has none).
func (s *Store) UserByEmail(ctx context.Context, email string) (User, string, error) {
	var hash *string
	u, err := scanUser(s.pool.QueryRow(ctx, `SELECT `+userCols+`, password_hash FROM users WHERE lower(email) = lower($1)`, email), &hash)
	if err != nil {
		return User{}, "", err
	}
	if hash == nil {
		return u, "", nil
	}
	return u, *hash, nil
}

func (s *Store) PasswordHash(ctx context.Context, userID string) (string, error) {
	var hash *string
	if err := s.pool.QueryRow(ctx, `SELECT password_hash FROM users WHERE id = $1`, userID).Scan(&hash); err != nil {
		return "", mapErr(err)
	}
	if hash == nil {
		return "", nil
	}
	return *hash, nil
}

// OwnerNeedsSetup reports whether the owner account has not been claimed yet.
func (s *Store) OwnerNeedsSetup(ctx context.Context) (bool, error) {
	var needs bool
	err := s.pool.QueryRow(ctx, `SELECT password_hash IS NULL AND google_sub IS NULL FROM users WHERE is_owner`).Scan(&needs)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return needs, mapErr(err)
}

// ClaimOwner sets the owner's email, name and password, once.
func (s *Store) ClaimOwner(ctx context.Context, email, name, passwordHash string) (User, error) {
	u, err := scanUser(s.pool.QueryRow(ctx,
		`UPDATE users SET email = $1, name = $2, password_hash = $3
		  WHERE is_owner AND password_hash IS NULL AND google_sub IS NULL RETURNING `+userCols,
		email, name, passwordHash))
	if errors.Is(err, ErrNotFound) {
		return User{}, ErrConflict
	}
	if err != nil {
		return User{}, takenErr(err)
	}
	return u, nil
}

func (s *Store) SetPassword(ctx context.Context, userID, passwordHash string) error {
	tag, err := s.pool.Exec(ctx, `UPDATE users SET password_hash = $2 WHERE id = $1`, userID, passwordHash)
	if err != nil {
		return mapErr(err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) SetName(ctx context.Context, userID, name string) (User, error) {
	return scanUser(s.pool.QueryRow(ctx, `UPDATE users SET name = $2 WHERE id = $1 RETURNING `+userCols, userID, name))
}

func (s *Store) TouchLogin(ctx context.Context, userID string) error {
	_, err := s.pool.Exec(ctx, `UPDATE users SET last_login_at = now() WHERE id = $1`, userID)
	return mapErr(err)
}

func (s *Store) DeleteUser(ctx context.Context, userID string) error {
	tag, err := s.pool.Exec(ctx, `DELETE FROM users WHERE id = $1 AND NOT is_owner`, userID)
	if err != nil {
		return mapErr(err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// ---- Google ----

func (s *Store) UserByGoogle(ctx context.Context, sub string) (User, error) {
	return scanUser(s.pool.QueryRow(ctx, `SELECT `+userCols+` FROM users WHERE google_sub = $1`, sub))
}

// CreateGoogleUser makes an account that signs in with Google only (no password yet).
func (s *Store) CreateGoogleUser(ctx context.Context, email, name, sub string) (User, error) {
	u, err := scanUser(s.pool.QueryRow(ctx,
		`INSERT INTO users (email, name, google_sub) VALUES ($1, $2, $3) RETURNING `+userCols, email, name, sub))
	if err != nil {
		return User{}, takenErr(err)
	}
	return u, nil
}

// ClaimOwnerGoogle claims the unclaimed owner account with a Google account.
func (s *Store) ClaimOwnerGoogle(ctx context.Context, email, name, sub string) (User, error) {
	u, err := scanUser(s.pool.QueryRow(ctx,
		`UPDATE users SET email = $1, name = CASE WHEN name = '' THEN $2 ELSE name END, google_sub = $3
		  WHERE is_owner AND password_hash IS NULL AND google_sub IS NULL RETURNING `+userCols,
		email, name, sub))
	if errors.Is(err, ErrNotFound) {
		return User{}, ErrConflict
	}
	if err != nil {
		return User{}, takenErr(err)
	}
	return u, nil
}

// LinkGoogle attaches a Google account to a signed-in account.
func (s *Store) LinkGoogle(ctx context.Context, userID, sub string) (User, error) {
	u, err := scanUser(s.pool.QueryRow(ctx, `UPDATE users SET google_sub = $2 WHERE id = $1 RETURNING `+userCols, userID, sub))
	if err != nil {
		return User{}, takenErr(err)
	}
	return u, nil
}

// UnlinkGoogle detaches Google, only while the account can still sign in with a password.
func (s *Store) UnlinkGoogle(ctx context.Context, userID string) (User, error) {
	u, err := scanUser(s.pool.QueryRow(ctx,
		`UPDATE users SET google_sub = NULL WHERE id = $1 AND password_hash IS NOT NULL RETURNING `+userCols, userID))
	if errors.Is(err, ErrNotFound) {
		return User{}, ErrConflict
	}
	return u, err
}

// ---- sessions ----

func (s *Store) CreateSession(ctx context.Context, tokenHash []byte, userID, userAgent string, expires time.Time) error {
	_, err := s.pool.Exec(ctx,
		`INSERT INTO sessions (token_hash, user_id, expires_at, user_agent) VALUES ($1, $2, $3, $4)`,
		tokenHash, userID, expires, userAgent)
	return mapErr(err)
}

// SessionUser returns the signed-in user for a session token hash, sliding the
// expiry forward (at most once an hour) while the session is in use.
func (s *Store) SessionUser(ctx context.Context, tokenHash []byte, ttl time.Duration) (User, error) {
	u, err := scanUser(s.pool.QueryRow(ctx,
		`WITH s AS (
		   UPDATE sessions SET last_seen_at = now(), expires_at = now() + $2::interval
		    WHERE token_hash = $1 AND expires_at > now() AND last_seen_at < now() - interval '1 hour'
		 )
		 SELECT u.id, u.email, u.name, u.role, u.status, u.is_owner, u.created_at, u.last_login_at,
		        u.password_hash IS NOT NULL, u.google_sub IS NOT NULL
		   FROM sessions x JOIN users u ON u.id = x.user_id
		  WHERE x.token_hash = $1 AND x.expires_at > now()`,
		tokenHash, ttl.String()))
	return u, err
}

func (s *Store) DeleteSession(ctx context.Context, tokenHash []byte) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM sessions WHERE token_hash = $1`, tokenHash)
	return mapErr(err)
}

// DeleteUserSessions signs a user out everywhere except, optionally, one session.
func (s *Store) DeleteUserSessions(ctx context.Context, userID string, keep []byte) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM sessions WHERE user_id = $1 AND ($2::bytea IS NULL OR token_hash <> $2)`, userID, keep)
	return mapErr(err)
}

// ---- password reset links ----

func (s *Store) CreateReset(ctx context.Context, tokenHash []byte, userID, createdBy string, expires time.Time) error {
	_, err := s.pool.Exec(ctx,
		`INSERT INTO password_resets (token_hash, user_id, created_by, expires_at) VALUES ($1, $2, $3, $4)`,
		tokenHash, userID, createdBy, expires)
	return mapErr(err)
}

// UseReset sets a new password with a reset link, once, and signs the account out everywhere.
func (s *Store) UseReset(ctx context.Context, tokenHash []byte, passwordHash string) (User, error) {
	var u User
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		var userID string
		err := tx.QueryRow(ctx,
			`UPDATE password_resets SET used_at = now()
			  WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING user_id`, tokenHash).Scan(&userID)
		if err != nil {
			return mapErr(err)
		}
		if u, err = scanUser(tx.QueryRow(ctx, `UPDATE users SET password_hash = $2 WHERE id = $1 RETURNING `+userCols, userID, passwordHash)); err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `DELETE FROM sessions WHERE user_id = $1`, userID)
		return mapErr(err)
	})
	return u, err
}

// ---- admin ----

type AdminUser struct {
	User
	Blocks     int `json:"blocks"`
	Items      int `json:"items"`
	AICalls30d int `json:"aiCalls30d"`
}

// ListUsers is the admin's user list: account facts and counts, never schedule contents.
func (s *Store) ListUsers(ctx context.Context, query string) ([]AdminUser, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT u.id, u.email, u.name, u.role, u.status, u.is_owner, u.created_at, u.last_login_at,
		        u.password_hash IS NOT NULL, u.google_sub IS NOT NULL,
		        (SELECT count(*) FROM time_blocks b WHERE b.user_id = u.id),
		        (SELECT count(*) FROM brain_dump_items i WHERE i.user_id = u.id),
		        COALESCE((SELECT sum(calls) FROM ai_usage a WHERE a.user_id = u.id AND a.day > current_date - 30), 0)
		   FROM users u
		  WHERE $1 = '' OR u.email ILIKE '%' || $1 || '%' OR u.name ILIKE '%' || $1 || '%'
		  ORDER BY u.created_at DESC
		  LIMIT 500`, query)
	if err != nil {
		return nil, mapErr(err)
	}
	defer rows.Close()
	list := []AdminUser{}
	for rows.Next() {
		var a AdminUser
		if a.User, err = scanUser(rows, &a.Blocks, &a.Items, &a.AICalls30d); err != nil {
			return nil, err
		}
		list = append(list, a)
	}
	return list, mapErr(rows.Err())
}

func (s *Store) AdminUserByID(ctx context.Context, id string) (User, error) {
	return scanUser(s.pool.QueryRow(ctx, `SELECT `+userCols+` FROM users WHERE id = $1`, id))
}

type AdminStats struct {
	Users      int `json:"users"`
	Active7d   int `json:"active7d"`
	Signups7d  int `json:"signups7d"`
	Suspended  int `json:"suspended"`
	AICalls7d  int `json:"aiCalls7d"`
	AdminCount int `json:"admins"`
}

func (s *Store) AdminStats(ctx context.Context) (AdminStats, error) {
	var st AdminStats
	err := s.pool.QueryRow(ctx,
		`SELECT (SELECT count(*) FROM users),
		        (SELECT count(DISTINCT user_id) FROM sessions WHERE last_seen_at > now() - interval '7 days'),
		        (SELECT count(*) FROM users WHERE created_at > now() - interval '7 days'),
		        (SELECT count(*) FROM users WHERE status = 'suspended'),
		        COALESCE((SELECT sum(calls) FROM ai_usage WHERE day > current_date - 7), 0),
		        (SELECT count(*) FROM users WHERE role = 'admin' AND status = 'active')`).
		Scan(&st.Users, &st.Active7d, &st.Signups7d, &st.Suspended, &st.AICalls7d, &st.AdminCount)
	return st, mapErr(err)
}

func (s *Store) SetRole(ctx context.Context, id, role string) (User, error) {
	return scanUser(s.pool.QueryRow(ctx, `UPDATE users SET role = $2 WHERE id = $1 AND NOT is_owner RETURNING `+userCols, id, role))
}

// SetStatus suspends or restores an account; suspending also signs it out everywhere.
func (s *Store) SetStatus(ctx context.Context, id, status string) (User, error) {
	var u User
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		var err error
		if u, err = scanUser(tx.QueryRow(ctx, `UPDATE users SET status = $2 WHERE id = $1 AND NOT is_owner RETURNING `+userCols, id, status)); err != nil {
			return err
		}
		if status == "suspended" {
			_, err = tx.Exec(ctx, `DELETE FROM sessions WHERE user_id = $1`, id)
		}
		return mapErr(err)
	})
	return u, err
}

type AuditEntry struct {
	ID        int64     `json:"id"`
	Admin     string    `json:"admin"`
	Action    string    `json:"action"`
	Target    string    `json:"target"`
	Detail    string    `json:"detail"`
	CreatedAt time.Time `json:"createdAt"`
}

func (s *Store) Audit(ctx context.Context, adminID, action, targetID, target, detail string) error {
	_, err := s.pool.Exec(ctx,
		`INSERT INTO admin_audit (admin_id, action, target_id, target, detail) VALUES ($1, $2, NULLIF($3, '')::uuid, $4, $5)`,
		adminID, action, targetID, target, detail)
	return mapErr(err)
}

func (s *Store) ListAudit(ctx context.Context, limit int) ([]AuditEntry, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT a.id, COALESCE(u.email, '(삭제된 계정)'), a.action, a.target, a.detail, a.created_at
		   FROM admin_audit a LEFT JOIN users u ON u.id = a.admin_id
		  ORDER BY a.id DESC LIMIT $1`, limit)
	if err != nil {
		return nil, mapErr(err)
	}
	defer rows.Close()
	list := []AuditEntry{}
	for rows.Next() {
		var e AuditEntry
		if err := rows.Scan(&e.ID, &e.Admin, &e.Action, &e.Target, &e.Detail, &e.CreatedAt); err != nil {
			return nil, mapErr(err)
		}
		list = append(list, e)
	}
	return list, mapErr(rows.Err())
}

// CountAICall records one AI call by a user for the admin's usage counts.
func (s *Store) CountAICall(ctx context.Context, userID, feature string) error {
	_, err := s.pool.Exec(ctx,
		`INSERT INTO ai_usage (user_id, day, feature, calls) VALUES ($1, current_date, $2, 1)
		 ON CONFLICT (user_id, day, feature) DO UPDATE SET calls = ai_usage.calls + 1`, userID, feature)
	return mapErr(err)
}
