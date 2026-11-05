package httpapi

import (
	"context"
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
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
			{Title: "제안서 초안  작성", Assignee: "서준 님", DueDate: "2026-05-14", Evidence: "제가 목요일까지 초안 쓸게요."},
			{Title: "발표 자료", Assignee: "박서준", DueDate: "2026-05-13", Evidence: "지어낸 문장이에요"},
		}},
	}
	got := foundTasks(parts, members, transcript, "2026-05-12")
	if len(got) != 3 {
		t.Fatalf("want 3 tasks, got %+v", got)
	}
	if got[0].AssigneeID != "b" || got[0].DueDate == nil || *got[0].DueDate != "2026-05-14" || got[0].Evidence == "" {
		t.Errorf("the same task named twice should merge its assignee and due date: %+v", got[0])
	}
	if got[1].AssigneeID != "a" || got[1].Evidence == "" {
		t.Errorf("evidence spaced or quoted differently still counts: %+v", got[1])
	}
	if got[2].Evidence != "" || got[2].DueDate != nil || got[2].AssigneeID != "" {
		t.Errorf("with made-up evidence, the assignee and due date are dropped too: %+v", got[2])
	}
}

func TestFoundTasksAssignOnlyWhoTookItOn(t *testing.T) {
	members := []store.TeamMember{{UserID: "a", Name: "김민지"}, {UserID: "b", Name: "박서준"}, {UserID: "c", Email: "dukryung@x.test"}}
	transcript := strings.Join([]string{
		"김민지: 녹음 기능 추가에 대해서 어떻게 개발할지 논의해 보고자 해요.",
		"김민지: 가격표는 서준 님이 봐 주세요.",
		"박서준: 네, 제가 내일까지 결제 화면 고칠게요.",
		"화자 1: 이미지 첨부는 다음 주에 정리해 둘게요.",
		"지금부터 회의 시작하겠습니다 dukryung 님 의견도 들어 볼게요",
	}, "\n")
	parts := []ai.MeetingPart{{Tasks: []ai.MeetingTask{
		{Title: "녹음 기능 추가", Assignee: "김민지", DueDate: "2026-11-05", Evidence: "녹음 기능 추가에 대해서 어떻게 개발할지 논의해 보고자 해요."},
		{Title: "가격표 검토", Assignee: "박서준", Evidence: "가격표는 서준 님이 봐 주세요."},
		{Title: "결제 화면 수정", Assignee: "박서준", DueDate: "2026-11-09", Evidence: "네, 제가 내일까지 결제 화면 고칠게요."},
		{Title: "이미지 첨부 정리", Assignee: "김민지", Evidence: "이미지 첨부는 다음 주에 정리해 둘게요."},
		{Title: "가격표 확인", Assignee: "김민지", Evidence: "가격표는 서준 님이 봐 주세요."},
	}}}
	got := foundTasks(parts, members, transcript, "2026-11-04")
	want := []struct {
		assignee string
		due      string
	}{{"", ""}, {"b", ""}, {"b", "2026-11-05"}, {"", "?"}, {"", ""}}
	if len(got) != len(want) {
		t.Fatalf("got %+v", got)
	}
	for i, w := range want {
		if got[i].AssigneeID != w.assignee {
			t.Errorf("%s: assignee %q, want %q", got[i].Title, got[i].AssigneeID, w.assignee)
		}
		due := ""
		if got[i].DueDate != nil {
			due = *got[i].DueDate
		}
		if w.due != "?" && due != w.due {
			t.Errorf("%s: due %q, want %q", got[i].Title, due, w.due)
		}
	}
}

func TestSameWork(t *testing.T) {
	for _, c := range []struct {
		a, b string
		same bool
	}{
		{"sweep 프로젝트 녹음 기능 추가", "sweep 프로젝트 녹음 기능 개발 방안 논의", true},
		{"sweep 프로젝트 녹음 기능 추가", "sweep 녹음 기능 추가", true},
		{"결제 오류 수정", "결제 오류 수정하기", true},
		{"결제 화면 오류 수정", "결제 오류 수정", true},
		{"출시 공지 초안 작성", "출시 공지 작성", true},
		{"API 문서 정리", "api 문서 정리 작업", true},
		{"결제 화면 오류 수정", "결제 화면 디자인 수정", false},
		{"앱 다크 모드 추가", "웹 다크 모드 추가", false},
		{"로그인 기능", "로그인 기능 테스트", false},
		{"주간 보고서 작성", "월간 보고서 작성", false},
		{"이미지 첨부 기능 추가", "파일 첨부 기능 추가", false},
		{"결제 테스트", "테스트", false},
	} {
		if got := sameWork(c.a, c.b); got != c.same {
			t.Errorf("sameWork(%q, %q) = %v, want %v", c.a, c.b, got, c.same)
		}
	}
}

func TestFoundTasksMergesTheSameWorkSaidDifferently(t *testing.T) {
	members := []store.TeamMember{{UserID: "a", Name: "김민지"}}
	transcript := "화자 1: sweep 프로젝트에 녹음 기능을 넣으려고 해요.\n화자 2: 녹음 기능은 민지 님이 다음 주 금요일까지 맡아 주세요."
	parts := []ai.MeetingPart{
		{Tasks: []ai.MeetingTask{{Title: "sweep 프로젝트 녹음 기능 추가", Evidence: "sweep 프로젝트에 녹음 기능을 넣으려고 해요."}}},
		{Tasks: []ai.MeetingTask{
			{Title: "sweep 녹음 기능 개발 방안 논의", Assignee: "김민지", Note: "민지 님이 맡음", Evidence: "녹음 기능은 민지 님이 다음 주 금요일까지 맡아 주세요."},
			{Title: "녹음 기능 테스트", Evidence: "녹음 기능은 민지 님이 다음 주 금요일까지 맡아 주세요."},
		}},
	}
	got := foundTasks(parts, members, transcript, "2026-11-05")
	if len(got) != 2 {
		t.Fatalf("want the two parts' recording task kept once, plus the other, got %+v", got)
	}
	if got[0].Title != "sweep 프로젝트 녹음 기능 추가" || got[0].AssigneeID != "a" || got[0].DueDate == nil || *got[0].DueDate != "2026-11-13" || got[0].Note == "" {
		t.Errorf("the later mention should fill in who, when and the note: %+v", got[0])
	}
}

func TestFoundTasksDropsWhatAsksForNoWork(t *testing.T) {
	transcript := strings.Join([]string{
		"화자 1: 디자인 시안은 지난주에 이미 다 끝났어요.",
		"화자 2: 다크 모드는 다음 버전에서 하기로 해요.",
		"화자 3: 화면 공유가 잘 되고 있나요?",
		"화자 1: 테스트는 준호 님이 해 주실 수 있어요?",
		"화자 2: 서버 비용 줄이는 방안은 이번 달 말까지 정리해 주세요.",
		"화자 1: 서버 비용 정리는 이번 달 말까지 할게요.",
	}, "\n")
	parts := []ai.MeetingPart{{Tasks: []ai.MeetingTask{
		{Title: "디자인 시안 확인", Evidence: "디자인 시안은 지난주에 이미 다 끝났어요."},
		{Title: "다크 모드 추가", Evidence: "다크 모드는 다음 버전에서 하기로 해요."},
		{Title: "화면 공유 확인", Evidence: "화면 공유가 잘 되고 있나요?"},
		{Title: "테스트 진행", Evidence: "테스트는 준호 님이 해 주실 수 있어요?"},
		{Title: "서버 비용 절감 방안 정리", Evidence: "서버 비용 줄이는 방안은 이번 달 말까지 정리해 주세요."},
		{Title: "서버 비용 정리", Evidence: "서버 비용 정리는 이번 달 말까지 할게요."},
		{Title: "다크 모드 방향 정리"}, // no words to go by: kept for the lead to judge
	}}}
	got := foundTasks(parts, nil, transcript, "2026-11-05")
	titles := []string{}
	for _, x := range got {
		titles = append(titles, x.Title)
	}
	if strings.Join(titles, ",") != "테스트 진행,서버 비용 절감 방안 정리,다크 모드 방향 정리" {
		t.Errorf("got %v", titles)
	}
}

func TestJoinTopicsKeepsASubjectOnce(t *testing.T) {
	got := joinTopics([]ai.MeetingMinutes{
		{Topics: []ai.MeetingTopic{{Title: "결제 오류", Points: []string{"iOS에서 멈춤"}}, {Title: "sweep 녹음 기능 추가", Points: []string{"브라우저에서 녹음"}}}},
		{Topics: []ai.MeetingTopic{{Title: "sweep 녹음 기능 논의", Points: []string{"맥 미니에서 받아쓰기", "브라우저에서  녹음"}}, {Title: "출시 일정", Points: []string{"11월 24일"}}}},
	})
	if len(got) != 3 || got[1].Title != "sweep 녹음 기능 추가" || len(got[1].Points) != 2 || got[2].Title != "출시 일정" {
		t.Errorf("got %+v", got)
	}
}

func TestMergeMinutesMergesAFewPartsAtATime(t *testing.T) {
	part := func(i int) ai.MeetingMinutes {
		return ai.MeetingMinutes{Summary: strings.Repeat("가", 600), Topics: []ai.MeetingTopic{{Title: fmt.Sprintf("주제 %d", i), Points: []string{"요점"}}}}
	}
	parts := []ai.MeetingMinutes{}
	for i := range 12 {
		parts = append(parts, part(i+1))
	}
	p := &countingMerger{}
	calls := 0
	out, err := mergeMinutes(context.Background(), p, "회의", "2026-11-05", parts, func() { calls++ })
	if err != nil {
		t.Fatal(err)
	}
	if len(out.Topics) != 12 {
		t.Errorf("every part's topics should come through, got %d", len(out.Topics))
	}
	for _, n := range p.sizes {
		if n > mergeRunes {
			t.Errorf("a merge read %d runes, more than %d", n, mergeRunes)
		}
	}
	if calls != len(p.sizes) || calls < 4 {
		t.Errorf("want each merge counted, got %d of %d", calls, len(p.sizes))
	}
}

type countingMerger struct {
	ai.Fake
	sizes []int
}

func (c *countingMerger) MergeMinutes(ctx context.Context, req ai.MergeRequest) (ai.MeetingMinutes, error) {
	n := 0
	for _, x := range req.Parts {
		n += ai.MergeRunes(x)
	}
	c.sizes = append(c.sizes, n)
	out, err := c.Fake.MergeMinutes(ctx, req)
	out.Summary = clip(out.Summary, 600) // a merge answers about as long as a part
	return out, err
}

func TestSpokenDue(t *testing.T) {
	held, _ := time.Parse("2006-01-02", "2026-11-04") // 수요일
	for said, want := range map[string]string{
		"이번 주 금요일까지 고칠게요":    "2026-11-06",
		"다음 주 수요일까지 시안 드릴게요": "2026-11-11",
		"다음주 월요일에 공유할게요":     "2026-11-09",
		"다다음 주 화요일까지":        "2026-11-17",
		"금요일까지 정리할게요":        "2026-11-06",
		"수요일까지 할게요":          "2026-11-11",
		"내일까지 공유하겠습니다":       "2026-11-05",
		"모레 드릴게요":            "2026-11-06",
		"면접 일정은 제가 내일까지 잡을게요. 다음 주 화요일이 좋겠어요": "2026-11-05",
		"11/20까지 작성할게요": "2026-11-20",
		"12월 3일까지":      "2026-12-03",
		"1월 5일까지":       "2027-01-05",
		"20일까지 할게요":     "2026-11-20",
		"3일까지 할게요":      "2026-12-03",
		"3일 안에 할게요":     "2026-11-07",
		"이번 달 말까지":      "2026-11-30",
		"다음 달 말까지":      "2026-12-31",
		"이번 주 안에 끝낼게요":  "2026-11-06",
		"다음 주까지 해 주세요":  "2026-11-13",
		"제가 할게요":        "",
		"화면 좀 봐 주세요":    "",
	} {
		if got, _ := spokenDue(said, held); got != want {
			t.Errorf("spokenDue(%q) = %q, want %q", said, got, want)
		}
	}
	if _, spoken := spokenDue("해 주세요", held); spoken {
		t.Error("주세요 is not a week")
	}
	if d := taskDue("연말까지 정리할게요", "2026-12-31", "2026-11-04"); d == nil || *d != "2026-12-31" {
		t.Error("a time it cannot read keeps the model's date")
	}
	if d := taskDue("제가 정리할게요", "2026-11-05", "2026-11-04"); d != nil {
		t.Error("a date nobody said is dropped")
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
