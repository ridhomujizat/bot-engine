package usercode

import (
	"context"
	"strings"
	"testing"
	"time"
)

func condState() map[string]any {
	return map[string]any{
		"temp": map[string]any{
			"skill-choice-ret-abc": "ya",
			"count":                "7",
			"ok":                   true,
		},
		"session": map[string]any{"phone": "0812", "menu": "utama"},
		"user":    map[string]any{"nickname": "Budi"},
		"__stacktrace": []any{
			map[string]any{"node": "start"},
			map[string]any{"node": "menu"},
			map[string]any{"node": "pilih"},
		},
	}
}

func TestEvalConditionTable(t *testing.T) {
	r := New(Options{Console: testWriter{t}})
	cases := []struct {
		name string
		expr string
		want bool
	}{
		{"always", "true", true},
		{"temp equals", "temp['skill-choice-ret-abc'] == 'ya'", true},
		{"temp not equals", "temp['skill-choice-ret-abc'] == 'tidak'", false},
		{"strict true", "temp.ok === true", true},
		{"strict with string", "temp.count === 7", false},
		{"number compare", "Number(temp['count']) > Number(5)", true},
		{"number compare false", "Number(temp.count) > 9", false},
		{"session and user", "session.menu == 'utama' && user.nickname == 'Budi'", true},
		{"session or", "session.menu == 'x' || session.phone == '0812'", true},
		{"event compare", "event.state.session.menu === 'utama'", true},
		{"missing nlu is false", "event.nlu.intent.name === 'greeting'", false},
		{"undefined member is false", "temp.missing.deep === 'x'", false},
		{"lastNode previous", "lastNode=menu", true},
		{"lastNode other", "lastNode=start", false},
		{"template literal", "`${session.menu}` === 'utama'", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			sb := &Sandbox{BotID: "b", Event: map[string]any{"state": condState()}}
			got, err := r.EvalCondition(context.Background(), tc.expr, sb)
			if err != nil {
				t.Fatalf("err = %v", err)
			}
			if got != tc.want {
				t.Fatalf("%s = %v, want %v", tc.expr, got, tc.want)
			}
		})
	}
}

func TestEvalConditionWritesBack(t *testing.T) {
	r := New(Options{Console: testWriter{t}})
	sb := &Sandbox{Event: map[string]any{"state": condState()}}
	ok, err := r.EvalCondition(context.Background(), "(temp.flag = 'set') === 'set'", sb)
	if err != nil || !ok {
		t.Fatalf("ok=%v err=%v", ok, err)
	}
	temp := sb.Event["state"].(map[string]any)["temp"].(map[string]any)
	if temp["flag"] != "set" {
		t.Fatalf("temp.flag not written back: %v", temp)
	}
}

func TestEvalConditionPropagatesNonTypeError(t *testing.T) {
	r := New(Options{Console: testWriter{t}})
	sb := &Sandbox{Event: map[string]any{"state": condState()}}
	_, err := r.EvalCondition(context.Background(), "(function(){ throw new RangeError('boom') })()", sb)
	if err == nil || !strings.Contains(err.Error(), "RangeError: boom") {
		t.Fatalf("RangeError should propagate, got %v", err)
	}
}

func TestEvalConditionSyntaxErrorPropagates(t *testing.T) {
	r := New(Options{Console: testWriter{t}})
	sb := &Sandbox{Event: map[string]any{"state": condState()}}
	if _, err := r.EvalCondition(context.Background(), "temp.x ===", sb); err == nil {
		t.Fatal("expected syntax error")
	}
}

func TestEvalConditionDeadline(t *testing.T) {
	r := New(Options{Console: testWriter{t}})
	sb := &Sandbox{Event: map[string]any{"state": condState()}}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	start := time.Now()
	_, err := r.EvalCondition(ctx, "(function(){ while(true){} })()", sb)
	if err == nil {
		t.Fatal("expected interrupt")
	}
	if time.Since(start) > 2*time.Second {
		t.Fatalf("interrupt too slow: %v", time.Since(start))
	}
}
