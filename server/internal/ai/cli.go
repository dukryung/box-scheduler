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

// CLIPlanner runs Claude Code in print mode (`claude -p`), which uses the
// signed-in Claude subscription (CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`).
type CLIPlanner struct {
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

func (p *CLIPlanner) Plan(ctx context.Context, req PlanRequest) (Plan, error) {
	if _, err := exec.LookPath(p.Bin); err != nil {
		return Plan{}, fmt.Errorf("%w: %s not found", ErrNotConfigured, p.Bin)
	}

	ctx, cancel := context.WithTimeout(ctx, p.Timeout)
	defer cancel()

	// Run in an empty directory with no tools, settings, MCP servers, or saved
	// session, so the call is a single, self-contained completion.
	dir, err := os.MkdirTemp("", "box-scheduler-ai-")
	if err != nil {
		return Plan{}, err
	}
	defer os.RemoveAll(dir)

	cmd := exec.CommandContext(ctx, p.Bin,
		"-p", userPrompt(req),
		"--output-format", "json",
		"--json-schema", schemaJSON(),
		"--system-prompt", systemPrompt,
		"--model", p.Model,
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
		return Plan{}, fmt.Errorf("claude timed out after %s", p.Timeout)
	}

	// Claude Code prints its JSON result even when it exits non-zero, and the
	// result text is the most useful explanation.
	var res cliResult
	if err := json.Unmarshal(stdout.Bytes(), &res); err != nil {
		if runErr != nil {
			return Plan{}, fmt.Errorf("claude failed: %v: %s", runErr, firstLine(stderr.String()))
		}
		return Plan{}, fmt.Errorf("unexpected claude output: %s", firstLine(stdout.String()))
	}
	if res.IsError && strings.Contains(res.Result, "Not logged in") {
		return Plan{}, fmt.Errorf("%w: %s", ErrNotConfigured, res.Result)
	}
	if runErr != nil || res.IsError || len(res.StructuredOutput) == 0 || string(res.StructuredOutput) == "null" {
		return Plan{}, fmt.Errorf("claude returned no plan (%s): %s", res.Subtype, firstLine(res.Result))
	}

	var plan Plan
	if err := json.Unmarshal(res.StructuredOutput, &plan); err != nil {
		return Plan{}, fmt.Errorf("plan did not match schema: %w", err)
	}
	return plan, nil
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
