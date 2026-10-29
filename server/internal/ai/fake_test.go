package ai

import (
	"context"
	"testing"
)

func TestFakeRevision(t *testing.T) {
	req := PlanRequest{Tasks: []TaskInput{{ID: "a", Title: "운동"}, {ID: "b", Title: "메일"}, {ID: "c", Title: "기획서"}},
		Revision: &Revision{Request: "운동 8시로, 메일 빼줘, 기획서 30분"}}
	plan, _ := Fake{}.Plan(context.Background(), req)
	a, b, c := plan.Tasks[0], plan.Tasks[1], plan.Tasks[2]
	if a.StartAt != "08:00" || a.Keep || !b.Skip || c.EstimateBoxes != 3 || c.Keep {
		t.Fatalf("plan = %+v", plan.Tasks)
	}
}
