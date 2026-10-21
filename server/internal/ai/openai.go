package ai

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// openAICaller talks to an OpenAI-compatible chat endpoint, which is what local
// model servers offer (Ollama at :11434/v1, LM Studio at :1234/v1). Output is
// constrained with a JSON schema; servers that do not support that get the
// schema in the prompt and JSON mode instead.
type openAICaller struct {
	BaseURL string // ends without /v1; it is added
	APIKey  string
	Model   string
	HTTP    *http.Client
}

func (c *openAICaller) endpoint(path string) string {
	base := strings.TrimRight(c.BaseURL, "/")
	if !strings.HasSuffix(base, "/v1") {
		base += "/v1"
	}
	return base + path
}

func (c *openAICaller) post(ctx context.Context, path string, body any) ([]byte, int, error) {
	buf, err := json.Marshal(body)
	if err != nil {
		return nil, 0, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint(path), bytes.NewReader(buf))
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	if c.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+c.APIKey)
	}
	res, err := c.HTTP.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, 4<<20))
	return data, res.StatusCode, err
}

type chatResponse struct {
	Choices []struct {
		Message struct {
			Content string `json:"content"`
		} `json:"message"`
		FinishReason string `json:"finish_reason"`
	} `json:"choices"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error"`
}

func (c *openAICaller) call(ctx context.Context, system, prompt string, schema map[string]any, out any) error {
	messages := []map[string]string{{"role": "system", "content": system}, {"role": "user", "content": prompt}}
	body := map[string]any{
		"model":       c.Model,
		"messages":    messages,
		"temperature": 0.2,
		"stream":      false,
		// Reasoning models (Qwen3 and others) think at length by default, which on a
		// small machine costs minutes; these answers are short and structured.
		// Ollama honours this on its OpenAI endpoint ("/no_think" and "think" are ignored there).
		"reasoning_effort": "none",
		"response_format": map[string]any{
			"type":        "json_schema",
			"json_schema": map[string]any{"name": "answer", "strict": false, "schema": schema},
		},
	}
	data, status, err := c.post(ctx, "/chat/completions", body)
	if err == nil && status == http.StatusBadRequest {
		// Servers that do not know these options: no reasoning setting, plain JSON
		// mode, and the schema described in the prompt instead.
		delete(body, "reasoning_effort")
		schemaJSON, _ := json.Marshal(schema)
		messages[0]["content"] = system + "\n\nAnswer with one JSON object only, matching this JSON schema:\n" + string(schemaJSON)
		body["response_format"] = map[string]any{"type": "json_object"}
		data, status, err = c.post(ctx, "/chat/completions", body)
	}
	if err != nil {
		return fmt.Errorf("local model: %w", err)
	}
	var res chatResponse
	if jerr := json.Unmarshal(data, &res); jerr != nil || status != http.StatusOK {
		msg := strings.TrimSpace(string(data))
		if res.Error != nil {
			msg = res.Error.Message
		}
		if len(msg) > 200 {
			msg = msg[:200]
		}
		return fmt.Errorf("local model answered %d: %s", status, msg)
	}
	if len(res.Choices) == 0 {
		return errors.New("local model gave no answer")
	}
	if res.Choices[0].FinishReason == "length" {
		return errors.New("local model's answer was cut off")
	}
	content := strings.TrimSpace(res.Choices[0].Message.Content)
	if i := strings.LastIndex(content, "</think>"); i >= 0 { // reasoning models may still think first
		content = strings.TrimSpace(content[i+len("</think>"):])
	}
	content = strings.TrimSuffix(strings.TrimPrefix(strings.TrimPrefix(content, "```json"), "```"), "```")
	if err := json.Unmarshal([]byte(strings.TrimSpace(content)), out); err != nil {
		return fmt.Errorf("local model's answer did not match the format: %w", err)
	}
	return nil
}

// ListModels asks an OpenAI-compatible server which models it serves.
func ListModels(ctx context.Context, client *http.Client, baseURL, apiKey string) ([]string, error) {
	c := &openAICaller{BaseURL: baseURL, APIKey: apiKey, HTTP: client}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.endpoint("/models"), nil)
	if err != nil {
		return nil, err
	}
	if apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+apiKey)
	}
	res, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	var body struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&body); err != nil || res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("모델 목록을 받지 못했어요 (%d)", res.StatusCode)
	}
	ids := make([]string, 0, len(body.Data))
	for _, m := range body.Data {
		ids = append(ids, m.ID)
	}
	return ids, nil
}
