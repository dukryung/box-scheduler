package httpapi

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"

	"box-scheduler/server/internal/ai"
	"box-scheduler/server/internal/store"
	"box-scheduler/server/internal/stt"
)

// Transcribing a recording ("받아쓰기"): the live captions are quick but rough
// and do not know who spoke, so a finished recording can go to the Mac mini,
// where Whisper writes it down carefully and the speakers are told apart
// ("화자 1", "화자 2", ...). People then say who each speaker is, and the
// result becomes the meeting's text, ready for the minutes.

const (
	transcribeTime = 4 * time.Hour // a long meeting waits behind others and takes a while
	maxSpeakers    = 20
)

// sttPoll is how often a running transcription is checked.
var sttPoll = 3 * time.Second

func (a *API) startTranscribe(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Speakers    int  `json:"speakers"`
		ThenMinutes bool `json:"thenMinutes"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	if a.opts.STT == nil {
		writeError(w, http.StatusServiceUnavailable, "이 서버에는 받아쓰기(Mac mini)가 설정되지 않았어요")
		return
	}
	teamID, m, ok := a.audioMeeting(w, r, true)
	if !ok {
		return
	}
	members, err := a.store.TeamMembers(r.Context(), teamID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	// The minutes come right after, with the AI of the person who asked.
	var p ai.Provider
	if body.ThenMinutes {
		if p, ok = a.aiFor(w, r, "minutes"); !ok {
			return
		}
	}
	rec, err := a.store.StartTranscribe(r.Context(), teamID, m.ID, chi.URLParam(r, "audioID"), body.ThenMinutes)
	if errors.Is(err, store.ErrMeetingState) && (m.Status == "draft" || m.Status == "ready") {
		writeError(w, http.StatusConflict, "녹음이 아직 끝나지 않았거나 이미 받아쓰는 중이에요")
		return
	}
	if err != nil {
		writeMeetingError(w, err)
		return
	}
	go a.transcribe(currentUser(r).ID, teamID, m, rec, members, min(max(body.Speakers, 0), maxSpeakers), p)
	writeJSON(w, http.StatusAccepted, rec)
}

func sttErrorText(err error) string {
	switch {
	case errors.Is(err, stt.ErrUnreachable):
		return "Mac mini의 받아쓰기 서버에 연결하지 못했어요. Mac mini가 켜져 있는지 확인하고 다시 해 주세요"
	case errors.Is(err, context.DeadlineExceeded):
		return "받아쓰기가 너무 오래 걸려 멈췄어요. 다시 해 주세요"
	}
	return "녹음을 받아쓰지 못했어요. 다시 해 주세요"
}

// transcribe sends the recording to the Mac mini, waits for it, and saves who
// said what. With p, the meeting's text becomes the transcription and the
// minutes are written next.
func (a *API) transcribe(userID, teamID string, m store.Meeting, rec store.MeetingAudio, members []store.TeamMember, speakers int, p ai.Provider) {
	ctx, cancel := context.WithTimeout(context.Background(), transcribeTime)
	defer cancel()
	started := time.Now()
	link := "/team/" + teamID + "?tab=meetings&meeting=" + m.ID
	fail := func(msg string, err error) {
		slog.Error("transcribe failed", "meeting", m.ID, "audio", rec.ID, "err", err, "elapsed", time.Since(started))
		if err := a.store.FailTranscribe(context.WithoutCancel(ctx), rec.ID, msg); err != nil {
			slog.Error("save transcribe failure", "err", err)
		}
		// The minutes were waiting for it: they are written from the live captions instead.
		if p != nil && a.minutesFromCaptions(context.WithoutCancel(ctx), userID, teamID, m.ID, members, p) == nil {
			msg += ". 대신 실시간 자막으로 회의록을 정리하고 있어요"
		}
		a.notifyTeam(context.WithoutCancel(ctx), userID, store.Notification{Kind: "meeting", Title: fmt.Sprintf("‘%s’ 녹음을 받아쓰지 못했어요", m.Title), Body: msg, Link: link})
	}

	f, err := os.Open(a.audioPath(m.ID, rec.ID, rec.Mime))
	if err != nil {
		fail("녹음 파일이 없어요", err)
		return
	}
	job, err := a.opts.STT.Submit(ctx, io.NewSectionReader(f, 0, rec.Bytes), rec.Bytes, rec.Mime, stt.Options{
		Language: "ko", Speakers: speakers, Prompt: whisperPrompt(members),
	})
	f.Close()
	if err != nil {
		fail(sttErrorText(err), err)
		return
	}
	job, err = a.opts.STT.Wait(ctx, job.ID, sttPoll, func(j stt.Job) {
		status := "running"
		if j.Status == "queued" {
			status = "queued"
		}
		_ = a.store.TranscribeStage(ctx, rec.ID, status, j.Stage)
	})
	if err != nil {
		if ctx.Err() != nil {
			_ = a.opts.STT.Cancel(context.WithoutCancel(ctx), job.ID)
		}
		fail(sttErrorText(err), err)
		return
	}
	if job.Status != "done" || job.Result == nil {
		fail("Mac mini가 녹음을 받아쓰지 못했어요. 다시 해 주세요", errors.New(job.Error))
		return
	}
	segments := cleanSegments(job.Result.Segments)
	if err := a.store.FinishTranscribe(ctx, rec.ID, segments); err != nil {
		slog.Warn("save transcription", "audio", rec.ID, "err", err) // deleted while it ran
		return
	}
	speakersFound := 0
	for _, s := range segments {
		speakersFound = max(speakersFound, s.Speaker)
	}
	slog.Info("transcribed", "meeting", m.ID, "audio", rec.ID, "seconds", job.Duration, "segments", len(segments), "speakers", speakersFound, "elapsed", time.Since(started))

	if p != nil {
		err := a.minutesFromTranscription(ctx, userID, teamID, m.ID, members, p)
		if errors.Is(err, errNothingHeard) {
			err = a.minutesFromCaptions(ctx, userID, teamID, m.ID, members, p)
		}
		if err == nil {
			return // the minutes tell when they are done
		}
		slog.Warn("minutes after transcription", "meeting", m.ID, "err", err)
	}
	body := fmt.Sprintf("화자 %d명으로 나눠 적었어요. 누가 누구인지 정하고 회의 내용으로 넣어 주세요", speakersFound)
	if len(segments) == 0 {
		body = "녹음에서 알아들은 말이 없어요"
	}
	a.notifyTeam(context.WithoutCancel(ctx), userID, store.Notification{Kind: "meeting", Title: fmt.Sprintf("‘%s’ 녹음 받아쓰기가 끝났어요", m.Title), Body: body, Link: link})
}

var errNothingHeard = errors.New("nothing heard")

// transcribing tells whether a recording of m is still being written down.
func transcribing(m store.Meeting) bool {
	for _, a := range m.Audio {
		if a.SttStatus == "queued" || a.SttStatus == "running" {
			return true
		}
	}
	return false
}

// minutesFromCaptions has the AI write the minutes from the meeting's text as
// it is (the live captions), when the transcription cannot be had.
func (a *API) minutesFromCaptions(ctx context.Context, userID, teamID, meetingID string, members []store.TeamMember, p ai.Provider) error {
	m, err := a.store.MeetingByID(ctx, teamID, meetingID)
	if err != nil {
		return err
	}
	if strings.TrimSpace(m.Transcript) == "" || transcribing(m) {
		return errNothingHeard
	}
	return a.beginMinutes(ctx, userID, teamID, m, members, p)
}

// minutesFromTranscription makes the transcriptions the meeting's text and has the AI write the minutes.
func (a *API) minutesFromTranscription(ctx context.Context, userID, teamID, meetingID string, members []store.TeamMember, p ai.Provider) error {
	m, err := a.store.MeetingByID(ctx, teamID, meetingID)
	if err != nil {
		return err
	}
	text := transcriptionText(m.Audio)
	if text == "" {
		return errNothingHeard
	}
	if err := a.store.SetTranscript(ctx, teamID, m.ID, text); err != nil {
		return err
	}
	m.Transcript = text
	return a.beginMinutes(ctx, userID, teamID, m, members, p)
}

// whisperPrompt gives Whisper the team's names, so it spells them as the team does.
func whisperPrompt(members []store.TeamMember) string {
	names := []string{}
	for _, x := range members {
		if x.Name != "" {
			names = append(names, x.Name)
		}
	}
	if len(names) == 0 {
		return ""
	}
	return clip("회의 참석자: "+strings.Join(names, ", ")+".", 300)
}

func cleanSegments(in []stt.Segment) []store.Segment {
	out := []store.Segment{}
	total := 0
	for _, s := range in {
		text := clip(s.Text, 2000)
		if text == "" || s.Speaker < 1 || s.Speaker > 99 {
			continue
		}
		if total += utf8.RuneCountInString(text); total > maxTranscript {
			break
		}
		out = append(out, store.Segment{Start: s.Start, End: s.End, Speaker: s.Speaker, Text: text})
	}
	return out
}

func speakerLabel(rec store.MeetingAudio, n int) string {
	if name := strings.TrimSpace(rec.SpeakerNames[strconv.Itoa(n)]); name != "" {
		return name
	}
	return fmt.Sprintf("화자 %d", n)
}

// transcriptionText writes the transcribed recordings out as the meeting's
// text, a line per turn: "김민지: ...".
func transcriptionText(recs []store.MeetingAudio) string {
	lines := []string{}
	for _, rec := range recs {
		if rec.SttStatus != "done" {
			continue
		}
		for _, s := range rec.Segments {
			lines = append(lines, speakerLabel(rec, s.Speaker)+": "+s.Text)
		}
	}
	return clip(strings.Join(lines, "\n"), maxTranscript)
}

// setSpeakers saves who each speaker of a transcription is.
func (a *API) setSpeakers(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Names map[string]string `json:"names"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	teamID, m, ok := a.audioMeeting(w, r, true)
	if !ok {
		return
	}
	names := map[string]string{}
	for k, v := range body.Names {
		n, err := strconv.Atoi(k)
		if err != nil || n < 1 || n > 99 {
			writeError(w, http.StatusBadRequest, "화자 번호가 올바르지 않아요")
			return
		}
		if v = clip(v, 40); v != "" {
			names[strconv.Itoa(n)] = v
		}
	}
	rec, err := a.store.SetSpeakerNames(r.Context(), teamID, m.ID, chi.URLParam(r, "audioID"), names)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, rec)
}

// useTranscription makes the transcribed recordings the meeting's text, in place of what was there.
func (a *API) useTranscription(w http.ResponseWriter, r *http.Request) {
	teamID, role, cur, ok := a.loadMeeting(w, r)
	if !ok {
		return
	}
	me := currentUser(r).ID
	if !canEditMeeting(role, me, cur) {
		writeError(w, http.StatusForbidden, "회의를 만든 사람과 manager만 고칠 수 있어요")
		return
	}
	text := transcriptionText(cur.Audio)
	if text == "" {
		writeError(w, http.StatusBadRequest, "받아쓰기가 끝난 녹음이 없어요")
		return
	}
	if err := a.store.SetTranscript(r.Context(), teamID, cur.ID, text); err != nil {
		writeMeetingError(w, err)
		return
	}
	m, err := a.store.MeetingByID(r.Context(), teamID, cur.ID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, a.withMeetingPermissions(role, me, m))
}
