package httpapi

import (
	"errors"
	"fmt"
	"html"
	"log/slog"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"

	"box-scheduler/server/internal/auth"
	"box-scheduler/server/internal/mail"
	"box-scheduler/server/internal/store"
)

const (
	inviteTTL       = 7 * 24 * time.Hour
	maxInvitesBatch = 20
)

var roleLabel = map[string]string{"owner": "owner", "manager": "manager", "member": "member"}

func cleanTeamName(s string) (string, bool) {
	s = strings.TrimSpace(s)
	n := utf8.RuneCountInString(s)
	return s, n >= 1 && n <= 60
}

// teamRole loads the caller's role in the URL's team and checks it is at least need.
func (a *API) teamRole(w http.ResponseWriter, r *http.Request, need string) (string, string, bool) {
	teamID := chi.URLParam(r, "teamID")
	role, err := a.store.TeamRole(r.Context(), teamID, currentUser(r).ID)
	if err != nil {
		writeStoreError(w, err) // not a member: 404, the team is not revealed
		return "", "", false
	}
	if store.RoleRank(role) < store.RoleRank(need) {
		writeError(w, http.StatusForbidden, roleLabel[need]+" 이상만 할 수 있어요")
		return "", "", false
	}
	return teamID, role, true
}

func (a *API) listTeams(w http.ResponseWriter, r *http.Request) {
	teams, err := a.store.ListTeams(r.Context(), currentUser(r).ID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"teams": teams})
}

func (a *API) createTeam(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name string `json:"name"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	name, ok := cleanTeamName(body.Name)
	if !ok {
		writeError(w, http.StatusBadRequest, "팀 이름은 1~60자로 적어 주세요")
		return
	}
	if !a.loginLimit.Allow("team-create:" + currentUser(r).ID) {
		writeError(w, http.StatusTooManyRequests, "팀을 너무 많이 만들었어요. 잠시 후 다시 해 주세요")
		return
	}
	t, err := a.store.CreateTeam(r.Context(), currentUser(r).ID, name)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, t)
}

type teamDetail struct {
	store.Team
	MembersList []store.TeamMember `json:"memberList"`
	Invites     []store.TeamInvite `json:"invites"`
	MailEnabled bool               `json:"mailEnabled"`
}

func (a *API) getTeam(w http.ResponseWriter, r *http.Request) {
	teamID, role, ok := a.teamRole(w, r, "member")
	if !ok {
		return
	}
	t, err := a.store.TeamByID(r.Context(), teamID, currentUser(r).ID)
	if err == nil {
		var members []store.TeamMember
		if members, err = a.store.TeamMembers(r.Context(), teamID); err == nil {
			invites := []store.TeamInvite{}
			if store.RoleRank(role) >= store.RoleRank("manager") {
				invites, err = a.store.PendingInvites(r.Context(), teamID)
			}
			if err == nil {
				writeJSON(w, http.StatusOK, teamDetail{Team: t, MembersList: members, Invites: invites, MailEnabled: a.opts.Mail.Enabled()})
				return
			}
		}
	}
	writeStoreError(w, err)
}

func (a *API) updateTeam(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name string `json:"name"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	teamID, _, ok := a.teamRole(w, r, "owner")
	if !ok {
		return
	}
	name, valid := cleanTeamName(body.Name)
	if !valid {
		writeError(w, http.StatusBadRequest, "팀 이름은 1~60자로 적어 주세요")
		return
	}
	if err := a.store.RenameTeam(r.Context(), teamID, name); err != nil {
		writeStoreError(w, err)
		return
	}
	a.getTeam(w, r)
}

// deleteTeam needs the team's name typed again.
func (a *API) deleteTeam(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Confirm string `json:"confirm"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	teamID, _, ok := a.teamRole(w, r, "owner")
	if !ok {
		return
	}
	t, err := a.store.TeamByID(r.Context(), teamID, currentUser(r).ID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if strings.TrimSpace(body.Confirm) != t.Name {
		writeError(w, http.StatusBadRequest, "확인용 팀 이름이 맞지 않아요")
		return
	}
	if err := a.store.DeleteTeam(r.Context(), teamID); err != nil {
		writeStoreError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func inviteMail(team, inviter, role, link string, expires time.Time) mail.Message {
	subject := fmt.Sprintf("[Box Scheduler] %s님이 ‘%s’ 팀에 초대했어요", inviter, team)
	text := fmt.Sprintf("%s님이 Box Scheduler의 ‘%s’ 팀에 %s(으)로 초대했어요.\n\n아래 링크에서 이 메일 주소로 가입하거나 로그인하면 팀에 들어갈 수 있어요.\n%s\n\n링크는 %s까지 쓸 수 있어요. 모르는 초대라면 이 메일은 무시하세요.\n",
		inviter, team, roleLabel[role], link, expires.In(seoul).Format("2006-01-02 15:04"))
	h := html.EscapeString
	body := fmt.Sprintf(`<div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#1c1917">
<h2 style="margin:0 0 12px;font-size:20px">‘%s’ 팀 초대</h2>
<p style="line-height:1.6">%s님이 Box Scheduler의 <b>%s</b> 팀에 <b>%s</b>(으)로 초대했어요. 이 메일 주소로 가입하거나 로그인하면 팀에 들어갈 수 있어요.</p>
<p style="margin:24px 0"><a href="%s" style="background:#d0470c;color:#fff;text-decoration:none;padding:12px 20px;border-radius:10px;font-weight:600">초대 수락하기</a></p>
<p style="font-size:13px;color:#6e6862;line-height:1.6">링크는 %s까지 쓸 수 있어요. 모르는 초대라면 이 메일은 무시하세요.<br>%s</p></div>`,
		h(team), h(inviter), h(team), h(roleLabel[role]), h(link), expires.In(seoul).Format("2006-01-02 15:04"), h(link))
	return mail.Message{Subject: subject, Text: text, HTML: body}
}

var seoul = func() *time.Location {
	if l, err := time.LoadLocation("Asia/Seoul"); err == nil {
		return l
	}
	return time.FixedZone("KST", 9*3600)
}()

type inviteResult struct {
	Email string `json:"email"`
	OK    bool   `json:"ok"`
	Sent  bool   `json:"sent"`
	Link  string `json:"link,omitempty"` // when no email went out, to pass on by hand
	Error string `json:"error,omitempty"`
}

// sendInvite emails the link, or returns it when mail is not set up or failed.
func (a *API) sendInvite(r *http.Request, teamName, role string, inv store.TeamInvite, token string) inviteResult {
	link := a.opts.PublicURL + "/invite/" + token
	u := currentUser(r)
	inviter := u.Name
	if inviter == "" {
		inviter = u.Email
	}
	msg := inviteMail(teamName, inviter, role, link, inv.ExpiresAt)
	msg.To = inv.Email
	res := inviteResult{Email: inv.Email, OK: true}
	if err := a.opts.Mail.Send(msg); err != nil {
		if !errors.Is(err, mail.ErrNotConfigured) {
			slog.Warn("invite mail failed", "err", err)
			res.Error = "메일을 보내지 못했어요. 링크를 직접 전달해 주세요"
		}
		res.Link = link
		return res
	}
	_ = a.store.MarkInviteSent(r.Context(), inv.ID)
	res.Sent = true
	return res
}

func (a *API) createInvites(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Emails []string `json:"emails"`
		Role   string   `json:"role"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	teamID, _, ok := a.teamRole(w, r, "manager")
	if !ok {
		return
	}
	if body.Role != "owner" && body.Role != "manager" && body.Role != "member" {
		writeError(w, http.StatusBadRequest, "역할은 owner, manager, member 중에서 골라 주세요")
		return
	}
	if len(body.Emails) == 0 || len(body.Emails) > maxInvitesBatch {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("이메일을 1~%d개 넣어 주세요", maxInvitesBatch))
		return
	}
	if !a.signupLimit.Allow("invite:" + teamID) {
		writeError(w, http.StatusTooManyRequests, "초대를 너무 많이 보냈어요. 잠시 후 다시 해 주세요")
		return
	}
	t, err := a.store.TeamByID(r.Context(), teamID, currentUser(r).ID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	results := []inviteResult{}
	seen := map[string]bool{}
	for _, raw := range body.Emails {
		email, valid := normEmail(raw)
		switch {
		case !valid:
			results = append(results, inviteResult{Email: strings.TrimSpace(raw), Error: "이메일 주소를 확인해 주세요"})
			continue
		case seen[email]:
			continue
		}
		seen[email] = true
		token, hash, err := auth.NewToken()
		if err != nil {
			writeStoreError(w, err)
			return
		}
		inv, err := a.store.CreateInvite(r.Context(), teamID, email, body.Role, currentUser(r).ID, hash, time.Now().Add(inviteTTL))
		if errors.Is(err, store.ErrMember) {
			results = append(results, inviteResult{Email: email, Error: "이미 팀 멤버예요"})
			continue
		}
		if err != nil {
			writeStoreError(w, err)
			return
		}
		results = append(results, a.sendInvite(r, t.Name, body.Role, inv, token))
	}
	writeJSON(w, http.StatusOK, map[string]any{"results": results})
}

func (a *API) resendInvite(w http.ResponseWriter, r *http.Request) {
	teamID, _, ok := a.teamRole(w, r, "manager")
	if !ok {
		return
	}
	if !a.signupLimit.Allow("invite:" + teamID) {
		writeError(w, http.StatusTooManyRequests, "초대를 너무 많이 보냈어요. 잠시 후 다시 해 주세요")
		return
	}
	t, err := a.store.TeamByID(r.Context(), teamID, currentUser(r).ID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	token, hash, err := auth.NewToken()
	if err != nil {
		writeStoreError(w, err)
		return
	}
	// A new token: the old link stops working.
	inv, err := a.store.ReissueInvite(r.Context(), teamID, chi.URLParam(r, "inviteID"), hash, time.Now().Add(inviteTTL))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, a.sendInvite(r, t.Name, inv.Role, inv, token))
}

func (a *API) revokeInvite(w http.ResponseWriter, r *http.Request) {
	teamID, _, ok := a.teamRole(w, r, "manager")
	if !ok {
		return
	}
	if err := a.store.RevokeInvite(r.Context(), teamID, chi.URLParam(r, "inviteID")); err != nil {
		writeStoreError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// updateMember changes a member's role (owners only). Owners may make others
// owners too, and step down themselves, as long as one owner is left.
func (a *API) updateMember(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Role string `json:"role"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	teamID, _, ok := a.teamRole(w, r, "owner")
	if !ok {
		return
	}
	if body.Role != "owner" && body.Role != "manager" && body.Role != "member" {
		writeError(w, http.StatusBadRequest, "역할은 owner, manager, member 중에서 골라 주세요")
		return
	}
	if err := a.store.SetMemberRole(r.Context(), teamID, chi.URLParam(r, "userID"), body.Role); err != nil {
		writeStoreError(w, err)
		return
	}
	a.getTeam(w, r)
}

// removeMember: anyone may leave (an owner, while another owner stays);
// managers may remove members; owners may remove anyone else.
func (a *API) removeMember(w http.ResponseWriter, r *http.Request) {
	teamID, role, ok := a.teamRole(w, r, "member")
	if !ok {
		return
	}
	target := chi.URLParam(r, "userID")
	me := currentUser(r).ID
	if target != me {
		targetRole, err := a.store.TeamRole(r.Context(), teamID, target)
		if err != nil {
			writeStoreError(w, err)
			return
		}
		if role != "owner" && (store.RoleRank(role) < store.RoleRank("manager") || store.RoleRank(targetRole) >= store.RoleRank(role)) {
			writeError(w, http.StatusForbidden, "이 멤버를 내보낼 권한이 없어요")
			return
		}
	}
	if err := a.store.RemoveMember(r.Context(), teamID, target); err != nil {
		writeStoreError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) transferTeam(w http.ResponseWriter, r *http.Request) {
	var body struct {
		UserID string `json:"userId"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	teamID, _, ok := a.teamRole(w, r, "owner")
	if !ok {
		return
	}
	if body.UserID == currentUser(r).ID {
		writeError(w, http.StatusBadRequest, "다른 멤버를 골라 주세요")
		return
	}
	if err := a.store.TransferOwner(r.Context(), teamID, currentUser(r).ID, body.UserID); err != nil {
		writeStoreError(w, err)
		return
	}
	a.getTeam(w, r)
}

// ---- invite links (the page before and after signing in) ----

func (a *API) inviteInfo(w http.ResponseWriter, r *http.Request) {
	info, err := a.store.InviteByToken(r.Context(), auth.HashToken(chi.URLParam(r, "token")))
	if err != nil {
		writeError(w, http.StatusNotFound, "초대를 찾을 수 없어요. 링크를 다시 확인해 주세요")
		return
	}
	writeJSON(w, http.StatusOK, info)
}

func (a *API) acceptInvite(w http.ResponseWriter, r *http.Request) {
	u := currentUser(r)
	teamID, err := a.store.AcceptInvite(r.Context(), auth.HashToken(chi.URLParam(r, "token")), u.ID, u.Email)
	switch {
	case errors.Is(err, store.ErrWrongEmail):
		writeErrorCode(w, http.StatusForbidden, "wrong_email", "이 초대는 다른 이메일로 보냈어요. 초대받은 이메일로 로그인해 주세요")
	case errors.Is(err, store.ErrNotFound):
		writeError(w, http.StatusGone, "만료됐거나 이미 쓴 초대예요. 초대한 사람에게 다시 보내 달라고 해 주세요")
	case err != nil:
		writeStoreError(w, err)
	default:
		writeJSON(w, http.StatusOK, map[string]string{"teamId": teamID})
	}
}

func (a *API) finishOnboarding(w http.ResponseWriter, r *http.Request) {
	if err := a.store.SetOnboarded(r.Context(), currentUser(r).ID); err != nil {
		writeStoreError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
