package ai

import (
	"context"
	"strings"
)

// Tidier rewrites a raw speech transcript into the request the person meant, so
// they can check it in the field before sending it themselves.
type Tidier interface {
	Tidy(ctx context.Context, transcript string) (string, error)
}

const tidySystemPrompt = `A person dictated a request to their timeboxing app, usually in Korean. You get the raw speech transcript. Rewrite it as the request they meant, the way they would type it: short, plain Korean.
- Keep every concrete detail: task names, dates and weekdays, times, lengths, order, and which task they mean.
- When they corrected themselves ("3시, 아니 4시"), keep only the correction.
- Drop fillers, hesitations, repetition and padding ("음", "어", "그 뭐지", "좀", "있잖아").
- Write clock times as HH:MM in 24-hour form when the hour is clear ("오후 3시" → 15:00); keep relative words like 오늘, 내일, 다음 주 금요일 as they are.
- Several requests: join them with ", ".
- Do not answer the request, do not add or guess details, and do not change what they asked. If it is already clear, return it almost unchanged.
Return only the rewritten request in text.`

var tidySchema = map[string]any{
	"type":                 "object",
	"properties":           map[string]any{"text": map[string]any{"type": "string"}},
	"required":             []string{"text"},
	"additionalProperties": false,
}

func (p claudeProvider) Tidy(ctx context.Context, transcript string) (string, error) {
	c := p.fast
	if c == nil {
		c = p.c
	}
	var out struct {
		Text string `json:"text"`
	}
	if err := c.call(ctx, tidySystemPrompt, transcript, tidySchema, &out); err != nil {
		return "", err
	}
	return strings.TrimSpace(out.Text), nil
}

func (disabled) Tidy(context.Context, string) (string, error) { return "", ErrNotConfigured }

// fakeFillers are dropped by the fake tidier, so tests can tell the field was rewritten.
var fakeFillers = map[string]bool{"음": true, "어": true, "그": true, "좀": true, "있잖아": true}

// Tidy (fake) drops filler words and prefixes nothing else, deterministically.
func (Fake) Tidy(_ context.Context, transcript string) (string, error) {
	var kept []string
	for _, w := range strings.Fields(transcript) {
		if !fakeFillers[strings.Trim(w, ",.")] {
			kept = append(kept, w)
		}
	}
	return strings.Join(kept, " "), nil
}
