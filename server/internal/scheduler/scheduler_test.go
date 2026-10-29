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

func TestPlaceKeepsABreakOnlyWhenAskedFor(t *testing.T) {
	tasks := []Task{
		{ID: "a", Priority: 1, Window: Any, Chunks: []Chunk{{"deep", 6}}},
		{ID: "b", Priority: 2, Window: Any, Chunks: []Chunk{{"next", 1}}},
	}
	if got, want := ranges(first(Place(tasks, Options{From: 60, To: 144}))), "deep:60-66 next:66-67 "; got != want {
		t.Fatalf("no break: placed = %q, want %q", got, want)
	}
	if got, want := ranges(first(Place(tasks, Options{From: 60, To: 144, Gap: 1}))), "deep:60-66 next:67-68 "; got != want {
		t.Fatalf("break: placed = %q, want %q", got, want)
	}
}

func first(p []Placement, _ []Unplaced) []Placement { return p }

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

func TestPlaceAskedForTimeWinsOverPinned(t *testing.T) {
	// The real case: QT asked for 09:00-09:30, where a suggested (pinned) block sat.
	at := 54
	tasks := []Task{
		{ID: "bs", Chunks: []Chunk{{"설계", 9}, {"구현", 8}}, Pinned: []Range{{54, 63}, {64, 72}}},
		{ID: "sr", Chunks: []Chunk{{"stocks", 12}}, Pinned: []Range{{78, 90}}},
		{ID: "cc", Chunks: []Chunk{{"청첩장", 3}}, Pinned: []Range{{90, 93}}},
		{ID: "qt", Chunks: []Chunk{{"QT", 3}}, StartAt: &at},
	}
	placed, unplaced := Place(tasks, Options{From: 54, To: 144})
	if got, want := ranges(placed), "QT:54-57 설계:57-66 구현:66-74 stocks:78-90 청첩장:90-93 "; got != want || len(unplaced) != 0 {
		t.Fatalf("placed = %q, want %q (unplaced %v)", got, want, unplaced)
	}
	for _, p := range placed {
		if p.Shifted {
			t.Fatalf("%s marked shifted: only a taken asked-for time is", p.Title)
		}
	}
}

func TestPlaceFollowsTheAIsTimes(t *testing.T) {
	at := func(s int) *int { return &s }
	tasks := []Task{
		{ID: "work", Priority: 1, Chunks: []Chunk{{"설계", 10}, {"구현", 6}}, Prefer: at(57)},
		{ID: "qt", Priority: 2, Chunks: []Chunk{{"QT", 3}}, Prefer: at(54)},
		// Asks for a time already taken by "work": goes after it, still before lunch;
		// 구현 does not fit before lunch, so it starts the afternoon.
		{ID: "mail", Priority: 3, Chunks: []Chunk{{"메일", 2}}, Prefer: at(60)},
		{ID: "loose", Priority: 4, Window: Afternoon, Chunks: []Chunk{{"loose", 2}}},
	}
	placed, unplaced := Place(tasks, Options{From: 54, To: 108, Occupied: []Range{{78, 81}}})
	if got, want := ranges(placed), "QT:54-57 설계:57-67 메일:67-69 구현:81-87 loose:87-89 "; got != want || len(unplaced) != 0 {
		t.Fatalf("placed = %q, want %q (unplaced %v)", got, want, unplaced)
	}
	// The AI's times stay inside [From, To).
	placed, _ = Place([]Task{{ID: "x", Chunks: []Chunk{{"x", 3}}, Prefer: at(140)}}, Options{From: 54, To: 108})
	if placed[0].Range != (Range{105, 108}) {
		t.Fatalf("late prefer = %+v", placed[0].Range)
	}
}

func TestPlacePacksTheAIsOrderFromTheStartOfEachPartOfTheDay(t *testing.T) {
	at := func(s int) *int { return &s }
	// Real qwen3 answer: QT first at 10:00 though 09:00 is free, two tasks at
	// overlapping times, a personal task in the evening; a meeting 14:00-15:00.
	tasks := []Task{
		{ID: "bs", Priority: 2, Chunks: []Chunk{{"box", 12}}, Prefer: at(61)},
		{ID: "sr", Priority: 3, Chunks: []Chunk{{"stocks", 12}}, Prefer: at(66)},
		{ID: "cc", Priority: 4, Chunks: []Chunk{{"청첩장", 6}}, Prefer: at(114)},
		{ID: "qt", Priority: 1, Chunks: []Chunk{{"QT", 3}}, Prefer: at(60)},
	}
	placed, unplaced := Place(tasks, Options{From: 54, To: 132, Occupied: []Range{{84, 90}}})
	if got, want := ranges(placed), "QT:54-57 box:57-69 stocks:90-102 청첩장:108-114 "; got != want || len(unplaced) != 0 {
		t.Fatalf("placed = %q, want %q (unplaced %v)", got, want, unplaced)
	}
}

func TestPlaceKeepsATimedTasksChunksInOrder(t *testing.T) {
	at := 54
	// The first chunk only fits in the afternoon; the second must not go back to the morning gap.
	tasks := []Task{{ID: "bs", Chunks: []Chunk{{"설계", 12}, {"리뷰", 6}}, Prefer: &at}}
	placed, unplaced := Place(tasks, Options{From: 54, To: 120, Occupied: []Range{{54, 60}, {67, 72}, {78, 84}, {101, 120}}})
	if got := ranges(placed); got != "설계:84-96 " || len(unplaced) != 1 {
		t.Fatalf("placed = %q, unplaced = %v (리뷰 must not land in the 10:00 gap before 설계)", got, unplaced)
	}
}

func TestPlaceKeepsTheAskedForBreakBetweenBlocks(t *testing.T) {
	at := func(s int) *int { return &s }
	tasks := []Task{
		{ID: "bs", Priority: 2, Chunks: []Chunk{{"box", 12}}, Prefer: at(61)},
		{ID: "sr", Priority: 3, Chunks: []Chunk{{"stocks", 12}}, Prefer: at(66)},
		{ID: "cc", Priority: 4, Chunks: []Chunk{{"청첩장", 6}}, Prefer: at(114)},
		{ID: "qt", Priority: 1, Chunks: []Chunk{{"QT", 3}}, Prefer: at(60)},
	}
	// Ten minutes after each block, and before and after the 14:00 meeting.
	placed, _ := Place(tasks, Options{From: 54, To: 132, Occupied: []Range{{84, 90}}, Gap: 1})
	if got, want := ranges(placed), "QT:54-57 box:58-70 stocks:91-103 청첩장:108-114 "; got != want {
		t.Fatalf("placed = %q, want %q", got, want)
	}
}

func TestPlaceDropsTheBreakRatherThanTheBlock(t *testing.T) {
	// Only 09:00-09:30 is free before the saved block: it fits there without the break.
	tasks := []Task{{ID: "a", Chunks: []Chunk{{"메일", 3}}}}
	placed, unplaced := Place(tasks, Options{From: 54, To: 60, Occupied: []Range{{57, 60}}, Gap: 2})
	if got := ranges(placed); got != "메일:54-57 " || len(unplaced) != 0 {
		t.Fatalf("placed = %q, unplaced = %v", got, unplaced)
	}
	// An asked-for time sits as asked, right after a saved block.
	nine := 60
	placed, _ = Place([]Task{{ID: "b", Chunks: []Chunk{{"운동", 3}}, StartAt: &nine}}, Options{From: 54, To: 132, Occupied: []Range{{57, 60}}, Gap: 2})
	if got := ranges(placed); got != "운동:60-63 " {
		t.Fatalf("asked = %q", got)
	}
}
