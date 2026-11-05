package ai

import (
	"context"
	"fmt"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
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
- tasks: the work to be done after the meeting, for the team lead to look over and assign: work a person took on or was asked to do, and each feature, change or job the meeting means to make: planned, proposed, or brought up to work out how ("~기능을 추가하려고 합니다", "~를 어떻게 개발할지 논의해 보고자 해요", "~를 고쳐야 해요", "~를 만들어 두면 좋겠네요"): the work itself is the task. For each task:
  - title: the work in a few words, the way a to-do is written ("박스 스케줄러 녹음 기능 추가", "고객사 제안서 초안 작성"), starting with the project or product when the meeting names one; without the person's name. For work brought up to discuss, the title is the work itself ("sweep 프로젝트 녹음 기능 추가"), not the talk about it ("~ 논의", "~ 검토", "~ 방향"). When one sentence brings up several features, each is its own task.
  - assignee: only when the transcript says who will do it: they said so themselves ("제가 ~할게요", a line of theirs) or were named for it ("~는 서준 님이 맡아 주세요") and did not refuse. Write them exactly as in the member list. Otherwise "": never pick someone because they brought the work up, ran the meeting or are in the member list.
  - dueDate: YYYY-MM-DD only when a deadline was said for this work, worked out from the meeting date with the calendar given ("다음 주 금요일", "내일", "이번 달 말"); "" when none was said. Never make one up.
  - note: one sentence of detail that helps do it, or "".
  - evidence: the words of the transcript where the task comes up, copied exactly (one sentence, up to 100 characters).
  One task per piece of work: if the same work comes up twice, list it once. It can also be in decisions or topics.
  Not tasks: work already done ("~끝냈어요", "~했어요"), work put off on purpose ("나중에", "다음 버전에서", "다음에 다시 이야기해요"), a decision already made ("출시는 24일로 확정"), questions and remarks that ask no one to do anything (opinions, agreeing, how a number was counted, whether the screen share works), small talk (lunch) and running the meeting itself ("회의 시작하겠습니다"). Most of a meeting is talk around a few pieces of work: a part with no work in it has "tasks": [].
- Use only what is in the text: never invent names, numbers or dates. Leave out small talk and fillers ("음", "어", "그러니까").
Write plain text in every field; no markdown.

Example (members: 김민지, 박서준; meeting on 2026-05-12 화):
김민지: 다음 주 화요일 고객 미팅 전에 제안서 초안이 있어야 해요. 그리고 앱에 다크 모드를 넣으려고 하는데, 어떻게 만들지 같이 얘기해 봐요.
박서준: 제가 목요일까지 초안 쓸게요. 가격표는 민지 님이 봐 주실 수 있어요?
김민지: 네, 가격표는 금요일까지 정리할게요.
→ {"summary":"다음 주 화요일 고객 미팅을 위해 제안서와 가격표를 준비하기로 했어요. 앱 다크 모드 추가도 논의했어요.","decisions":[],"topics":[{"title":"고객 미팅 준비","points":["미팅은 다음 주 화요일(5/19)","미팅 전에 제안서 초안이 필요하다"]},{"title":"다크 모드","points":["앱에 다크 모드를 넣을 계획"]}],"tasks":[{"title":"고객 미팅 제안서 초안 작성","assignee":"박서준","dueDate":"2026-05-14","note":"","evidence":"제가 목요일까지 초안 쓸게요."},{"title":"제안서 가격표 정리","assignee":"김민지","dueDate":"2026-05-15","note":"","evidence":"네, 가격표는 금요일까지 정리할게요."},{"title":"앱 다크 모드 추가","assignee":"","dueDate":"","note":"어떻게 만들지 정해야 해요","evidence":"그리고 앱에 다크 모드를 넣으려고 하는데, 어떻게 만들지 같이 얘기해 봐요."}]}`

const mergeSystemPrompt = `A long team meeting was written up part by part. You get each part's summary and decisions, in order. Write the whole meeting's summary and decisions, in Korean.
- summary: 2 to 5 sentences for the whole meeting: what it was about and what came of it.
- decisions: every decision from the parts, once each (merge ones that say the same thing; a later part can change an earlier decision: keep the later one).
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
	"type": "object",
	"properties": orderedProps{
		{"summary", map[string]any{"type": "string"}},
		{"decisions", map[string]any{"type": "array", "items": map[string]any{"type": "string"}}},
	},
	"required":             []string{"summary", "decisions"},
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
		writeMergePart(&b, i+1, p)
	}
	return b.String()
}

func writeMergePart(b *strings.Builder, n int, p MeetingMinutes) {
	fmt.Fprintf(b, "\n[Part %d]\nSummary: %s\n", n, p.Summary)
	for _, d := range p.Decisions {
		fmt.Fprintf(b, "Decision: %s\n", d)
	}
}

// MergeRunes is how much of a merge prompt a part's minutes take, in runes:
// its summary and decisions.
func MergeRunes(p MeetingMinutes) int {
	var b strings.Builder
	writeMergePart(&b, 1, p)
	return utf8.RuneCountInString(b.String())
}

// How long a local model's answers may run, in tokens: a part's minutes and
// tasks, and a merge's summary and decisions. Either is well under this; a
// small model answers about 10 tokens a second, so an answer that runs on is
// cut off before the call's 3 minutes are up, and tried again.
const (
	meetingPartTokens  = 1400
	meetingMergeTokens = 800
)

func (p claudeProvider) MeetingPart(ctx context.Context, req MeetingRequest) (MeetingPart, error) {
	var out MeetingPart
	err := p.c.call(withMaxTokens(ctx, meetingPartTokens), meetingSystemPrompt, meetingPrompt(req), meetingSchema, &out)
	return out, err
}

// MergeMinutes writes the whole meeting's summary and decisions from the parts';
// the topics are the parts' own, joined by the caller.
func (p claudeProvider) MergeMinutes(ctx context.Context, req MergeRequest) (MeetingMinutes, error) {
	var out MeetingMinutes
	err := p.c.call(withMaxTokens(ctx, meetingMergeTokens), mergeSystemPrompt, mergePrompt(req), mergeSchema, &out)
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
	fakePromise  = regexp.MustCompile(`(할게요|하겠습니다|해 주세요|해주세요|추가하려고 해요)`)
	fakeDeadline = regexp.MustCompile(`(\d{1,2})/(\d{1,2})까지`)
)

// MeetingPart (fake) reads "이름: 말" lines: the first line is the summary, a
// line with 결정 is a decision, and a line that promises, asks for or plans
// work is a task: for its speaker when they promise it, for the member it names
// when it asks ("서준 님 ~해 주세요"), else for no one; due on "M/D까지" when
// it says so. Each part takes half
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
			switch verb := fakePromise.FindString(said); {
			case (verb == "할게요" || verb == "하겠습니다") && members[who]:
				t.Assignee = who
			case strings.HasPrefix(verb, "해"):
				for _, name := range req.Members {
					if strings.Contains(said, name) {
						t.Assignee = name
					}
				}
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
