package ai

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
)

// Assistant turns a spoken or typed request into schedule edits. It only
// proposes ops; the server validates them and the person confirms before anything is saved.
type Assistant interface {
	Interpret(ctx context.Context, req AssistantRequest) (AssistantReply, error)
}

type ContextBlock struct {
	Ref   string
	Start string
	End   string
	Title string
	Done  bool
}

type ContextItem struct {
	Ref             string
	Title           string
	EstimateMinutes int // 0 when unknown
	Status          string
}

type ContextDay struct {
	Date    string
	Weekday string
	Blocks  []ContextBlock
	Items   []ContextItem
}

type Turn struct {
	Role string `json:"role"` // "user" or "assistant"
	Text string `json:"text"`
}

type AssistantRequest struct {
	Now      string // "2026-10-14 (수) 16:40"
	Today    string
	ViewDate string
	Message  string
	History  []Turn
	Days     []ContextDay
}

// RawOp is one edit as the model writes it: existing blocks and items are named
// by short refs (b3, i2) and times are HH:MM. The server resolves and checks it.
type RawOp struct {
	Kind            string `json:"kind"`
	Block           string `json:"block,omitempty"`
	Item            string `json:"item,omitempty"`
	Date            string `json:"date,omitempty"`
	Start           string `json:"start,omitempty"`
	End             string `json:"end,omitempty"`
	Title           string `json:"title,omitempty"`
	Done            *bool  `json:"done,omitempty"`
	EstimateMinutes *int   `json:"estimateMinutes,omitempty"`
	Status          string `json:"status,omitempty"`
}

type AssistantReply struct {
	Reply         string  `json:"reply"`
	Clarification string  `json:"clarification"`
	Ops           []RawOp `json:"ops"`
}

const assistantSystemPrompt = `You edit a person's schedule in a timeboxing app from a request they spoke or typed, usually in Korean. Days are split into 10-minute boxes, so every time is HH:MM on a 10-minute grid, from 00:00 to 24:00.

You get the current time, the day they are looking at, their blocks on nearby days (each with a ref such as b3) and their brain dump items, which are tasks not yet scheduled (refs such as i2). Return ops that do exactly what they asked and nothing more:
- create_block: date, start, end, title. Always give both start and end: "1시간 동안" from 15:00 ends at 16:00. To schedule a brain dump item, also set item to its ref and use its title; if they gave no length, use its estimate.
- update_block: block, plus only the fields that change (date, start, end, title, done). To move a block, give the new start (and date if the day changes) and leave out end to keep its length. "N분 늦춰줘" or "N분 앞당겨줘" moves the whole block: start is its current start plus or minus N, and end is left out.
- delete_block: block. Only when they clearly ask to remove or cancel it.
- add_item, update_item, delete_item: brain dump items (title, estimateMinutes, status open|done|dropped, date).

Dates: 오늘 is today, 내일 is today plus one, 모레 is today plus two, and a weekday name means the next such day. When no day is given, use the day they are looking at. An hour from 1 to 7 without 오전/오후 means the afternoon.
Blocks on the same day must never overlap. If the requested time is taken, use the nearest free time that day and say so in reply.
Refer to existing blocks and items only by their refs. Do not invent tasks the person did not mention.

Your ops are not saved yet: the app shows them to the person as a preview, and nothing changes until they confirm it there. So never ask for permission or confirmation ("이렇게 할까요?", "맞나요?"); when you can tell what they want, return the ops. Ask instead, with no ops and one short question in clarification, only when:
- more than one block or item fits what they named and nothing in the request tells which (two blocks titled 회의 that day and they say just 회의);
- you cannot tell at all which day or time they mean;
- the request is not about their schedule.
Otherwise clarification is "".
reply: one or two short Korean sentences describing what will change, in hours and minutes, or empty when you ask a question.

Examples, with the person looking at 2026-05-12 and these blocks that day: c1 08:00-08:30 산책, c2 13:00-14:00 디자인 리뷰, c3 19:00-20:00 독서.
- "독서 저녁 9시로 미뤄줘" → ops [{"kind":"update_block","block":"c3","start":"21:00"}]
- "디자인 리뷰 취소됐어" → ops [{"kind":"delete_block","block":"c2"}]
- "산책 다 했어" → ops [{"kind":"update_block","block":"c1","done":true}]
- "디자인 리뷰 20분 앞당겨줘" → ops [{"kind":"update_block","block":"c2","start":"12:40"}]
- "모레 오전 11시에 30분 병원" → ops [{"kind":"create_block","date":"2026-05-14","start":"11:00","end":"11:30","title":"병원"}]
- "리뷰 미뤄줘" when the day also has c4 16:00-17:00 코드 리뷰 → ops [], clarification "디자인 리뷰와 코드 리뷰 중 어느 쪽을 미룰까요?"`

// assistantSchema lists ops first: models fill the fields in order, and one
// that writes a question first tends to leave the ops empty.
var assistantSchema = map[string]any{
	"type": "object",
	"properties": orderedProps{
		{"ops", map[string]any{
			"type": "array",
			"items": map[string]any{
				"type": "object",
				// In this order, not sorted: grammar-constrained decoding (Ollama) only
				// lets optional fields come in schema order, and sorted, end comes
				// before start, so a model that wrote start could no longer give end.
				"properties": orderedProps{
					{"kind", map[string]any{"type": "string", "enum": []string{
						"create_block", "update_block", "delete_block", "add_item", "update_item", "delete_item",
					}}},
					{"block", map[string]any{"type": "string"}},
					{"item", map[string]any{"type": "string"}},
					{"date", map[string]any{"type": "string"}},
					{"start", map[string]any{"type": "string"}},
					{"end", map[string]any{"type": "string"}},
					{"title", map[string]any{"type": "string"}},
					{"done", map[string]any{"type": "boolean"}},
					{"estimateMinutes", map[string]any{"type": "integer"}},
					{"status", map[string]any{"type": "string", "enum": []string{"open", "done", "dropped"}}},
				},
				"required":             []string{"kind"},
				"additionalProperties": false,
			},
		}},
		{"reply", map[string]any{"type": "string"}},
		{"clarification", map[string]any{"type": "string"}},
	},
	"required":             []string{"ops", "reply", "clarification"},
	"additionalProperties": false,
}

// orderedProps are a schema's properties in the order given; a map would be
// marshalled with its keys sorted.
type orderedProps []struct {
	name   string
	schema any
}

func (p orderedProps) MarshalJSON() ([]byte, error) {
	b := []byte{'{'}
	for i, prop := range p {
		if i > 0 {
			b = append(b, ',')
		}
		k, _ := json.Marshal(prop.name)
		v, err := json.Marshal(prop.schema)
		if err != nil {
			return nil, err
		}
		b = append(append(append(b, k...), ':'), v...)
	}
	return append(b, '}'), nil
}

func assistantPrompt(req AssistantRequest) string {
	var b strings.Builder
	fmt.Fprintf(&b, "Now: %s\nToday: %s\nLooking at: %s\n\n<schedule>\n", req.Now, req.Today, req.ViewDate)
	for _, d := range req.Days {
		fmt.Fprintf(&b, "[%s %s]\n", d.Date, d.Weekday)
		if len(d.Blocks) == 0 {
			b.WriteString("  (no blocks)\n")
		}
		for _, bl := range d.Blocks {
			done := ""
			if bl.Done {
				done = " (done)"
			}
			fmt.Fprintf(&b, "  %s %s-%s %s%s\n", bl.Ref, bl.Start, bl.End, bl.Title, done)
		}
		for _, it := range d.Items {
			est := "estimate unknown"
			if it.EstimateMinutes > 0 {
				est = fmt.Sprintf("estimate %d min", it.EstimateMinutes)
			}
			fmt.Fprintf(&b, "  brain dump %s: %s (%s, %s)\n", it.Ref, it.Title, est, it.Status)
		}
	}
	b.WriteString("</schedule>\n")
	if len(req.History) > 0 {
		b.WriteString("\n<conversation>\n")
		for _, t := range req.History {
			fmt.Fprintf(&b, "%s: %s\n", t.Role, t.Text)
		}
		b.WriteString("</conversation>\n")
	}
	fmt.Fprintf(&b, "\nRequest: %s", req.Message)
	return b.String()
}
