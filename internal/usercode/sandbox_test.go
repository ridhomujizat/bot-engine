package usercode

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"reflect"
	"sync"
	"testing"
	"time"
)

// recordingHost records every shim call so tests can check order and payloads.
type recordingHost struct {
	mu        sync.Mutex
	infos     []string
	errs      []string
	replies   [][]map[string]any
	renders   []string
	inserts   []string
	renderErr error
}

func (h *recordingHost) LogInfo(botID string, args ...any) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.infos = append(h.infos, fmt.Sprint(botID, args))
}
func (h *recordingHost) LogError(botID string, args ...any) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.errs = append(h.errs, fmt.Sprint(botID, args))
}
func (h *recordingHost) LogWarn(botID string, args ...any) { h.LogInfo(botID, args...) }

func (h *recordingHost) RenderElement(ctx context.Context, botID, id string, args, event map[string]any) ([]map[string]any, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.renders = append(h.renders, id)
	if h.renderErr != nil {
		return nil, h.renderErr
	}
	return []map[string]any{{"type": "text", "text": "render:" + id, "args": args["text"]}}, nil
}

func (h *recordingHost) ReplyToEvent(ctx context.Context, event map[string]any, payloads []map[string]any) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.replies = append(h.replies, payloads)
	return nil
}

func (h *recordingHost) InsertAndRetrieve(ctx context.Context, botID, table string, data map[string]any, cols []string, idc string) (map[string]any, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.inserts = append(h.inserts, table)
	out := map[string]any{"id": 7.0}
	for k, v := range data {
		out[k] = v
	}
	return out, nil
}

func TestWriteBackDeleteReassignDate(t *testing.T) {
	state := map[string]any{
		"session": map[string]any{"gone": "x", "keep": "y", "nested": map[string]any{"a": 1.0}},
		"temp":    map[string]any{},
	}
	sb := &Sandbox{BotID: "b", Event: map[string]any{"state": state, "preview": "old"}}
	code := `
delete session.gone
event.state.temp = { replaced: true, list: [1, 'two'] }
session.when = new Date(0)
session.nested.a = session.nested.a + 1
event.preview = undefined
session.nothing = undefined
session.fn = function () {}
return null
`
	r := New(Options{Console: testWriter{t}})
	if _, err := r.RunAction(context.Background(), "wb", code, sb, nil); err != nil {
		t.Fatal(err)
	}
	st := sb.Event["state"].(map[string]any)
	sess := st["session"].(map[string]any)
	if _, has := sess["gone"]; has {
		t.Errorf("delete not written back: %v", sess)
	}
	if sess["keep"] != "y" {
		t.Errorf("keep lost: %v", sess)
	}
	if sess["when"] != "1970-01-01T00:00:00.000Z" {
		t.Errorf("Date should serialize as ISO string, got %#v", sess["when"])
	}
	if !reflect.DeepEqual(sess["nested"], map[string]any{"a": 2.0}) {
		t.Errorf("nested = %#v", sess["nested"])
	}
	if _, has := sess["nothing"]; has {
		t.Errorf("undefined must be dropped")
	}
	if _, has := sess["fn"]; has {
		t.Errorf("functions must be dropped")
	}
	if !reflect.DeepEqual(st["temp"], map[string]any{"replaced": true, "list": []any{1.0, "two"}}) {
		t.Errorf("event.state.temp reassignment = %#v", st["temp"])
	}
	if _, has := sb.Event["preview"]; has {
		t.Errorf("event.preview = undefined should drop the key")
	}
}

func TestWriteBackHappensOnThrow(t *testing.T) {
	sb := &Sandbox{Event: map[string]any{"state": map[string]any{"session": map[string]any{}}}}
	r := New(Options{Console: testWriter{t}})
	_, err := r.RunAction(context.Background(), "boom", `session.before = 'kept'; throw new Error('bad things')`, sb, nil)
	if err == nil {
		t.Fatal("expected error")
	}
	var jsErr *JSError
	if !errors.As(err, &jsErr) || jsErr.Message != "bad things" || jsErr.Name != "Error" || jsErr.Stack == "" {
		t.Fatalf("error = %#v", err)
	}
	if got := sb.Event["state"].(map[string]any)["session"].(map[string]any)["before"]; got != "kept" {
		t.Fatalf("state written before the throw must persist, got %v", got)
	}
}

func TestHookMutatesEventState(t *testing.T) {
	sb := &Sandbox{BotID: "b", Event: map[string]any{"state": map[string]any{"temp": map[string]any{"a": "1"}}}}
	r := New(Options{Console: testWriter{t}})
	host := &recordingHost{}
	code := `
bp.logger.info('hook start', event.state.temp.a)
event.state.temp = { ...event.state.temp, b: '2' }
event.payload = { text: 'changed' }
`
	if err := r.RunHook(context.Background(), "before_conversation_end", "create_end_message", code, sb, host); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(sb.Event["state"].(map[string]any)["temp"], map[string]any{"a": "1", "b": "2"}) {
		t.Fatalf("temp = %#v", sb.Event["state"])
	}
	if !reflect.DeepEqual(sb.Event["payload"], map[string]any{"text": "changed"}) {
		t.Fatalf("payload = %#v", sb.Event["payload"])
	}
	if len(host.infos) != 1 {
		t.Fatalf("logger calls = %v", host.infos)
	}
}

func TestBPShimsOrderAndReturn(t *testing.T) {
	host := &recordingHost{}
	sb := &Sandbox{BotID: "example", Event: map[string]any{"state": map[string]any{}}}
	code := `
const payloads = await bp.cms.renderElement('builtin_text', { text: 'halo' }, event)
bp.events.replyToEvent(event, payloads)
await bp.events.replyToEvent(event, [{ type: 'text', text: 'second' }])
const row = await bp.database.insertAndRetrieve('member_example', { phone: '0812' }, ['id'], 'id')
bp.logger.forBot('other').error('boom', 1)
return { first: payloads[0].text, row: row.id }
`
	r := New(Options{Console: testWriter{t}})
	res, err := r.RunAction(context.Background(), "shims", code, sb, host)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(res, map[string]any{"first": "render:builtin_text", "row": 7.0}) {
		t.Fatalf("result = %#v", res)
	}
	if len(host.renders) != 1 || host.renders[0] != "builtin_text" {
		t.Fatalf("renders = %v", host.renders)
	}
	if len(host.replies) != 2 || host.replies[1][0]["text"] != "second" {
		t.Fatalf("replies = %#v", host.replies)
	}
	if len(host.inserts) != 1 || host.inserts[0] != "member_example" {
		t.Fatalf("inserts = %v", host.inserts)
	}
	if len(host.errs) != 1 {
		t.Fatalf("errs = %v", host.errs)
	}
}

func TestBPShimHostErrorRejects(t *testing.T) {
	host := &recordingHost{renderErr: errors.New("renderer down")}
	sb := &Sandbox{Event: map[string]any{"state": map[string]any{}}}
	r := New(Options{Console: testWriter{t}})
	res, err := r.RunAction(context.Background(), "x", `
try { await bp.cms.renderElement('builtin_text', {}, event) } catch (e) { return 'caught:' + e.message }
return 'no'`, sb, host)
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if res != "caught:renderer down" {
		t.Fatalf("result = %#v", res)
	}
}

func TestActionDeadlineInterruptsBusyLoop(t *testing.T) {
	sb := &Sandbox{Event: map[string]any{"state": map[string]any{}}}
	r := New(Options{Console: testWriter{t}})
	ctx, cancel := context.WithTimeout(context.Background(), 80*time.Millisecond)
	defer cancel()
	start := time.Now()
	_, err := r.RunAction(ctx, "spin", `while (true) {}`, sb, nil)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err = %v, want deadline exceeded", err)
	}
	if d := time.Since(start); d > 2*time.Second {
		t.Fatalf("took %v", d)
	}
}

func TestActionDeadlineCancelsPendingHTTP(t *testing.T) {
	ft := &fakeTransport{reply: func(r *http.Request, _ string) (int, string, error) {
		<-r.Context().Done()
		return 0, "", r.Context().Err()
	}}
	sb := &Sandbox{Event: map[string]any{"state": map[string]any{}}}
	r := New(Options{Console: testWriter{t}, HTTPClient: &http.Client{Transport: ft}})
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	_, err := r.RunAction(ctx, "hang", `const axios = require('axios'); await axios.get('http://slow.test/')`, sb, nil)
	if err == nil {
		t.Fatal("expected failure when the run deadline passes during a request")
	}
}

func TestPromiseNeverSettledIsError(t *testing.T) {
	sb := &Sandbox{Event: map[string]any{"state": map[string]any{}}}
	r := New(Options{Console: testWriter{t}})
	_, err := r.RunAction(context.Background(), "never", `await new Promise(() => {}); return 1`, sb, nil)
	if err == nil {
		t.Fatal("expected error for a promise nothing can settle")
	}
}
