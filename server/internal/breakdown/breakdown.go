// Package breakdown spreads the pieces of a task over working days: the AI
// suggests what the pieces are and how long each takes; this decides when.
package breakdown

import "time"

// Policy is the working day the spread respects. Times are 10-minute slots.
type Policy struct {
	WorkStart, WorkEnd   int // 09:00–18:00
	LunchStart, LunchEnd int // 11:00–12:00, not working time
	PerTaskMax           int // most of one task in a day (2 hours)
	MinPiece             int // smallest piece (10 minutes)
	// ReserveAfter: periods with more working days than this keep the last one free (review, slack).
	ReserveAfter int
}

var Default = Policy{WorkStart: 54, WorkEnd: 108, LunchStart: 66, LunchEnd: 72, PerTaskMax: 12, MinPiece: 1, ReserveAfter: 3}

// Capacity is the working time in a day (8 hours by default).
func (p Policy) Capacity() int {
	return (p.WorkEnd - p.WorkStart) - max(0, min(p.LunchEnd, p.WorkEnd)-max(p.LunchStart, p.WorkStart))
}

// WorkingOverlap is how much of [start, end) falls in working time (lunch excluded).
func (p Policy) WorkingOverlap(start, end int) int {
	overlap := func(a, b int) int { return max(0, min(end, b)-max(start, a)) }
	return overlap(p.WorkStart, p.WorkEnd) - overlap(max(p.LunchStart, p.WorkStart), min(p.LunchEnd, p.WorkEnd))
}

// Sub is one piece of the task, in order.
type Sub struct {
	Title string `json:"title"`
	Boxes int    `json:"boxes"`
}

// Day is a candidate day and how much working time is already taken on it.
type Day struct {
	Date string
	Busy int // slots of working time already planned
	// Left caps today's working time to what remains after now (-1: whole day).
	Left int
}

type Piece struct {
	Sub   int    `json:"sub"` // index into the subs
	Title string `json:"title"`
	Boxes int    `json:"boxes"`
}

type DayPlan struct {
	Date    string  `json:"date"`
	Free    int     `json:"free"` // working time not yet planned
	Reserve bool    `json:"reserve"`
	Pieces  []Piece `json:"pieces"`
	Total   int     `json:"total"`
}

type Result struct {
	Days     []DayPlan `json:"days"`
	Total    int       `json:"total"`    // asked for
	Placed   int       `json:"placed"`   // fitted
	Shortage int       `json:"shortage"` // did not fit before the due date
}

// WorkingDays lists Monday–Friday dates from..to (YYYY-MM-DD), inclusive.
func WorkingDays(from, to string) []string {
	start, err1 := time.Parse(time.DateOnly, from)
	end, err2 := time.Parse(time.DateOnly, to)
	if err1 != nil || err2 != nil || end.Before(start) || end.Sub(start) > 366*24*time.Hour {
		return nil
	}
	var out []string
	for d := start; !d.After(end); d = d.AddDate(0, 0, 1) {
		if wd := d.Weekday(); wd != time.Saturday && wd != time.Sunday {
			out = append(out, d.Format(time.DateOnly))
		}
	}
	return out
}

// Allocate fills days in order with the subs in order ("순서대로 채우기"):
// each day takes at most PerTaskMax of this task and only free working time;
// the last day is kept in reserve when the period is long enough, and used
// only if everything else is full.
func Allocate(subs []Sub, days []Day, p Policy) Result {
	res := Result{Days: make([]DayPlan, len(days))}
	cap := make([]int, len(days))
	for i, d := range days {
		free := max(0, p.Capacity()-d.Busy)
		if d.Left >= 0 {
			free = min(free, d.Left)
		}
		res.Days[i] = DayPlan{Date: d.Date, Free: free, Pieces: []Piece{}}
		cap[i] = min(free, p.PerTaskMax)
		cap[i] -= cap[i] % max(p.MinPiece, 1)
	}
	if len(days) > p.ReserveAfter {
		res.Days[len(days)-1].Reserve = true
	}

	remaining := make([]int, len(subs))
	for i, s := range subs {
		remaining[i] = max(0, s.Boxes)
		res.Total += remaining[i]
	}
	cur := 0
	fill := func(i int) {
		for cap[i] > 0 && cur < len(subs) {
			if remaining[cur] == 0 {
				cur++
				continue
			}
			n := min(cap[i], remaining[cur])
			res.Days[i].Pieces = append(res.Days[i].Pieces, Piece{Sub: cur, Title: subs[cur].Title, Boxes: n})
			res.Days[i].Total += n
			cap[i] -= n
			remaining[cur] -= n
			res.Placed += n
		}
	}
	for i := range days {
		if !res.Days[i].Reserve {
			fill(i)
		}
	}
	for i := range days {
		if res.Days[i].Reserve {
			fill(i)
		}
	}
	res.Shortage = res.Total - res.Placed
	return res
}

// ScaleTo stretches or shrinks the pieces to add up to total, keeping their
// proportions (each at least one box). Small models often miss the total.
func ScaleTo(subs []Sub, total int) ([]Sub, bool) {
	sum := 0
	for _, s := range subs {
		sum += s.Boxes
	}
	if total <= 0 || sum == 0 || sum == total || total < len(subs) {
		return subs, false
	}
	out := make([]Sub, len(subs))
	acc, given := 0, 0
	for i, s := range subs {
		acc += s.Boxes
		// Cumulative rounding keeps the sum exact.
		end := (acc*total + sum/2) / sum
		out[i] = Sub{Title: s.Title, Boxes: max(1, end-given)}
		given += out[i].Boxes
	}
	// Taking at least one box can overshoot; trim from the largest pieces.
	for given > total {
		big := 0
		for i := range out {
			if out[i].Boxes > out[big].Boxes {
				big = i
			}
		}
		out[big].Boxes--
		given--
	}
	return out, true
}
