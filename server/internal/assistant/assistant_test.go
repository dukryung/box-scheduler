package assistant

import (
	"strings"
	"testing"

	"box-scheduler/server/internal/ai"
	"box-scheduler/server/internal/store"
)

const day = "2026-10-14"

func snapshot() Snapshot {
	four := 4
	return Snapshot{
		Blocks: []store.Block{
			{ID: "gym", Date: day, StartSlot: 114, EndSlot: 120, Title: "헬스장"},        // 19:00-20:00
			{ID: "read", Date: day, StartSlot: 120, EndSlot: 123, Title: "책 읽기"},      // 20:00-20:30
			{ID: "meet", Date: "2026-10-15", StartSlot: 78, EndSlot: 84, Title: "회의"}, // tomorrow 13:00-14:00
		},
		Items: []store.BrainDumpItem{{ID: "contract", Date: day, Title: "계약서 검토", EstimateBoxes: &four, Status: "open"}},
	}
}

func TestRefsAreStable(t *testing.T) {
	r := NewRefs(snapshot())
	if r.Blocks["b1"] != "gym" || r.Blocks["b2"] != "read" || r.Blocks["b3"] != "meet" || r.Items["i1"] != "contract" {
		t.Fatalf("refs = %+v", r)
	}
	if r.RefOf("read") != "b2" {
		t.Fatalf("RefOf = %q", r.RefOf("read"))
	}
}

func TestParseTime(t *testing.T) {
	for in, want := range map[string]int{"00:00": 0, "10:20": 62, "24:00": 144} {
		if got, ok := ParseTime(in); !ok || got != want {
			t.Errorf("ParseTime(%q) = %d, %v", in, got, ok)
		}
	}
	for _, bad := range []string{"10:05", "25:00", "noon", "10"} {
		if _, ok := ParseTime(bad); ok {
			t.Errorf("ParseTime(%q) should fail", bad)
		}
	}
}

func TestMoveKeepsLengthAndChecksOverlap(t *testing.T) {
	snap := snapshot()
	r := NewRefs(snap)
	res := Build([]ai.RawOp{
		{Kind: "update_block", Block: "b1", Start: "20:00"}, // collides with 책 읽기
		{Kind: "update_block", Block: "b2", Start: "21:00"}, // frees 20:00
		{Kind: "update_block", Block: "b1", Start: "20:00"}, // now fits
	}, r, snap, day)

	if len(res.Ops) != 2 || len(res.Warnings) != 1 || !strings.Contains(res.Warnings[0], "겹쳐서") {
		t.Fatalf("ops = %+v, warnings = %v", res.Ops, res.Warnings)
	}
	gym := res.Ops[1]
	if gym.BlockID != "gym" || *gym.StartSlot != 120 || *gym.EndSlot != 126 {
		t.Fatalf("move = %+v", gym)
	}
	if c := res.Changes[1]; c.Kind != "move" || c.Before.StartSlot != 114 || c.After.StartSlot != 120 {
		t.Fatalf("change = %+v", c)
	}
}

func TestCreateFromBrainDumpUsesEstimate(t *testing.T) {
	snap := snapshot()
	res := Build([]ai.RawOp{{Kind: "create_block", Item: "i1", Start: "15:00"}}, NewRefs(snap), snap, day)
	if len(res.Ops) != 1 {
		t.Fatalf("ops = %+v, warnings = %v", res.Ops, res.Warnings)
	}
	op := res.Ops[0]
	if *op.Title != "계약서 검토" || *op.StartSlot != 90 || *op.EndSlot != 94 || *op.BrainDumpID != "contract" || op.Date != day || op.Source != "ai" {
		t.Fatalf("create = %+v", op)
	}
}

func TestUnknownRefsAndBadTimesAreDropped(t *testing.T) {
	snap := snapshot()
	res := Build([]ai.RawOp{
		{Kind: "delete_block", Block: "b9"},
		{Kind: "create_block", Title: "치과", Start: "15:05", End: "16:00"},
		{Kind: "update_block", Block: "b2", Done: ptr(false)}, // already not done: no-op
		{Kind: "delete_block", Block: "b3"},
	}, NewRefs(snap), snap, day)

	if len(res.Ops) != 1 || res.Ops[0].Kind != "delete_block" || res.Ops[0].BlockID != "meet" {
		t.Fatalf("ops = %+v", res.Ops)
	}
	if len(res.Warnings) != 2 {
		t.Fatalf("warnings = %v", res.Warnings)
	}
}

func TestItemEdits(t *testing.T) {
	snap := snapshot()
	sixty := 60
	res := Build([]ai.RawOp{
		{Kind: "add_item", Title: "장보기", EstimateMinutes: &sixty},
		{Kind: "update_item", Item: "i1", Status: "done"},
	}, NewRefs(snap), snap, day)

	if len(res.Ops) != 2 || *res.Ops[0].EstimateBoxes != 6 || *res.Ops[1].Status != "done" {
		t.Fatalf("ops = %+v", res.Ops)
	}
	if res.Changes[0].Detail != "예상 1시간" || res.Changes[1].Detail != "완료로" {
		t.Fatalf("changes = %+v", res.Changes)
	}
}
