package ai

import (
	"encoding/json"
	"fmt"
	"strings"
)

const systemPrompt = `You plan a person's day in a timeboxing app. The day is divided into 144 boxes of 10 minutes each (slot 0 = 00:00, slot 60 = 10:00, slot 143 = 23:50).

You get the tasks from their brain dump, the blocks already on their calendar, and recently completed blocks with their real lengths. For every task, decide:
- estimateBoxes: the total boxes the remaining work needs. If the user gave an estimate, keep it unless it is clearly unrealistic. If some boxes are already scheduled (scheduledBoxes), plan only what is left.
- chunks: how to split that work into blocks to schedule, in order. Use one chunk for short tasks. Split work longer than 90 minutes (9 boxes) into focused chunks with clear sub-goals, e.g. "초안 작성" then "검토". Chunk boxes should add up to estimateBoxes. Chunk titles name the concrete step and stay in the task's language.
- priority: 1 (do first) to 5 (can wait). Weigh deadlines and urgency in the wording, items carried over from earlier days, and how much other tasks depend on this one.
- preferredWindow: "morning" for deep work that needs focus, "afternoon" for meetings, admin, and collaborative work, "evening" for light or personal tasks, or "any".
- reason: one short sentence, in the same language as the task titles, explaining the estimate and the timing.

Some tasks have a dueDate (deadline). Tasks marked backlog come from the person's backlog, not today's list: put them in priority order by deadline, and if the day is too full give them the lowest priority so they are the ones left out.

Use recentCompleted to calibrate estimates for similar work. Do not place tasks on specific slots; a separate scheduler does that. Put any advice about the day as a whole (overload, missing breaks, tasks that will not fit) in notes, in the same language as the task titles, in two sentences at most. Include every task exactly once, using its id as taskId. In reason and notes, talk in hours and minutes, never in boxes or slots.`

// planSchema constrains the model's output to Plan.
var planSchema = map[string]any{
	"type": "object",
	"properties": map[string]any{
		"tasks": map[string]any{
			"type": "array",
			"items": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"taskId":          map[string]any{"type": "string"},
					"estimateBoxes":   map[string]any{"type": "integer"},
					"priority":        map[string]any{"type": "integer"},
					"preferredWindow": map[string]any{"type": "string", "enum": []string{"morning", "afternoon", "evening", "any"}},
					"chunks": map[string]any{
						"type": "array",
						"items": map[string]any{
							"type": "object",
							"properties": map[string]any{
								"title": map[string]any{"type": "string"},
								"boxes": map[string]any{"type": "integer"},
							},
							"required":             []string{"title", "boxes"},
							"additionalProperties": false,
						},
					},
					"reason": map[string]any{"type": "string"},
				},
				"required":             []string{"taskId", "estimateBoxes", "priority", "preferredWindow", "chunks", "reason"},
				"additionalProperties": false,
			},
		},
		"notes": map[string]any{"type": "string"},
	},
	"required":             []string{"tasks", "notes"},
	"additionalProperties": false,
}

func userPrompt(req PlanRequest) string {
	ctx, _ := json.MarshalIndent(req, "", "  ")
	var b strings.Builder
	fmt.Fprintf(&b, "Plan %s (%s). Only boxes %d-%d are available for new work.\n\n", req.Date, req.Weekday, req.From, req.To)
	b.WriteString("<day>\n")
	b.Write(ctx)
	b.WriteString("\n</day>")
	return b.String()
}
