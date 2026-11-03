package ai

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func TestMeetingCalendarNamesTheDays(t *testing.T) {
	c := meetingCalendar("2026-05-12")
	for _, want := range []string{"Meeting date: 2026-05-12 화 (내일 = 2026-05-13)", "이번 주: 2026-05-11 월,", "2026-05-15 금", "다음 주: 2026-05-18 월, 2026-05-19 화", "그다음 주: 2026-06-01 월", "2026-06-07 일\n"} {
		if !strings.Contains(c, want) {
			t.Errorf("calendar lacks %q:\n%s", want, c)
		}
	}
}

func TestMeetingSchemaListsTasksLast(t *testing.T) {
	buf, err := json.Marshal(meetingSchema)
	if err != nil {
		t.Fatal(err)
	}
	s := string(buf)
	order := []string{`"summary"`, `"decisions"`, `"topics"`, `"tasks"`, `"assignee"`, `"dueDate"`, `"evidence"`}
	at := -1
	for _, k := range order {
		i := strings.Index(s[at+1:], k)
		if i < 0 {
			t.Fatalf("%s missing or out of order in %s", k, s)
		}
		at += i + 1
	}
}

func TestFakeMeetingPart(t *testing.T) {
	fakePartTime = 0
	part, err := Fake{}.MeetingPart(context.Background(), MeetingRequest{HeldOn: "2026-05-12", Members: []string{"민지"}, Part: 1, Parts: 1,
		Text: "민지: 다음 주 출시를 논의했어요\n서준: 출시일은 5/20으로 결정\n민지: 공지 메일 5/18까지 작성할게요"})
	if err != nil {
		t.Fatal(err)
	}
	if len(part.Decisions) != 1 || len(part.Tasks) != 1 {
		t.Fatalf("%+v", part)
	}
	if x := part.Tasks[0]; x.Title != "공지 메일 작성" || x.Assignee != "민지" || x.DueDate != "2026-05-18" {
		t.Errorf("task: %+v", x)
	}
}
