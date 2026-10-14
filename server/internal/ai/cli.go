package ai

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"
)

// cliCaller runs Claude Code in print mode (`claude -p`), which uses the
// signed-in Claude subscription (CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`).
type cliCaller struct {
	Bin     string
	Model   string
	Timeout time.Duration
}

// cliResult is the subset of `claude -p --output-format json` output we use.
type cliResult struct {
	IsError          bool            `json:"is_error"`
	Subtype          string          `json:"subtype"`
	Result           string          `json:"result"`
	StructuredOutput json.RawMessage `json:"structured_output"`
}

func (c *cliCaller) call(ctx context.Context, system, prompt string, schema map[string]any, out any) error {
	if _, err := exec.LookPath(c.Bin); err != nil {
		return fmt.Errorf("%w: %s not found", ErrNotConfigured, c.Bin)
	}
	schemaJSON, err := json.Marshal(schema)
	if err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(ctx, c.Timeout)
	defer cancel()

	// Run in an empty directory with no tools, settings, MCP servers, or saved
	// session, so the call is a single, self-contained completion.
	dir, err := os.MkdirTemp("", "box-scheduler-ai-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)

	cmd := exec.CommandContext(ctx, c.Bin,
		"-p", prompt,
		"--output-format", "json",
		"--json-schema", string(schemaJSON),
		"--system-prompt", system,
		"--model", c.Model,
		"--tools", "",
		"--setting-sources", "",
		"--strict-mcp-config",
		"--no-session-persistence",
	)
	cmd.Dir = dir
	cmd.Env = subscriptionEnv()
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr

	runErr := cmd.Run()
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return fmt.Errorf("claude timed out after %s", c.Timeout)
	}

	// Claude Code prints its JSON result even when it exits non-zero, and the
	// result text is the most useful explanation.
	var res cliResult
	if err := json.Unmarshal(stdout.Bytes(), &res); err != nil {
		if runErr != nil {
			return fmt.Errorf("claude failed: %v: %s", runErr, firstLine(stderr.String()))
		}
		return fmt.Errorf("unexpected claude output: %s", firstLine(stdout.String()))
	}
	if res.IsError && strings.Contains(res.Result, "Not logged in") {
		return fmt.Errorf("%w: %s", ErrNotConfigured, res.Result)
	}
	if runErr != nil || res.IsError || len(res.StructuredOutput) == 0 || string(res.StructuredOutput) == "null" {
		return fmt.Errorf("claude returned no structured output (%s): %s", res.Subtype, firstLine(res.Result))
	}
	if err := json.Unmarshal(res.StructuredOutput, out); err != nil {
		return fmt.Errorf("output did not match schema: %w", err)
	}
	return nil
}

// subscriptionEnv drops ANTHROPIC_API_KEY: in print mode Claude Code prefers an
// API key over the subscription token, which would bill the call per use.
func subscriptionEnv() []string {
	env := []string{}
	for _, kv := range os.Environ() {
		if !strings.HasPrefix(kv, "ANTHROPIC_API_KEY=") {
			env = append(env, kv)
		}
	}
	return env
}

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[:i]
	}
	if len(s) > 300 {
		s = s[:300]
	}
	return s
}
