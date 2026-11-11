package engine

import (
	"context"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ridhomujizat/bot-engine/internal/botfs"
	"github.com/ridhomujizat/bot-engine/internal/lock"
	"github.com/ridhomujizat/bot-engine/internal/state"
	"github.com/ridhomujizat/bot-engine/internal/usercode"
)

// fixtureRoot is testdata/bots relative to this package.
const fixtureRoot = "../../testdata/bots"

// copyBot copies testdata/bots/<id> into a temp dir laid out as BPFS paths
// (data/bots/<id>/...), so botfs.Disk can serve it.
func copyBot(t *testing.T, id string) *botfs.Disk {
	t.Helper()
	root := t.TempDir()
	src := filepath.Join(fixtureRoot, id)
	dst := filepath.Join(root, "data", "bots", id)
	err := filepath.WalkDir(src, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(src, p)
		target := filepath.Join(dst, rel)
		if d.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		return os.WriteFile(target, b, 0o644)
	})
	if err != nil {
		t.Fatalf("copy fixture %s: %v", id, err)
	}
	return botfs.NewDisk(root)
}

type testEnv struct {
	eng   *Engine
	sess  *state.MemorySessions
	clock *time.Time
}

func newTestEnv(t *testing.T, store botfs.Store) *testEnv {
	t.Helper()
	clock := time.Date(2026, 11, 11, 10, 0, 0, 0, time.UTC)
	sessions := state.NewMemorySessions()
	sessions.Now = func() time.Time { return clock }
	mgr := &state.Manager{
		Sessions: sessions,
		Users:    state.NewMemoryUsers(),
		KVS:      state.NewMemoryKVS(),
		Now:      func() time.Time { return clock },
	}
	eng := New(Deps{
		Store:    store,
		Locker:   lock.NewMemory(),
		UserCode: usercode.New(usercode.Options{Console: io.Discard}),
		State:    mgr,
		Sessions: sessions,
		KVS:      mgr.KVS,
		Global: GlobalDialogConfig{
			TimeoutInterval:        "25m",
			SessionTimeoutInterval: "30m",
			JanitorInterval:        "10s",
			ConverseTimeout:        "5s",
			MaxMessageLength:       360,
		},
		Now:        func() time.Time { return clock },
		BotRecheck: time.Second,
	})
	return &testEnv{eng: eng, sess: sessions, clock: &clock}
}

func (env *testEnv) converse(t *testing.T, botID, user string, body map[string]any, include ...string) map[string]any {
	t.Helper()
	out, err := env.eng.Converse(context.Background(), botID, user, body, include)
	if err != nil {
		t.Fatalf("Converse(%v): %v", body, err)
	}
	return out
}

func text(s string) map[string]any { return map[string]any{"type": "text", "text": s} }

func responseTexts(t *testing.T, out map[string]any) []string {
	t.Helper()
	list, _ := out["responses"].([]any)
	var res []string
	for _, item := range list {
		m, _ := item.(map[string]any)
		s, _ := m["text"].(string)
		res = append(res, s)
	}
	return res
}

func sameStrings(t *testing.T, got, want []string) {
	t.Helper()
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("responses = %q, want %q", got, want)
	}
}

func stateOfResp(t *testing.T, out map[string]any) map[string]any {
	t.Helper()
	st, ok := out["state"].(map[string]any)
	if !ok {
		t.Fatalf("state missing from response: %v", out)
	}
	return st
}

func contextOfState(st map[string]any) map[string]any {
	c, _ := st["context"].(map[string]any)
	return c
}

func TestConverseSayWaitAndEcho(t *testing.T) {
	env := newTestEnv(t, copyBot(t, "synthetic-core"))

	out := env.converse(t, "synthetic-core", "u1", text("hi"), "state", "decision", "suggestions", "nlu")
	sameStrings(t, responseTexts(t, out), []string{"Hello, say something"})
	c := contextOfState(stateOfResp(t, out))
	if c["currentFlow"] != "main.flow.json" || c["currentNode"] != "entry" {
		t.Fatalf("context = %v", c)
	}
	for _, k := range []string{"state", "decision", "suggestions", "nlu"} {
		if _, ok := out[k]; !ok {
			t.Fatalf("include %s missing", k)
		}
	}

	out = env.converse(t, "synthetic-core", "u1", text("echo me"), "state")
	sameStrings(t, responseTexts(t, out), []string{"Echo echo me"})
	if n := contextOfState(stateOfResp(t, out))["currentNode"]; n != "echo" {
		t.Fatalf("currentNode = %v, want echo", n)
	}
}

func TestConverseIncludeFilterDefaultsToResponses(t *testing.T) {
	env := newTestEnv(t, copyBot(t, "synthetic-core"))
	out := env.converse(t, "synthetic-core", "u2", text("hi"))
	if len(out) != 1 {
		t.Fatalf("keys = %v, want only responses", keysOf(out))
	}
	if _, ok := out["responses"]; !ok {
		t.Fatalf("responses missing")
	}
}

func keysOf(m map[string]any) []string {
	var ks []string
	for k := range m {
		ks = append(ks, k)
	}
	return ks
}

func TestConverseValidation(t *testing.T) {
	env := newTestEnv(t, copyBot(t, "synthetic-core"))
	cases := []map[string]any{
		{"type": "text", "text": ""},
		{"type": "text"},
		{"type": "text", "text": strings.Repeat("a", 51)}, // converse.maxMessageLength 50 in bot.config.json
	}
	for _, body := range cases {
		_, err := env.eng.Converse(context.Background(), "synthetic-core", "u3", body, nil)
		e, ok := err.(*Error)
		if !ok || e.Status != http.StatusBadRequest || e.Message != "Text must be a valid string of less than 50 chars" {
			t.Fatalf("body %v: err = %#v", body, err)
		}
	}
	// Non-text types are not validated (secured route).
	env.converse(t, "synthetic-core", "u3", map[string]any{"type": "postback", "payload": map[string]any{}})
}

func TestConverseUnknownBot(t *testing.T) {
	env := newTestEnv(t, copyBot(t, "synthetic-core"))
	_, err := env.eng.Converse(context.Background(), "no-such-bot", "u1", text("hi"), nil)
	if e, ok := err.(*Error); !ok || e.Status != http.StatusNotFound {
		t.Fatalf("err = %#v, want 404", err)
	}
}

func TestSubflowReturnAndDialogEnd(t *testing.T) {
	env := newTestEnv(t, copyBot(t, "synthetic-core"))
	env.converse(t, "synthetic-core", "u4", text("hi"))

	out := env.converse(t, "synthetic-core", "u4", text("sub"), "state")
	sameStrings(t, responseTexts(t, out), []string{"In subflow"})
	if f := contextOfState(stateOfResp(t, out))["currentFlow"]; f != "skills/sub.flow.json" {
		t.Fatalf("currentFlow = %v, want skills/sub.flow.json", f)
	}

	out = env.converse(t, "synthetic-core", "u4", text("x"), "state")
	sameStrings(t, responseTexts(t, out), []string{"Back in main"})
	if c := contextOfState(stateOfResp(t, out)); len(c) != 0 {
		t.Fatalf("context after dialog end = %v, want empty", c)
	}
}

func TestActionErrorRunsErrorFlow(t *testing.T) {
	env := newTestEnv(t, copyBot(t, "synthetic-core"))
	env.converse(t, "synthetic-core", "u5", text("hi"))
	out := env.converse(t, "synthetic-core", "u5", text("fail"), "state")
	sameStrings(t, responseTexts(t, out), []string{"Something went wrong"})
	if f := contextOfState(stateOfResp(t, out))["currentFlow"]; f != "error.flow.json" {
		t.Fatalf("currentFlow = %v, want error.flow.json", f)
	}
}

func TestEndTransitionClearsContext(t *testing.T) {
	env := newTestEnv(t, copyBot(t, "synthetic-core"))
	env.converse(t, "synthetic-core", "u6", text("hi"))
	out := env.converse(t, "synthetic-core", "u6", text("end"), "state")
	if len(responseTexts(t, out)) != 0 {
		t.Fatalf("responses = %v, want none", responseTexts(t, out))
	}
	if c := contextOfState(stateOfResp(t, out)); len(c) != 0 {
		t.Fatalf("context = %v, want empty", c)
	}
}

// Skipped message types never touch the dialog or the persisted state.
func TestSkippedTypeLeavesStateAlone(t *testing.T) {
	env := newTestEnv(t, copyBot(t, "synthetic-core"))
	env.converse(t, "synthetic-core", "u7", text("hi"))

	out := env.converse(t, "synthetic-core", "u7", map[string]any{"type": "typing"}, "state")
	if len(responseTexts(t, out)) != 0 {
		t.Fatalf("responses = %v, want none", responseTexts(t, out))
	}
	if n := contextOfState(stateOfResp(t, out))["currentNode"]; n != "entry" {
		t.Fatalf("currentNode = %v, want entry (unchanged)", n)
	}
}

// Janitor path: an expired context runs timeout.flow.json and is reset.
func TestJanitorRunsTimeoutFlow(t *testing.T) {
	env := newTestEnv(t, copyBot(t, "synthetic-core"))
	env.converse(t, "synthetic-core", "u8", text("hi"))

	id := state.SessionID("synthetic-core", "api", "u8", "")
	bot, err := env.eng.Bot(context.Background(), "synthetic-core")
	if err != nil {
		t.Fatal(err)
	}
	_ = bot
	env.eng.processSessionTimeout(context.Background(), id)

	sess, err := env.sess.Get(context.Background(), id)
	if err != nil || sess == nil {
		t.Fatalf("session after timeout: %v %v", sess, err)
	}
	if len(sess.Context) != 0 || len(sess.TempData) != 0 {
		t.Fatalf("context after timeout = %v, want reset", sess.Context)
	}
}

func TestBotCacheReloadsOnModifiedChange(t *testing.T) {
	disk := copyBot(t, "synthetic-core")
	env := newTestEnv(t, disk)
	ctx := context.Background()

	first, err := env.eng.Bot(ctx, "synthetic-core")
	if err != nil {
		t.Fatal(err)
	}
	// Within the recheck window the cached pointer is returned.
	again, _ := env.eng.Bot(ctx, "synthetic-core")
	if first != again {
		t.Fatalf("bot reloaded inside throttle window")
	}

	// Edit a content element and advance the clock past the throttle window.
	path := filepath.Join(disk.Root, "data", "bots", "synthetic-core", "content-elements", "builtin_text.json")
	b, _ := os.ReadFile(path)
	if err := os.WriteFile(path, []byte(strings.Replace(string(b), "Something went wrong", "Changed", 1)), 0o644); err != nil {
		t.Fatal(err)
	}
	later := time.Now().Add(time.Hour)
	_ = os.Chtimes(path, later, later)
	*env.clock = env.clock.Add(time.Minute)

	reloaded, err := env.eng.Bot(ctx, "synthetic-core")
	if err != nil {
		t.Fatal(err)
	}
	if reloaded == first {
		t.Fatalf("bot not reloaded after modified_on changed")
	}
	if got := reloaded.ContentElements["builtin_text-error"].FormData["text$en"]; got != "Changed" {
		t.Fatalf("content after reload = %v, want Changed", got)
	}
}
