package ai

import (
	"net/http"
	"os"
	"time"

	"github.com/anthropics/anthropic-sdk-go"
	"github.com/anthropics/anthropic-sdk-go/option"
)

// AnthropicModels are the models an account can pick for its own API key.
var AnthropicModels = []string{"claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"}

// ForAnthropicKey is a provider on an account's own Anthropic API key. Tidying
// dictation always uses Haiku, which is quick and cheap.
func ForAnthropicKey(key, model string, timeout time.Duration) Provider {
	opts := []option.RequestOption{option.WithAPIKey(key), option.WithRequestTimeout(timeout)}
	if base := os.Getenv("AI_ANTHROPIC_BASE_URL"); base != "" { // tests point this at a fake
		opts = append(opts, option.WithBaseURL(base))
	}
	client := anthropic.NewClient(opts...)
	return claudeProvider{c: &apiCaller{client: client, model: model}, fast: &apiCaller{client: client, model: "claude-haiku-5-5"}}
}

// ForOpenAICompatible is a provider on an OpenAI-compatible server (a local LLM),
// reached through client, which guards which addresses may be dialed.
func ForOpenAICompatible(baseURL, apiKey, model string, client *http.Client) Provider {
	c := &openAICaller{BaseURL: baseURL, APIKey: apiKey, Model: model, HTTP: client}
	return claudeProvider{c: c, fast: c}
}
