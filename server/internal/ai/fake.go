package ai

import (
	"context"
	"fmt"
	"strings"
)

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

// Fake assistant understands a tiny command language so tests are deterministic.
// Clauses are separated by ", ":
//
//	<title> HH:MM로 옮겨     move the first block whose title contains <title>
//	<title> HH:MM-HH:MM 추가  create a block on the viewed day
//	<title> 삭제              delete a block
//	<title> 완료              mark a block done
//
// Anything else gets a clarifying question.
func (Fake) Interpret(_ context.Context, req AssistantRequest) (AssistantReply, error) {
	var blocks []ContextBlock
	for _, d := range req.Days {
		if d.Date == req.ViewDate {
			blocks = d.Blocks
		}
	}
	find := func(title string) string {
		for _, b := range blocks {
			if strings.Contains(b.Title, title) {
				return b.Ref
			}
		}
		return ""
	}

	reply := AssistantReply{Ops: []RawOp{}}
	for _, clause := range strings.Split(req.Message, ", ") {
		f := strings.Fields(clause)
		if len(f) < 2 {
			return AssistantReply{Ops: []RawOp{}, Clarification: "무엇을 바꿀까요?"}, nil
		}
		verb, title := f[len(f)-1], strings.Join(f[:len(f)-1], " ")
		switch {
		case verb == "삭제" && find(title) != "":
			reply.Ops = append(reply.Ops, RawOp{Kind: "delete_block", Block: find(title)})
		case verb == "완료" && find(title) != "":
			done := true
			reply.Ops = append(reply.Ops, RawOp{Kind: "update_block", Block: find(title), Done: &done})
		case verb == "옮겨" && len(f) >= 3:
			at := strings.TrimSuffix(f[len(f)-2], "로")
			name := strings.Join(f[:len(f)-2], " ")
			if find(name) == "" {
				return AssistantReply{Ops: []RawOp{}, Clarification: fmt.Sprintf("'%s' 블록을 찾지 못했어요. 어떤 일정인가요?", name)}, nil
			}
			reply.Ops = append(reply.Ops, RawOp{Kind: "update_block", Block: find(name), Start: at})
		case verb == "추가" && len(f) >= 3 && strings.Contains(f[len(f)-2], "-"):
			span := strings.SplitN(f[len(f)-2], "-", 2)
			reply.Ops = append(reply.Ops, RawOp{Kind: "create_block", Date: req.ViewDate, Start: span[0], End: span[1], Title: strings.Join(f[:len(f)-2], " ")})
		default:
			return AssistantReply{Ops: []RawOp{}, Clarification: "무엇을 바꿀까요?"}, nil
		}
	}
	reply.Reply = fmt.Sprintf("%d개를 바꿀게요.", len(reply.Ops))
	return reply, nil
}
