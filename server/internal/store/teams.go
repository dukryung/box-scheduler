package store

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

var (
	// ErrForbidden means the account's role in the team does not allow the action.
	ErrForbidden = errors.New("not allowed for this role")
	// ErrWrongEmail means an invite was sent to another address than the signed-in one.
	ErrWrongEmail = errors.New("invite is for another email")
	ErrMember     = errors.New("already a member")
)

type Team struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Role      string    `json:"role"` // the caller's role
	Members   int       `json:"members"`
	CreatedAt time.Time `json:"createdAt"`
}

type TeamMember struct {
	UserID   string    `json:"userId"`
	Email    string    `json:"email"`
	Name     string    `json:"name"`
	Role     string    `json:"role"`
	JoinedAt time.Time `json:"joinedAt"`
}

type TeamInvite struct {
	ID        string     `json:"id"`
	Email     string     `json:"email"`
	Role      string     `json:"role"`
	InvitedBy string     `json:"invitedBy"`
	CreatedAt time.Time  `json:"createdAt"`
	ExpiresAt time.Time  `json:"expiresAt"`
	SentAt    *time.Time `json:"sentAt"`
}

// RoleRank orders roles for permission checks.
func RoleRank(role string) int {
	return map[string]int{"member": 1, "manager": 2, "owner": 3}[role]
}

func (s *Store) CreateTeam(ctx context.Context, userID, name string) (Team, error) {
	var t Team
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		if err := tx.QueryRow(ctx, `INSERT INTO teams (name, created_by) VALUES ($1, $2) RETURNING id::text, name, created_at`, name, userID).
			Scan(&t.ID, &t.Name, &t.CreatedAt); err != nil {
			return mapErr(err)
		}
		if _, err := tx.Exec(ctx, `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'owner')`, t.ID, userID); err != nil {
			return mapErr(err)
		}
		_, err := tx.Exec(ctx, `UPDATE users SET onboarded = true WHERE id = $1`, userID)
		return mapErr(err)
	})
	t.Role, t.Members = "owner", 1
	return t, err
}

func (s *Store) ListTeams(ctx context.Context, userID string) ([]Team, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT t.id::text, t.name, m.role, t.created_at, (SELECT count(*) FROM team_members x WHERE x.team_id = t.id)
		   FROM team_members m JOIN teams t ON t.id = m.team_id
		  WHERE m.user_id = $1 ORDER BY t.created_at`, userID)
	if err != nil {
		return nil, mapErr(err)
	}
	defer rows.Close()
	list := []Team{}
	for rows.Next() {
		var t Team
		if err := rows.Scan(&t.ID, &t.Name, &t.Role, &t.CreatedAt, &t.Members); err != nil {
			return nil, err
		}
		list = append(list, t)
	}
	return list, mapErr(rows.Err())
}

// TeamRole is the account's role in the team, or ErrNotFound when it is not a
// member (so a team's existence is not revealed to outsiders).
func (s *Store) TeamRole(ctx context.Context, teamID, userID string) (string, error) {
	var role string
	err := s.pool.QueryRow(ctx, `SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2`, teamID, userID).Scan(&role)
	return role, mapErr(err)
}

func (s *Store) TeamByID(ctx context.Context, teamID, userID string) (Team, error) {
	var t Team
	err := s.pool.QueryRow(ctx,
		`SELECT t.id::text, t.name, m.role, t.created_at, (SELECT count(*) FROM team_members x WHERE x.team_id = t.id)
		   FROM teams t JOIN team_members m ON m.team_id = t.id AND m.user_id = $2 WHERE t.id = $1`, teamID, userID).
		Scan(&t.ID, &t.Name, &t.Role, &t.CreatedAt, &t.Members)
	return t, mapErr(err)
}

func (s *Store) TeamMembers(ctx context.Context, teamID string) ([]TeamMember, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT u.id::text, u.email, u.name, m.role, m.joined_at FROM team_members m JOIN users u ON u.id = m.user_id
		  WHERE m.team_id = $1
		  ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'manager' THEN 1 ELSE 2 END, m.joined_at`, teamID)
	if err != nil {
		return nil, mapErr(err)
	}
	defer rows.Close()
	list := []TeamMember{}
	for rows.Next() {
		var m TeamMember
		if err := rows.Scan(&m.UserID, &m.Email, &m.Name, &m.Role, &m.JoinedAt); err != nil {
			return nil, err
		}
		list = append(list, m)
	}
	return list, mapErr(rows.Err())
}

func (s *Store) RenameTeam(ctx context.Context, teamID, name string) error {
	_, err := s.pool.Exec(ctx, `UPDATE teams SET name = $2 WHERE id = $1`, teamID, name)
	return mapErr(err)
}

func (s *Store) DeleteTeam(ctx context.Context, teamID string) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM teams WHERE id = $1`, teamID)
	return mapErr(err)
}

func (s *Store) SetMemberRole(ctx context.Context, teamID, userID, role string) error {
	tag, err := s.pool.Exec(ctx, `UPDATE team_members SET role = $3 WHERE team_id = $1 AND user_id = $2 AND role <> 'owner'`, teamID, userID, role)
	if err == nil && tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return mapErr(err)
}

func (s *Store) RemoveMember(ctx context.Context, teamID, userID string) error {
	tag, err := s.pool.Exec(ctx, `DELETE FROM team_members WHERE team_id = $1 AND user_id = $2 AND role <> 'owner'`, teamID, userID)
	if err == nil && tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return mapErr(err)
}

// TransferOwner hands the team to another member; the old owner becomes a manager.
func (s *Store) TransferOwner(ctx context.Context, teamID, from, to string) error {
	return s.inTx(ctx, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `UPDATE team_members SET role = 'manager' WHERE team_id = $1 AND user_id = $2 AND role = 'owner'`, teamID, from)
		if err != nil {
			return mapErr(err)
		}
		if tag.RowsAffected() == 0 {
			return ErrForbidden
		}
		tag, err = tx.Exec(ctx, `UPDATE team_members SET role = 'owner' WHERE team_id = $1 AND user_id = $2`, teamID, to)
		if err != nil {
			return mapErr(err)
		}
		if tag.RowsAffected() == 0 {
			return ErrNotFound
		}
		return nil
	})
}

// ---- invites ----

// CreateInvite makes (or renews) the live invite for an address. It refuses an
// address that already belongs to a member.
func (s *Store) CreateInvite(ctx context.Context, teamID, email, role, invitedBy string, tokenHash []byte, expires time.Time) (TeamInvite, error) {
	var inv TeamInvite
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		var member bool
		if err := tx.QueryRow(ctx,
			`SELECT EXISTS (SELECT 1 FROM team_members m JOIN users u ON u.id = m.user_id WHERE m.team_id = $1 AND lower(u.email) = lower($2))`,
			teamID, email).Scan(&member); err != nil {
			return mapErr(err)
		}
		if member {
			return ErrMember
		}
		if _, err := tx.Exec(ctx,
			`UPDATE team_invites SET revoked_at = now() WHERE team_id = $1 AND lower(email) = lower($2) AND accepted_at IS NULL AND revoked_at IS NULL`,
			teamID, email); err != nil {
			return mapErr(err)
		}
		err := tx.QueryRow(ctx,
			`INSERT INTO team_invites (team_id, email, role, token_hash, invited_by, expires_at) VALUES ($1, lower($2), $3, $4, $5, $6)
			 RETURNING id::text, email, role, created_at, expires_at, sent_at`,
			teamID, email, role, tokenHash, invitedBy, expires).Scan(&inv.ID, &inv.Email, &inv.Role, &inv.CreatedAt, &inv.ExpiresAt, &inv.SentAt)
		return mapErr(err)
	})
	return inv, err
}

func (s *Store) MarkInviteSent(ctx context.Context, inviteID string) error {
	_, err := s.pool.Exec(ctx, `UPDATE team_invites SET sent_at = now() WHERE id = $1`, inviteID)
	return mapErr(err)
}

// PendingInvites are the team's live invites (not accepted, revoked or expired).
func (s *Store) PendingInvites(ctx context.Context, teamID string) ([]TeamInvite, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT i.id::text, i.email, i.role, COALESCE(u.email, ''), i.created_at, i.expires_at, i.sent_at
		   FROM team_invites i LEFT JOIN users u ON u.id = i.invited_by
		  WHERE i.team_id = $1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()
		  ORDER BY i.created_at DESC`, teamID)
	if err != nil {
		return nil, mapErr(err)
	}
	defer rows.Close()
	list := []TeamInvite{}
	for rows.Next() {
		var i TeamInvite
		if err := rows.Scan(&i.ID, &i.Email, &i.Role, &i.InvitedBy, &i.CreatedAt, &i.ExpiresAt, &i.SentAt); err != nil {
			return nil, err
		}
		list = append(list, i)
	}
	return list, mapErr(rows.Err())
}

func (s *Store) InviteByID(ctx context.Context, teamID, inviteID string) (TeamInvite, error) {
	var i TeamInvite
	err := s.pool.QueryRow(ctx,
		`SELECT id::text, email, role, created_at, expires_at, sent_at FROM team_invites
		  WHERE team_id = $1 AND id = $2 AND accepted_at IS NULL AND revoked_at IS NULL`, teamID, inviteID).
		Scan(&i.ID, &i.Email, &i.Role, &i.CreatedAt, &i.ExpiresAt, &i.SentAt)
	return i, mapErr(err)
}

func (s *Store) RevokeInvite(ctx context.Context, teamID, inviteID string) error {
	tag, err := s.pool.Exec(ctx, `UPDATE team_invites SET revoked_at = now() WHERE team_id = $1 AND id = $2 AND accepted_at IS NULL AND revoked_at IS NULL`, teamID, inviteID)
	if err == nil && tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return mapErr(err)
}

// ReissueInvite gives a live invite a new token and expiry (for resending).
func (s *Store) ReissueInvite(ctx context.Context, teamID, inviteID string, tokenHash []byte, expires time.Time) (TeamInvite, error) {
	var i TeamInvite
	err := s.pool.QueryRow(ctx,
		`UPDATE team_invites SET token_hash = $3, expires_at = $4 WHERE team_id = $1 AND id = $2 AND accepted_at IS NULL AND revoked_at IS NULL
		 RETURNING id::text, email, role, created_at, expires_at, sent_at`, teamID, inviteID, tokenHash, expires).
		Scan(&i.ID, &i.Email, &i.Role, &i.CreatedAt, &i.ExpiresAt, &i.SentAt)
	return i, mapErr(err)
}

// InviteInfo is what the invite page shows before signing in.
type InviteInfo struct {
	TeamID    string `json:"teamId"`
	Team      string `json:"team"`
	Email     string `json:"email"`
	Role      string `json:"role"`
	InvitedBy string `json:"invitedBy"`
	Status    string `json:"status"` // pending | accepted | expired | revoked
}

func (s *Store) InviteByToken(ctx context.Context, tokenHash []byte) (InviteInfo, error) {
	var i InviteInfo
	err := s.pool.QueryRow(ctx,
		`SELECT t.id::text, t.name, i.email, i.role, COALESCE(NULLIF(u.name, ''), u.email, ''),
		        CASE WHEN i.accepted_at IS NOT NULL THEN 'accepted' WHEN i.revoked_at IS NOT NULL THEN 'revoked'
		             WHEN i.expires_at <= now() THEN 'expired' ELSE 'pending' END
		   FROM team_invites i JOIN teams t ON t.id = i.team_id LEFT JOIN users u ON u.id = i.invited_by
		  WHERE i.token_hash = $1`, tokenHash).
		Scan(&i.TeamID, &i.Team, &i.Email, &i.Role, &i.InvitedBy, &i.Status)
	return i, mapErr(err)
}

// AcceptInvite adds the signed-in account to the team, once, if the invite was
// sent to its email.
func (s *Store) AcceptInvite(ctx context.Context, tokenHash []byte, userID, userEmail string) (string, error) {
	var teamID string
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		var email, role string
		err := tx.QueryRow(ctx,
			`SELECT team_id::text, email, role FROM team_invites
			  WHERE token_hash = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now() FOR UPDATE`, tokenHash).
			Scan(&teamID, &email, &role)
		if err != nil {
			return mapErr(err)
		}
		if !strings.EqualFold(email, userEmail) {
			return ErrWrongEmail
		}
		if _, err := tx.Exec(ctx,
			`INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT (team_id, user_id) DO NOTHING`,
			teamID, userID, role); err != nil {
			return mapErr(err)
		}
		if _, err := tx.Exec(ctx, `UPDATE team_invites SET accepted_at = now(), accepted_by = $2 WHERE token_hash = $1`, tokenHash, userID); err != nil {
			return mapErr(err)
		}
		_, err = tx.Exec(ctx, `UPDATE users SET onboarded = true WHERE id = $1`, userID)
		return mapErr(err)
	})
	return teamID, err
}

func (s *Store) SetOnboarded(ctx context.Context, userID string) error {
	_, err := s.pool.Exec(ctx, `UPDATE users SET onboarded = true WHERE id = $1`, userID)
	return mapErr(err)
}
