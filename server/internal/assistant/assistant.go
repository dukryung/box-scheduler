// Package assistant checks the edits Claude proposes for a spoken request and
// describes them for preview. Nothing here touches the database.
package assistant

import (
	"cmp"
	"fmt"
	"slices"
	"strconv"
	"strings"

	"box-scheduler/server/internal/ai"
	"box-scheduler/server/internal/store"
)

const (
	slotsPerDay       = 144
	defaultBlockBoxes = 3
)

// Op is a resolved, validated edit. The client sends these back unchanged to apply them.
type Op struct {
	Kind          string  `json:"kind"`
	BlockID       string  `json:"blockId,omitempty"`
	ItemID        string  `json:"itemId,omitempty"`
	Date          string  `json:"date,omitempty"`
	StartSlot     *int    `json:"startSlot,omitempty"`
	EndSlot       *int    `json:"endSlot,omitempty"`
	Title         *string `json:"title,omitempty"`
	Done          *bool   `json:"done,omitempty"`
	Color         *string `json:"color,omitempty"`
	BrainDumpID   *string `json:"brainDumpId,omitempty"`
	Source        string  `json:"source,omitempty"`
	EstimateBoxes *int    `json:"estimateBoxes,omitempty"`
	Status        *string `json:"status,omitempty"`
}

type Span struct {
	Date      string `json:"date"`
	StartSlot int    `json:"startSlot"`
	EndSlot   int    `json:"endSlot"`
}

// Change is one line of the preview.
type Change struct {
	Kind   string `json:"kind"` // add, move, edit, done, undone, remove, item-add, item-edit, item-remove
	Title  string `json:"title"`
	Before *Span  `json:"before,omitempty"`
	After  *Span  `json:"after,omitempty"`
	Detail string `json:"detail,omitempty"`
}

type Result struct {
	Ops      []Op     `json:"ops"`
	Changes  []Change `json:"changes"`
	Warnings []string `json:"warnings"`
}

// Snapshot is what the request may touch: blocks for every date involved and brain dump items.
type Snapshot struct {
	Blocks []store.Block
	Items  []store.BrainDumpItem
}

// Refs maps the short names given to the model (b3, i2) to real ids.
type Refs struct {
	Blocks map[string]string
	Items  map[string]string
}

// NewRefs numbers blocks (by date, then time) and items in a stable order.
func NewRefs(snap Snapshot) Refs {
	blocks := slices.Clone(snap.Blocks)
	slices.SortFunc(blocks, func(a, b store.Block) int {
		return cmp.Or(cmp.Compare(a.Date, b.Date), cmp.Compare(a.StartSlot, b.StartSlot))
	})
	r := Refs{Blocks: map[string]string{}, Items: map[string]string{}}
	for i, b := range blocks {
		r.Blocks["b"+strconv.Itoa(i+1)] = b.ID
	}
	for i, it := range snap.Items {
		r.Items["i"+strconv.Itoa(i+1)] = it.ID
	}
	return r
}

// RefOf is the reverse lookup used when describing the schedule to the model.
func (r Refs) RefOf(id string) string {
	for ref, v := range r.Blocks {
		if v == id {
			return ref
		}
	}
	for ref, v := range r.Items {
		if v == id {
			return ref
		}
	}
	return ""
}

// ParseTime reads "HH:MM" on the 10-minute grid as a slot; "24:00" is the end of day.
func ParseTime(s string) (int, bool) {
	h, m, ok := strings.Cut(strings.TrimSpace(s), ":")
	if !ok {
		return 0, false
	}
	hh, err1 := strconv.Atoi(h)
	mm, err2 := strconv.Atoi(m)
	if err1 != nil || err2 != nil || hh < 0 || mm < 0 || mm > 59 || mm%10 != 0 {
		return 0, false
	}
	slot := hh*6 + mm/10
	return slot, slot <= slotsPerDay
}

func FormatTime(slot int) string { return fmt.Sprintf("%02d:%02d", slot/6, (slot%6)*10) }

// Build resolves the model's ops against the snapshot, applying them in order to
// an in-memory copy so each is checked against the edits before it. Ops that
// cannot be applied are dropped with a warning instead of failing the whole request.
func Build(raw []ai.RawOp, refs Refs, snap Snapshot, viewDate string) Result {
	blocks := map[string]store.Block{}
	for _, b := range snap.Blocks {
		blocks[b.ID] = b
	}
	items := map[string]store.BrainDumpItem{}
	for _, it := range snap.Items {
		items[it.ID] = it
	}
	res := Result{Ops: []Op{}, Changes: []Change{}, Warnings: []string{}}
	warn := func(format string, a ...any) { res.Warnings = append(res.Warnings, fmt.Sprintf(format, a...)) }
	newID := 0

	overlaps := func(date string, start, end int, except string) *store.Block {
		for _, b := range blocks {
			if b.ID != except && b.Date == date && start < b.EndSlot && b.StartSlot < end {
				return &b
			}
		}
		return nil
	}

	for _, r := range raw {
		switch r.Kind {
		case "create_block":
			date := cmp.Or(r.Date, viewDate)
			title := strings.TrimSpace(r.Title)
			var itemID *string
			estimate := 0
			if r.Item != "" {
				id, ok := refs.Items[r.Item]
				if !ok {
					warn("알 수 없는 할 일(%s)은 건너뛰었어요", r.Item)
					continue
				}
				itemID = &id
				title = cmp.Or(title, items[id].Title)
				if e := items[id].EstimateBoxes; e != nil {
					estimate = *e
				}
			}
			start, ok := ParseTime(r.Start)
			if !ok || title == "" || !validDate(date) {
				warn("'%s' 일정은 시간이나 이름이 분명하지 않아 건너뛰었어요", cmp.Or(title, "새"))
				continue
			}
			end, ok := ParseTime(r.End)
			if !ok {
				end = start + cmp.Or(estimate, defaultBlockBoxes)
			}
			if end <= start || end > slotsPerDay {
				warn("'%s'의 시간이 올바르지 않아 건너뛰었어요", title)
				continue
			}
			if o := overlaps(date, start, end, ""); o != nil {
				warn("'%s'은(는) '%s'와 겹쳐서 넣지 않았어요", title, o.Title)
				continue
			}
			newID++
			tmp := fmt.Sprintf("new-%d", newID)
			blocks[tmp] = store.Block{ID: tmp, Date: date, StartSlot: start, EndSlot: end, Title: title}
			res.Ops = append(res.Ops, Op{Kind: "create_block", Date: date, StartSlot: ptr(start), EndSlot: ptr(end), Title: ptr(title), BrainDumpID: itemID, Source: "ai"})
			res.Changes = append(res.Changes, Change{Kind: "add", Title: title, After: &Span{date, start, end}})

		case "update_block":
			id, ok := refs.Blocks[r.Block]
			b, exists := blocks[id]
			if !ok || !exists {
				warn("알 수 없는 일정(%s)은 건너뛰었어요", r.Block)
				continue
			}
			next := b
			next.Date = cmp.Or(r.Date, b.Date)
			if r.Start != "" {
				start, ok := ParseTime(r.Start)
				if !ok {
					warn("'%s'의 시작 시각이 올바르지 않아 건너뛰었어요", b.Title)
					continue
				}
				next.StartSlot = start
				next.EndSlot = start + (b.EndSlot - b.StartSlot) // a move keeps the length
			}
			if r.End != "" {
				end, ok := ParseTime(r.End)
				if !ok {
					warn("'%s'의 끝 시각이 올바르지 않아 건너뛰었어요", b.Title)
					continue
				}
				next.EndSlot = end
			}
			if t := strings.TrimSpace(r.Title); t != "" {
				next.Title = t
			}
			if r.Done != nil {
				next.Done = *r.Done
			}
			if !validDate(next.Date) || next.EndSlot <= next.StartSlot || next.EndSlot > slotsPerDay {
				warn("'%s'의 바뀐 시간이 하루를 벗어나 건너뛰었어요", b.Title)
				continue
			}
			if o := overlaps(next.Date, next.StartSlot, next.EndSlot, id); o != nil {
				warn("'%s'은(는) '%s'와 겹쳐서 옮기지 않았어요", b.Title, o.Title)
				continue
			}
			op := Op{Kind: "update_block", BlockID: id}
			moved := next.Date != b.Date || next.StartSlot != b.StartSlot || next.EndSlot != b.EndSlot
			if moved {
				op.Date, op.StartSlot, op.EndSlot = next.Date, ptr(next.StartSlot), ptr(next.EndSlot)
				res.Changes = append(res.Changes, Change{Kind: "move", Title: b.Title, Before: spanOf(b), After: spanOf(next)})
			}
			if next.Title != b.Title {
				op.Title = ptr(next.Title)
				res.Changes = append(res.Changes, Change{Kind: "edit", Title: b.Title, After: spanOf(next), Detail: "이름을 '" + next.Title + "'(으)로"})
			}
			if next.Done != b.Done {
				op.Done = ptr(next.Done)
				kind := "done"
				if !next.Done {
					kind = "undone"
				}
				res.Changes = append(res.Changes, Change{Kind: kind, Title: b.Title, After: spanOf(next)})
			}
			if !moved && op.Title == nil && op.Done == nil {
				continue // nothing actually changes
			}
			blocks[id] = next
			res.Ops = append(res.Ops, op)

		case "delete_block":
			id, ok := refs.Blocks[r.Block]
			b, exists := blocks[id]
			if !ok || !exists {
				warn("알 수 없는 일정(%s)은 건너뛰었어요", r.Block)
				continue
			}
			delete(blocks, id)
			res.Ops = append(res.Ops, Op{Kind: "delete_block", BlockID: id})
			res.Changes = append(res.Changes, Change{Kind: "remove", Title: b.Title, Before: spanOf(b)})

		case "add_item":
			title := strings.TrimSpace(r.Title)
			date := cmp.Or(r.Date, viewDate)
			if title == "" || !validDate(date) {
				warn("이름 없는 할 일은 건너뛰었어요")
				continue
			}
			op := Op{Kind: "add_item", Date: date, Title: ptr(title), EstimateBoxes: minutesToBoxes(r.EstimateMinutes)}
			res.Ops = append(res.Ops, op)
			res.Changes = append(res.Changes, Change{Kind: "item-add", Title: title, Detail: estimateDetail(op.EstimateBoxes)})

		case "update_item":
			id, ok := refs.Items[r.Item]
			it, exists := items[id]
			if !ok || !exists {
				warn("알 수 없는 할 일(%s)은 건너뛰었어요", r.Item)
				continue
			}
			op := Op{Kind: "update_item", ItemID: id, EstimateBoxes: minutesToBoxes(r.EstimateMinutes)}
			details := []string{}
			if t := strings.TrimSpace(r.Title); t != "" && t != it.Title {
				op.Title = ptr(t)
				details = append(details, "이름을 '"+t+"'(으)로")
			}
			if op.EstimateBoxes != nil {
				details = append(details, estimateDetail(op.EstimateBoxes))
			}
			if r.Status != "" && r.Status != it.Status {
				op.Status = ptr(r.Status)
				details = append(details, map[string]string{"open": "다시 열기", "done": "완료로", "dropped": "하지 않기로"}[r.Status])
			}
			if len(details) == 0 {
				continue
			}
			res.Ops = append(res.Ops, op)
			res.Changes = append(res.Changes, Change{Kind: "item-edit", Title: it.Title, Detail: strings.Join(details, ", ")})

		case "delete_item":
			id, ok := refs.Items[r.Item]
			it, exists := items[id]
			if !ok || !exists {
				warn("알 수 없는 할 일(%s)은 건너뛰었어요", r.Item)
				continue
			}
			delete(items, id)
			res.Ops = append(res.Ops, Op{Kind: "delete_item", ItemID: id})
			res.Changes = append(res.Changes, Change{Kind: "item-remove", Title: it.Title})

		default:
			warn("지원하지 않는 작업(%s)은 건너뛰었어요", r.Kind)
		}
	}
	return res
}

func spanOf(b store.Block) *Span { return &Span{b.Date, b.StartSlot, b.EndSlot} }

func ptr[T any](v T) *T { return &v }

func validDate(s string) bool {
	if len(s) != 10 || s[4] != '-' || s[7] != '-' {
		return false
	}
	_, err := strconv.Atoi(s[:4] + s[5:7] + s[8:])
	return err == nil
}

func minutesToBoxes(m *int) *int {
	if m == nil || *m <= 0 {
		return nil
	}
	return ptr(min((*m+9)/10, slotsPerDay))
}

func estimateDetail(boxes *int) string {
	if boxes == nil {
		return ""
	}
	m := *boxes * 10
	if m >= 60 && m%60 == 0 {
		return fmt.Sprintf("예상 %d시간", m/60)
	}
	if m >= 60 {
		return fmt.Sprintf("예상 %d시간 %d분", m/60, m%60)
	}
	return fmt.Sprintf("예상 %d분", m)
}
