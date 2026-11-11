package usercode

import (
	"context"
	"strings"
	"testing"
)

// nopHost is a Host that ignores everything except log calls.
type nopHost struct{ logs []string }

func (h *nopHost) LogInfo(botID string, args ...any)  { h.logs = append(h.logs, "info") }
func (h *nopHost) LogError(botID string, args ...any) { h.logs = append(h.logs, "error") }
func (h *nopHost) LogWarn(botID string, args ...any)  { h.logs = append(h.logs, "warn") }
func (h *nopHost) RenderElement(ctx context.Context, botID, id string, args, event map[string]any) ([]map[string]any, error) {
	return nil, nil
}
func (h *nopHost) ReplyToEvent(ctx context.Context, event map[string]any, payloads []map[string]any) error {
	return nil
}
func (h *nopHost) InsertAndRetrieve(ctx context.Context, botID, table string, data map[string]any, cols []string, idc string) (map[string]any, error) {
	return data, nil
}

// testWriter sends console output of bot code to the test log.
type testWriter struct{ t *testing.T }

func (w testWriter) Write(p []byte) (int, error) {
	w.t.Logf("console: %s", strings.TrimRight(string(p), "\n"))
	return len(p), nil
}

// runCode runs an action with the given state and returns the result and the
// written-back sandbox.
func runCode(t *testing.T, code string, state map[string]any) (any, *Sandbox, error) {
	t.Helper()
	r := New(Options{Console: testWriter{t}})
	sb := &Sandbox{BotID: "bot", Event: map[string]any{"state": state}}
	res, err := r.RunAction(context.Background(), "t", code, sb, &nopHost{})
	return res, sb, err
}
