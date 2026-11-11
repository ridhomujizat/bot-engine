package builtin

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/ridhomujizat/bot-engine/internal/model"
	"github.com/ridhomujizat/bot-engine/internal/state"
)

var testNow = time.Date(2026, 11, 11, 10, 0, 0, 0, time.UTC)

// testEnv bundles a fresh event, KVS and deps.
type testEnv struct {
	ev   map[string]any
	kvs  *state.MemoryKVS
	deps Deps
}

func newEnv(t *testing.T) *testEnv {
	t.Helper()
	kvs := state.NewMemoryKVS()
	kvs.Now = func() time.Time { return testNow }
	ev := map[string]any{
		"botId":   "bot1",
		"channel": "web",
		"target":  "u1",
		"preview": "",
		"payload": map[string]any{"text": "hi"},
		"state": map[string]any{
			"user":    map[string]any{"nickname": "Budi"},
			"temp":    map[string]any{"keep-me-not": "x"},
			"context": map[string]any{"flow": "main.flow.json"},
			"session": map[string]any{
				"lastMessages":    []any{"m1"},
				"workflows":       map[string]any{"w": 1.0},
				"nluContexts":     []any{},
				"currentWorkflow": "w",
				"other":           "gone",
			},
		},
	}
	return &testEnv{
		ev:   ev,
		kvs:  kvs,
		deps: Deps{KVS: kvs, Now: func() time.Time { return testNow }},
	}
}

func (e *testEnv) state(key string) map[string]any {
	return e.ev["state"].(map[string]any)[key].(map[string]any)
}

func (e *testEnv) run(t *testing.T, name string, args map[string]any) error {
	t.Helper()
	return Run(context.Background(), name, args, e.ev, e.deps)
}

func (e *testEnv) mustRun(t *testing.T, name string, args map[string]any) {
	t.Helper()
	if err := e.run(t, name, args); err != nil {
		t.Fatalf("%s: %v", name, err)
	}
}

// jsonArgs parses a JSON args literal the way the flow instruction would deliver it.
func jsonArgs(t *testing.T, s string) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal([]byte(s), &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func TestIsBuiltin(t *testing.T) {
	for _, n := range []string{
		"builtin/setVariable", "builtin/removeVariable", "builtin/resetSession", "builtin/resetContext",
		"builtin/appendContext", "builtin/incrementNumberOfConversations", "builtin/getGlobalVariable",
		"builtin/resetGlobalVariable", "builtin/wait", "basic-skills/choice_parse_answer",
		"basic-skills/choice_invalid_answer",
	} {
		if !IsBuiltin(n) {
			t.Errorf("IsBuiltin(%q) = false", n)
		}
	}
	for _, n := range []string{"builtin/sendFeedback", "builtin/storeFileLocally", "check-stock/search", "basic-skills/callApi"} {
		if IsBuiltin(n) {
			t.Errorf("IsBuiltin(%q) = true, want false", n)
		}
	}
	if err := Run(context.Background(), "builtin/nope", nil, map[string]any{}, Deps{}); err == nil {
		t.Errorf("Run of unknown action should fail")
	}
}

func TestSetVariableTemp(t *testing.T) {
	tests := []struct {
		name    string
		args    string
		present bool // key expected in temp afterwards
		want    any
	}{
		{"number keeps type", `{"type":"temp","name":"skill-choice-invalid-count-x","value": 0 }`, true, 0.0},
		{"string", `{"type":"temp","name":"s","value":"abc"}`, true, "abc"},
		{"null value stored as null", `{"type":"temp","name":"s","value":null}`, true, nil},
		{"string null deletes", `{"type":"temp","name":"keep-me-not","value":"null"}`, false, nil},
		{"empty string deletes", `{"type":"temp","name":"keep-me-not","value":""}`, false, nil},
		{"absent value deletes", `{"type":"temp","name":"keep-me-not"}`, false, nil},
		{"bool", `{"type":"temp","name":"b","value":true}`, true, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := newEnv(t)
			e.mustRun(t, "builtin/setVariable", jsonArgs(t, tt.args))
			name := jsonArgs(t, tt.args)["name"].(string)
			got, ok := e.state("temp")[name]
			if ok != tt.present || (ok && !reflect.DeepEqual(got, tt.want)) {
				t.Errorf("temp[%s] = %#v (present %v), want %#v (present %v)", name, got, ok, tt.want, tt.present)
			}
		})
	}
}

func TestSetVariableErrorsAndUserType(t *testing.T) {
	e := newEnv(t)
	// args arrive already Mustache-rendered, so the value is stored as given
	e.mustRun(t, "builtin/setVariable", jsonArgs(t, `{"type":"user","name":"nickname","value":"hi"}`))
	if got := e.state("user")["nickname"]; got != "hi" {
		t.Errorf("user.nickname = %#v", got)
	}
	if err := e.run(t, "builtin/setVariable", jsonArgs(t, `{"type":"nope","name":"x","value":1}`)); err == nil {
		t.Errorf("unknown state bag should be an error (legacy TypeError)")
	}
}

func TestSetVariableBotAndRemove(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	_ = e.kvs.Set(ctx, "bot1", "global", map[string]any{"a": 1.0}, 0)

	e.mustRun(t, "builtin/setVariable", map[string]any{"type": "bot", "name": "b", "value": 2.0})
	got, _, _ := e.kvs.Get(ctx, "bot1", "global")
	if !reflect.DeepEqual(got, map[string]any{"a": 1.0, "b": 2.0}) {
		t.Errorf("bot global after set = %#v", got)
	}

	// absent value: the key is dropped (undefined is not stored by JSON.stringify)
	e.mustRun(t, "builtin/setVariable", map[string]any{"type": "bot", "name": "a"})
	got, _, _ = e.kvs.Get(ctx, "bot1", "global")
	if !reflect.DeepEqual(got, map[string]any{"b": 2.0}) {
		t.Errorf("bot global after absent value = %#v", got)
	}

	// removeVariable on bot stores the string "null"
	e.mustRun(t, "builtin/removeVariable", map[string]any{"type": "bot", "name": "b"})
	got, _, _ = e.kvs.Get(ctx, "bot1", "global")
	if !reflect.DeepEqual(got, map[string]any{"b": "null"}) {
		t.Errorf("bot global after removeVariable = %#v", got)
	}

	e.mustRun(t, "builtin/removeVariable", map[string]any{"type": "user", "name": "nickname"})
	if _, ok := e.state("user")["nickname"]; ok {
		t.Errorf("user.nickname not removed")
	}
}

func TestResetSession(t *testing.T) {
	e := newEnv(t)
	e.mustRun(t, "builtin/resetSession", nil)
	temp := e.state("temp")
	if len(temp) != 0 {
		t.Errorf("temp = %#v, want empty", temp)
	}
	sess := e.state("session")
	for _, k := range []string{"lastMessages", "nluContexts", "workflows"} {
		if _, ok := sess[k]; !ok {
			t.Errorf("session.%s removed, must be kept", k)
		}
	}
	for _, k := range []string{"other", "currentWorkflow"} {
		if _, ok := sess[k]; ok {
			t.Errorf("session.%s kept, must be removed", k)
		}
	}
	if !reflect.DeepEqual(e.state("context"), map[string]any{"flow": "main.flow.json"}) {
		t.Errorf("resetSession must not touch context: %#v", e.state("context"))
	}
	flags, _ := e.ev["flags"].(map[string]any)
	if flags[FlagForcePersistState] != true {
		t.Errorf("force persist flag not set: %#v", e.ev["flags"])
	}
}

func TestResetContextAndAppendRemove(t *testing.T) {
	e := newEnv(t)
	e.state("session")["nluContexts"] = []any{map[string]any{"context": "old", "ttl": 3.0}}
	e.mustRun(t, "builtin/resetContext", nil)
	if !reflect.DeepEqual(e.state("session")["nluContexts"], []any{}) {
		t.Errorf("resetContext: %#v", e.state("session")["nluContexts"])
	}

	// existing a(ttl 5) keeps the higher ttl; b is appended; ttl "1" is numeric.
	e.state("session")["nluContexts"] = []any{map[string]any{"context": "a", "ttl": 5.0}}
	e.mustRun(t, "builtin/appendContext", map[string]any{"contexts": "a, b", "ttl": "1"})
	want := []any{
		map[string]any{"context": "a", "ttl": 5.0},
		map[string]any{"context": " b", "ttl": 1.0}, // split is not trimmed per item (appendContext.js:25)
	}
	if got := e.state("session")["nluContexts"]; !reflect.DeepEqual(got, want) {
		t.Errorf("appendContext = %#v, want %#v", got, want)
	}

	// absent ttl -> 1000; ttl "" -> Number("") = 0
	e.state("session")["nluContexts"] = []any{}
	e.mustRun(t, "builtin/appendContext", map[string]any{"contexts": "x"})
	e.mustRun(t, "builtin/appendContext", map[string]any{"contexts": "y", "ttl": ""})
	want = []any{
		map[string]any{"context": "x", "ttl": 1000.0},
		map[string]any{"context": "y", "ttl": 0.0},
	}
	if got := e.state("session")["nluContexts"]; !reflect.DeepEqual(got, want) {
		t.Errorf("appendContext defaults = %#v, want %#v", got, want)
	}

	e.mustRun(t, "builtin/removeContext", map[string]any{"contexts": "x,zz"})
	want = []any{map[string]any{"context": "y", "ttl": 0.0}}
	if got := e.state("session")["nluContexts"]; !reflect.DeepEqual(got, want) {
		t.Errorf("removeContext = %#v, want %#v", got, want)
	}

	if err := e.run(t, "builtin/appendContext", map[string]any{"ttl": "1"}); err == nil {
		t.Errorf("appendContext without contexts should fail")
	}
}

func TestNumberOfConversations(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()

	// get before any increment: output absent (undefined)
	e.mustRun(t, "builtin/getNumberOfConversations", map[string]any{"output": "$r"})
	if _, ok := e.state("temp")["$r"]; ok {
		t.Errorf("getNumberOfConversations should leave $r undefined")
	}

	// first increment outputs 0 (value undefined -> 0), second outputs 1
	for i, want := range []float64{0, 1, 2} {
		e.mustRun(t, "builtin/incrementNumberOfConversations", map[string]any{"output": "$r"})
		if got := e.state("temp")["$r"]; got != want {
			t.Errorf("increment #%d output = %#v, want %v", i, got, want)
		}
	}
	raw, ok, _ := e.kvs.Get(ctx, "bot1", "storage/users/u1/numberOfConversations")
	if !ok || !reflect.DeepEqual(raw, map[string]any{"value": 2.0, "expiry": "never"}) {
		t.Errorf("stored box = %#v", raw)
	}
	e.mustRun(t, "builtin/getNumberOfConversations", map[string]any{"output": "n"})
	if e.state("temp")["n"] != 2.0 {
		t.Errorf("getNumberOfConversations n = %#v", e.state("temp")["n"])
	}
}

func TestGlobalVariables(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()

	e.mustRun(t, "builtin/setGlobalVariable", map[string]any{"name": "promo", "value": "on", "expiry": "1 hour", "output": "p"})
	if e.state("temp")["p"] != "on" {
		t.Errorf("setGlobalVariable output = %#v", e.state("temp")["p"])
	}
	raw, _, _ := e.kvs.Get(ctx, "bot1", "storage/global/promo")
	box := raw.(map[string]any)
	if box["expiry"] != testNow.Add(time.Hour).Format(isoMillis) || box["value"] != "on" {
		t.Errorf("box = %#v", box)
	}

	e.mustRun(t, "builtin/getGlobalVariable", map[string]any{"name": "promo", "output": "g"})
	if e.state("temp")["g"] != "on" {
		t.Errorf("getGlobalVariable = %#v", e.state("temp")["g"])
	}

	// expired box reads as undefined (unboxWithExpiry)
	e2 := newEnv(t)
	e2.kvs.Now = func() time.Time { return testNow.Add(2 * time.Hour) }
	e2.deps.Now = func() time.Time { return testNow.Add(2 * time.Hour) }
	e2.ev["state"].(map[string]any)["temp"] = map[string]any{}
	e2.mustRun(t, "builtin/getGlobalVariable", map[string]any{"name": "promo", "output": "g"})
	if _, ok := e2.state("temp")["g"]; ok {
		t.Errorf("expired global should be undefined")
	}

	// never expiry and no output
	e.mustRun(t, "builtin/setGlobalVariable", map[string]any{"name": "forever", "value": 7.0})
	raw, _, _ = e.kvs.Get(ctx, "bot1", "storage/global/forever")
	if !reflect.DeepEqual(raw, map[string]any{"value": 7.0, "expiry": "never"}) {
		t.Errorf("never box = %#v", raw)
	}

	// empty expiry string throws in ms
	if err := e.run(t, "builtin/setGlobalVariable", map[string]any{"name": "x", "value": 1.0, "expiry": ""}); err == nil {
		t.Errorf("empty expiry should fail")
	}

	// resetGlobalVariable: LIKE 'storage/global/promo%' (also removes other bots' rows, legacy quirk)
	_ = e.kvs.Set(ctx, "other-bot", "storage/global/promo-2", "z", 0)
	e.mustRun(t, "builtin/resetGlobalVariable", map[string]any{"name": "promo"})
	if _, ok, _ := e.kvs.Get(ctx, "bot1", "storage/global/promo"); ok {
		t.Errorf("promo not reset")
	}
	if _, ok, _ := e.kvs.Get(ctx, "other-bot", "storage/global/promo-2"); ok {
		t.Errorf("LIKE prefix reset should match rows of all bots (legacy behaviour)")
	}
	if _, ok, _ := e.kvs.Get(ctx, "bot1", "storage/global/forever"); !ok {
		t.Errorf("unrelated global removed")
	}
}

func TestWait(t *testing.T) {
	e := newEnv(t)
	start := time.Now()
	e.mustRun(t, "builtin/wait", map[string]any{"delay": 5.0})
	if time.Since(start) > 500*time.Millisecond {
		t.Errorf("wait 5ms took %v", time.Since(start))
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := Run(ctx, "builtin/wait", map[string]any{}, e.ev, e.deps); err == nil {
		t.Errorf("cancelled wait should return ctx error")
	}
}

func TestSwitchLanguage(t *testing.T) {
	e := newEnv(t)
	e.mustRun(t, "builtin/switchLanguage", map[string]any{"lang": "EN"})
	if e.state("user")["language"] != "en" {
		t.Errorf("language = %#v", e.state("user")["language"])
	}
	flags, _ := e.ev["flags"].(map[string]any)
	if flags[FlagForcePersistState] != true {
		t.Errorf("persist flag not set")
	}
	if err := e.run(t, "builtin/switchLanguage", map[string]any{"lang": 5.0}); err == nil {
		t.Errorf("non-string lang should fail")
	}
}

// choiceEnv builds the event + bot used by the choice actions.
func choiceEnv(t *testing.T, preview string, payload map[string]any) *testEnv {
	t.Helper()
	e := newEnv(t)
	e.ev["preview"] = preview
	if payload != nil {
		e.ev["payload"] = payload
	} else {
		e.ev["payload"] = nil
	}
	e.deps.Bot = &model.Bot{ContentElements: map[string]*model.ContentElement{
		"plain": {ID: "plain", FormData: map[string]any{"choices": []any{
			map[string]any{"title": "Monkey", "value": "monkey"},
			map[string]any{"title": "Giraffe", "value": "giraffe"},
		}}},
		"lang": {ID: "lang", FormData: map[string]any{"choices$en": []any{
			map[string]any{"title": "Monkey", "value": "monkey"},
		}}},
	}}
	return e
}

var animalKeywords = map[string]any{
	"monkey":  []any{"monkey", "Monkey"},
	"giraffe": []any{"giraffe", "Giraffe"},
}

func parseArgs(extra map[string]any) map[string]any {
	m := map[string]any{"contentId": "lang", "keywords": animalKeywords, "config": map[string]any{}}
	for k, v := range extra {
		m[k] = v
	}
	return m
}

func TestChoiceParseAnswer(t *testing.T) {
	cfg := BasicSkillsConfig{MatchNumbers: true, MatchNLU: false}
	tests := []struct {
		name     string
		preview  string
		payload  map[string]any
		extra    map[string]any
		deps     func(*Deps)
		wantOK   bool
		wantRet  any
		wantKeys string
	}{
		{name: "exact preview", preview: "Giraffe", wantOK: true, wantRet: "giraffe"},
		{name: "lower exact", preview: "monkey", wantOK: true, wantRet: "monkey"},
		{name: "substring", preview: "I like monkeys a lot", wantOK: true, wantRet: "monkey"},
		{name: "payload text exact", preview: "", payload: map[string]any{"text": "GIRAFFE"}, wantOK: true, wantRet: "giraffe"},
		{name: "payload payload", preview: "zzz", payload: map[string]any{"payload": "giraffe"}, wantOK: true, wantRet: "giraffe"},
		{name: "no match", preview: "elephant", wantOK: false},
		{name: "randomId suffix", preview: "monkey", extra: map[string]any{"randomId": "abc"}, wantOK: true, wantRet: "monkey", wantKeys: "-abc"},
		{name: "number picks choices[index] when formData.choices exists", preview: "2", extra: map[string]any{"contentId": "plain"}, wantOK: true, wantRet: "giraffe"},
		{name: "number with choices$en key finds nothing in legacy, falls through to text", preview: "1", wantOK: false},
		{name: "zero index is not a choice", preview: "0", extra: map[string]any{"contentId": "plain"}, wantOK: false},
		{name: "number with trailing punctuation", preview: "1)", extra: map[string]any{"contentId": "plain"}, wantOK: true, wantRet: "monkey"},
		{name: "parenthesis prefix is not a number delimiter", preview: "(1)", extra: map[string]any{"contentId": "plain"}, wantOK: false},
		{name: "matchNumbers off", preview: "2", extra: map[string]any{"contentId": "plain"}, wantOK: false},
		{name: "empty keyword matches any text in second pass", preview: "abc",
			extra: map[string]any{"keywords": map[string]any{"any": []any{""}}}, wantOK: true, wantRet: "any"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := choiceEnv(t, tt.preview, tt.payload)
			e.deps.BasicSkills = &cfg
			if tt.name == "matchNumbers off" {
				off := BasicSkillsConfig{MatchNumbers: false}
				e.deps.BasicSkills = &off
			}
			args := parseArgs(tt.extra)
			e.mustRun(t, "basic-skills/choice_parse_answer", args)
			suffix := ""
			if tt.wantKeys != "" {
				suffix = tt.wantKeys
			}
			temp := e.state("temp")
			if got := temp["skill-choice-valid"+suffix]; got != tt.wantOK {
				t.Errorf("valid = %#v, want %v", got, tt.wantOK)
			}
			if tt.wantOK {
				if got := temp["skill-choice-ret"+suffix]; got != tt.wantRet {
					t.Errorf("ret = %#v, want %#v", got, tt.wantRet)
				}
			}
		})
	}
}

func TestChoiceParseAnswerNLU(t *testing.T) {
	e := choiceEnv(t, "hello there", nil)
	e.deps.BasicSkills = &BasicSkillsConfig{MatchNumbers: true, MatchNLU: true}
	e.ev["nlu"] = map[string]any{"intent": map[string]any{"name": "greeting"}}
	args := parseArgs(map[string]any{"keywords": map[string]any{
		"hi":  []any{"intent:Greeting"},
		"bye": []any{"intent:goodbye"},
	}})
	e.mustRun(t, "basic-skills/choice_parse_answer", args)
	if e.state("temp")["skill-choice-ret"] != nil && e.state("temp")["skill-choice-ret"] != "hi" {
		t.Errorf("ret = %#v", e.state("temp")["skill-choice-ret"])
	}
	// intent names are compared case-sensitively with the substring after "intent:" (legacy substr)
	if e.state("temp")["skill-choice-valid"] != false {
		t.Errorf("'Greeting' must not equal 'greeting': %#v", e.state("temp")["skill-choice-valid"])
	}

	e2 := choiceEnv(t, "hello there", nil)
	e2.deps.BasicSkills = &BasicSkillsConfig{MatchNumbers: false, MatchNLU: true}
	e2.ev["nlu"] = map[string]any{"intent": map[string]any{"name": "Greeting"}}
	e2.mustRun(t, "basic-skills/choice_parse_answer", parseArgs(map[string]any{"keywords": map[string]any{
		"hi": []any{"intent:Greeting"},
	}}))
	if e2.state("temp")["skill-choice-ret"] != "hi" {
		t.Errorf("NLU intent match: ret = %#v", e2.state("temp")["skill-choice-ret"])
	}

	// no nlu on the event: legacy throws TypeError when an intent keyword is tested
	e3 := choiceEnv(t, "hello", nil)
	e3.deps.BasicSkills = &BasicSkillsConfig{MatchNLU: true}
	if err := e3.run(t, "basic-skills/choice_parse_answer", parseArgs(map[string]any{"keywords": map[string]any{
		"hi": []any{"intent:greeting"},
	}})); err == nil {
		t.Errorf("missing event.nlu should be an error")
	}
}

func TestChoiceParseAnswerNoPreviewMatchOnNonString(t *testing.T) {
	e := choiceEnv(t, "", nil)
	e.ev["preview"] = 5.0
	if err := e.run(t, "basic-skills/choice_parse_answer", parseArgs(nil)); err == nil {
		t.Errorf("non-string preview should be an error (preview.match)")
	}
}

func TestChoiceInvalidAnswer(t *testing.T) {
	e := newEnv(t)
	e.mustRun(t, "basic-skills/choice_invalid_answer", map[string]any{"randomId": "r1"})
	if e.state("temp")["skill-choice-invalid-count-r1"] != 1.0 {
		t.Errorf("first invalid = %#v", e.state("temp")["skill-choice-invalid-count-r1"])
	}
	e.mustRun(t, "basic-skills/choice_invalid_answer", map[string]any{"randomId": "r1"})
	if e.state("temp")["skill-choice-invalid-count-r1"] != 2.0 {
		t.Errorf("second invalid = %#v", e.state("temp")["skill-choice-invalid-count-r1"])
	}

	// no randomId: bare key (old flows)
	e.mustRun(t, "basic-skills/choice_invalid_answer", nil)
	if e.state("temp")["skill-choice-invalid-count"] != 1.0 {
		t.Errorf("bare key = %#v", e.state("temp")["skill-choice-invalid-count"])
	}

	// JS "+" semantics: a stored string concatenates; null counts as 0
	e.state("temp")["skill-choice-invalid-count-s"] = "2"
	e.mustRun(t, "basic-skills/choice_invalid_answer", map[string]any{"randomId": "s"})
	if e.state("temp")["skill-choice-invalid-count-s"] != "21" {
		t.Errorf("string + 1 = %#v, want \"21\"", e.state("temp")["skill-choice-invalid-count-s"])
	}
	e.state("temp")["skill-choice-invalid-count-n"] = nil
	e.mustRun(t, "basic-skills/choice_invalid_answer", map[string]any{"randomId": "n"})
	if e.state("temp")["skill-choice-invalid-count-n"] != 1.0 {
		t.Errorf("null + 1 = %#v", e.state("temp")["skill-choice-invalid-count-n"])
	}
}

func TestJSHelpers(t *testing.T) {
	if got := jsToNumber(""); got != 0 {
		t.Errorf("Number('') = %v", got)
	}
	if got := jsToNumber(" 12 "); got != 12 {
		t.Errorf("Number(' 12 ') = %v", got)
	}
	if got := jsToNumber("1e3"); got != 1000 {
		t.Errorf("Number('1e3') = %v", got)
	}
	if got := jsToNumber("0x10"); got != 16 {
		t.Errorf("Number('0x10') = %v", got)
	}
	if got := jsToNumber("12px"); got == got { // NaN
		t.Errorf("Number('12px') should be NaN")
	}
	if got := jsToNumber("NaN"); got == got {
		t.Errorf("Number('NaN') should be NaN")
	}
	if got := jsToString(1.5); got != "1.5" {
		t.Errorf("String(1.5) = %q", got)
	}
	if got := jsToString(1e21); got != "1e+21" {
		t.Errorf("String(1e21) = %q", got)
	}
	if !strings.Contains(jsToString(map[string]any{}), "object") {
		t.Errorf("object to string")
	}
}
