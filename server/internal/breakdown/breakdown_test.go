package breakdown

import (
	"reflect"
	"testing"
)

func TestCapacityAndOverlap(t *testing.T) {
	if c := Default.Capacity(); c != 48 {
		t.Fatalf("capacity %d, want 48 (8 hours)", c)
	}
	cases := []struct{ s, e, want int }{
		{54, 60, 6},   // 09:00–10:00
		{60, 78, 12},  // 10:00–13:00 minus lunch
		{48, 54, 0},   // before work
		{102, 114, 6}, // 17:00–19:00
		{66, 72, 0},   // lunch
	}
	for _, c := range cases {
		if got := Default.WorkingOverlap(c.s, c.e); got != c.want {
			t.Errorf("overlap %d–%d = %d, want %d", c.s, c.e, got, c.want)
		}
	}
}

func TestWorkingDays(t *testing.T) {
	got := WorkingDays("2026-10-21", "2026-10-31")
	want := []string{"2026-10-21", "2026-10-22", "2026-10-23", "2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v", got)
	}
	if WorkingDays("2026-10-31", "2026-10-21") != nil {
		t.Error("reversed range")
	}
}

func day(date string, busy int) Day { return Day{Date: date, Busy: busy, Left: -1} }

// The example from the plan: 20 hours over 10/21–10/31, two busy days.
func TestAllocateSequential(t *testing.T) {
	subs := []Sub{{"공통 규칙", 12}, {"로그인 API", 24}, {"이벤트 API", 36}, {"예약 API", 24}, {"예시", 12}, {"리뷰", 12}}
	dates := WorkingDays("2026-10-21", "2026-10-31")
	days := make([]Day, len(dates))
	for i, d := range dates {
		days[i] = day(d, 0)
	}
	days[2].Busy = 42 // 10/23: only 1 hour free
	r := Allocate(subs, days, Default)
	if r.Total != 120 {
		t.Fatalf("total %d", r.Total)
	}
	for i, d := range r.Days {
		if d.Total > Default.PerTaskMax || d.Total > d.Free {
			t.Errorf("%s: %d over cap", d.Date, d.Total)
		}
		if i == 2 && d.Total != 6 {
			t.Errorf("busy day got %d, want 6", d.Total)
		}
	}
	if !r.Days[len(r.Days)-1].Reserve {
		t.Error("last day not reserved")
	}
	// 7 days × 2h − 1h on the busy day = 13h before the reserve, 2h on it: 15h of 20h fit.
	if r.Placed != 90 || r.Shortage != 30 {
		t.Errorf("placed %d shortage %d", r.Placed, r.Shortage)
	}
	if r.Days[0].Pieces[0].Title != "공통 규칙" || r.Days[0].Pieces[0].Boxes != 12 {
		t.Errorf("first day: %+v", r.Days[0].Pieces)
	}
	// Order is kept: a piece never comes before an earlier sub is finished.
	last := 0
	for _, d := range r.Days {
		for _, p := range d.Pieces {
			if p.Sub < last {
				t.Fatalf("order broken at %s", d.Date)
			}
			last = p.Sub
		}
	}
}

func TestReserveUsedOnlyWhenNeeded(t *testing.T) {
	days := []Day{day("2026-10-26", 0), day("2026-10-27", 0), day("2026-10-28", 0), day("2026-10-29", 0)}
	r := Allocate([]Sub{{"a", 30}}, days, Default)
	if r.Days[3].Total != 0 || r.Placed != 30 {
		t.Errorf("reserve used early: %+v", r.Days)
	}
	r = Allocate([]Sub{{"a", 44}}, days, Default)
	if r.Days[3].Total != 8 || r.Shortage != 0 {
		t.Errorf("reserve not used when needed: %+v", r.Days[3])
	}
	short := Allocate([]Sub{{"a", 12}}, days[:2], Default)
	if short.Days[1].Reserve {
		t.Error("short periods keep no reserve")
	}
}

func TestTodayLeft(t *testing.T) {
	r := Allocate([]Sub{{"a", 30}}, []Day{{Date: "2026-10-21", Left: 4}, day("2026-10-22", 0)}, Default)
	if r.Days[0].Total != 4 || r.Days[1].Total != 12 {
		t.Errorf("%+v", r.Days)
	}
}

func TestScaleTo(t *testing.T) {
	subs := []Sub{{"a", 15}, {"b", 15}, {"c", 15}, {"d", 15}, {"e", 10}, {"f", 10}}
	got, changed := ScaleTo(subs, 120)
	sum := 0
	for _, s := range got {
		sum += s.Boxes
	}
	if !changed || sum != 120 || got[0].Boxes != 23 && got[0].Boxes != 22 {
		t.Fatalf("scaled %v (sum %d)", got, sum)
	}
	if got[4].Boxes >= got[0].Boxes {
		t.Error("proportions lost")
	}
	if _, changed := ScaleTo(subs, 80); changed {
		t.Error("already matching")
	}
	tiny, _ := ScaleTo([]Sub{{"a", 50}, {"b", 1}, {"c", 1}}, 3)
	for _, s := range tiny {
		if s.Boxes != 1 {
			t.Errorf("tiny: %v", tiny)
		}
	}
	if _, changed := ScaleTo(subs, 0); changed {
		t.Error("no total: unchanged")
	}
}
