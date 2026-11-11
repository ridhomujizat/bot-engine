package dialog

import (
	"context"
	"errors"
	"testing"

	"github.com/ridhomujizat/bot-engine/internal/model"
)

// Port of legacy dialog engine tests (commented out upstream)
// plus the flow semantics of that the scenarios depend on.

func mainWithWait() map[string]*model.Flow {
	return map[string]*model.Flow{
		"main.flow.json": flowOf("entry",
			node("entry", []string{"say #!hello"}, true, tr("true", "other")),
			node("other", []string{"say #!bye"}, false),
		),
	}
}

// Say, wait, resume on the next message, then the flow ends (queue empty).
func TestSayWaitResume(t *testing.T) {
	bot := testBot(mainWithWait())
	out := &recorder{}
	e := newTestEngine(bot, newFakeRunner(), out)

	ev := newEvent("t", "hi")
	step(t, e, ev)
	expectTexts(t, out.texts(), "msg:hello")
	expectNode(t, ev, "main.flow.json", "entry")

	ev2 := newEvent("t", "again")
	ev2["state"] = ev["state"] // same persisted state for the next turn
	out.payloads = nil
	step(t, e, ev2)
	expectTexts(t, out.texts(), "msg:bye")
	if c := ctxOf(ev2); len(c) != 0 {
		t.Fatalf("context after end = %v, want empty", c)
	}
}

// END transition ends the dialog: context and temp are cleaned.
func TestEndTransitionCleansState(t *testing.T) {
	bot := testBot(map[string]*model.Flow{
		"main.flow.json": flowOf("entry", node("entry", []string{"say #!hello"}, false, tr("true", "END"))),
	})
	out := &recorder{}
	ev := newEvent("t", "x")
	ev["state"].(map[string]any)["temp"] = map[string]any{"k": "v"}
	step(t, newTestEngine(bot, newFakeRunner(), out), ev)

	expectTexts(t, out.texts(), "msg:hello")
	if len(ctxOf(ev)) != 0 || len(tempOf(ev)) != 0 {
		t.Fatalf("context/temp not cleaned: %v %v", ctxOf(ev), tempOf(ev))
	}
}

// Subflow via a skill-call node; the subflow returns with "#" and the parent
// node runs only its transitions.
func TestSubflowAndReturn(t *testing.T) {
	bot := testBot(map[string]*model.Flow{
		"main.flow.json": flowOf("call",
			&model.FlowNode{
				Name: "call", Type: "skill-call", Flow: "skills/sub.flow.json",
				NodeActions: model.NodeActions{Next: []*model.NodeTransition{tr("true", "after")}},
			},
			node("after", []string{"say #!back"}, false),
		),
		"skills/sub.flow.json": flowOf("s1", node("s1", []string{"say #!in-sub"}, true, tr("true", "#"))),
	})
	out := &recorder{}
	e := newTestEngine(bot, newFakeRunner(), out)

	ev := newEvent("t", "start")
	step(t, e, ev)
	expectTexts(t, out.texts(), "msg:in-sub")
	expectNode(t, ev, "skills/sub.flow.json", "s1")

	out.payloads = nil
	ev2 := newEvent("t", "pick")
	ev2["state"] = ev["state"]
	step(t, e, ev2)
	expectTexts(t, out.texts(), "msg:back")

	want := []string{"main.flow.json|call", "main.flow.json|call", "main.flow.json|after"}
	var got []string
	for _, item := range stacktrace(ev2) {
		m := item.(map[string]any)
		got = append(got, str(m, "flow")+"|"+str(m, "node"))
	}
	if len(got) != len(want) {
		t.Fatalf("stacktrace = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("stacktrace = %v, want %v", got, want)
		}
	}
}

// An action error with no temp.onErrorFlowTo runs error.flow.json.
func TestActionErrorGoesToErrorFlow(t *testing.T) {
	bot := testBot(map[string]*model.Flow{
		"main.flow.json":  flowOf("entry", node("entry", []string{"boom"}, false)),
		"error.flow.json": flowOf("entry", node("entry", []string{"say #!error"}, true)),
	})
	bot.Actions["boom"] = "throw"
	runner := newFakeRunner()
	runner.actions["boom"] = func(ev, args map[string]any) error { return errors.New("kaboom") }
	out := &recorder{}
	ev := newEvent("t", "x")
	step(t, newTestEngine(bot, runner, out), ev)

	expectTexts(t, out.texts(), "msg:error")
	expectNode(t, ev, "error.flow.json", "entry")
}

// temp.onErrorFlowTo overrides the default error flow.
func TestCustomErrorFlowFromTemp(t *testing.T) {
	bot := testBot(map[string]*model.Flow{
		"main.flow.json":   flowOf("entry", node("entry", []string{"boom"}, false)),
		"custom.flow.json": flowOf("entry", node("entry", []string{"say #!custom"}, true)),
	})
	bot.Actions["boom"] = "throw"
	runner := newFakeRunner()
	runner.actions["boom"] = func(ev, args map[string]any) error {
		tempOf(ev)["onErrorFlowTo"] = "custom.flow.json"
		return errors.New("kaboom")
	}
	out := &recorder{}
	ev := newEvent("t", "x")
	step(t, newTestEngine(bot, runner, out), ev)
	expectTexts(t, out.texts(), "msg:custom")
	expectNode(t, ev, "custom.flow.json", "entry")
}

// A loop without waits: the third visit of a node is an infinite loop. The loop
// is reported (not thrown), never goes to the error flow, and cleans state.
func TestInfiniteLoopCleansState(t *testing.T) {
	bot := testBot(map[string]*model.Flow{
		"main.flow.json": flowOf("a",
			node("a", nil, false, tr("true", "b")),
			node("b", nil, false, tr("true", "a")),
		),
	})
	out := &recorder{}
	ev := newEvent("t", "x")
	if _, err := newTestEngine(bot, newFakeRunner(), out).Decide(context.Background(), ev); err != nil {
		t.Fatalf("Decide returned %v, want nil (loop is reported, not thrown)", err)
	}
	if len(ctxOf(ev)) != 0 {
		t.Fatalf("context after loop = %v, want empty", ctxOf(ev))
	}
}

// Timeout with a timeout.flow.json present jumps to its start node (janitor path).
func TestProcessTimeoutUsesTimeoutFlow(t *testing.T) {
	bot := testBot(map[string]*model.Flow{
		"main.flow.json":    flowOf("entry", node("entry", nil, true)),
		"timeout.flow.json": flowOf("entry", node("entry", []string{"say #!timeout"}, true)),
	})
	out := &recorder{}
	e := newTestEngine(bot, newFakeRunner(), out)

	ev := newEvent("t", "")
	ev["state"].(map[string]any)["context"] = map[string]any{"currentFlow": "main.flow.json", "currentNode": "entry"}
	if err := e.ProcessTimeout(context.Background(), ev); err != nil {
		t.Fatalf("ProcessTimeout: %v", err)
	}
	expectTexts(t, out.texts(), "msg:timeout")
	expectNode(t, ev, "timeout.flow.json", "entry")
}

// Without any timeout node or flow the context is left as it was.
func TestProcessTimeoutWithoutTimeoutLeavesContext(t *testing.T) {
	bot := testBot(map[string]*model.Flow{"main.flow.json": flowOf("entry", node("entry", nil, true))})
	out := &recorder{}
	ev := newEvent("t", "")
	ev["state"].(map[string]any)["context"] = map[string]any{"currentFlow": "main.flow.json", "currentNode": "entry"}
	if err := newTestEngine(bot, newFakeRunner(), out).ProcessTimeout(context.Background(), ev); err != nil {
		t.Fatalf("ProcessTimeout: %v", err)
	}
	expectNode(t, ev, "main.flow.json", "entry")
	if len(out.payloads) != 0 {
		t.Fatalf("unexpected payloads %v", out.texts())
	}
}

// Transition to a node that does not exist fails the turn into the error flow.
func TestMissingNodeGoesToErrorFlow(t *testing.T) {
	bot := testBot(map[string]*model.Flow{
		"main.flow.json":  flowOf("entry", node("entry", nil, false, tr("true", "nope"))),
		"error.flow.json": flowOf("entry", node("entry", []string{"say #!error"}, true)),
	})
	out := &recorder{}
	ev := newEvent("t", "x")
	step(t, newTestEngine(bot, newFakeRunner(), out), ev)
	expectTexts(t, out.texts(), "msg:error")
}

// Skipped message types (builtin 00_dialog_engine) do not touch the dialog.
func TestSkipFlagSkipsDialog(t *testing.T) {
	bot := testBot(mainWithWait())
	out := &recorder{}
	ev := newEvent("t", "")
	setSkipFlagForTest(ev)
	processed, err := newTestEngine(bot, newFakeRunner(), out).Decide(context.Background(), ev)
	if err != nil || processed {
		t.Fatalf("processed=%v err=%v, want false/nil", processed, err)
	}
	if len(out.payloads) != 0 || len(ctxOf(ev)) != 0 {
		t.Fatalf("dialog ran despite skip flag")
	}
}

// Before conversation end hooks run when the dialog ends (hook-service BeforeConversationEnd).
func TestBeforeConversationEndHookRuns(t *testing.T) {
	bot := testBot(map[string]*model.Flow{
		"main.flow.json": flowOf("entry", node("entry", []string{"say #!hello"}, false)),
	})
	bot.Hooks["before_conversation_end"] = []model.Hook{{Name: "end", Code: "x"}}
	runner := newFakeRunner()
	ran := false
	runner.hooks["end"] = func(ev map[string]any) error { ran = true; return nil }
	out := &recorder{}
	ev := newEvent("t", "x")
	step(t, newTestEngine(bot, runner, out), ev)
	if !ran {
		t.Fatalf("before_conversation_end hook did not run")
	}
}

// Default decision is set when the dialog runs.
func TestDecisionDefaultSet(t *testing.T) {
	bot := testBot(mainWithWait())
	ev := newEvent("t", "x")
	step(t, newTestEngine(bot, newFakeRunner(), &recorder{}), ev)
	d, ok := ev["decision"].(map[string]any)
	if !ok || str(d, "sourceDetails") != "execute default flow" {
		t.Fatalf("decision = %v", ev["decision"])
	}
}
