package httpapi

import (
	"strings"
	"testing"

	"box-scheduler/server/internal/store"
	"box-scheduler/server/internal/stt"
)

func TestTranscriptionText(t *testing.T) {
	recs := []store.MeetingAudio{
		{SttStatus: "done", SpeakerNames: map[string]string{"1": "김민지", "2": " "}, Segments: []store.Segment{
			{Speaker: 1, Text: "회의 시작할게요."}, {Speaker: 2, Text: "제가 금요일까지 할게요."}, {Speaker: 1, Text: "좋아요."},
		}},
		{SttStatus: "running", Segments: []store.Segment{{Speaker: 1, Text: "아직"}}},
		{SttStatus: "done", SpeakerNames: map[string]string{}, Segments: []store.Segment{{Speaker: 3, Text: "두 번째 녹음"}}},
	}
	got := transcriptionText(recs)
	want := "김민지: 회의 시작할게요.\n화자 2: 제가 금요일까지 할게요.\n김민지: 좋아요.\n화자 3: 두 번째 녹음"
	if got != want {
		t.Fatalf("got %q\nwant %q", got, want)
	}
	if transcriptionText(nil) != "" {
		t.Fatal("nothing transcribed should give no text")
	}
}

func TestCleanSegments(t *testing.T) {
	got := cleanSegments([]stt.Segment{
		{Speaker: 1, Text: "  안녕하세요 "}, {Speaker: 0, Text: "번호 없음"}, {Speaker: 2, Text: "   "}, {Speaker: 2, Start: 1.5, End: 3, Text: "네"},
	})
	if len(got) != 2 || got[0].Text != "안녕하세요" || got[1].Start != 1.5 || got[1].Speaker != 2 {
		t.Fatalf("got %+v", got)
	}
	long := []stt.Segment{}
	for i := 0; i < 200; i++ {
		long = append(long, stt.Segment{Speaker: 1, Text: strings.Repeat("가", 1000)})
	}
	if n := len(cleanSegments(long)); n != maxTranscript/1000 {
		t.Fatalf("kept %d segments, want %d", n, maxTranscript/1000)
	}
}

func TestWhisperPrompt(t *testing.T) {
	if p := whisperPrompt([]store.TeamMember{{Name: "김민지"}, {Email: "x@y.z"}, {Name: "이준호"}}); p != "회의 참석자: 김민지, 이준호." {
		t.Fatalf("got %q", p)
	}
	if whisperPrompt(nil) != "" {
		t.Fatal("no names should give no prompt")
	}
}
