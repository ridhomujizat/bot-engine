package state

import (
	"context"
	"reflect"
	"testing"
	"time"

	"github.com/ridhomujizat/bot-engine/internal/model"
)

var fixedNow = time.Date(2026, 11, 11, 10, 0, 0, 0, time.UTC)

func clock(t time.Time) func() time.Time { return func() time.Time { return t } }

func newMemoryManager(now time.Time) (*Manager, *MemoryKVS) {
	kvs := NewMemoryKVS()
	kvs.Now = clock(now)
	sess := NewMemorySessions()
	sess.Now = clock(now)
	return &Manager{Sessions: sess, Users: NewMemoryUsers(), KVS: kvs, Now: clock(now)}, kvs
}

func newEvent(botID, channel, target string) map[string]any {
	return map[string]any{"botId": botID, "channel": channel, "target": target}
}

// suite runs the behavioural checks against any store implementation.
func suite(t *testing.T, m *Manager) {
	t.Helper()
	ctx := context.Background()
	cfg := Config{TimeoutInterval: 5 * time.Minute, SessionTimeoutInterval: 30 * time.Minute}

	t.Run("restore new user gives defaults", func(t *testing.T) {
		ev := newEvent("bot1", "web", "u-new")
		if err := m.Restore(ctx, ev, cfg); err != nil {
			t.Fatal(err)
		}
		st := ev["state"].(map[string]any)
		if !reflect.DeepEqual(st["user"], map[string]any{}) {
			t.Errorf("user = %#v", st["user"])
		}
		if !reflect.DeepEqual(st["context"], map[string]any{}) {
			t.Errorf("context = %#v", st["context"])
		}
		if !reflect.DeepEqual(st["temp"], map[string]any{}) {
			t.Errorf("temp = %#v", st["temp"])
		}
		// legacy defaults: session.slots is always present; state.bot is absent (not null) without a bot KVS entry.
		want := map[string]any{"lastMessages": []any{}, "workflows": map[string]any{}, "slots": map[string]any{}}
		if !reflect.DeepEqual(st["session"], want) {
			t.Errorf("session = %#v", st["session"])
		}
		if _, ok := st["bot"]; ok {
			t.Errorf("bot present (%#v), want absent like legacy", st["bot"])
		}
		if !reflect.DeepEqual(st["__stacktrace"], []any{}) {
			t.Errorf("__stacktrace = %#v", st["__stacktrace"])
		}
	})

	t.Run("persist then restore round-trips state", func(t *testing.T) {
		ev := newEvent("bot1", "WEB", "u-rt")
		if err := m.Restore(ctx, ev, cfg); err != nil {
			t.Fatal(err)
		}
		st := ev["state"].(map[string]any)
		st["user"] = map[string]any{"nickname": "Budi", "language": nil, "n": float64(3)}
		st["temp"] = map[string]any{"tmp": "x"}
		st["context"] = map[string]any{"flow": "main.flow.json", "node": "entry"}
		sess := st["session"].(map[string]any)
		var msgs []any
		for i := 0; i < 7; i++ {
			msgs = append(msgs, float64(i))
		}
		sess["lastMessages"] = msgs
		sess["currentWorkflow"] = "wf"
		if err := m.Persist(ctx, ev, false, cfg); err != nil {
			t.Fatal(err)
		}

		ev2 := newEvent("bot1", "WEB", "u-rt") // session id uses the raw channel, user lookup lower-cases it
		if err := m.Restore(ctx, ev2, cfg); err != nil {
			t.Fatal(err)
		}
		st2 := ev2["state"].(map[string]any)
		wantUser := map[string]any{"nickname": "Budi", "n": float64(3)}
		if !reflect.DeepEqual(st2["user"], wantUser) {
			t.Errorf("user = %#v, want %#v", st2["user"], wantUser)
		}
		if !reflect.DeepEqual(st2["temp"], map[string]any{"tmp": "x"}) {
			t.Errorf("temp = %#v", st2["temp"])
		}
		if !reflect.DeepEqual(st2["context"], map[string]any{"flow": "main.flow.json", "node": "entry"}) {
			t.Errorf("context = %#v", st2["context"])
		}
		s2 := st2["session"].(map[string]any)
		if got := s2["lastMessages"].([]any); len(got) != 5 || got[0] != float64(2) || got[4] != float64(6) {
			t.Errorf("lastMessages = %#v, want last 5 (2..6)", got)
		}
		if s2["currentWorkflow"] != "wf" {
			t.Errorf("currentWorkflow = %#v", s2["currentWorkflow"])
		}
	})

	t.Run("ignoreContext keeps stored context and temp", func(t *testing.T) {
		ev := newEvent("bot1", "web", "u-ign")
		_ = m.Restore(ctx, ev, cfg)
		st := ev["state"].(map[string]any)
		st["context"] = map[string]any{"a": "1"}
		st["temp"] = map[string]any{"t": "1"}
		_ = m.Persist(ctx, ev, false, cfg)

		ev2 := newEvent("bot1", "web", "u-ign")
		_ = m.Restore(ctx, ev2, cfg)
		st2 := ev2["state"].(map[string]any)
		st2["context"] = map[string]any{}
		st2["temp"] = map[string]any{}
		if err := m.Persist(ctx, ev2, true, cfg); err != nil {
			t.Fatal(err)
		}

		ev3 := newEvent("bot1", "web", "u-ign")
		_ = m.Restore(ctx, ev3, cfg)
		st3 := ev3["state"].(map[string]any)
		if !reflect.DeepEqual(st3["context"], map[string]any{"a": "1"}) {
			t.Errorf("context overwritten: %#v", st3["context"])
		}
		if !reflect.DeepEqual(st3["temp"], map[string]any{"t": "1"}) {
			t.Errorf("temp overwritten: %#v", st3["temp"])
		}
	})

	t.Run("bot state comes from global kvs key", func(t *testing.T) {
		if err := m.KVS.Set(ctx, "bot2", "global", map[string]any{"greeting": "hi"}, 0); err != nil {
			t.Fatal(err)
		}
		ev := newEvent("bot2", "web", "u-bot")
		_ = m.Restore(ctx, ev, cfg)
		if got := ev["state"].(map[string]any)["bot"]; !reflect.DeepEqual(got, map[string]any{"greeting": "hi"}) {
			t.Errorf("bot = %#v", got)
		}
	})

	t.Run("persist with missing user wipes attributes like legacy", func(t *testing.T) {
		ev := newEvent("bot1", "web", "u-wipe")
		_ = m.Restore(ctx, ev, cfg)
		ev["state"].(map[string]any)["user"] = map[string]any{"k": "v"}
		_ = m.Persist(ctx, ev, false, cfg)
		delete(ev["state"].(map[string]any), "user")
		_ = m.Persist(ctx, ev, false, cfg)
		ev2 := newEvent("bot1", "web", "u-wipe")
		_ = m.Restore(ctx, ev2, cfg)
		if got := ev2["state"].(map[string]any)["user"]; !reflect.DeepEqual(got, map[string]any{}) {
			t.Errorf("user = %#v, want {}", got)
		}
	})

	t.Run("threadId is part of session id", func(t *testing.T) {
		ev := newEvent("bot1", "web", "u-thr")
		ev["threadId"] = "t1"
		_ = m.Restore(ctx, ev, cfg)
		ev["state"].(map[string]any)["temp"] = map[string]any{"thread": "yes"}
		_ = m.Persist(ctx, ev, false, cfg)

		plain := newEvent("bot1", "web", "u-thr")
		_ = m.Restore(ctx, plain, cfg)
		if got := plain["state"].(map[string]any)["temp"]; !reflect.DeepEqual(got, map[string]any{}) {
			t.Errorf("thread session leaked into plain session: %#v", got)
		}
	})

	t.Run("delete dialog session resets context on next restore", func(t *testing.T) {
		ev := newEvent("bot1", "web", "u-del")
		_ = m.Restore(ctx, ev, cfg)
		ev["state"].(map[string]any)["context"] = map[string]any{"x": "y"}
		_ = m.Persist(ctx, ev, false, cfg)
		if err := m.DeleteDialogSession(ctx, SessionID("bot1", "web", "u-del", "")); err != nil {
			t.Fatal(err)
		}
		ev2 := newEvent("bot1", "web", "u-del")
		_ = m.Restore(ctx, ev2, cfg)
		if got := ev2["state"].(map[string]any)["context"]; !reflect.DeepEqual(got, map[string]any{}) {
			t.Errorf("context after delete = %#v", got)
		}
	})
}

func TestMemoryStateManager(t *testing.T) {
	m, _ := newMemoryManager(fixedNow)
	suite(t, m)
}

func TestMemoryExpiry(t *testing.T) {
	ctx := context.Background()
	m, _ := newMemoryManager(fixedNow)
	cfg := Config{TimeoutInterval: 5 * time.Minute, SessionTimeoutInterval: 30 * time.Minute}
	ev := newEvent("bot1", "web", "u-exp")
	_ = m.Restore(ctx, ev, cfg)
	ev["state"].(map[string]any)["context"] = map[string]any{"x": "1"}
	if err := m.Persist(ctx, ev, false, cfg); err != nil {
		t.Fatal(err)
	}
	sid := SessionID("bot1", "web", "u-exp", "")
	s, _ := m.Sessions.Get(ctx, sid)
	if s.ContextExpiry == nil || !s.ContextExpiry.Equal(fixedNow.Add(5*time.Minute)) {
		t.Fatalf("context expiry = %v", s.ContextExpiry)
	}
	if s.SessionExpiry == nil || !s.SessionExpiry.Equal(fixedNow.Add(30*time.Minute)) {
		t.Fatalf("session expiry = %v", s.SessionExpiry)
	}

	before := fixedNow.Add(4 * time.Minute)
	if ids, _ := m.Sessions.ExpiredContextIDs(ctx, before); len(ids) != 0 {
		t.Errorf("early ExpiredContextIDs = %v", ids)
	}
	after := fixedNow.Add(6 * time.Minute)
	ids, _ := m.Sessions.ExpiredContextIDs(ctx, after)
	if !reflect.DeepEqual(ids, []string{sid}) {
		t.Errorf("ExpiredContextIDs = %v", ids)
	}
	if err := m.Sessions.DeleteExpired(ctx, fixedNow.Add(31*time.Minute)); err != nil {
		t.Fatal(err)
	}
	if got, _ := m.Sessions.Get(ctx, sid); got != nil {
		t.Errorf("session survived DeleteExpired")
	}
}

func TestMemoryKVSExpiryAndLike(t *testing.T) {
	ctx := context.Background()
	now := fixedNow
	kvs := NewMemoryKVS()
	kvs.Now = func() time.Time { return now }

	if err := kvs.Set(ctx, "b1", "storage/global/tok", "v", time.Minute); err != nil {
		t.Fatal(err)
	}
	if err := kvs.Set(ctx, "b2", "storage/global/tok2", "w", 0); err != nil {
		t.Fatal(err)
	}
	if err := kvs.Set(ctx, "b1", "storage/global/other", "z", 0); err != nil {
		t.Fatal(err)
	}
	if v, ok, _ := kvs.Get(ctx, "b1", "storage/global/tok"); !ok || v != "v" {
		t.Fatalf("get before expiry = %v %v", v, ok)
	}
	now = fixedNow.Add(2 * time.Minute)
	if _, ok, _ := kvs.Get(ctx, "b1", "storage/global/tok"); ok {
		t.Fatalf("expired key still visible")
	}
	// resetGlobalVariable semantics: LIKE 'storage/global/tok%' removes across bots.
	if err := kvs.DeleteKeysLike(ctx, "storage/global/tok%"); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := kvs.Get(ctx, "b2", "storage/global/tok2"); ok {
		t.Errorf("LIKE delete did not remove key of another bot")
	}
	if _, ok, _ := kvs.Get(ctx, "b1", "storage/global/other"); !ok {
		t.Errorf("LIKE delete removed unrelated key")
	}
}

func TestParseMs(t *testing.T) {
	tests := []struct {
		in   string
		want float64
		ok   bool
	}{
		{"5m", 300000, true},
		{"6 hours", 6 * 3600000, true},
		{"1.5h", 5400000, true},
		{"30s", 30000, true},
		{"2 days", 2 * 86400000, true},
		{"100", 100, true},
		{"1w", 7 * 86400000, true},
		{"never", 0, false},
		{"5 parsecs", 0, false},
	}
	for _, tt := range tests {
		got, ok := ParseMs(tt.in)
		if ok != tt.ok || (ok && got != tt.want) {
			t.Errorf("ParseMs(%q) = %v,%v want %v,%v", tt.in, got, ok, tt.want, tt.ok)
		}
	}
}

func TestLikeMatch(t *testing.T) {
	tests := []struct {
		p, s string
		want bool
	}{
		{"abc%", "abcdef", true},
		{"abc%", "ab", false},
		{"a_c", "abc", true},
		{"a_c", "abbc", false},
		{`a\_c`, "a_c", true},
		{`a\_c`, "abc", false},
		{"%", "", true},
	}
	for _, tt := range tests {
		if got := likeMatch(tt.p, tt.s); got != tt.want {
			t.Errorf("likeMatch(%q,%q) = %v", tt.p, tt.s, got)
		}
	}
}

func TestResolveConfig(t *testing.T) {
	global := DefaultConfig()
	got := ResolveConfig(&model.BotConfig{Dialog: &model.DialogConfig{TimeoutInterval: "5m"}}, global)
	if got.TimeoutInterval != 5*time.Minute || got.SessionTimeoutInterval != 30*time.Minute {
		t.Errorf("ResolveConfig = %+v", got)
	}
	if ResolveConfig(nil, global) != global {
		t.Errorf("nil bot config should keep global")
	}
}

func TestSessionID(t *testing.T) {
	if got := SessionID("b", "api", "u", ""); got != "b::api::u" {
		t.Errorf("got %q", got)
	}
	if got := SessionID("b", "api", "u", "t"); got != "b::api::u::t" {
		t.Errorf("got %q", got)
	}
}
