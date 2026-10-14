package httpapi

import (
	"cmp"
	"net/http"
	"slices"
	"strings"
	"time"

	"box-scheduler/server/internal/store"
)

const (
	maxStatsDays  = 366
	topTasksLimit = 8
)

type boxCount struct {
	PlannedBoxes int `json:"plannedBoxes"`
	DoneBoxes    int `json:"doneBoxes"`
}

type dailyStat struct {
	Date string `json:"date"`
	boxCount
}

type hourlyStat struct {
	Hour int `json:"hour"`
	boxCount
}

type taskStat struct {
	Title string `json:"title"`
	boxCount
}

type statsTotals struct {
	boxCount
	Blocks     int `json:"blocks"`
	DoneBlocks int `json:"doneBlocks"`
	ActiveDays int `json:"activeDays"`
	AIBoxes    int `json:"aiBoxes"`
}

type statsResponse struct {
	From      string         `json:"from"`
	To        string         `json:"to"`
	Totals    statsTotals    `json:"totals"`
	Daily     []dailyStat    `json:"daily"`
	Hourly    []hourlyStat   `json:"hourly"`
	TopTasks  []taskStat     `json:"topTasks"`
	BrainDump map[string]int `json:"brainDump"` // item count by status
}

func (a *API) getStats(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	from, ok1 := parseDate(q.Get("from"))
	to, ok2 := parseDate(q.Get("to"))
	if !ok1 || !ok2 || to.Before(from) || to.Sub(from) > maxStatsDays*24*time.Hour {
		writeError(w, http.StatusBadRequest, "from/to must be YYYY-MM-DD, from <= to, at most a year apart")
		return
	}
	uid := userID(r)
	fromS, toS := from.Format(dateLayout), to.Format(dateLayout)

	blocks, err := a.store.ListBlocks(r.Context(), uid, fromS, toS)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	counts, err := a.store.BrainDumpStatusCounts(r.Context(), uid, fromS, toS)
	if err != nil {
		writeStoreError(w, err)
		return
	}

	resp := computeStats(blocks, from, to)
	resp.BrainDump = counts
	writeJSON(w, http.StatusOK, resp)
}

// computeStats aggregates blocks over [from, to]; every day and hour is present,
// even with zero boxes, so charts have a continuous axis.
func computeStats(blocks []store.Block, from, to time.Time) statsResponse {
	resp := statsResponse{From: from.Format(dateLayout), To: to.Format(dateLayout), Hourly: make([]hourlyStat, 24)}

	dayIdx := map[string]int{}
	for d := from; !d.After(to); d = d.AddDate(0, 0, 1) {
		dayIdx[d.Format(dateLayout)] = len(resp.Daily)
		resp.Daily = append(resp.Daily, dailyStat{Date: d.Format(dateLayout)})
	}
	for h := range resp.Hourly {
		resp.Hourly[h].Hour = h
	}

	tasks := map[string]*taskStat{}
	for _, b := range blocks {
		boxes := b.EndSlot - b.StartSlot
		done := 0
		if b.Done {
			done = boxes
			resp.Totals.DoneBlocks++
		}
		resp.Totals.Blocks++
		resp.Totals.PlannedBoxes += boxes
		resp.Totals.DoneBoxes += done
		if b.Source == "ai" {
			resp.Totals.AIBoxes += boxes
		}

		if i, ok := dayIdx[b.Date]; ok {
			resp.Daily[i].PlannedBoxes += boxes
			resp.Daily[i].DoneBoxes += done
		}
		for s := b.StartSlot; s < b.EndSlot; s++ {
			h := &resp.Hourly[s/6]
			h.PlannedBoxes++
			if b.Done {
				h.DoneBoxes++
			}
		}

		// Pieces of a split task ("기획서 · 초안") count toward the task itself.
		name, _, _ := strings.Cut(b.Title, " · ")
		t, ok := tasks[name]
		if !ok {
			t = &taskStat{Title: name}
			tasks[name] = t
		}
		t.PlannedBoxes += boxes
		t.DoneBoxes += done
	}

	for _, d := range resp.Daily {
		if d.PlannedBoxes > 0 {
			resp.Totals.ActiveDays++
		}
	}

	resp.TopTasks = []taskStat{}
	for _, t := range tasks {
		resp.TopTasks = append(resp.TopTasks, *t)
	}
	slices.SortFunc(resp.TopTasks, func(a, b taskStat) int {
		if c := cmp.Compare(b.PlannedBoxes, a.PlannedBoxes); c != 0 {
			return c
		}
		return cmp.Compare(a.Title, b.Title)
	})
	if len(resp.TopTasks) > topTasksLimit {
		resp.TopTasks = resp.TopTasks[:topTasksLimit]
	}
	return resp
}
