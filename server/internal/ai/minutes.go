package ai

import (
	"context"
	"fmt"
	"regexp"
	"strings"
	"time"
)

// Minuter writes meeting minutes and finds the tasks in what was said. A long
// meeting is read part by part (a small local model takes about 4,000 tokens
// at once); the parts' minutes are then merged into one.
type Minuter interface {
	MeetingPart(ctx context.Context, req MeetingRequest) (MeetingPart, error)
	MergeMinutes(ctx context.Context, req MergeRequest) (MeetingMinutes, error)
}

type MeetingRequest struct {
	Title   string
	HeldOn  string   // YYYY-MM-DD
	Members []string // the team's people, as the minutes should name them
	Part    int      // 1-based
	Parts   int
	Text    string
}

type MeetingTopic struct {
	Title  string   `json:"title"`
	Points []string `json:"points"`
}

type MeetingMinutes struct {
	Summary   string         `json:"summary"`
	Decisions []string       `json:"decisions"`
	Topics    []MeetingTopic `json:"topics"`
}

type MeetingTask struct {
	Title    string `json:"title"`
	Assignee string `json:"assignee"`
	DueDate  string `json:"dueDate"`
	Note     string `json:"note"`
	Evidence string `json:"evidence"`
}

type MeetingPart struct {
	MeetingMinutes
	Tasks []MeetingTask `json:"tasks"`
}

type MergeRequest struct {
	Title  string
	HeldOn string
	Parts  []MeetingMinutes
}

const meetingSystemPrompt = `You write the minutes of a team meeting, in Korean. You get what was said (typed notes or a speech-recognition transcript, which can have errors, fillers and lines like "김민지: ..."), or one part of a longer meeting.
- summary: 2 to 4 sentences: what the meeting was about and what came of it.
- decisions: each thing that was agreed or decided about the plan (a date, a choice, who leads something), as one short sentence. [] when nothing was decided. Work someone will do is a task, not a decision.
- topics: the subjects discussed, in order: a short title and 1 to 5 points each. Points are short and concrete (numbers, dates, names, reasons).
- tasks: work someone has to do after the meeting: a person said they will do it, or was asked to and agreed. For each task:
  - title: the work in a few words, the way a to-do is written ("고객사 제안서 초안 작성"), without the person's name.
  - assignee: who will do it, written exactly as in the member list; "" when no one was named or they are not in the list.
  - dueDate: YYYY-MM-DD when a deadline was said, worked out from the meeting date with the calendar given ("다음 주 금요일", "내일", "이번 달 말"); "" when none was said.
  - note: one sentence of detail that helps do it, or "".
  - evidence: the words of the transcript where the task comes up, copied exactly (one sentence, up to 100 characters).
  Every "제가 ~할게요 / ~하겠습니다 / ~해 둘게요", and every request someone agreed to, is a task, even when it is also in decisions or topics.
  Not tasks: ideas and wishes ("~하면 좋을 것 같아요", "나중에", "다음 버전에서"), questions nobody took on, and work already done ("~끝냈어요", "~했어요").
  One task per piece of work: if the same work comes up twice, list it once.
- Use only what is in the text: never invent names, numbers, dates or tasks. Leave out small talk and fillers ("음", "어", "그러니까").
Write plain text in every field; no markdown.

Example (members: 김민지, 박서준; meeting on 2026-05-12 화):
김민지: 다음 주 화요일 고객 미팅 전에 제안서 초안이 있어야 해요.
박서준: 제가 목요일까지 초안 쓸게요. 가격표는 민지 님이 봐 주실 수 있어요?
김민지: 네, 가격표는 금요일까지 정리할게요. 그리고 발표는 서준 님이 하는 걸로 하죠.
→ {"summary":"다음 주 화요일 고객 미팅을 위해 제안서와 가격표를 준비하기로 했어요. 발표는 박서준이 맡아요.","decisions":["고객 미팅 발표는 박서준이 맡는다"],"topics":[{"title":"고객 미팅 준비","points":["미팅은 다음 주 화요일(5/19)","미팅 전에 제안서 초안이 필요하다"]}],"tasks":[{"title":"제안서 초안 작성","assignee":"박서준","dueDate":"2026-05-14","note":"","evidence":"제가 목요일까지 초안 쓸게요."},{"title":"가격표 정리","assignee":"김민지","dueDate":"2026-05-15","note":"","evidence":"네, 가격표는 금요일까지 정리할게요."}]}`

const mergeSystemPrompt = `A long team meeting was written up part by part. You get each part's minutes, in order. Merge them into the minutes of the whole meeting, in Korean.
- summary: 2 to 5 sentences for the whole meeting: what it was about and what came of it.
- decisions: every decision from the parts, once each (merge ones that say the same thing; a later part can change an earlier decision: keep the later one).
- topics: the subjects in the order they came up; merge parts that continue the same subject; 1 to 6 points each.
- Keep the concrete details (numbers, dates, names). Do not add anything that is not in the parts.
Write plain text in every field; no markdown.`

var meetingTopicSchema = map[string]any{
	"type": "object",
	"properties": orderedProps{
		{"title", map[string]any{"type": "string"}},
		{"points", map[string]any{"type": "array", "items": map[string]any{"type": "string"}}},
	},
	"required":             []string{"title", "points"},
	"additionalProperties": false,
}

func minutesProps() orderedProps {
	return orderedProps{
		{"summary", map[string]any{"type": "string"}},
		{"decisions", map[string]any{"type": "array", "items": map[string]any{"type": "string"}}},
		{"topics", map[string]any{"type": "array", "items": meetingTopicSchema}},
	}
}

var mergeSchema = map[string]any{
	"type":                 "object",
	"properties":           minutesProps(),
	"required":             []string{"summary", "decisions", "topics"},
	"additionalProperties": false,
}

var meetingSchema = map[string]any{
	"type": "object",
	"properties": append(minutesProps(), orderedProps{
		{"tasks", map[string]any{
			"type": "array",
			"items": map[string]any{
				"type": "object",
				"properties": orderedProps{
					{"title", map[string]any{"type": "string"}},
					{"assignee", map[string]any{"type": "string"}},
					{"dueDate", map[string]any{"type": "string"}},
					{"note", map[string]any{"type": "string"}},
					{"evidence", map[string]any{"type": "string"}},
				},
				"required":             []string{"title", "assignee", "dueDate", "note", "evidence"},
				"additionalProperties": false,
			},
		}},
	}...),
	"required":             []string{"summary", "decisions", "topics", "tasks"},
	"additionalProperties": false,
}

var koWeekdays = []string{"일", "월", "화", "수", "목", "금", "토"}

// meetingCalendar lists the meeting's week and the three after it by name
// ("다음 주"), so "다음 주 금요일" can be looked up rather than counted.
func meetingCalendar(heldOn string) string {
	d, err := time.Parse("2006-01-02", heldOn)
	if err != nil {
		return ""
	}
	var b strings.Builder
	fmt.Fprintf(&b, "Meeting date: %s %s (내일 = %s)\nCalendar:\n", heldOn, koWeekdays[d.Weekday()], d.AddDate(0, 0, 1).Format("2006-01-02"))
	monday := d.AddDate(0, 0, -((int(d.Weekday()) + 6) % 7))
	for w, name := range []string{"이번 주", "다음 주", "다다음 주", "그다음 주"} {
		days := make([]string, 7)
		for i := range days {
			x := monday.AddDate(0, 0, 7*w+i)
			days[i] = x.Format("2006-01-02") + " " + koWeekdays[x.Weekday()]
		}
		fmt.Fprintf(&b, "%s: %s\n", name, strings.Join(days, ", "))
	}
	return b.String()
}

func meetingPrompt(r MeetingRequest) string {
	var b strings.Builder
	fmt.Fprintf(&b, "Meeting: %s\n", r.Title)
	b.WriteString(meetingCalendar(r.HeldOn))
	if len(r.Members) > 0 {
		fmt.Fprintf(&b, "Members: %s\n", strings.Join(r.Members, ", "))
	}
	if r.Parts > 1 {
		fmt.Fprintf(&b, "This is part %d of %d of the meeting.\n", r.Part, r.Parts)
	}
	fmt.Fprintf(&b, "\n<transcript>\n%s\n</transcript>\n", r.Text)
	return b.String()
}

func mergePrompt(r MergeRequest) string {
	var b strings.Builder
	fmt.Fprintf(&b, "Meeting: %s (%s)\n", r.Title, r.HeldOn)
	for i, p := range r.Parts {
		fmt.Fprintf(&b, "\n[Part %d]\nSummary: %s\n", i+1, p.Summary)
		for _, d := range p.Decisions {
			fmt.Fprintf(&b, "Decision: %s\n", d)
		}
		for _, t := range p.Topics {
			fmt.Fprintf(&b, "Topic: %s\n", t.Title)
			for _, x := range t.Points {
				fmt.Fprintf(&b, "  - %s\n", x)
			}
		}
	}
	return b.String()
}

func (p claudeProvider) MeetingPart(ctx context.Context, req MeetingRequest) (MeetingPart, error) {
	var out MeetingPart
	err := p.c.call(ctx, meetingSystemPrompt, meetingPrompt(req), meetingSchema, &out)
	return out, err
}

func (p claudeProvider) MergeMinutes(ctx context.Context, req MergeRequest) (MeetingMinutes, error) {
	var out MeetingMinutes
	err := p.c.call(ctx, mergeSystemPrompt, mergePrompt(req), mergeSchema, &out)
	return out, err
}

func (disabled) MeetingPart(context.Context, MeetingRequest) (MeetingPart, error) {
	return MeetingPart{}, ErrNotConfigured
}

func (disabled) MergeMinutes(context.Context, MergeRequest) (MeetingMinutes, error) {
	return MeetingMinutes{}, ErrNotConfigured
}

var fakePartTime = 500 * time.Millisecond

var (
	fakeSpeaker  = regexp.MustCompile(`^\s*([^:：]{1,20})[:：]\s*(.+)$`)
	fakePromise  = regexp.MustCompile(`(할게요|하겠습니다|해 주세요|해주세요)`)
	fakeDeadline = regexp.MustCompile(`(\d{1,2})/(\d{1,2})까지`)
)

// MeetingPart (fake) reads "이름: 말" lines: the first line is the summary, a
// line with 결정 is a decision, and a line that promises or asks for work is a
// task for its speaker, due on "M/D까지" when it says so. Each part takes half
// a second, as a model would take a while, so tests can see the work running.
func (Fake) MeetingPart(ctx context.Context, req MeetingRequest) (MeetingPart, error) {
	select {
	case <-time.After(fakePartTime):
	case <-ctx.Done():
		return MeetingPart{}, ctx.Err()
	}
	out := MeetingPart{MeetingMinutes: MeetingMinutes{Decisions: []string{}, Topics: []MeetingTopic{}}, Tasks: []MeetingTask{}}
	topic := MeetingTopic{Title: fmt.Sprintf("논의 %d", req.Part), Points: []string{}}
	members := map[string]bool{}
	for _, m := range req.Members {
		members[m] = true
	}
	for _, line := range strings.Split(req.Text, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		who, said := "", line
		if m := fakeSpeaker.FindStringSubmatch(line); m != nil {
			who, said = strings.TrimSpace(m[1]), strings.TrimSpace(m[2])
		}
		if out.Summary == "" {
			out.Summary = said
		}
		switch {
		case strings.Contains(said, "결정"):
			out.Decisions = append(out.Decisions, said)
		case fakePromise.MatchString(said):
			t := MeetingTask{Title: strings.TrimSpace(fakePromise.Split(said, 2)[0]), Evidence: said}
			if members[who] {
				t.Assignee = who
			}
			if m := fakeDeadline.FindStringSubmatch(said); m != nil {
				var mo, day int
				fmt.Sscan(m[1], &mo)
				fmt.Sscan(m[2], &day)
				t.DueDate = fmt.Sprintf("%s-%02d-%02d", req.HeldOn[:4], mo, day)
				t.Title = strings.Join(strings.Fields(strings.Replace(t.Title, m[0], "", 1)), " ")
			}
			out.Tasks = append(out.Tasks, t)
		default:
			if len(topic.Points) < 5 {
				topic.Points = append(topic.Points, said)
			}
		}
	}
	if len(topic.Points) > 0 {
		out.Topics = append(out.Topics, topic)
	}
	return out, nil
}

// MergeMinutes (fake) joins the parts as they are.
func (Fake) MergeMinutes(_ context.Context, req MergeRequest) (MeetingMinutes, error) {
	out := MeetingMinutes{Decisions: []string{}, Topics: []MeetingTopic{}}
	summaries := []string{}
	for _, p := range req.Parts {
		summaries = append(summaries, p.Summary)
		out.Decisions = append(out.Decisions, p.Decisions...)
		out.Topics = append(out.Topics, p.Topics...)
	}
	out.Summary = strings.Join(summaries, " ")
	return out, nil
}
