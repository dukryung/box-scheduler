package httpapi

import (
	"strings"
	"testing"
	"time"

	"box-scheduler/server/internal/ai"
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

	tasks, estimates, missing := toSchedulerTasks(plan, inputs)

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
