package ai

import "context"

// Fake returns a predictable plan without calling Claude: each task keeps its
// estimate (or 3 boxes), in brain dump order, as a single chunk.
type Fake struct{}

func (Fake) Plan(_ context.Context, req PlanRequest) (Plan, error) {
	plan := Plan{Tasks: []TaskPlan{}, Notes: "테스트용 제안이에요."}
	for i, t := range req.Tasks {
		boxes := 3
		if t.EstimateBoxes != nil {
			boxes = max(*t.EstimateBoxes-t.ScheduledBoxes, 1)
		}
		plan.Tasks = append(plan.Tasks, TaskPlan{
			TaskID:        t.ID,
			EstimateBoxes: boxes,
			Priority:      i + 1,
			Window:        "any",
			Chunks:        []Chunk{{Title: t.Title, Boxes: boxes}},
			Reason:        "순서대로 배치했어요.",
		})
	}
	return plan, nil
}
