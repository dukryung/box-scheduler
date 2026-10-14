package scheduler

import (
	"fmt"
	"testing"
)

func ranges(ps []Placement) string {
	out := ""
	for _, p := range ps {
		out += fmt.Sprintf("%s:%d-%d ", p.Title, p.Range.Start, p.Range.End)
	}
	return out
}

func TestPlaceUsesPreferredWindow(t *testing.T) {
	tasks := []Task{
		{ID: "a", Priority: 2, Window: Afternoon, Chunks: []Chunk{{"afternoon", 3}}},
		{ID: "b", Priority: 1, Window: Morning, Chunks: []Chunk{{"morning", 2}}},
	}
	placed, unplaced := Place(tasks, Options{From: 42, To: 138})

	if got, want := ranges(placed), "morning:42-44 afternoon:78-81 "; got != want {
		t.Fatalf("placed = %q, want %q", got, want)
	}
	if len(unplaced) != 0 {
		t.Fatalf("unplaced = %v", unplaced)
	}
}

func TestPlaceSkipsOccupiedAndKeepsChunkOrder(t *testing.T) {
	tasks := []Task{{ID: "a", Priority: 1, Window: Any, Chunks: []Chunk{{"draft", 4}, {"review", 2}}}}
	// 60-62 is taken, so a 4-box draft can't start at 58.
	placed, _ := Place(tasks, Options{From: 58, To: 144, Occupied: []Range{{60, 62}}})

	if got, want := ranges(placed), "draft:62-66 review:66-68 "; got != want {
		t.Fatalf("placed = %q, want %q", got, want)
	}
}

func TestPlaceKeepsBreakAfterLongFocus(t *testing.T) {
	tasks := []Task{
		{ID: "a", Priority: 1, Window: Any, Chunks: []Chunk{{"deep", 6}}},
		{ID: "b", Priority: 2, Window: Any, Chunks: []Chunk{{"next", 1}}},
	}
	placed, _ := Place(tasks, Options{From: 60, To: 144})

	if got, want := ranges(placed), "deep:60-66 next:67-68 "; got != want {
		t.Fatalf("placed = %q, want %q", got, want)
	}
}

func TestPlaceFallsBackOutsideWindowThenReportsUnplaced(t *testing.T) {
	tasks := []Task{
		{ID: "a", Priority: 1, Window: Evening, Chunks: []Chunk{{"fits early", 2}}},
		{ID: "b", Priority: 2, Window: Any, Chunks: []Chunk{{"too big", 10}}},
	}
	// Only 60-66 is available: evening is full, so "fits early" falls back.
	placed, unplaced := Place(tasks, Options{From: 60, To: 66})

	if got, want := ranges(placed), "fits early:60-62 "; got != want {
		t.Fatalf("placed = %q, want %q", got, want)
	}
	if len(unplaced) != 1 || unplaced[0].Title != "too big" || unplaced[0].Boxes != 10 {
		t.Fatalf("unplaced = %+v", unplaced)
	}
}

func TestPlaceUnknownWindowMeansAny(t *testing.T) {
	tasks := []Task{{ID: "a", Priority: 1, Window: "whenever", Chunks: []Chunk{{"x", 1}}}}
	placed, _ := Place(tasks, Options{From: 10, To: 20})
	if got, want := ranges(placed), "x:10-11 "; got != want {
		t.Fatalf("placed = %q, want %q", got, want)
	}
}
