package ai

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/anthropics/anthropic-sdk-go"
	"github.com/anthropics/anthropic-sdk-go/option"
	"github.com/anthropics/anthropic-sdk-go/shared/constant"
)

// APIPlanner calls the Messages API with ANTHROPIC_API_KEY (billed per use).
type APIPlanner struct {
	client anthropic.Client
	model  string
}

func NewAPIPlanner(model string, timeout time.Duration) *APIPlanner {
	return &APIPlanner{
		client: anthropic.NewClient(option.WithRequestTimeout(timeout)),
		model:  model,
	}
}

func (p *APIPlanner) Plan(ctx context.Context, req PlanRequest) (Plan, error) {
	msg, err := p.client.Beta.Messages.New(ctx, anthropic.BetaMessageNewParams{
		Model:     anthropic.Model(p.model),
		MaxTokens: 16000,
		System:    []anthropic.BetaTextBlockParam{{Text: systemPrompt}},
		Messages: []anthropic.BetaMessageParam{
			anthropic.NewBetaUserMessage(anthropic.NewBetaTextBlock(userPrompt(req))),
		},
		OutputConfig: anthropic.BetaOutputConfigParam{
			Format: anthropic.BetaJSONOutputFormatParam{Schema: planSchema},
		},
		// If a safety classifier declines, let the API retry on a fallback model.
		Betas:     []anthropic.AnthropicBeta{anthropic.AnthropicBetaServerSideFallback2026_07_01},
		Fallbacks: anthropic.BetaFallbacksParamUnion{OfDefault: constant.ValueOf[constant.Default]()},
	})
	if err != nil {
		return Plan{}, fmt.Errorf("messages API: %w", err)
	}
	if msg.StopReason == anthropic.BetaStopReasonRefusal {
		return Plan{}, fmt.Errorf("Claude declined to plan this day")
	}
	if msg.StopReason == anthropic.BetaStopReasonMaxTokens {
		return Plan{}, fmt.Errorf("plan was cut off (max tokens)")
	}

	for _, block := range msg.Content {
		if text, ok := block.AsAny().(anthropic.BetaTextBlock); ok {
			var plan Plan
			if err := json.Unmarshal([]byte(text.Text), &plan); err != nil {
				return Plan{}, fmt.Errorf("plan did not match schema: %w", err)
			}
			return plan, nil
		}
	}
	return Plan{}, fmt.Errorf("no plan in response")
}
