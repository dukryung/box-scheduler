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

// apiCaller calls the Messages API with ANTHROPIC_API_KEY (billed per use).
type apiCaller struct {
	client anthropic.Client
	model  string
}

func newAPICaller(model string, timeout time.Duration) *apiCaller {
	return &apiCaller{
		client: anthropic.NewClient(option.WithRequestTimeout(timeout)),
		model:  model,
	}
}

func (c *apiCaller) call(ctx context.Context, system, prompt string, schema map[string]any, out any) error {
	msg, err := c.client.Beta.Messages.New(ctx, anthropic.BetaMessageNewParams{
		Model:     anthropic.Model(c.model),
		MaxTokens: 16000,
		System:    []anthropic.BetaTextBlockParam{{Text: system}},
		Messages: []anthropic.BetaMessageParam{
			anthropic.NewBetaUserMessage(anthropic.NewBetaTextBlock(prompt)),
		},
		OutputConfig: anthropic.BetaOutputConfigParam{
			Format: anthropic.BetaJSONOutputFormatParam{Schema: schema},
		},
		// If a safety classifier declines, let the API retry on a fallback model.
		Betas:     []anthropic.AnthropicBeta{anthropic.AnthropicBetaServerSideFallback2026_07_01},
		Fallbacks: anthropic.BetaFallbacksParamUnion{OfDefault: constant.ValueOf[constant.Default]()},
	})
	if err != nil {
		return fmt.Errorf("messages API: %w", err)
	}
	if msg.StopReason == anthropic.BetaStopReasonRefusal {
		return fmt.Errorf("Claude declined this request")
	}
	if msg.StopReason == anthropic.BetaStopReasonMaxTokens {
		return fmt.Errorf("response was cut off (max tokens)")
	}

	for _, block := range msg.Content {
		if text, ok := block.AsAny().(anthropic.BetaTextBlock); ok {
			if err := json.Unmarshal([]byte(text.Text), out); err != nil {
				return fmt.Errorf("output did not match schema: %w", err)
			}
			return nil
		}
	}
	return fmt.Errorf("no output in response")
}
