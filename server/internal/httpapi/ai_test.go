package httpapi

import (
	"strings"
	"testing"
	"time"

	"box-scheduler/server/internal/ai"
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

	tasks, estimates, missing := toSchedulerTasks(plan, inputs, nil)

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

	tasks, estimates, missing := toSchedulerTasks(plan, inputs, rv)

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
	plain, _, _ := toSchedulerTasks(plan, inputs, nil)
	if len(plain) != 4 || plain[2].StartAt != nil || plain[0].Pinned != nil {
		t.Fatalf("plain = %+v", plain)
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
