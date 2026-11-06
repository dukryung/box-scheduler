package httpapi

import (
	"testing"
	"time"

	"box-scheduler/server/internal/store"
)

func TestComputeStats(t *testing.T) {
	day := func(s string) time.Time { d, _ := time.Parse(dateLayout, s); return d }
	blocks := []store.Block{
		// 10:40-11:20 crosses an hour boundary: 2 boxes in hour 10, 2 in hour 11.
		// With 운동 (10:00-11:00, done) hour 10 has 8 planned and 8 done boxes.
		{Date: "2026-10-01", StartSlot: 64, EndSlot: 68, Title: "기획서 · 초안", Done: true, Source: "ai"},
		{Date: "2026-10-01", StartSlot: 70, EndSlot: 72, Title: "기획서 · 검토"},
		{Date: "2026-10-03", StartSlot: 60, EndSlot: 66, Title: "운동", Done: true},
	}

	s := computeStats(blocks, day("2026-10-01"), day("2026-10-03"))

	if got := s.Totals; got.PlannedBoxes != 12 || got.DoneBoxes != 10 || got.Blocks != 3 || got.DoneBlocks != 2 || got.ActiveDays != 2 || got.AIBoxes != 4 {
		t.Fatalf("totals = %+v", got)
	}
	if len(s.Daily) != 3 || s.Daily[1].Date != "2026-10-02" || s.Daily[1].PlannedBoxes != 0 {
		t.Fatalf("daily should include empty days: %+v", s.Daily)
	}
	if h := s.Hourly; h[10].PlannedBoxes != 8 || h[10].DoneBoxes != 8 || h[11].PlannedBoxes != 4 || h[11].DoneBoxes != 2 {
		t.Fatalf("hourly = %+v / %+v", h[10], h[11])
	}
	if len(s.TopTasks) != 2 || s.TopTasks[0].Title != "기획서" || s.TopTasks[0].PlannedBoxes != 6 || s.TopTasks[0].DoneBoxes != 4 {
		t.Fatalf("topTasks = %+v", s.TopTasks)
	}
}

func TestSumBoxes(t *testing.T) {
	got := sumBoxes([]store.Block{{StartSlot: 0, EndSlot: 3, Done: true}, {StartSlot: 10, EndSlot: 12}})
	if got.PlannedBoxes != 5 || got.DoneBoxes != 3 {
		t.Fatalf("sumBoxes = %+v", got)
	}
}

func TestFinishStreak(t *testing.T) {
	day := func(s string) time.Time { d, _ := time.Parse(dateLayout, s); return d }
	b := func(date string, done bool) store.Block { return store.Block{Date: date, StartSlot: 0, EndSlot: 1, Done: done} }
	blocks := []store.Block{
		b("2026-10-01", true), b("2026-10-01", false), // breaks the run
		b("2026-10-02", true),
		// 10-03 had nothing planned: passed over
		b("2026-10-04", true), b("2026-10-04", true),
		b("2026-10-05", false), // today, still under way
	}
	if got := finishStreak(blocks, day("2026-10-05")); got != 2 {
		t.Fatalf("streak with today under way = %d, want 2", got)
	}
	if got := finishStreak(append(blocks[:len(blocks)-1], b("2026-10-05", true)), day("2026-10-05")); got != 3 {
		t.Fatalf("streak with today finished = %d, want 3", got)
	}
	if got := finishStreak(nil, day("2026-10-05")); got != 0 {
		t.Fatalf("no blocks = %d, want 0", got)
	}
}
