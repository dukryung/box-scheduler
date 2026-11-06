package httpapi

import (
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"

	"box-scheduler/server/internal/store"
)

// Meeting recordings ("회의 녹음"): the browser records with MediaRecorder and
// uploads the recording piece by piece while the meeting goes on (pieces of a
// MediaRecorder recording, joined in order, are the whole file). Live captions
// go into the meeting's text as they come; the recording is kept to listen to
// and, later, to transcribe more carefully. Files live under Options.AudioDir.

const (
	maxAudioChunk = 4 << 20   // one piece (the app sends about 15 seconds)
	maxAudioBytes = 300 << 20 // one recording (about 20 hours at 32 kbps)
)

// audioTypes are the containers MediaRecorder produces (Chrome: webm, Safari: mp4), with their file extension.
var audioTypes = map[string]string{"audio/webm": ".webm", "audio/ogg": ".ogg", "audio/mp4": ".m4a", "audio/mpeg": ".mp3", "audio/wav": ".wav"}

func (a *API) audioPath(meetingID, audioID, mimeType string) string {
	base, _, _ := mime.ParseMediaType(mimeType)
	return filepath.Join(a.opts.AudioDir, meetingID, audioID+audioTypes[base])
}

// audioMeeting loads the meeting for a recording call; edit asks for its creator or a manager.
func (a *API) audioMeeting(w http.ResponseWriter, r *http.Request, edit bool) (string, store.Meeting, bool) {
	if a.opts.AudioDir == "" {
		writeError(w, http.StatusServiceUnavailable, "이 서버에는 녹음 저장소가 설정되지 않았어요")
		return "", store.Meeting{}, false
	}
	teamID, role, m, ok := a.loadMeeting(w, r)
	if !ok {
		return "", m, false
	}
	if edit && !canEditMeeting(role, currentUser(r).ID, m) {
		writeError(w, http.StatusForbidden, "회의를 만든 사람과 manager만 녹음할 수 있어요")
		return "", m, false
	}
	return teamID, m, true
}

func (a *API) startAudio(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Mime string `json:"mime"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	teamID, m, ok := a.audioMeeting(w, r, true)
	if !ok {
		return
	}
	base, _, err := mime.ParseMediaType(body.Mime)
	if _, known := audioTypes[base]; err != nil || !known || len(body.Mime) > 100 {
		writeError(w, http.StatusBadRequest, "이 브라우저의 녹음 형식은 저장할 수 없어요")
		return
	}
	if err := os.MkdirAll(filepath.Join(a.opts.AudioDir, m.ID), 0o750); err != nil {
		slog.Error("audio dir", "err", err)
		writeError(w, http.StatusInternalServerError, "녹음 파일을 만들지 못했어요")
		return
	}
	rec, err := a.store.CreateMeetingAudio(r.Context(), teamID, m.ID, currentUser(r).ID, body.Mime)
	if err != nil {
		writeMeetingError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, rec)
}

// appendAudio takes piece {seq} of a recording; sending a piece again is harmless.
func (a *API) appendAudio(w http.ResponseWriter, r *http.Request) {
	teamID, m, ok := a.audioMeeting(w, r, true)
	if !ok {
		return
	}
	seq, err := strconv.Atoi(chi.URLParam(r, "seq"))
	if err != nil || seq < 0 {
		writeError(w, http.StatusBadRequest, "seq must be a number")
		return
	}
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxAudioChunk))
	if err != nil {
		writeError(w, http.StatusRequestEntityTooLarge, "녹음 조각이 너무 커요")
		return
	}
	audioID := chi.URLParam(r, "audioID")
	cur, err := a.store.MeetingAudioByID(r.Context(), teamID, m.ID, audioID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	path := a.audioPath(m.ID, audioID, cur.Mime)
	rec, err := a.store.AppendMeetingAudio(r.Context(), teamID, m.ID, audioID, seq, maxAudioBytes, func(size int64) (int64, error) {
		f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY, 0o640)
		if err != nil {
			return 0, err
		}
		defer f.Close()
		// Bytes past what was recorded are from a try that failed before it was counted.
		if err := f.Truncate(size); err != nil {
			return 0, err
		}
		if _, err := f.WriteAt(data, size); err != nil {
			return 0, err
		}
		return int64(len(data)), f.Sync()
	})
	var order store.ErrChunkOrder
	switch {
	case errors.As(err, &order):
		writeJSON(w, http.StatusConflict, map[string]any{"error": "녹음 조각 순서가 맞지 않아요", "expected": order.Expected})
	case errors.Is(err, store.ErrInvalid):
		writeError(w, http.StatusRequestEntityTooLarge, "녹음 파일이 너무 커요. 녹음을 끝내고 새로 시작해 주세요")
	case err != nil:
		if !errors.Is(err, store.ErrMeetingState) && !errors.Is(err, store.ErrNotFound) {
			slog.Error("append audio", "err", err)
		}
		writeMeetingError(w, err)
	default:
		writeJSON(w, http.StatusOK, rec)
	}
}

func (a *API) finishAudio(w http.ResponseWriter, r *http.Request) {
	var body struct {
		DurationSec int `json:"durationSec"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	teamID, m, ok := a.audioMeeting(w, r, true)
	if !ok {
		return
	}
	rec, err := a.store.FinishMeetingAudio(r.Context(), teamID, m.ID, chi.URLParam(r, "audioID"), max(body.DurationSec, 0))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, rec)
}

// getAudio plays a recording back for anyone in the team.
func (a *API) getAudio(w http.ResponseWriter, r *http.Request) {
	teamID, m, ok := a.audioMeeting(w, r, false)
	if !ok {
		return
	}
	rec, err := a.store.MeetingAudioByID(r.Context(), teamID, m.ID, chi.URLParam(r, "audioID"))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	f, err := os.Open(a.audioPath(m.ID, rec.ID, rec.Mime))
	if err != nil {
		writeError(w, http.StatusNotFound, "녹음 파일이 없어요")
		return
	}
	defer f.Close()
	w.Header().Set("Content-Type", rec.Mime)
	w.Header().Set("Cache-Control", "private, no-cache")
	// Only what was counted: a piece being written is not part of it yet.
	http.ServeContent(w, r, "", rec.CreatedAt, io.NewSectionReader(f, 0, rec.Bytes))
}

func (a *API) deleteAudio(w http.ResponseWriter, r *http.Request) {
	teamID, m, ok := a.audioMeeting(w, r, true)
	if !ok {
		return
	}
	rec, err := a.store.MeetingAudioByID(r.Context(), teamID, m.ID, chi.URLParam(r, "audioID"))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if err := a.store.DeleteMeetingAudio(r.Context(), teamID, m.ID, rec.ID); err != nil {
		writeStoreError(w, err)
		return
	}
	if err := os.Remove(a.audioPath(m.ID, rec.ID, rec.Mime)); err != nil && !errors.Is(err, os.ErrNotExist) {
		slog.Warn("remove audio", "err", err)
	}
	w.WriteHeader(http.StatusNoContent)
}

// removeMeetingAudio drops a deleted meeting's recordings from disk.
func (a *API) removeMeetingAudio(meetingID string) {
	if a.opts.AudioDir == "" || meetingID == "" {
		return
	}
	if err := os.RemoveAll(filepath.Join(a.opts.AudioDir, meetingID)); err != nil {
		slog.Warn("remove meeting audio", "meeting", meetingID, "err", err)
	}
}

// SweepMeetingAudio removes the recordings of meetings that are gone (their
// team was deleted, which drops its meetings without the server seeing it).
func SweepMeetingAudio(dir string, live map[string]bool) (int, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return 0, nil
		}
		return 0, err
	}
	n := 0
	for _, e := range entries {
		if !e.IsDir() || live[e.Name()] {
			continue
		}
		// Leave a folder just made for a meeting still being created.
		if info, err := e.Info(); err == nil && time.Since(info.ModTime()) < time.Hour {
			continue
		}
		if err := os.RemoveAll(filepath.Join(dir, e.Name())); err != nil {
			return n, fmt.Errorf("remove %s: %w", e.Name(), err)
		}
		n++
	}
	return n, nil
}
