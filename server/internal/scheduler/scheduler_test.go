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

func TestFitMovesOnlyWhatOverlaps(t *testing.T) {
	// The day changed after the plan was made: something now sits at 65-68.
	occupied := []Range{{51, 54}, {58, 64}, {65, 68}}
	got, ok := Fit([]Range{{66, 75}, {90, 93}}, occupied)
	if !ok[0] || got[0] != (Range{68, 77}) {
		t.Fatalf("moved = %v %v, want 68-77", got[0], ok[0])
	}
	if !ok[1] || got[1] != (Range{90, 93}) {
		t.Fatalf("free range moved: %v", got[1])
	}
}

func TestFitLooksEarlierWhenTheDayIsFullLater(t *testing.T) {
	got, ok := Fit([]Range{{130, 136}, {131, 134}}, []Range{{0, 100}, {128, 144}})
	if !ok[0] || got[0] != (Range{122, 128}) {
		t.Fatalf("first = %v %v, want 122-128", got[0], ok[0])
	}
	if !ok[1] || got[1] != (Range{119, 122}) {
		t.Fatalf("second = %v %v, want 119-122 (the earlier one keeps its spot)", got[1], ok[1])
	}
	if _, ok := Fit([]Range{{10, 20}}, []Range{{0, 144}}); ok[0] {
		t.Fatal("fit into a full day")
	}
}

func TestPlaceKeepsPinnedAndAskedForTimes(t *testing.T) {
	at := func(s int) *int { return &s }
	tasks := []Task{
		{ID: "new", Priority: 1, Window: Morning, Chunks: []Chunk{{"new", 3}}},
		{ID: "kept", Priority: 3, Chunks: []Chunk{{"kept", 3}}, Pinned: []Range{{60, 63}}},
		// 20:00 is past To (18:00); the person asked for it, so it still goes there.
		{ID: "evening", Priority: 2, Chunks: []Chunk{{"evening a", 2}, {"evening b", 2}}, StartAt: at(120)},
	}
	placed, unplaced := Place(tasks, Options{From: 54, To: 108, Occupied: []Range{{54, 57}}})
	if got, want := ranges(placed), "new:57-60 kept:60-63 evening a:120-122 evening b:122-124 "; got != want {
		t.Fatalf("placed = %q, want %q", got, want)
	}
	if len(unplaced) != 0 || placed[2].Shifted {
		t.Fatalf("unplaced = %v, shifted = %v", unplaced, placed[2].Shifted)
	}
}

func TestPlaceShiftsAnAskedForTimeThatIsTaken(t *testing.T) {
	at := 60
	placed, _ := Place([]Task{{ID: "a", Chunks: []Chunk{{"a", 3}}, StartAt: &at}}, Options{From: 0, To: 144, Occupied: []Range{{58, 62}}})
	if len(placed) != 1 || placed[0].Range != (Range{62, 65}) || !placed[0].Shifted {
		t.Fatalf("placed = %+v", placed)
	}
	// Never before From, even when asked.
	early := 10
	placed, _ = Place([]Task{{ID: "b", Chunks: []Chunk{{"b", 2}}, StartAt: &early}}, Options{From: 54, To: 144})
	if placed[0].Range != (Range{54, 56}) {
		t.Fatalf("early ask = %+v", placed[0].Range)
	}
}
