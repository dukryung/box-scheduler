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

// MaxGap is the longest break between blocks: an hour.
const MaxGap = 6

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
	// Pinned gives each chunk the range it should keep (a task left as it was
	// when a plan is revised); StartAt is a start slot the person asked for.
	// Either may go past To, and moves to the nearest free time when taken.
	Pinned  []Range
	StartAt *int
	// Prefer is the start the AI chose. Small models are vague about exact times
	// but sensible about the order of the day, so it sets the order and the part
	// of the day (morning, afternoon, evening); within that, tasks run back to
	// back from the start of their part of the day.
	Prefer *int
}

type Placement struct {
	TaskID string
	Title  string
	Range  Range
	Reason string
	// Shifted: the asked-for time was taken (by a saved block), so it went to the
	// nearest free time.
	Shifted bool
}

type Unplaced struct {
	TaskID string
	Title  string
	Boxes  int
}

type Options struct {
	// Placements stay within [From, To), except times the person fixed, which
	// may run to the end of the day.
	From, To int
	Occupied []Range
	// Gap is the break, in boxes, kept between planned blocks and anything next
	// to them. Times the person fixed sit as asked, and a block that only fits
	// without the break still goes in.
	Gap int
}

// Place puts each task where the plan says: an asked-for or kept time first,
// then the AI's chosen start (or the nearest free time to it), and otherwise the
// earliest free run in the task's preferred window, falling back to anywhere in
// [From, To). Nothing overlaps, and a task's chunks keep their order.
func Place(tasks []Task, opt Options) ([]Placement, []Unplaced) {
	from := max(opt.From, 0)
	to := min(opt.To, SlotsPerDay)

	// Free runs reach the end of the day: asked-for times may go past To, while
	// other tasks only ever search up to To.
	var free [SlotsPerDay]bool
	for s := from; s < SlotsPerDay; s++ {
		free[s] = true
	}
	// roomy is free time at least gap boxes away from every block.
	gap := min(max(opt.Gap, 0), MaxGap)
	roomy := free
	busy := func(r Range) {
		for s := max(r.Start, 0); s < min(r.End, SlotsPerDay); s++ {
			free[s] = false
		}
		for s := max(r.Start-gap, 0); s < min(r.End+gap, SlotsPerDay); s++ {
			roomy[s] = false
		}
	}
	for _, r := range opt.Occupied {
		busy(r)
	}

	// nearIn is the run of boxes in [lo, hi) closest to start, later first.
	nearIn := func(f *[SlotsPerDay]bool, start, boxes, lo, hi int) (int, bool) {
		start = min(max(start, lo), hi-boxes)
		if start < lo {
			return 0, false
		}
		if at, ok := firstFit(f, start, hi, boxes); ok {
			return at, true
		}
		return lastFit(f, lo, start+boxes, boxes)
	}
	// Fixed times may run to the end of the day, never before From.
	near := func(start, boxes int) (int, bool) { return nearIn(&free, start, boxes, from, SlotsPerDay) }
	// What the person fixed goes first: times they asked for win over everything
	// else suggested, then tasks kept as they were (moving aside if an asked-for
	// time took their place). Then the AI's timed plan, earliest first, and last
	// tasks with only a preferred window.
	const (
		asked = iota
		pinned
		timed
		planned
	)
	stage := func(t Task) int {
		switch {
		case t.StartAt != nil:
			return asked
		case len(t.Pinned) == len(t.Chunks) && len(t.Pinned) > 0:
			return pinned
		case t.Prefer != nil:
			return timed
		}
		return planned
	}
	preferred := func(t Task) int {
		if t.Prefer != nil {
			return *t.Prefer
		}
		return 0
	}
	total := func(t Task) int {
		n := 0
		for _, c := range t.Chunks {
			n += c.Boxes
		}
		return n
	}
	// At the same time and priority, a short task (a routine) goes before a long one.
	ordered := slices.Clone(tasks)
	slices.SortStableFunc(ordered, func(a, b Task) int {
		return cmp.Or(cmp.Compare(stage(a), stage(b)), cmp.Compare(preferred(a), preferred(b)), cmp.Compare(a.Priority, b.Priority), cmp.Compare(total(a), total(b)))
	})

	placed := []Placement{}
	unplaced := []Unplaced{}
	// Where the previous task in the AI's order ended, per part of the day, so a
	// long task running into the evening does not drag the morning's tasks along.
	lastEnd := [3]int{from, from, from}
	take := func(t Task, c Chunk, start, boxes int, shifted bool) int {
		end := start + boxes
		busy(Range{start, end})
		placed = append(placed, Placement{TaskID: t.ID, Title: c.Title, Range: Range{start, end}, Reason: t.Reason, Shifted: shifted})
		return end
	}
	// plan finds a place for chunk i of a timed or planned task within f.
	plan := func(f *[SlotsPerDay]bool, t Task, i, cursor, boxes int) (start int, found bool) {
		if t.Prefer == nil {
			w, ok := windowRanges[t.Window]
			if !ok {
				w = windowRanges[Any]
			}
			if start, found = firstFit(f, max(cursor, w.Start, from), min(w.End, to), boxes); !found {
				start, found = firstFit(f, cursor, to, boxes)
			}
			return start, found
		}
		p := partOf(*t.Prefer)
		lo := max(parts[p].Start, lastEnd[p], from)
		if i > 0 {
			lo = max(lo, cursor)
		}
		// Its part of the day, or the start of a later one, before anywhere at all.
		for p := partOf(lo); p < len(parts) && !found; p++ {
			lo = max(lo, lastEnd[p])
			start, found = firstFit(f, max(lo, parts[p].Start), min(parts[p].End, to), boxes)
		}
		if !found {
			floor := from
			if i > 0 {
				floor = cursor // a task's chunks keep their order
			}
			start, found = nearIn(f, lo, boxes, floor, to)
		}
		return start, found
	}
	for _, t := range ordered {
		cursor := from
		st := stage(t)
		for i, c := range t.Chunks {
			boxes := min(max(c.Boxes, 1), SlotsPerDay)
			var start int
			var found, shifted bool
			switch st {
			case pinned:
				want := t.Pinned[i]
				boxes = min(max(want.End-want.Start, 1), SlotsPerDay)
				start, found = near(want.Start, boxes)
			case asked:
				want := max(*t.StartAt, cursor)
				start, found = near(want, boxes)
				shifted = found && i == 0 && start != *t.StartAt
			default:
				// With a break between blocks, but without one rather than not at all.
				if start, found = plan(&roomy, t, i, cursor, boxes); !found && gap > 0 {
					start, found = plan(&free, t, i, cursor, boxes)
				}
			}
			if !found {
				unplaced = append(unplaced, Unplaced{TaskID: t.ID, Title: c.Title, Boxes: boxes})
				continue
			}
			cursor = take(t, c, start, boxes, shifted)
			if st == timed {
				p := partOf(start)
				lastEnd[p] = max(lastEnd[p], cursor)
			}
		}
	}

	slices.SortFunc(placed, func(a, b Placement) int { return cmp.Compare(a.Range.Start, b.Range.Start) })
	return placed, unplaced
}

// parts are the morning, afternoon and evening, with lunch left out.
var parts = []Range{windowRanges[Morning], windowRanges[Afternoon], windowRanges[Evening]}

// partOf is the part of the day holding slot s; lunch belongs to the afternoon.
func partOf(s int) int {
	switch {
	case s < parts[0].End:
		return 0
	case s < parts[2].Start:
		return 1
	}
	return 2
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

// Fit keeps each wanted range where it is when it is free, and otherwise moves
// it to the nearest free run of the same length, looking later in the day first.
// Earlier entries win over later ones; ok[i] is false when range i fits nowhere.
func Fit(want []Range, occupied []Range) (got []Range, ok []bool) {
	var free [SlotsPerDay]bool
	for s := range free {
		free[s] = true
	}
	take := func(r Range) {
		for s := max(r.Start, 0); s < min(r.End, SlotsPerDay); s++ {
			free[s] = false
		}
	}
	for _, r := range occupied {
		take(r)
	}

	got = make([]Range, len(want))
	ok = make([]bool, len(want))
	for i, r := range want {
		boxes := min(max(r.End-r.Start, 1), SlotsPerDay)
		start := min(max(r.Start, 0), SlotsPerDay-boxes)
		at, found := firstFit(&free, start, SlotsPerDay, boxes)
		if !found {
			at, found = lastFit(&free, 0, start+boxes, boxes)
		}
		if !found {
			continue
		}
		got[i], ok[i] = Range{at, at + boxes}, true
		take(got[i])
	}
	return got, ok
}

// lastFit returns the last start in [lo, hi) where `boxes` consecutive slots are free.
func lastFit(free *[SlotsPerDay]bool, lo, hi, boxes int) (int, bool) {
	run := 0
	for s := hi - 1; s >= lo; s-- {
		if !free[s] {
			run = 0
			continue
		}
		run++
		if run == boxes {
			return s, true
		}
	}
	return 0, false
}
