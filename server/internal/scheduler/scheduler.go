// Package scheduler places planned task chunks into a day's free 10-minute slots.
//
// The AI decides what to do, how long it takes, and when it fits best; this
// package decides exactly where it goes, so placements never overlap.
package scheduler

import (
	"cmp"
	"slices"
)

const SlotsPerDay = 144

// Range is a half-open slot range [Start, End).
type Range struct {
	Start int
	End   int
}

type Window string

const (
	Morning   Window = "morning"
	Afternoon Window = "afternoon"
	Evening   Window = "evening"
	Any       Window = "any"
)

// windowRanges are the preferred slots for each window. Lunch (12:00-13:00) is
// left out on purpose; tasks only land there through the "anywhere" fallback.
var windowRanges = map[Window]Range{
	Morning:   {0, 72},    // until 12:00
	Afternoon: {78, 108},  // 13:00-18:00
	Evening:   {108, 144}, // after 18:00
	Any:       {0, SlotsPerDay},
}

// focusBreakBoxes is how long a chunk must be before a one-box break is kept after it.
const focusBreakBoxes = 6

type Chunk struct {
	Title string
	Boxes int
}

type Task struct {
	ID       string
	Priority int // 1 is most important
	Window   Window
	Chunks   []Chunk
	Reason   string
}

type Placement struct {
	TaskID string
	Title  string
	Range  Range
	Reason string
}

type Unplaced struct {
	TaskID string
	Title  string
	Boxes  int
}

type Options struct {
	// Placements stay within [From, To).
	From, To int
	Occupied []Range
}

// Place assigns each chunk the earliest free run in its task's preferred window,
// falling back to anywhere in [From, To). Tasks go in priority order and a task's
// chunks keep their order.
func Place(tasks []Task, opt Options) ([]Placement, []Unplaced) {
	from := max(opt.From, 0)
	to := min(opt.To, SlotsPerDay)

	var free [SlotsPerDay]bool
	for s := from; s < to; s++ {
		free[s] = true
	}
	for _, r := range opt.Occupied {
		for s := max(r.Start, 0); s < min(r.End, SlotsPerDay); s++ {
			free[s] = false
		}
	}

	ordered := slices.Clone(tasks)
	slices.SortStableFunc(ordered, func(a, b Task) int { return cmp.Compare(a.Priority, b.Priority) })

	placed := []Placement{}
	unplaced := []Unplaced{}
	for _, t := range ordered {
		cursor := from
		for _, c := range t.Chunks {
			boxes := min(max(c.Boxes, 1), SlotsPerDay)
			w, ok := windowRanges[t.Window]
			if !ok {
				w = windowRanges[Any]
			}

			start, found := firstFit(&free, max(cursor, w.Start, from), min(w.End, to), boxes)
			if !found {
				start, found = firstFit(&free, cursor, to, boxes)
			}
			if !found {
				unplaced = append(unplaced, Unplaced{TaskID: t.ID, Title: c.Title, Boxes: boxes})
				continue
			}

			end := start + boxes
			for s := start; s < end; s++ {
				free[s] = false
			}
			if boxes >= focusBreakBoxes && end < SlotsPerDay {
				free[end] = false // keep a short break after a long focus block
			}
			placed = append(placed, Placement{TaskID: t.ID, Title: c.Title, Range: Range{start, end}, Reason: t.Reason})
			cursor = end
		}
	}

	slices.SortFunc(placed, func(a, b Placement) int { return cmp.Compare(a.Range.Start, b.Range.Start) })
	return placed, unplaced
}

// firstFit returns the first start in [lo, hi) where `boxes` consecutive slots are free.
func firstFit(free *[SlotsPerDay]bool, lo, hi, boxes int) (int, bool) {
	run := 0
	for s := lo; s < hi; s++ {
		if !free[s] {
			run = 0
			continue
		}
		run++
		if run == boxes {
			return s - boxes + 1, true
		}
	}
	return 0, false
}
