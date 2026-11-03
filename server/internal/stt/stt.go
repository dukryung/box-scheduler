// Package stt talks to the meeting transcription service on the Mac mini
// (stt/server.py): a recording goes up as a job, and the job is polled until
// Whisper has written it down with the speakers told apart.
package stt

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// ErrUnreachable means the service did not answer (the Mac mini is off, or the tunnel is down).
var ErrUnreachable = errors.New("transcription service unreachable")

type Client struct {
	URL  string
	HTTP *http.Client
}

func New(base string) *Client {
	return &Client{URL: strings.TrimRight(base, "/"), HTTP: &http.Client{Timeout: 10 * time.Minute}}
}

type Options struct {
	Language string // "ko"
	Speakers int    // how many people talk, 0 when not known
	Prompt   string // words to spell right, such as the team's names
}

type Segment struct {
	Start   float64 `json:"start"`
	End     float64 `json:"end"`
	Speaker int     `json:"speaker"`
	Text    string  `json:"text"`
}

type Result struct {
	Language string    `json:"language"`
	Speakers int       `json:"speakers"`
	Segments []Segment `json:"segments"`
}

// Job is where a transcription is: queued (Position in line), running (Stage:
// decode, transcribe, diarize), done (Result) or failed (Error).
type Job struct {
	ID       string  `json:"id"`
	Status   string  `json:"status"`
	Stage    string  `json:"stage"`
	Error    string  `json:"error"`
	Position int     `json:"position"`
	Duration float64 `json:"duration"`
	Result   *Result `json:"result"`
}

func (c *Client) do(req *http.Request, out any) error {
	res, err := c.HTTP.Do(req)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrUnreachable, err)
	}
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, 32<<20))
	if err != nil {
		return fmt.Errorf("%w: %v", ErrUnreachable, err)
	}
	if res.StatusCode >= 300 {
		var e struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(body, &e)
		return fmt.Errorf("transcription service: %d %s", res.StatusCode, e.Error)
	}
	return json.Unmarshal(body, out)
}

// Submit sends a recording of size bytes.
func (c *Client) Submit(ctx context.Context, audio io.Reader, size int64, mime string, o Options) (Job, error) {
	q := url.Values{}
	if o.Language != "" {
		q.Set("language", o.Language)
	}
	if o.Speakers > 0 {
		q.Set("speakers", strconv.Itoa(o.Speakers))
	}
	if o.Prompt != "" {
		q.Set("prompt", o.Prompt)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.URL+"/v1/jobs?"+q.Encode(), audio)
	if err != nil {
		return Job{}, err
	}
	req.ContentLength = size
	req.Header.Set("Content-Type", mime)
	var j Job
	return j, c.do(req, &j)
}

func (c *Client) Job(ctx context.Context, id string) (Job, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.URL+"/v1/jobs/"+url.PathEscape(id), nil)
	if err != nil {
		return Job{}, err
	}
	var j Job
	return j, c.do(req, &j)
}

// Cancel drops a job that has not started (one that runs is left to finish).
func (c *Client) Cancel(ctx context.Context, id string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, c.URL+"/v1/jobs/"+url.PathEscape(id), nil)
	if err != nil {
		return err
	}
	var out map[string]any
	return c.do(req, &out)
}

// Wait polls the job until it is done or failed, telling seen about every
// change of status or stage. Brief outages are ridden out.
func (c *Client) Wait(ctx context.Context, id string, every time.Duration, seen func(Job)) (Job, error) {
	last := ""
	misses := 0
	for {
		j, err := c.Job(ctx, id)
		switch {
		case err == nil:
			misses = 0
			if key := j.Status + "/" + j.Stage + "/" + strconv.Itoa(j.Position); key != last {
				last = key
				seen(j)
			}
			if j.Status == "done" || j.Status == "failed" {
				return j, nil
			}
		case errors.Is(err, ErrUnreachable) && misses < 20:
			misses++
		default:
			return j, err
		}
		select {
		case <-ctx.Done():
			return Job{}, ctx.Err()
		case <-time.After(every):
		}
	}
}
