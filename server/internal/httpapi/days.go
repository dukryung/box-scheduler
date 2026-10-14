package httpapi

import (
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"box-scheduler/server/internal/store"
)

type dayResponse struct {
	Date      string                `json:"date"`
	Weekday   int                   `json:"weekday"` // 0 = Sunday
	Note      *string               `json:"note"`
	Blocks    []store.Block         `json:"blocks"`
	BrainDump []store.BrainDumpItem `json:"brainDump"`
}

func (a *API) getDay(w http.ResponseWriter, r *http.Request) {
	date := chi.URLParam(r, "date")
	t, ok := parseDate(date)
	if !ok {
		writeError(w, http.StatusBadRequest, "date must be YYYY-MM-DD")
		return
	}
	uid := userID(r)

	note, err := a.store.GetDayNote(r.Context(), uid, date)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	blocks, err := a.store.ListBlocks(r.Context(), uid, date, date)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	items, err := a.store.ListBrainDump(r.Context(), uid, date)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, dayResponse{
		Date: date, Weekday: int(t.Weekday()), Note: note, Blocks: blocks, BrainDump: items,
	})
}

func (a *API) putDayNote(w http.ResponseWriter, r *http.Request) {
	date := chi.URLParam(r, "date")
	if _, ok := parseDate(date); !ok {
		writeError(w, http.StatusBadRequest, "date must be YYYY-MM-DD")
		return
	}
	var body struct {
		Note *string `json:"note"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	if err := a.store.SetDayNote(r.Context(), userID(r), date, body.Note); err != nil {
		writeStoreError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// calendarPreviewLimit is how many block titles a month cell shows before "+N more".
const calendarPreviewLimit = 3

type calendarItem struct {
	Title     string  `json:"title"`
	Color     *string `json:"color"`
	StartSlot int     `json:"startSlot"`
	Done      bool    `json:"done"`
}

type calendarDay struct {
	Items        []calendarItem `json:"items"`
	Total        int            `json:"total"`
	PlannedBoxes int            `json:"plannedBoxes"`
	DoneBoxes    int            `json:"doneBoxes"`
}

func (a *API) getCalendar(w http.ResponseWriter, r *http.Request) {
	month := r.URL.Query().Get("month")
	first, err := time.Parse("2006-01", month)
	if err != nil {
		writeError(w, http.StatusBadRequest, "month must be YYYY-MM")
		return
	}
	last := first.AddDate(0, 1, -1)

	blocks, err := a.store.ListBlocks(r.Context(), userID(r), first.Format(dateLayout), last.Format(dateLayout))
	if err != nil {
		writeStoreError(w, err)
		return
	}

	days := map[string]*calendarDay{}
	for _, b := range blocks {
		d, ok := days[b.Date]
		if !ok {
			d = &calendarDay{Items: []calendarItem{}}
			days[b.Date] = d
		}
		// Blocks arrive ordered by start_slot, so the first few are the earliest of the day.
		if len(d.Items) < calendarPreviewLimit {
			d.Items = append(d.Items, calendarItem{Title: b.Title, Color: b.Color, StartSlot: b.StartSlot, Done: b.Done})
		}
		boxes := b.EndSlot - b.StartSlot
		d.Total++
		d.PlannedBoxes += boxes
		if b.Done {
			d.DoneBoxes += boxes
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"month": month, "days": days})
}
