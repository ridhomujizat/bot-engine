package engine

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// Scenario files live in testdata/scenarios/*.json. Each file is one bot and a
// list of steps; a step is one converse call for one user. Expectations are
// partial: every expected response object must be a subset of the matching
// actual response, and the response count must match exactly.
//
//	{
//	 "name": "...", "bot": "synthetic-core",
//	 "steps": [
//	 {"user": "u1", "message": {"type": "text", "text": "hi"},
//	 "include": ["state"],
//	 "expect": {
//	 "responses": [{"type": "text", "text": "Hello, say something"}],
//	 "currentFlow": "main.flow.json", "currentNode": "entry",
//	 "stacktrace": ["main.flow.json|entry"],
//	 "contextEmpty": false
//	 }}
//	 ]
//	}
//
// Fields in expect are optional. Only the fields legacy returns to client worker and
// the parity-relevant state fields are checked.
type scenario struct {
	Name  string         `json:"name"`
	Bot   string         `json:"bot"`
	Steps []scenarioStep `json:"steps"`
}

type scenarioStep struct {
	Name    string         `json:"name"`
	User    string         `json:"user"`
	Message map[string]any `json:"message"`
	Include []string       `json:"include"`
	Expect  scenarioExpect `json:"expect"`
}

type scenarioExpect struct {
	Responses    []map[string]any `json:"responses"`
	CurrentFlow  *string          `json:"currentFlow"`
	CurrentNode  *string          `json:"currentNode"`
	Stacktrace   []string         `json:"stacktrace"`
	ContextEmpty *bool            `json:"contextEmpty"`
}

func TestScenarios(t *testing.T) {
	files, err := filepath.Glob("../../testdata/scenarios/*.json")
	if err != nil {
		t.Fatal(err)
	}
	if len(files) == 0 {
		t.Fatal("no scenario files found")
	}
	for _, file := range files {
		raw, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		var sc scenario
		if err := json.Unmarshal(raw, &sc); err != nil {
			t.Fatalf("%s: %v", file, err)
		}
		t.Run(strings.TrimSuffix(filepath.Base(file), ".json"), func(t *testing.T) {
			runScenario(t, sc)
		})
	}
}

func runScenario(t *testing.T, sc scenario) {
	env := newTestEnv(t, copyBot(t, sc.Bot))
	for i, st := range sc.Steps {
		name := st.Name
		if name == "" {
			name = "step" + string(rune('1'+i))
		}
		t.Run(name, func(t *testing.T) {
			out := env.converse(t, sc.Bot, st.User, st.Message, append([]string{"state"}, st.Include...)...)
			checkExpect(t, out, st.Expect)
		})
	}
}

func checkExpect(t *testing.T, out map[string]any, ex scenarioExpect) {
	t.Helper()
	list, _ := out["responses"].([]any)
	if ex.Responses != nil {
		if len(list) != len(ex.Responses) {
			t.Fatalf("got %d responses, want %d: %v", len(list), len(ex.Responses), list)
		}
		for i, want := range ex.Responses {
			got, _ := list[i].(map[string]any)
			for k, v := range want {
				if !reflect.DeepEqual(got[k], v) {
					t.Fatalf("response[%d].%s = %v, want %v (full: %v)", i, k, got[k], v, got)
				}
			}
		}
	}

	st := stateOfResp(t, out)
	c := contextOfState(st)
	if ex.CurrentFlow != nil && c["currentFlow"] != *ex.CurrentFlow {
		t.Fatalf("currentFlow = %v, want %s", c["currentFlow"], *ex.CurrentFlow)
	}
	if ex.CurrentNode != nil && c["currentNode"] != *ex.CurrentNode {
		t.Fatalf("currentNode = %v, want %s", c["currentNode"], *ex.CurrentNode)
	}
	if ex.ContextEmpty != nil && (len(c) == 0) != *ex.ContextEmpty {
		t.Fatalf("context = %v, contextEmpty want %v", c, *ex.ContextEmpty)
	}
	if ex.Stacktrace != nil {
		var got []string
		trace, _ := st["__stacktrace"].([]any)
		for _, item := range trace {
			m, _ := item.(map[string]any)
			got = append(got, m["flow"].(string)+"|"+m["node"].(string))
		}
		if strings.Join(got, ",") != strings.Join(ex.Stacktrace, ",") {
			t.Fatalf("stacktrace = %v, want %v", got, ex.Stacktrace)
		}
	}
}
