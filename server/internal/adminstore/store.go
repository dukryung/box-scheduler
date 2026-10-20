// Package adminstore holds the admin server's database access. It connects as
// app_admin, which can read account facts and counts but no schedule contents.
package adminstore

import (
	"context"
	"encoding/hex"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrNotFound  = errors.New("not found")
	ErrTaken     = errors.New("email already registered")
	ErrProtected = errors.New("the owner account cannot be changed here")
)

type Store struct{ pool *pgxpool.Pool }

func New(pool *pgxpool.Pool) *Store { return &Store{pool: pool} }

func mapErr(err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "23505":
			return ErrTaken
		case "23503", "22P02": // missing account, malformed id
			return ErrNotFound
		}
	}
	return err
}

func (s *Store) inTx(ctx context.Context, fn func(pgx.Tx) error) error {
	return pgx.BeginFunc(ctx, s.pool, fn)
}

// ---- admin accounts ----

type Account struct {
	ID                 string     `json:"id"`
	Email              string     `json:"email"`
	Name               string     `json:"name"`
	Role               string     `json:"role"` // super | operator
	Status             string     `json:"status"`
	MustChangePassword bool       `json:"mustChangePassword"`
	TOTPEnabled        bool       `json:"totpEnabled"`
	CreatedAt          time.Time  `json:"createdAt"`
	LastLoginAt        *time.Time `json:"lastLoginAt"`
}

const accountCols = `id, email, name, role, status, must_change_password, totp_enabled, created_at, last_login_at`

func scanAccount(row pgx.Row, extra ...any) (Account, error) {
	var a Account
	err := row.Scan(append([]any{&a.ID, &a.Email, &a.Name, &a.Role, &a.Status, &a.MustChangePassword, &a.TOTPEnabled, &a.CreatedAt, &a.LastLoginAt}, extra...)...)
	return a, mapErr(err)
}

func (s *Store) CreateAccount(ctx context.Context, email, name, role, passwordHash string) (Account, error) {
	return scanAccount(s.pool.QueryRow(ctx,
		`INSERT INTO admin.accounts (email, name, role, password_hash) VALUES (lower($1), $2, $3, $4) RETURNING `+accountCols,
		email, name, role, passwordHash))
}

// Credentials is what signing in needs to check.
type Credentials struct {
	Account
	PasswordHash string
	LockedUntil  *time.Time
}

func (s *Store) CredentialsByEmail(ctx context.Context, email string) (Credentials, error) {
	var c Credentials
	var err error
	c.Account, err = scanAccount(s.pool.QueryRow(ctx,
		`SELECT `+accountCols+`, password_hash, locked_until FROM admin.accounts WHERE lower(email) = lower($1)`, email),
		&c.PasswordHash, &c.LockedUntil)
	return c, err
}

func (s *Store) PasswordHash(ctx context.Context, id string) (string, error) {
	var h string
	err := s.pool.QueryRow(ctx, `SELECT password_hash FROM admin.accounts WHERE id = $1`, id).Scan(&h)
	return h, mapErr(err)
}

func (s *Store) AccountByID(ctx context.Context, id string) (Account, error) {
	return scanAccount(s.pool.QueryRow(ctx, `SELECT `+accountCols+` FROM admin.accounts WHERE id = $1`, id))
}

func (s *Store) AccountByEmail(ctx context.Context, email string) (Account, error) {
	return scanAccount(s.pool.QueryRow(ctx, `SELECT `+accountCols+` FROM admin.accounts WHERE lower(email) = lower($1)`, email))
}

func (s *Store) ListAccounts(ctx context.Context) ([]Account, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+accountCols+` FROM admin.accounts ORDER BY created_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	list := []Account{}
	for rows.Next() {
		a, err := scanAccount(rows)
		if err != nil {
			return nil, err
		}
		list = append(list, a)
	}
	return list, rows.Err()
}

// LoginFailed counts a failed sign-in; the fifth in a row locks the account for 15 minutes.
func (s *Store) LoginFailed(ctx context.Context, id string) error {
	_, err := s.pool.Exec(ctx,
		`UPDATE admin.accounts SET
		   failed_logins = CASE WHEN failed_logins + 1 >= 5 THEN 0 ELSE failed_logins + 1 END,
		   locked_until  = CASE WHEN failed_logins + 1 >= 5 THEN now() + interval '15 minutes' ELSE locked_until END
		 WHERE id = $1`, id)
	return err
}

func (s *Store) LoginSucceeded(ctx context.Context, id string) error {
	_, err := s.pool.Exec(ctx, `UPDATE admin.accounts SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = $1`, id)
	return err
}

func (s *Store) SetPassword(ctx context.Context, id, hash string, mustChange bool) error {
	tag, err := s.pool.Exec(ctx, `UPDATE admin.accounts SET password_hash = $2, must_change_password = $3 WHERE id = $1`, id, hash, mustChange)
	if err == nil && tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return err
}

// ResetAccess sets a temporary password, clears two-factor and the lock, and signs the account out.
func (s *Store) ResetAccess(ctx context.Context, id, hash string) error {
	return s.inTx(ctx, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx,
			`UPDATE admin.accounts SET password_hash = $2, must_change_password = true, totp_secret = NULL, totp_enabled = false,
			        totp_last_step = 0, failed_logins = 0, locked_until = NULL WHERE id = $1`, id, hash)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return ErrNotFound
		}
		_, err = tx.Exec(ctx, `DELETE FROM admin.sessions WHERE admin_id = $1`, id)
		return err
	})
}

func (s *Store) SetAccount(ctx context.Context, id string, role, status *string) (Account, error) {
	var a Account
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		var err error
		a, err = scanAccount(tx.QueryRow(ctx,
			`UPDATE admin.accounts SET role = COALESCE($2, role), status = COALESCE($3, status) WHERE id = $1 RETURNING `+accountCols, id, role, status))
		if err != nil {
			return err
		}
		if a.Status == "disabled" {
			_, err = tx.Exec(ctx, `DELETE FROM admin.sessions WHERE admin_id = $1`, id)
		}
		return err
	})
	return a, err
}

func (s *Store) CountActiveSupers(ctx context.Context) (int, error) {
	var n int
	err := s.pool.QueryRow(ctx, `SELECT count(*) FROM admin.accounts WHERE role = 'super' AND status = 'active'`).Scan(&n)
	return n, err
}

// ---- two-factor ----

func (s *Store) SetPendingTOTP(ctx context.Context, id, secret string) error {
	_, err := s.pool.Exec(ctx, `UPDATE admin.accounts SET totp_secret = $2 WHERE id = $1 AND NOT totp_enabled`, id, secret)
	return err
}

func (s *Store) TOTPSecret(ctx context.Context, id string) (string, error) {
	var secret *string
	if err := s.pool.QueryRow(ctx, `SELECT totp_secret FROM admin.accounts WHERE id = $1`, id).Scan(&secret); err != nil {
		return "", mapErr(err)
	}
	if secret == nil {
		return "", ErrNotFound
	}
	return *secret, nil
}

// UseTOTPStep records a code's time step, refusing one already used (no replays).
func (s *Store) UseTOTPStep(ctx context.Context, id string, step int64, enable bool) (bool, error) {
	tag, err := s.pool.Exec(ctx,
		`UPDATE admin.accounts SET totp_last_step = $2, totp_enabled = totp_enabled OR $3 WHERE id = $1 AND totp_last_step < $2`, id, step, enable)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}

// ---- admin sessions ----

func (s *Store) CreateSession(ctx context.Context, hash []byte, adminID, ip, ua string, expires time.Time) error {
	_, err := s.pool.Exec(ctx,
		`INSERT INTO admin.sessions (token_hash, admin_id, ip, user_agent, expires_at) VALUES ($1, $2, $3, $4, $5)`, hash, adminID, ip, ua, expires)
	return err
}

// Session returns the signed-in admin if the session is unexpired and was used
// within idle, and marks it used now.
func (s *Store) Session(ctx context.Context, hash []byte, idle time.Duration) (Account, bool, error) {
	var mfa bool
	a, err := scanAccount(s.pool.QueryRow(ctx,
		`UPDATE admin.sessions x SET last_seen_at = now()
		   FROM admin.accounts a
		  WHERE x.token_hash = $1 AND a.id = x.admin_id AND x.expires_at > now() AND x.last_seen_at > now() - $2::interval
		 RETURNING a.id, a.email, a.name, a.role, a.status, a.must_change_password, a.totp_enabled, a.created_at, a.last_login_at, x.mfa_ok`,
		hash, idle.String()), &mfa)
	return a, mfa, err
}

func (s *Store) MarkMFA(ctx context.Context, hash []byte) error {
	_, err := s.pool.Exec(ctx, `UPDATE admin.sessions SET mfa_ok = true WHERE token_hash = $1`, hash)
	return err
}

func (s *Store) DeleteSession(ctx context.Context, hash []byte) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM admin.sessions WHERE token_hash = $1`, hash)
	return err
}

func (s *Store) DeleteOtherSessions(ctx context.Context, adminID string, keep []byte) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM admin.sessions WHERE admin_id = $1 AND token_hash <> $2`, adminID, keep)
	return err
}

// ---- audit ----

type AuditEntry struct {
	ID        int64     `json:"id"`
	Actor     string    `json:"actor"`
	Action    string    `json:"action"`
	TargetID  *string   `json:"targetId"`
	Target    string    `json:"target"`
	Detail    string    `json:"detail"`
	IP        string    `json:"ip"`
	CreatedAt time.Time `json:"createdAt"`
}

func (s *Store) Audit(ctx context.Context, actor, action, targetID, target, detail, ip string) error {
	_, err := s.pool.Exec(ctx,
		`INSERT INTO admin.audit (actor, action, target_id, target, detail, ip) VALUES ($1, $2, NULLIF($3, '')::uuid, $4, $5, $6)`,
		actor, action, targetID, target, detail, ip)
	return err
}

func (s *Store) ListAudit(ctx context.Context, query, action, targetID string, limit, offset int) ([]AuditEntry, int, error) {
	const where = `($1 = '' OR actor ILIKE '%' || $1 || '%' OR target ILIKE '%' || $1 || '%')
	           AND ($2 = '' OR action = $2) AND ($3 = '' OR target_id = NULLIF($3, '')::uuid)`
	var total int
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM admin.audit WHERE `+where, query, action, targetID).Scan(&total); err != nil {
		return nil, 0, err
	}
	rows, err := s.pool.Query(ctx,
		`SELECT id, actor, action, target_id::text, target, detail, ip, created_at FROM admin.audit WHERE `+where+
			` ORDER BY id DESC LIMIT $4 OFFSET $5`, query, action, targetID, limit, offset)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	list := []AuditEntry{}
	for rows.Next() {
		var e AuditEntry
		if err := rows.Scan(&e.ID, &e.Actor, &e.Action, &e.TargetID, &e.Target, &e.Detail, &e.IP, &e.CreatedAt); err != nil {
			return nil, 0, err
		}
		list = append(list, e)
	}
	return list, total, rows.Err()
}

// ---- app accounts ----

type User struct {
	ID          string     `json:"id"`
	Email       string     `json:"email"`
	Name        string     `json:"name"`
	Status      string     `json:"status"`
	IsOwner     bool       `json:"isOwner"`
	CreatedAt   time.Time  `json:"createdAt"`
	LastLoginAt *time.Time `json:"lastLoginAt"`
	HasPassword bool       `json:"hasPassword"`
	Google      bool       `json:"google"`
	Blocks      int        `json:"blocks"`
	Items       int        `json:"items"`
	AICalls30d  int        `json:"aiCalls30d"`
	AIConns     int        `json:"aiConnections"`
}

const userSelect = `SELECT u.id, u.email, u.name, u.status, u.is_owner, u.created_at, u.last_login_at, u.has_password, u.google,
       c.blocks, c.items, c.ai_calls_30d, c.ai_connections
  FROM admin.user_accounts u JOIN admin.user_counts c ON c.user_id = u.id`

func scanUser(row pgx.Row) (User, error) {
	var u User
	err := row.Scan(&u.ID, &u.Email, &u.Name, &u.Status, &u.IsOwner, &u.CreatedAt, &u.LastLoginAt, &u.HasPassword, &u.Google, &u.Blocks, &u.Items, &u.AICalls30d, &u.AIConns)
	return u, mapErr(err)
}

type UserQuery struct {
	Q      string
	Filter string // all | active | suspended | google | password | owner
	Sort   string // created | login | ai | email
	Limit  int
	Offset int
}

func (s *Store) ListUsers(ctx context.Context, q UserQuery) ([]User, int, error) {
	where := ` WHERE ($1 = '' OR u.email ILIKE '%' || $1 || '%' OR u.name ILIKE '%' || $1 || '%')
	   AND CASE $2 WHEN 'active' THEN u.status = 'active' WHEN 'suspended' THEN u.status = 'suspended'
	               WHEN 'google' THEN u.google WHEN 'password' THEN u.has_password WHEN 'owner' THEN u.is_owner ELSE true END`
	order := map[string]string{
		"login": " ORDER BY u.last_login_at DESC NULLS LAST, u.created_at DESC",
		"ai":    " ORDER BY c.ai_calls_30d DESC, u.created_at DESC",
		"email": " ORDER BY u.email",
	}[q.Sort]
	if order == "" {
		order = " ORDER BY u.created_at DESC"
	}
	var total int
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM admin.user_accounts u`+where, q.Q, q.Filter).Scan(&total); err != nil {
		return nil, 0, err
	}
	rows, err := s.pool.Query(ctx, userSelect+where+order+` LIMIT $3 OFFSET $4`, q.Q, q.Filter, q.Limit, q.Offset)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	list := []User{}
	for rows.Next() {
		u, err := scanUser(rows)
		if err != nil {
			return nil, 0, err
		}
		list = append(list, u)
	}
	return list, total, rows.Err()
}

func (s *Store) User(ctx context.Context, id string) (User, error) {
	return scanUser(s.pool.QueryRow(ctx, userSelect+` WHERE u.id = $1`, id))
}

type UserSession struct {
	ID         string    `json:"id"` // hex of the token hash; useless for signing in
	CreatedAt  time.Time `json:"createdAt"`
	LastSeenAt time.Time `json:"lastSeenAt"`
	ExpiresAt  time.Time `json:"expiresAt"`
	UserAgent  string    `json:"userAgent"`
}

type Note struct {
	ID        int64     `json:"id"`
	Author    string    `json:"author"`
	Body      string    `json:"body"`
	CreatedAt time.Time `json:"createdAt"`
}

type UserDetail struct {
	User
	Sessions     []UserSession  `json:"sessions"`
	AIByFeat     map[string]int `json:"aiByFeature"`
	ActiveDays   int            `json:"activeDays30d"`
	ServiceToday int            `json:"serviceToday"`
	Notes        []Note         `json:"notes"`
}

func (s *Store) UserDetail(ctx context.Context, id string) (UserDetail, error) {
	u, err := s.User(ctx, id)
	if err != nil {
		return UserDetail{}, err
	}
	d := UserDetail{User: u, Sessions: []UserSession{}, AIByFeat: map[string]int{}, Notes: []Note{}}

	rows, err := s.pool.Query(ctx,
		`SELECT token_hash, created_at, last_seen_at, expires_at, user_agent FROM public.sessions
		  WHERE user_id = $1 AND expires_at > now() ORDER BY last_seen_at DESC`, id)
	if err != nil {
		return UserDetail{}, err
	}
	for rows.Next() {
		var x UserSession
		var hash []byte
		if err := rows.Scan(&hash, &x.CreatedAt, &x.LastSeenAt, &x.ExpiresAt, &x.UserAgent); err != nil {
			rows.Close()
			return UserDetail{}, err
		}
		x.ID = hex.EncodeToString(hash)
		d.Sessions = append(d.Sessions, x)
	}
	rows.Close()

	rows, err = s.pool.Query(ctx, `SELECT feature, sum(calls) FROM public.ai_usage WHERE user_id = $1 AND day > current_date - 30 GROUP BY feature`, id)
	if err != nil {
		return UserDetail{}, err
	}
	for rows.Next() {
		var f string
		var n int
		if err := rows.Scan(&f, &n); err != nil {
			rows.Close()
			return UserDetail{}, err
		}
		d.AIByFeat[f] = n
	}
	rows.Close()

	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM public.user_activity WHERE user_id = $1 AND day > current_date - 30`, id).Scan(&d.ActiveDays); err != nil {
		return UserDetail{}, err
	}
	if d.ServiceToday, err = s.ServiceCallsToday(ctx, id); err != nil {
		return UserDetail{}, err
	}

	rows, err = s.pool.Query(ctx, `SELECT id, author, body, created_at FROM admin.notes WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`, id)
	if err != nil {
		return UserDetail{}, err
	}
	defer rows.Close()
	for rows.Next() {
		var n Note
		if err := rows.Scan(&n.ID, &n.Author, &n.Body, &n.CreatedAt); err != nil {
			return UserDetail{}, err
		}
		d.Notes = append(d.Notes, n)
	}
	return d, rows.Err()
}

// SetUserStatus suspends or restores an app account; suspending signs it out everywhere.
func (s *Store) SetUserStatus(ctx context.Context, id, status string) error {
	return s.inTx(ctx, func(tx pgx.Tx) error {
		var owner bool
		if err := tx.QueryRow(ctx, `SELECT is_owner FROM public.users WHERE id = $1`, id).Scan(&owner); err != nil {
			return mapErr(err)
		}
		if owner {
			return ErrProtected
		}
		if _, err := tx.Exec(ctx, `UPDATE public.users SET status = $2 WHERE id = $1`, id, status); err != nil {
			return err
		}
		if status == "suspended" {
			_, err := tx.Exec(ctx, `DELETE FROM public.sessions WHERE user_id = $1`, id)
			return err
		}
		return nil
	})
}

func (s *Store) DeleteUser(ctx context.Context, id string) error {
	var owner bool
	if err := s.pool.QueryRow(ctx, `SELECT is_owner FROM public.users WHERE id = $1`, id).Scan(&owner); err != nil {
		return mapErr(err)
	}
	if owner {
		return ErrProtected
	}
	_, err := s.pool.Exec(ctx, `DELETE FROM public.users WHERE id = $1 AND NOT is_owner`, id)
	return err
}

// RevokeSessions signs an app account out: one session (by id) or all of them.
func (s *Store) RevokeSessions(ctx context.Context, userID, sessionID string) (int64, error) {
	if sessionID == "" {
		tag, err := s.pool.Exec(ctx, `DELETE FROM public.sessions WHERE user_id = $1`, userID)
		return tag.RowsAffected(), err
	}
	hash, err := hex.DecodeString(sessionID)
	if err != nil {
		return 0, ErrNotFound
	}
	tag, err := s.pool.Exec(ctx, `DELETE FROM public.sessions WHERE user_id = $1 AND token_hash = $2`, userID, hash)
	return tag.RowsAffected(), err
}

func (s *Store) CreateReset(ctx context.Context, hash []byte, userID, issuedBy string, expires time.Time) error {
	_, err := s.pool.Exec(ctx,
		`INSERT INTO public.password_resets (token_hash, user_id, issued_by, expires_at) VALUES ($1, $2, $3, $4)`, hash, userID, issuedBy, expires)
	return err
}

func (s *Store) AddNote(ctx context.Context, userID, author, body string) (Note, error) {
	var n Note
	err := s.pool.QueryRow(ctx,
		`INSERT INTO admin.notes (user_id, author, body) VALUES ($1, $2, $3) RETURNING id, author, body, created_at`, userID, author, body).
		Scan(&n.ID, &n.Author, &n.Body, &n.CreatedAt)
	return n, mapErr(err)
}

// ---- dashboard ----

type DayPoint struct {
	Day     string `json:"day"`
	Signups int    `json:"signups"`
	Active  int    `json:"active"`
	AICalls int    `json:"aiCalls"`
}

type Dashboard struct {
	Users     int        `json:"users"`
	Active7d  int        `json:"active7d"`
	Signups7d int        `json:"signups7d"`
	Suspended int        `json:"suspended"`
	Google    int        `json:"google"`
	AICalls7d int        `json:"aiCalls7d"`
	Days      []DayPoint `json:"days"` // the last 30 days, oldest first
}

func (s *Store) Dashboard(ctx context.Context) (Dashboard, error) {
	var d Dashboard
	err := s.pool.QueryRow(ctx,
		`SELECT (SELECT count(*) FROM admin.user_accounts),
		        (SELECT count(DISTINCT user_id) FROM public.user_activity WHERE day > current_date - 7),
		        (SELECT count(*) FROM admin.user_accounts WHERE created_at > now() - interval '7 days'),
		        (SELECT count(*) FROM admin.user_accounts WHERE status = 'suspended'),
		        (SELECT count(*) FROM admin.user_accounts WHERE google),
		        COALESCE((SELECT sum(calls) FROM public.ai_usage WHERE day > current_date - 7), 0)`).
		Scan(&d.Users, &d.Active7d, &d.Signups7d, &d.Suspended, &d.Google, &d.AICalls7d)
	if err != nil {
		return d, err
	}
	rows, err := s.pool.Query(ctx,
		`SELECT g.day::date::text,
		        (SELECT count(*) FROM admin.user_accounts u WHERE u.created_at::date = g.day::date),
		        (SELECT count(*) FROM public.user_activity a WHERE a.day = g.day::date),
		        COALESCE((SELECT sum(calls) FROM public.ai_usage x WHERE x.day = g.day::date), 0)
		   FROM generate_series(current_date - 29, current_date, interval '1 day') AS g(day)
		  ORDER BY g.day`)
	if err != nil {
		return d, err
	}
	defer rows.Close()
	for rows.Next() {
		var p DayPoint
		if err := rows.Scan(&p.Day, &p.Signups, &p.Active, &p.AICalls); err != nil {
			return d, err
		}
		d.Days = append(d.Days, p)
	}
	return d, rows.Err()
}
