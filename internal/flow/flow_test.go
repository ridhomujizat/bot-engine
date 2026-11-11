package flow

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ridhomujizat/bot-engine/internal/botfs"
)

// dirStore is a test-only botfs.Store backed by a directory laid out as
// {root}/{botID}/...; paths map to data/bots/{botID}/....
type dirStore struct{ root string }

func (d dirStore) full(p string) string {
	return filepath.Join(d.root, strings.TrimPrefix(p, "data/bots/"))
}

func (d dirStore) ReadFile(_ context.Context, p string) ([]byte, error) {
	b, err := os.ReadFile(d.full(p))
	if errors.Is(err, os.ErrNotExist) {
		return nil, botfs.ErrNotFound
	}
	return b, err
}

func (d dirStore) ListFiles(_ context.Context, prefix string) ([]botfs.FileInfo, error) {
	var out []botfs.FileInfo
	base := d.full(prefix)
	err := filepath.Walk(base, func(p string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return err
		}
		rel, _ := filepath.Rel(d.root, p)
		out = append(out, botfs.FileInfo{Path: "data/bots/" + filepath.ToSlash(rel), ModifiedOn: info.ModTime()})
		return nil
	})
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	return out, err
}

func (d dirStore) WriteFile(context.Context, string, []byte) error { return errors.New("read-only") }
func (d dirStore) DeleteFile(context.Context, string) error        { return errors.New("read-only") }
func (d dirStore) LastModified(ctx context.Context, prefix string) (time.Time, error) {
	files, err := d.ListFiles(ctx, prefix)
	var max time.Time
	for _, f := range files {
		if f.ModifiedOn.After(max) {
			max = f.ModifiedOn
		}
	}
	return max, err
}

// writeBot materializes files (relative to the bot dir) into a temp store root.
func writeBot(t *testing.T, files map[string]string) dirStore {
	t.Helper()
	root := t.TempDir()
	for rel, content := range files {
		p := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dirStore{root: root}
}

const minimalConfig = `{"id":"bot","name":"bot","defaultLanguage":"en","languages":["en"]}`

func issuesText(issues []Issue) string {
	var b strings.Builder
	for _, i := range issues {
		b.WriteString(i.File + ": " + i.Message + "\n")
	}
	return b.String()
}

func TestLoadParsesAllKinds(t *testing.T) {
	store := writeBot(t, map[string]string{
		"bot/bot.config.json":                             minimalConfig,
		"bot/flows/main.flow.json":                        `{"startNode":"entry","nodes":[{"name":"entry","onEnter":["say #!builtin_text-a"],"onReceive":[],"next":[{"condition":"true","node":"#"}]}]}`,
		"bot/flows/main.ui.json":                          `{"nodes":[]}`,
		"bot/flows/skills/choice-x.flow.json":             `{"startNode":"s","nodes":[]}`,
		"bot/content-elements/builtin_text.json":          `[{"id":"builtin_text-a","formData":{"text$en":"hi"}}]`,
		"bot/actions/check-stock/search.js":               `return 1`,
		"bot/hooks/before_conversation_end/create_end.js": `// hook`,
		"bot/media/logo.png":                              "binary",
	})
	bot, err := Load(context.Background(), store, "bot")
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := bot.Flows["main.flow.json"]; !ok {
		t.Errorf("main flow missing: %v", keysOf(bot.Flows))
	}
	if _, ok := bot.Flows["skills/choice-x.flow.json"]; !ok {
		t.Errorf("skill flow missing")
	}
	if _, ok := bot.Flows["main.ui.json"]; ok {
		t.Errorf("ui.json must not load as flow")
	}
	if el := bot.ContentElements["builtin_text-a"]; el == nil || el.ContentType != "builtin_text" {
		t.Errorf("content element not loaded with type: %#v", el)
	}
	if _, ok := bot.Actions["check-stock/search"]; !ok {
		t.Errorf("nested action missing: %v", keysOf(bot.Actions))
	}
	hooks := bot.Hooks["before_conversation_end"]
	if len(hooks) != 1 || hooks[0].Name != "create_end" {
		t.Errorf("hooks: %#v", hooks)
	}
	if bot.ModifiedOn.IsZero() {
		t.Errorf("ModifiedOn not set")
	}
	if bot.Flows["main.flow.json"].Nodes[0].OnReceive == nil {
		t.Errorf("empty onReceive must stay non-nil (waits for input)")
	}
}

func TestLoadMissingConfig(t *testing.T) {
	store := writeBot(t, map[string]string{"bot/flows/main.flow.json": `{}`})
	if _, err := Load(context.Background(), store, "bot"); !errors.Is(err, botfs.ErrNotFound) {
		t.Fatalf("want ErrNotFound, got %v", err)
	}
}

func TestValidateCleanBot(t *testing.T) {
	store := writeBot(t, map[string]string{
		"bot/bot.config.json": minimalConfig,
		"bot/flows/main.flow.json": `{"startNode":"a","nodes":[
			{"name":"a","onEnter":["say #!builtin_text-1","builtin/setVariable {\"name\":\"x\"}"],"onReceive":[],"next":[{"condition":"true","node":"b"}]},
			{"name":"b","type":"skill-call","skill":"choice","flow":"skills/choice-1.flow.json","onEnter":[],"next":[{"condition":"true","node":"skills/choice-1.flow.json#s"}]},
			{"name":"c","onEnter":["check/go {}"],"next":[{"condition":"true","node":"END"}]}
		]}`,
		"bot/flows/skills/choice-1.flow.json":    `{"startNode":"s","nodes":[{"name":"s","onEnter":[],"next":[{"condition":"true","node":"#"}]}]}`,
		"bot/content-elements/builtin_text.json": `[{"id":"builtin_text-1","formData":{"text$en":"hi {{session.name}}","variations$en":["yo"]}}]`,
		"bot/actions/check/go.js":                `const axios = require('axios'); const qs = require("qs"); bp.logger.info('x'); await bp.events.replyToEvent(event, []); return 1`,
		"bot/hooks/before_conversation_end/h.js": `bp.logger.info('end')`,
	})
	bot, err := Load(context.Background(), store, "bot")
	if err != nil {
		t.Fatal(err)
	}
	if issues := Validate(bot); len(issues) != 0 {
		t.Fatalf("unexpected issues:\n%s", issuesText(issues))
	}
}

func TestValidateRejectsOutOfScope(t *testing.T) {
	cases := []struct {
		name  string
		files map[string]string
		want  string
	}{
		{
			name: "node type slot",
			files: map[string]string{
				"bot/flows/main.flow.json": `{"startNode":"a","nodes":[{"name":"a","type":"skill-call","skill":"slot","flow":"skills/x.flow.json","next":[]}]}`,
			},
			want: `skill "slot" is not supported`,
		},
		{
			name: "unknown node type",
			files: map[string]string{
				"bot/flows/main.flow.json": `{"startNode":"a","nodes":[{"name":"a","type":"hitl","next":[]}]}`,
			},
			want: `node type "hitl" is not supported`,
		},
		{
			name: "say inline",
			files: map[string]string{
				"bot/flows/main.flow.json": `{"startNode":"a","nodes":[{"name":"a","onEnter":["say @builtin_text {}"],"next":[]}]}`,
			},
			want: `instruction "say @builtin_text {}" not supported`,
		},
		{
			name: "builtin not in scope",
			files: map[string]string{
				"bot/flows/main.flow.json": `{"startNode":"a","nodes":[{"name":"a","onEnter":["builtin/sendEmail {}"],"next":[]}]}`,
			},
			want: `builtin action "builtin/sendEmail" is not supported`,
		},
		{
			name: "missing user action",
			files: map[string]string{
				"bot/flows/main.flow.json": `{"startNode":"a","nodes":[{"name":"a","onEnter":["ghost {}"],"next":[]}]}`,
			},
			want: `action "ghost" not found`,
		},
		{
			name: "nlu content type",
			files: map[string]string{
				"bot/flows/main.flow.json":                `{"startNode":"a","nodes":[{"name":"a","onEnter":["say #!builtin_text-1"],"next":[]}]}`,
				"bot/content-elements/builtin_quick.json": `[{"id":"builtin_text-1","formData":{}}]`,
			},
			want: `content type "builtin_quick" is not supported`,
		},
		{
			name: "dropdown content type out of scope",
			files: map[string]string{
				"bot/flows/main.flow.json":                   `{"startNode":"a","nodes":[]}`,
				"bot/content-elements/builtin_dropdown.json": `[{"id":"d","formData":{}}]`,
			},
			want: `content type "builtin_dropdown" is not supported`,
		},
		{
			name: "bp.kvs",
			files: map[string]string{
				"bot/flows/main.flow.json": `{"startNode":"a","nodes":[]}`,
				"bot/actions/x.js":         `await bp.kvs.get('k')`,
			},
			want: `bp.kvs.get is not supported`,
		},
		{
			name: "bp.cms without renderElement",
			files: map[string]string{
				"bot/flows/main.flow.json": `{"startNode":"a","nodes":[]}`,
				"bot/actions/x.js":         `bp.cms.getContentElement()`,
			},
			want: `bp.cms.getContentElement is not supported`,
		},
		{
			name: "require outside scope",
			files: map[string]string{
				"bot/flows/main.flow.json": `{"startNode":"a","nodes":[]}`,
				"bot/actions/x.js":         `const fs = require('fs')`,
			},
			want: `require("fs") is not supported`,
		},
		{
			name: "non-literal require",
			files: map[string]string{
				"bot/flows/main.flow.json": `{"startNode":"a","nodes":[]}`,
				"bot/actions/x.js":         `const m = require(name)`,
			},
			want: `non-literal argument`,
		},
		{
			name: "hook type not supported",
			files: map[string]string{
				"bot/flows/main.flow.json":       `{"startNode":"a","nodes":[]}`,
				"bot/hooks/after_bot_mount/h.js": `return`,
			},
			want: `hook type "after_bot_mount" is not supported`,
		},
		{
			name: "transition to missing node",
			files: map[string]string{
				"bot/flows/main.flow.json": `{"startNode":"a","nodes":[{"name":"a","next":[{"condition":"true","node":"nowhere"}]}]}`,
			},
			want: `transition target "nowhere" not found`,
		},
		{
			name: "transition to missing flow",
			files: map[string]string{
				"bot/flows/main.flow.json": `{"startNode":"a","nodes":[{"name":"a","next":[{"condition":"true","node":"other.flow.json#x"}]}]}`,
			},
			want: `transition target flow "other.flow.json" not found`,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			tc.files["bot/bot.config.json"] = minimalConfig
			store := writeBot(t, tc.files)
			bot, err := Load(context.Background(), store, "bot")
			if err != nil {
				t.Fatal(err)
			}
			text := issuesText(Validate(bot))
			if !strings.Contains(text, tc.want) {
				t.Fatalf("want issue containing %q, got:\n%s", tc.want, text)
			}
		})
	}
}

func keysOf[T any](m map[string]T) []string { return sortedKeys(m) }
