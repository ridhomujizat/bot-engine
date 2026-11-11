package dialog

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/ridhomujizat/bot-engine/internal/event"
	"github.com/ridhomujizat/bot-engine/internal/model"
	"github.com/ridhomujizat/bot-engine/internal/usercode"
)

// fakeRunner is a usercode.Runner for tests. Actions and hooks are Go funcs.
// Conditions go through evalExpr, a small evaluator for the expression forms the
// fixtures use. Like the real runner, every call replaces sb.Event with a deep copy.
type fakeRunner struct {
	actions map[string]func(ev map[string]any, args map[string]any) error
	hooks   map[string]func(ev map[string]any) error
	calls   []string
}

func newFakeRunner() *fakeRunner {
	return &fakeRunner{
		actions: map[string]func(map[string]any, map[string]any) error{},
		hooks:   map[string]func(map[string]any) error{},
	}
}

func (f *fakeRunner) RunAction(_ context.Context, name, _ string, sb *usercode.Sandbox, _ usercode.Host) (any, error) {
	f.calls = append(f.calls, "action:"+name)
	fn, ok := f.actions[name]
	if !ok {
		return nil, fmt.Errorf("fake: no action %s", name)
	}
	err := fn(sb.Event, sb.Args)
	sb.Event = deepCopy(sb.Event)
	return nil, err
}

func (f *fakeRunner) RunHook(_ context.Context, hookType, name, _ string, sb *usercode.Sandbox, _ usercode.Host) error {
	f.calls = append(f.calls, "hook:"+hookType+":"+name)
	fn := f.hooks[name]
	var err error
	if fn != nil {
		err = fn(sb.Event)
	}
	sb.Event = deepCopy(sb.Event)
	return err
}

func (f *fakeRunner) EvalCondition(_ context.Context, expr string, sb *usercode.Sandbox) (bool, error) {
	var ok bool
	var err error
	switch {
	case expr == "true":
		ok = true
	case strings.HasPrefix(expr, "lastNode"):
		ok = lastNodeMatches(expr, sb.Event)
	default:
		ok, err = evalExpr(expr, sb.Event)
	}
	sb.Event = deepCopy(sb.Event)
	return ok, err
}

func lastNodeMatches(expr string, ev map[string]any) bool {
	st, _ := ev["state"].(map[string]any)
	stack, _ := st["__stacktrace"].([]any)
	if len(stack) == 0 {
		return false
	}
	last := stack[0]
	if len(stack) > 1 {
		last = stack[len(stack)-2]
	}
	m, _ := last.(map[string]any)
	return expr == "lastNode="+str(m, "node")
}

func deepCopy(m map[string]any) map[string]any {
	if m == nil {
		return nil
	}
	b, _ := json.Marshal(m)
	var out map[string]any
	_ = json.Unmarshal(b, &out)
	return out
}

// evalExpr supports `lhs OP rhs` with OP in ===, !==, ==, !=, >, <, >=, <=,
// where a side is a path (temp['k'], session.k, event.payload.text), a literal,
// or Number(path|literal). Undefined paths compare as undefined.
func evalExpr(expr string, ev map[string]any) (bool, error) {
	ops := []string{" !== ", " === ", " == ", " != ", " >= ", " <= ", " > ", " < "}
	for _, op := range ops {
		i := strings.Index(expr, op)
		if i < 0 {
			continue
		}
		l := evalValue(strings.TrimSpace(expr[:i]), ev)
		r := evalValue(strings.TrimSpace(expr[i+len(op):]), ev)
		switch strings.TrimSpace(op) {
		case "===", "==":
			return looseEq(l, r), nil
		case "!==", "!=":
			return !looseEq(l, r), nil
		}
		ln, lok := l.(float64)
		rn, rok := r.(float64)
		if !lok || !rok || math.IsNaN(ln) || math.IsNaN(rn) {
			return false, nil
		}
		switch strings.TrimSpace(op) {
		case ">":
			return ln > rn, nil
		case "<":
			return ln < rn, nil
		case ">=":
			return ln >= rn, nil
		case "<=":
			return ln <= rn, nil
		}
	}
	return false, fmt.Errorf("fake: unsupported expression %q", expr)
}

func looseEq(a, b any) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return fmt.Sprint(a) == fmt.Sprint(b)
}

func evalValue(s string, ev map[string]any) any {
	if strings.HasPrefix(s, "Number(") && strings.HasSuffix(s, ")") {
		inner := evalValue(s[len("Number("):len(s)-1], ev)
		switch v := inner.(type) {
		case float64:
			return v
		case string:
			f, err := strconv.ParseFloat(v, 64)
			if err != nil {
				return math.NaN()
			}
			return f
		case bool:
			if v {
				return float64(1)
			}
			return float64(0)
		}
		return math.NaN()
	}
	if (strings.HasPrefix(s, `"`) && strings.HasSuffix(s, `"`)) || (strings.HasPrefix(s, "'") && strings.HasSuffix(s, "'")) {
		return s[1 : len(s)-1]
	}
	switch s {
	case "true":
		return true
	case "false":
		return false
	case "null", "undefined":
		return nil
	}
	if f, err := strconv.ParseFloat(s, 64); err == nil {
		return f
	}
	// path
	p := strings.ReplaceAll(s, "['", ".")
	p = strings.ReplaceAll(p, "']", "")
	segs := strings.Split(p, ".")
	var cur any = ev
	if segs[0] == "event" {
		segs = segs[1:]
	} else {
		// temp, session, user, bot and context live under event.state.
		cur = ev["state"]
	}
	for _, seg := range segs {
		m, ok := cur.(map[string]any)
		if !ok {
			return nil
		}
		cur = m[seg]
	}
	return cur
}

// ---- synthetic bots ----------------------------------------------------------

func node(name string, onEnter []string, wait bool, next ...*model.NodeTransition) *model.FlowNode {
	n := &model.FlowNode{Name: name, ID: "id-" + name}
	n.OnEnter = onEnter
	if wait {
		empty := []string{}
		n.OnReceive = &empty
	}
	n.Next = next
	return n
}

func tr(cond, to string) *model.NodeTransition {
	return &model.NodeTransition{Condition: cond, Node: to}
}

func flowOf(start string, nodes ...*model.FlowNode) *model.Flow {
	return &model.Flow{Version: "0.0.1", StartNode: start, Nodes: nodes}
}

// testBot builds a bot in memory. Content element ids are "hello", "bye",...
func testBot(flows map[string]*model.Flow) *model.Bot {
	b := &model.Bot{
		ID:              "t",
		Config:          model.BotConfig{ID: "t", DefaultLanguage: "en"},
		Flows:           map[string]*model.Flow{},
		ContentElements: map[string]*model.ContentElement{},
		Actions:         map[string]string{},
		Hooks:           map[string][]model.Hook{},
	}
	for name, f := range flows {
		f.Name = name
		b.Flows[name] = f
	}
	for _, id := range []string{"hello", "bye", "in-sub", "back", "error", "timeout", "x", "custom"} {
		b.ContentElements[id] = &model.ContentElement{
			ID:          id,
			ContentType: "builtin_text",
			FormData:    map[string]any{"text$en": "msg:" + id},
		}
	}
	return b
}

// recorder collects payloads like the converse outbox.
type recorder struct{ payloads []map[string]any }

func (r *recorder) Emit(_ context.Context, ps []map[string]any) error {
	r.payloads = append(r.payloads, ps...)
	return nil
}

func (r *recorder) texts() []string {
	var out []string
	for _, p := range r.payloads {
		s, _ := p["text"].(string)
		out = append(out, s)
	}
	return out
}

func quietLogger() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func newTestEngine(bot *model.Bot, runner usercode.Runner, out *recorder) *Engine {
	return New(Deps{Bot: bot, UserCode: runner, Outbox: out, Logger: quietLogger()})
}

// newEvent returns a fresh incoming event with an empty state (state restore is the engine's job).
func newEvent(botID string, text string) map[string]any {
	ev := event.New(event.Args{
		Type:      "text",
		Channel:   "api",
		Direction: event.DirectionIncoming,
		Target:    "user1",
		BotID:     botID,
		Payload:   map[string]any{"type": "text", "text": text},
	}, time.Now())
	st := ev["state"].(map[string]any)
	st["user"] = map[string]any{}
	st["session"] = map[string]any{"lastMessages": []any{}, "workflows": map[string]any{}}
	st["temp"] = map[string]any{}
	st["bot"] = map[string]any{}
	st["context"] = map[string]any{}
	return ev
}

// step runs one turn: Decide (decision engine, non-NDU) against the event.
func step(t *testing.T, e *Engine, ev map[string]any) {
	t.Helper()
	if _, err := e.Decide(context.Background(), ev); err != nil {
		t.Fatalf("Decide: %v", err)
	}
}

func ctxOf(ev map[string]any) map[string]any { return contextOf(ev) }

func expectTexts(t *testing.T, got []string, want ...string) {
	t.Helper()
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("responses = %q, want %q", got, want)
	}
}

func expectNode(t *testing.T, ev map[string]any, flow, node string) {
	t.Helper()
	c := ctxOf(ev)
	if str(c, "currentFlow") != flow || str(c, "currentNode") != node {
		t.Fatalf("position = %s/%s, want %s/%s", str(c, "currentFlow"), str(c, "currentNode"), flow, node)
	}
}

var _ = errors.New

func setSkipFlagForTest(ev map[string]any) { event.SetFlag(ev, event.FlagSkipDialogEngine, true) }
