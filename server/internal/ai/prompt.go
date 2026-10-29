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
- startAt: when the task should start, "HH:MM" (24-hour), inside the available boxes. Work it out in this order:
  1. Routines first: a short daily habit such as QT (Quiet Time, a morning devotion), prayer, Bible reading, meditation, a morning workout or a daily review goes at the very start of the available time, before any other work, whatever its priority. Such routines usually take 20 to 30 minutes unless the person said otherwise.
  2. Then the remaining tasks one after another in priority order: deep, focused work in the morning, meetings, calls and admin in the afternoon, light or personal things (errands, chores, social plans) in the evening.
  3. Each task starts after the previous one ends (its whole estimate, all chunks), skipping over existingBlocks.
  If recentCompleted shows when they usually do similar work, start it around that time. A scheduler then fits the plan exactly, moving anything that collides to the nearest free time.
- reason: one short sentence, in the same language as the task titles, explaining the estimate and the timing.

Some tasks have a dueDate (deadline). Tasks marked backlog come from the person's backlog, not today's list: put them in priority order by deadline, and if the day is too full give them the lowest priority so they are the ones left out.

Use recentCompleted to calibrate estimates for similar work. Put any advice about the day as a whole (overload, missing breaks, tasks that will not fit) in notes, in the same language as the task titles, in two sentences at most. Include every task exactly once, using its id as taskId. In reason and notes, talk in hours and minutes, never in boxes or slots.

Leave endAt "", skip false and keep false, unless the prompt asks you to revise an earlier suggestion.`

const revisionPrompt = `This time you are revising: revision.previousSuggestion is the plan the person was shown (blocks with start and end times), revision.earlierRequests are changes they asked for before, already applied, and revision.request is what they ask now. Change only what revision.request asks for:
- keep: true for every task the request does not touch, so it stays exactly where it was. Copy its estimate and chunks from before.
- skip: true for a task the person wants left out of this plan.
- startAt: "HH:MM" (24-hour) when they ask for a task at a specific time, e.g. "8시" in the evening is "20:00". When a task only gets longer or shorter or is split differently, set startAt to its current start so it stays in place. Otherwise "".
- endAt: "HH:MM" only when they also say when it should end ("9시에서 9시 30분까지" is startAt "09:00", endAt "09:30"). Otherwise "".
A time the person asks for wins over the other suggested blocks: do not move a task away from a time they named because another suggested task is there; the scheduler moves that other one.
- Other changes (longer or shorter, split differently, earlier or later in the day, more urgent) go in estimateBoxes, chunks, preferredWindow and priority as usual, with keep false.
Any task the request names gets keep: false, and its new values must actually carry the change. Examples, for a task shown at 09:30–10:30:
- "30분만 하면 돼" → keep false, estimateBoxes 3, chunks [one chunk of 3], startAt "09:30".
- "오전 9시에서 9시 30분까지로 바꿔줘" → keep false, startAt "09:00", endAt "09:30", estimateBoxes 3, chunks [one chunk of 3].
- "오후로 미뤄줘" → keep false, preferredWindow "afternoon", startAt "".
- "9시로 옮겨줘" → keep false, startAt "09:00", and the same length and chunks as shown in previousSuggestion (a task shortened or split earlier stays that way).
- "빼줘" → skip true.
Blocks marked uncheckedByUser were switched off by the person; keep those tasks unless asked otherwise. Still include every task exactly once. In notes, say in one short sentence what you changed, in the language of the request, and only what your answer really changes.`

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
					"reason":  map[string]any{"type": "string"},
					"startAt": map[string]any{"type": "string"},
					"endAt":   map[string]any{"type": "string"},
					"skip":    map[string]any{"type": "boolean"},
					"keep":    map[string]any{"type": "boolean"},
				},
				"required":             []string{"taskId", "estimateBoxes", "priority", "preferredWindow", "chunks", "reason", "startAt", "endAt", "skip", "keep"},
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
	if req.Revision != nil {
		b.WriteString("\n\n" + revisionPrompt)
	}
	return b.String()
}
