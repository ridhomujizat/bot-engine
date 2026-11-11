package studioapi

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

const sampleChoice = "../../testdata/bots/synthetic-choice/flows/skills/choice-a1bdc2.flow.json"

// stripIDs removes the random node ids (top-level "id" of each node) so generated and
// saved flows compare structurally. Ids inside conditions (e.g. {"id":"always"}) stay.
func stripIDs(v any) any {
	nodes, ok := v.([]any)
	if !ok {
		return v
	}
	out := make([]any, len(nodes))
	for i, n := range nodes {
		m, ok := n.(map[string]any)
		if !ok {
			out[i] = n
			continue
		}
		c := map[string]any{}
		for k, val := range m {
			if k != "id" {
				c[k] = val
			}
		}
		out[i] = c
	}
	return out
}

// The sample saved by legacy was generated from the body in its skillData. Feeding that body
// to the legacy generator must give the same nodes (ids excluded) and the same key order.
func TestLegacyChoiceMatchesLegacySample(t *testing.T) {
	raw, err := os.ReadFile(filepath.FromSlash(sampleChoice))
	if err != nil {
		t.Fatal(err)
	}
	var sample struct {
		SkillData json.RawMessage `json:"skillData"`
	}
	if err := json.Unmarshal(raw, &sample); err != nil {
		t.Fatal(err)
	}
	body, err := decodeOrdered(sample.SkillData)
	if err != nil {
		t.Fatal(err)
	}
	gen, err := GenerateChoice(body.(*OMap), false)
	if err != nil {
		t.Fatal(err)
	}
	genJSON, _ := MarshalJS(gen, 0)

	var got, want map[string]any
	if err := json.Unmarshal(genJSON, &got); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &want); err != nil {
		t.Fatal(err)
	}
	gotNodes := stripIDs(got["flow"].(map[string]any)["nodes"])
	wantNodes := stripIDs(want["nodes"])
	if !reflect.DeepEqual(gotNodes, wantNodes) {
		g, _ := json.MarshalIndent(gotNodes, "", "  ")
		w, _ := json.MarshalIndent(wantNodes, "", "  ")
		t.Fatalf("nodes differ.\nwant:\n%s\ngot:\n%s", w, g)
	}

	// Key order of the first node (name, onEnter, next, id) must match the saved file.
	first := gen.Vals["flow"].(*OMap).Vals["nodes"].([]any)[0].(*OMap)
	if strings.Join(first.Keys, ",") != "name,onEnter,next,id" {
		t.Fatalf("entry key order: %v", first.Keys)
	}

	// Envelope: flow then transitions; flow keys follow finalizeFlow.
	flow := gen.Vals["flow"].(*OMap)
	if strings.Join(flow.Keys, ",") != "nodes,catchAll,version,name,location,startNode" {
		t.Fatalf("flow keys: %v", flow.Keys)
	}
	if len(gen.Vals["transitions"].([]any)) != 9 { // 8 keywords + On failure
		t.Fatalf("transitions: %d", len(gen.Vals["transitions"].([]any)))
	}
}

func TestChoiceLabelUsesUTF16Units(t *testing.T) {
	if got := choiceLabel("abcdefghij"); got != "abcdefg..." {
		t.Fatalf("long label: %q", got)
	}
	if got := choiceLabel("abcdefgh"); got != "abcdefgh" {
		t.Fatalf("8-char label changed: %q", got)
	}
	// U+1F600 is two UTF-16 units: 5 emoji = 10 units, so the label is cut to 7 units plus "...".
	if got := choiceLabel(strings.Repeat("\U0001F600", 5)); jsLength(got) != 10 {
		t.Fatalf("surrogate label length: %d units", jsLength(got))
	}
}

func TestOneFlowChoiceShape(t *testing.T) {
	body, _ := decodeOrdered([]byte(`{"randomId":"r1","contentId":"builtin_single-choice-x","invalidContentId":"","keywords":{"intent:greet":"intent:greet","Support":["Support"]},"config":{"nbMaxRetries":"2","repeatChoicesOnInvalid":"true","variableName":""}}`))
	gen, err := GenerateChoice(body.(*OMap), true)
	if err != nil {
		t.Fatal(err)
	}
	nodes := gen.Vals["flow"].(*OMap).Vals["nodes"].([]any)
	var names []string
	for _, n := range nodes {
		names = append(names, nodeName(n))
	}
	want := "entry,wait,failure,trigger-1-entity,trigger-1-intent,success-1,trigger-2-entity,trigger-2-text,success-2"
	if strings.Join(names, ",") != want {
		t.Fatalf("node order:\n got %s\nwant %s", strings.Join(names, ","), want)
	}
	b, _ := MarshalJS(gen, 0)
	s := string(b)
	for _, frag := range []string{
		`\"value\": 0 }`,          // one-flow spacing
		`"intentName":"greet"`,    // intent prefix stripped
		`"candidate":["Support"]`, // non-intent keyword kept as given
		`"lastNode=success-2"`,    // transitions use lastNode
		`Number(temp['skill-choice-invalid-count-r1']) > Number(2)`, // nbMaxRetries string "2" parsed
	} {
		if !strings.Contains(s, frag) {
			t.Fatalf("missing %s in %s", frag, s)
		}
	}
}

func TestChoiceRequiresKeywords(t *testing.T) {
	body, _ := decodeOrdered([]byte(`{"contentId":"x"}`))
	if _, err := GenerateChoice(body.(*OMap), false); err == nil {
		t.Fatal("missing keywords accepted")
	}
}

func TestSkillsListOnlyChoice(t *testing.T) {
	s := ListSkills()
	if len(s) != 1 || s[0].ID != "choice" || s[0].ModuleName != "basic-skills" {
		t.Fatalf("skills: %+v", s)
	}
}
