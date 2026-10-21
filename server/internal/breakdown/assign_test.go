package breakdown

import "testing"

func TestAssignFillsShares(t *testing.T) {
	subs := []Sub{{"규격", 12}, {"로그인", 24}, {"사용자", 30}, {"이벤트", 36}, {"예시", 12}, {"검토", 6}}
	got := Assign(subs, []Share{{"minji", 72}, {"seojun", 48}}, nil)
	sum := map[string]int{}
	for i, u := range got {
		sum[u] += subs[i].Boxes
	}
	if sum["minji"] != 72 || sum["seojun"] != 48 {
		t.Fatalf("shares not met: %v (%v)", sum, got)
	}
}

func TestAssignEvenWithoutShares(t *testing.T) {
	subs := []Sub{{"a", 6}, {"b", 6}, {"c", 6}, {"d", 6}}
	got := Assign(subs, []Share{{"x", 0}, {"y", 0}}, nil)
	n := map[string]int{}
	for _, u := range got {
		n[u]++
	}
	if n["x"] != 2 || n["y"] != 2 {
		t.Fatalf("not even: %v", got)
	}
}

func TestAssignCountsKeptWork(t *testing.T) {
	// x already has 12 of their 18: the new 6 + 6 go one each way at most.
	got := Assign([]Sub{{"a", 6}, {"b", 6}}, []Share{{"x", 18}, {"y", 6}}, map[string]int{"x": 12})
	if got[0] == got[1] {
		t.Fatalf("kept work ignored: %v", got)
	}
}

func TestAssignSingleAndNone(t *testing.T) {
	if got := Assign([]Sub{{"a", 6}, {"b", 3}}, []Share{{"solo", 0}}, nil); got[0] != "solo" || got[1] != "solo" {
		t.Fatalf("single: %v", got)
	}
	if got := Assign([]Sub{{"a", 6}}, nil, nil); got[0] != "" {
		t.Fatalf("no one: %v", got)
	}
}
