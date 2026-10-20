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
	Status      string     `json:"status"`
	IsOwner     bool       `json:"isOwner"`
	CreatedAt   time.Time  `json:"createdAt"`
	LastLoginAt *time.Time `json:"lastLoginAt"`
	HasPassword bool       `json:"hasPassword"`
	Google      bool       `json:"google"` // a Google account is linked
}

const userCols = `id, email, name, status, is_owner, created_at, last_login_at, password_hash IS NOT NULL, google_sub IS NOT NULL`

func scanUser(row pgx.Row, extra ...any) (User, error) {
	var u User
	dest := append([]any{&u.ID, &u.Email, &u.Name, &u.Status, &u.IsOwner, &u.CreatedAt, &u.LastLoginAt, &u.HasPassword, &u.Google}, extra...)
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
		 SELECT u.id, u.email, u.name, u.status, u.is_owner, u.created_at, u.last_login_at,
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

// MarkActive records that the account was used today (for the admin dashboard).
func (s *Store) MarkActive(ctx context.Context, userID string) error {
	_, err := s.pool.Exec(ctx, `INSERT INTO user_activity (user_id, day) VALUES ($1, current_date) ON CONFLICT DO NOTHING`, userID)
	return mapErr(err)
}

// CountAICall records one AI call by a user for the admin's usage counts.
func (s *Store) CountAICall(ctx context.Context, userID, feature string) error {
	_, err := s.pool.Exec(ctx,
		`INSERT INTO ai_usage (user_id, day, feature, calls) VALUES ($1, current_date, $2, 1)
		 ON CONFLICT (user_id, day, feature) DO UPDATE SET calls = ai_usage.calls + 1`, userID, feature)
	return mapErr(err)
}
