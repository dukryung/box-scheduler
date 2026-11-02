package httpapi

import (
	"strings"
	"testing"
	"time"

	"box-scheduler/server/internal/ai"
	"box-scheduler/server/internal/assistant"
	"box-scheduler/server/internal/breakdown"
	"box-scheduler/server/internal/scheduler"
	"box-scheduler/server/internal/store"
)

func TestToSchedulerTasksValidatesPlan(t *testing.T) {
	four := 4
	inputs := []ai.TaskInput{
		{ID: "a", Title: "기획서", EstimateBoxes: &four},
		{ID: "b", Title: "메일"},
		{ID: "c", Title: "운동"},
	}
	plan := ai.Plan{Tasks: []ai.TaskPlan{
		{TaskID: "a", EstimateBoxes: 4, Priority: 1, Window: "morning", Chunks: []ai.Chunk{{Title: "초안", Boxes: 3}, {Title: "검토", Boxes: 1}}},
		{TaskID: "a", EstimateBoxes: 9, Priority: 1}, // duplicate: ignored
		{TaskID: "b", EstimateBoxes: 0, Priority: 2, Chunks: []ai.Chunk{{Title: "", Boxes: 0}}},
		{TaskID: "zzz", EstimateBoxes: 2, Priority: 1}, // unknown id: ignored
	}}

	tasks, estimates, missing := toSchedulerTasks(plan, inputs, nil, false)

	if len(tasks) != 2 {
		t.Fatalf("tasks = %+v", tasks)
	}
	if got := tasks[0].Chunks; len(got) != 2 || got[0].Title != "기획서 · 초안" || got[1].Title != "기획서 · 검토" {
		t.Fatalf("split chunks = %+v", got)
	}
	// No usable chunks and a zero estimate -> one chunk of the clamped estimate.
	if got := tasks[1].Chunks; len(got) != 1 || got[0].Title != "메일" || got[0].Boxes != 1 {
		t.Fatalf("fallback chunk = %+v", got)
	}
	// Only tasks without a user estimate get the AI's estimate saved.
	if len(estimates) != 1 || estimates[0].TaskID != "b" {
		t.Fatalf("estimates = %+v", estimates)
	}
	if len(missing) != 1 || missing[0].TaskID != "c" || missing[0].Boxes != defaultTaskBoxes {
		t.Fatalf("missing = %+v", missing)
	}
}

func TestToSchedulerTasksRevision(t *testing.T) {
	inputs := []ai.TaskInput{{ID: "a", Title: "기획서"}, {ID: "b", Title: "메일"}, {ID: "c", Title: "운동"}, {ID: "d", Title: "독서"}}
	rv := &reviseRequest{Request: "운동은 8시로, 메일은 빼줘"}
	rv.Previous = []shownBlock{
		{TaskID: "a", Title: "기획서 · 초안", StartSlot: 60, EndSlot: 66},
		{TaskID: "a", Title: "기획서 · 검토", StartSlot: 70, EndSlot: 72},
	}
	plan := ai.Plan{Tasks: []ai.TaskPlan{
		// Kept: the model's own chunks are ignored, the shown blocks stay.
		{TaskID: "a", EstimateBoxes: 3, Priority: 1, Keep: true, Chunks: []ai.Chunk{{Title: "다른", Boxes: 3}}},
		{TaskID: "b", EstimateBoxes: 2, Priority: 2, Skip: true},
		{TaskID: "c", EstimateBoxes: 6, Priority: 3, StartAt: "20:05"},
		// Kept but not on screen (left out earlier): stays out.
		{TaskID: "d", EstimateBoxes: 3, Priority: 4, Keep: true},
	}}

	tasks, estimates, missing := toSchedulerTasks(plan, inputs, rv, false)

	if len(tasks) != 2 || len(missing) != 0 {
		t.Fatalf("tasks = %+v, missing = %+v (a skipped task is not missing)", tasks, missing)
	}
	if a := tasks[0]; len(a.Chunks) != 2 || a.Chunks[1].Title != "기획서 · 검토" || a.Pinned[0] != (scheduler.Range{Start: 60, End: 66}) {
		t.Fatalf("kept = %+v", a)
	}
	if c := tasks[1]; c.StartAt == nil || *c.StartAt != 120 {
		t.Fatalf("asked-for time = %+v", c.StartAt)
	}
	if len(estimates) != 2 || estimates[0] != (taskEstimate{TaskID: "a", EstimateBoxes: 8}) {
		t.Fatalf("estimates = %+v", estimates)
	}
	// Outside a revision these fields mean nothing.
	plain, _, _ := toSchedulerTasks(plan, inputs, nil, false)
	if len(plain) != 4 || plain[2].StartAt != nil || *plain[2].Prefer != 120 || plain[0].Pinned != nil {
		t.Fatalf("plain = %+v", plain)
	}
}

func TestToSchedulerTasksAskedForSpan(t *testing.T) {
	inputs := []ai.TaskInput{{ID: "qt", Title: "QT 하기"}}
	rv := &reviseRequest{Request: "QT 하기 시간을 오전 9시에서 9시 30분까지로 수정해줘", Previous: []shownBlock{{TaskID: "qt", Title: "QT 하기", StartSlot: 108, EndSlot: 114}}}
	plan := ai.Plan{Tasks: []ai.TaskPlan{{TaskID: "qt", EstimateBoxes: 6, Chunks: []ai.Chunk{{Title: "QT 하기", Boxes: 6}}, StartAt: "09:00", EndAt: "09:30"}}}
	tasks, estimates, _ := toSchedulerTasks(plan, inputs, rv, false)
	if len(tasks) != 1 || *tasks[0].StartAt != 54 || len(tasks[0].Chunks) != 1 || tasks[0].Chunks[0].Boxes != 3 {
		t.Fatalf("tasks = %+v", tasks)
	}
	if estimates[0].EstimateBoxes != 3 {
		t.Fatalf("estimates = %+v", estimates)
	}
}

func TestToSchedulerTasksTakesTheAIsTimes(t *testing.T) {
	inputs := []ai.TaskInput{{ID: "qt", Title: "QT 하기"}, {ID: "x", Title: "기획서"}}
	plan := ai.Plan{Tasks: []ai.TaskPlan{
		{TaskID: "qt", EstimateBoxes: 3, Priority: 1, StartAt: "09:00"},
		{TaskID: "x", EstimateBoxes: 6, Priority: 2, StartAt: "아침"}, // unreadable: window only
	}}
	tasks, _, _ := toSchedulerTasks(plan, inputs, nil, false)
	if tasks[0].Prefer == nil || *tasks[0].Prefer != 54 || tasks[0].StartAt != nil {
		t.Fatalf("qt = %+v", tasks[0])
	}
	if tasks[1].Prefer != nil {
		t.Fatalf("x = %+v", tasks[1])
	}
}

func TestToSchedulerTasksRespacesKeptTasks(t *testing.T) {
	inputs := []ai.TaskInput{{ID: "a", Title: "기획서"}}
	rv := &reviseRequest{Request: "사이사이 10분씩 쉬게 해줘", Previous: []shownBlock{{TaskID: "a", Title: "기획서", StartSlot: 60, EndSlot: 66}}}
	plan := ai.Plan{Tasks: []ai.TaskPlan{{TaskID: "a", EstimateBoxes: 6, Keep: true}}}
	tasks, _, _ := toSchedulerTasks(plan, inputs, rv, true)
	if k := tasks[0]; k.Pinned != nil || k.Prefer == nil || *k.Prefer != 60 || k.Chunks[0].Boxes != 6 {
		t.Fatalf("kept = %+v", k)
	}
	// Real qwen3: every task restated with its current start and a new length.
	inputs = append(inputs, ai.TaskInput{ID: "b", Title: "운동"})
	rv.Request = "사이사이 10분씩 쉬고 운동은 30분만"
	rv.Previous = append(rv.Previous, shownBlock{TaskID: "b", Title: "운동", StartSlot: 70, EndSlot: 76})
	plan.Tasks = []ai.TaskPlan{
		{TaskID: "a", EstimateBoxes: 4, Chunks: []ai.Chunk{{Title: "기획서", Boxes: 4}}, StartAt: "10:00"},
		{TaskID: "b", EstimateBoxes: 3, Chunks: []ai.Chunk{{Title: "운동", Boxes: 3}}, StartAt: "11:40"},
	}
	tasks, _, _ = toSchedulerTasks(plan, inputs, rv, true)
	if a := tasks[0]; a.StartAt != nil || *a.Prefer != 60 || a.Chunks[0].Boxes != 6 {
		t.Fatalf("not named, kept = %+v", a)
	}
	if b := tasks[1]; b.StartAt == nil || b.Chunks[0].Boxes != 3 {
		t.Fatalf("named, changed = %+v", b)
	}
}

func TestMentions(t *testing.T) {
	if !mentions("box는 1시간만", "box scheduler 고도화") || mentions("사이사이 쉬게", "QT 하기") || mentions("a 빼줘", "a b") {
		t.Fatal("mentions")
	}
}

func TestBreakRules(t *testing.T) {
	if !asksForBreak("사이사이 10분씩 쉬게 해줘") || !asksForBreak("쉬는 시간 없이 붙여줘") || asksForBreak("운동은 8시로") {
		t.Fatal("asksForBreak")
	}
	if !validBreak(0) || !validBreak(30) || validBreak(15) || validBreak(70) || validBreak(-10) {
		t.Fatal("validBreak")
	}
	if breakBoxes(0) != 0 || breakBoxes(10) != 1 || breakBoxes(15) != 2 {
		t.Fatal("breakBoxes")
	}
}

func TestToRevisionChecksInput(t *testing.T) {
	if _, msg := toRevision(&reviseRequest{Request: "  "}); msg == "" {
		t.Fatal("empty request accepted")
	}
	if _, msg := toRevision(&reviseRequest{Request: strings.Repeat("가", maxReviseText+1)}); msg == "" {
		t.Fatal("long request accepted")
	}
	rv, msg := toRevision(&reviseRequest{Request: " 운동은 저녁에 ", Earlier: []string{"", "메일 빼줘"}})
	if msg != "" || rv.Request != "운동은 저녁에" || len(rv.Earlier) != 1 {
		t.Fatalf("rv = %+v, msg = %q", rv, msg)
	}
}

func TestUrgentBacklog(t *testing.T) {
	day, _ := time.Parse(dateLayout, "2026-10-19")
	six, one, three := 6, 1, 3
	str := func(s string) *string { return &s }
	items := []store.BacklogItem{
		{BrainDumpItem: store.BrainDumpItem{ID: "soon", Status: "open", DueDate: str("2026-10-24")}},
		{BrainDumpItem: store.BrainDumpItem{ID: "late", Status: "open", DueDate: str("2026-11-30")}},
		{BrainDumpItem: store.BrainDumpItem{ID: "overdue", Status: "open", DueDate: str("2026-10-10")}},
		{BrainDumpItem: store.BrainDumpItem{ID: "important", Status: "open", Priority: &one}},
		{BrainDumpItem: store.BrainDumpItem{ID: "normal", Status: "open", Priority: &three}},
		{BrainDumpItem: store.BrainDumpItem{ID: "covered", Status: "open", Priority: &one, EstimateBoxes: &six}, ScheduledBoxes: 6},
		{BrainDumpItem: store.BrainDumpItem{ID: "finished", Status: "done", Priority: &one}},
	}
	got := []string{}
	for _, task := range urgentBacklog(items, day) {
		if !task.Backlog {
			t.Errorf("%s not marked as backlog", task.ID)
		}
		got = append(got, task.ID)
	}
	if strings.Join(got, ",") != "soon,overdue,important" {
		t.Fatalf("urgent = %v", got)
	}
}

func TestChunkTitleDropsRepeatedTask(t *testing.T) {
	cases := map[string]string{
		"초안 작성":             "기획서 · 초안 작성",
		"기획서 · 초안 작성":       "기획서 · 초안 작성",
		"기획서 · 기획서 · 초안 작성": "기획서 · 초안 작성",
		"기획서 - 검토":          "기획서 · 검토",
		"기획서":               "기획서",
		"":                  "기획서",
	}
	for in, want := range cases {
		if got := chunkTitle("기획서", in, 2); got != want {
			t.Errorf("chunkTitle(%q) = %q, want %q", in, got, want)
		}
	}
	if got := chunkTitle("기획서", "초안 작성", 1); got != "기획서" {
		t.Errorf("single chunk: %q", got)
	}
}

func TestClarificationGivesWayToOps(t *testing.T) {
	ops := []assistant.Op{{Kind: "delete_block"}}
	if got := clarification("이렇게 할까요?", ops); got != "" {
		t.Errorf("with ops: got %q, want no question", got)
	}
	if got := clarification("어느 회의인가요?", nil); got != "어느 회의인가요?" {
		t.Errorf("without ops: got %q, want the question", got)
	}
	if got := clarification(" ", nil); got != "" {
		t.Errorf("blank question: got %q, want none", got)
	}
}

func TestToSchedulerTasksTrustsTheWindowOverATimeOutsideIt(t *testing.T) {
	inputs := []ai.TaskInput{{ID: "shop", Title: "장보기"}, {ID: "doc", Title: "기획서"}}
	plan := ai.Plan{Tasks: []ai.TaskPlan{
		{TaskID: "shop", EstimateBoxes: 6, Priority: 4, Window: "evening", StartAt: "12:50", Chunks: []ai.Chunk{{Title: "장보기", Boxes: 6}}},
		{TaskID: "doc", EstimateBoxes: 6, Priority: 1, Window: "morning", StartAt: "10:00", Chunks: []ai.Chunk{{Title: "기획서", Boxes: 6}}},
	}}
	tasks, _, _ := toSchedulerTasks(plan, inputs, nil, false)
	if got := *tasks[0].Prefer; got != 108 {
		t.Errorf("evening errand at 12:50: prefer %d, want 108 (18:00)", got)
	}
	if got := *tasks[1].Prefer; got != 60 {
		t.Errorf("morning work at 10:00: prefer %d, want it kept at 60", got)
	}
}

func TestToSchedulerTasksPlansOnlyWhatIsLeft(t *testing.T) {
	twelve := 12
	inputs := []ai.TaskInput{{ID: "dev", Title: "로그인 기능", EstimateBoxes: &twelve, ScheduledBoxes: 6}}
	plan := ai.Plan{Tasks: []ai.TaskPlan{{TaskID: "dev", EstimateBoxes: 12, Priority: 1, Window: "morning",
		Chunks: []ai.Chunk{{Title: "설계", Boxes: 6}, {Title: "구현", Boxes: 6}}}}}
	tasks, _, _ := toSchedulerTasks(plan, inputs, nil, false)
	if got := chunkBoxes(tasks[0].Chunks); got != 6 || len(tasks[0].Chunks) != 2 {
		t.Errorf("got %v, want the 6 boxes left in two chunks", tasks[0].Chunks)
	}
}

func TestCleanSubsMergesPiecesWithTheSameTitle(t *testing.T) {
	got := cleanSubs("발표", []breakdown.Sub{{Title: "자료 작성", Boxes: 2}, {Title: "리허설", Boxes: 1}, {Title: "자료 작성", Boxes: 3}})
	if len(got) != 2 || got[0] != (breakdown.Sub{Title: "자료 작성", Boxes: 5}) {
		t.Errorf("got %v, want 자료 작성 once with 5 boxes", got)
	}
}
