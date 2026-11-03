package httpapi

import (
	"net/http/httptest"
	"strings"
	"testing"
	"unicode/utf8"

	"box-scheduler/server/internal/ai"
	"box-scheduler/server/internal/store"
)

func TestSplitTranscriptKeepsLinesWhole(t *testing.T) {
	line := "김민지: " + strings.Repeat("가", 50)
	text := strings.Repeat(line+"\n", 100)
	parts := splitTranscript(text, 1800)
	if len(parts) < 3 {
		t.Fatalf("want several parts, got %d", len(parts))
	}
	total := 0
	for _, p := range parts {
		if n := utf8.RuneCountInString(p); n > 1800 {
			t.Errorf("part of %d runes", n)
		}
		for _, l := range strings.Split(p, "\n") {
			if l != line {
				t.Fatalf("line cut: %q", l)
			}
			total++
		}
	}
	if total != 100 {
		t.Errorf("want all 100 lines, got %d", total)
	}
	if got := splitTranscript("짧은 회의", 1800); len(got) != 1 || got[0] != "짧은 회의" {
		t.Errorf("short text: %q", got)
	}
}

func TestSplitTranscriptCutsALongLineAtASentence(t *testing.T) {
	sentence := strings.Repeat("나", 29) + ". "
	parts := splitTranscript(strings.Repeat(sentence, 100), 100)
	for _, p := range parts[:len(parts)-1] {
		if !strings.HasSuffix(p, ".") || utf8.RuneCountInString(p) > 100 {
			t.Fatalf("part should end a sentence within 100 runes: %q", p)
		}
	}
}

func TestMatchMember(t *testing.T) {
	members := []store.TeamMember{{UserID: "a", Name: "김민지"}, {UserID: "b", Name: "박서준"}, {UserID: "c", Name: "", Email: "jun@x.test"}, {UserID: "d", Name: "이민지"}}
	for name, want := range map[string]string{
		"김민지": "a", "박서준": "b", "서준 님": "b", "서준씨": "b", "박서준 대리": "b", "jun": "c",
		"민지": "", // 김민지 and 이민지
		"":   "", "최": "", "홍길동": "",
	} {
		if got := matchMember(name, members); got != want {
			t.Errorf("matchMember(%q) = %q, want %q", name, got, want)
		}
	}
}

func TestFoundTasksMergesAndChecksEvidence(t *testing.T) {
	members := []store.TeamMember{{UserID: "a", Name: "김민지"}, {UserID: "b", Name: "박서준"}}
	transcript := "박서준: 제가 목요일까지 초안 쓸게요.\n김민지: 가격표는   금요일까지 정리할게요."
	parts := []ai.MeetingPart{
		{Tasks: []ai.MeetingTask{
			{Title: "제안서 초안 작성", Assignee: "", Evidence: "제가 목요일까지 초안 쓸게요."},
			{Title: "가격표 정리", Assignee: "민지", DueDate: "2026-05-15", Evidence: "\"가격표는 금요일까지 정리할게요\""},
			{Title: "  ", Assignee: "박서준"},
		}},
		{Tasks: []ai.MeetingTask{
			{Title: "제안서 초안  작성", Assignee: "서준 님", DueDate: "2026-05-14", Evidence: "없던 말"},
			{Title: "발표 자료", DueDate: "목요일", Evidence: "지어낸 문장이에요"},
		}},
	}
	got := foundTasks(parts, members, transcript)
	if len(got) != 3 {
		t.Fatalf("want 3 tasks, got %+v", got)
	}
	if got[0].AssigneeID != "b" || got[0].DueDate == nil || *got[0].DueDate != "2026-05-14" || got[0].Evidence == "" {
		t.Errorf("the same task named twice should merge its assignee and due date: %+v", got[0])
	}
	if got[1].AssigneeID != "a" || got[1].Evidence == "" {
		t.Errorf("evidence spaced or quoted differently still counts: %+v", got[1])
	}
	if got[2].Evidence != "" || got[2].DueDate != nil {
		t.Errorf("made-up evidence and a non-date are dropped: %+v", got[2])
	}
}

func TestCleanTasksChecksAssignees(t *testing.T) {
	members := []store.TeamMember{{UserID: "a"}}
	empty, bad := "", "5월"
	if _, msg := cleanTasks([]store.MeetingTask{{Title: "x", AssigneeID: "z"}}, members); msg == "" {
		t.Error("an assignee outside the team is refused")
	}
	if _, msg := cleanTasks([]store.MeetingTask{{Title: "x", DueDate: &bad}}, members); msg == "" {
		t.Error("a bad due date is refused")
	}
	got, msg := cleanTasks([]store.MeetingTask{{Title: " x ", DueDate: &empty, AssigneeID: "a", ID: "old", TeamTaskID: "t"}, {Title: " "}}, members)
	if msg != "" || len(got) != 1 || got[0].Title != "x" || got[0].DueDate != nil || got[0].ID != "" || got[0].TeamTaskID != "" {
		t.Errorf("cleaned: %+v %q", got, msg)
	}
}

func TestAllowedBodyTakesRawBytesOnlyForRecordingPieces(t *testing.T) {
	for _, c := range []struct {
		method, path, ct string
		want             bool
	}{
		{"POST", "/api/teams/t/meetings/m/audio/a/chunks/0", "application/octet-stream", true},
		{"POST", "/api/teams/t/meetings/m/audio", "application/json", true},
		{"POST", "/api/teams/t/meetings/m/audio", "application/octet-stream", false},
		{"POST", "/api/teams/t/tasks", "application/octet-stream", false},
		{"POST", "/api/teams/t/meetings/m/audio/a/chunks/0", "text/plain", false},
		{"POST", "/api/teams/t/meetings/m/audio/a/chunks/0", "multipart/form-data", false},
		{"DELETE", "/api/teams/t/meetings/m/audio/a/chunks/0", "application/octet-stream", false},
	} {
		r := httptest.NewRequest(c.method, c.path, nil)
		r.Header.Set("Content-Type", c.ct)
		if got := allowedBody(r); got != c.want {
			t.Errorf("%s %s (%s) = %v, want %v", c.method, c.path, c.ct, got, c.want)
		}
	}
}
