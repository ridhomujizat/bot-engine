package studioapi

import (
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"unicode/utf16"
)

// Port of legacy (generateFlow, one-flow path)
// and (generateFlowLegacy), plus finalizeFlow.
// Only the "choice" skill of "basic-skills" is served: the other basic skills have no
// generator here, so listing them would offer skills the editor cannot generate.

const (
	skillModule     = "basic-skills"
	skillChoiceID   = "choice"
	choiceHardLimit = 10
	choiceMaxLabel  = 8
)

// SkillInfo is one entry of GET /modules/skills (legacy getAllSkills).
type SkillInfo struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Icon       string `json:"icon"`
	ModuleName string `json:"moduleName"`
}

// ListSkills returns the skills the editor can generate.
func ListSkills() []SkillInfo {
	return []SkillInfo{{
		ID:         skillChoiceID,
		Name:       "module.basic-skills.choice", // legacy sends the translation key; the editor translates it
		Icon:       "numbered-list",
		ModuleName: skillModule,
	}}
}

// IsChoiceSkill reports whether module/skill names a generator this package implements.
func IsChoiceSkill(module, skill string) bool {
	return module == skillModule && skill == skillChoiceID
}

// choiceInput holds the parts of the generateFlow body the generator reads.
type choiceInput struct {
	body            *OMap // full request body, kept for the legacy {...data, randomId} args
	contentID       string
	invalidContent  string
	hasInvalid      bool
	keywords        *OMap
	randomID        any // string or nil (undefined)
	nbMaxRetries    any
	repeatOnInvalid any
	variableName    any
}

func parseChoiceInput(body *OMap) (*choiceInput, error) {
	in := &choiceInput{body: body}
	kw, ok := body.Get("keywords")
	if !ok {
		return nil, errors.New("keywords is missing")
	}
	km, ok := kw.(*OMap)
	if !ok {
		return nil, errors.New("keywords must be an object")
	}
	in.keywords = km
	in.contentID = strOf(body, "contentId")
	if v, ok := body.Get("invalidContentId"); ok {
		s, _ := v.(string)
		in.invalidContent = s
		in.hasInvalid = s != ""
	}
	if v, ok := body.Get("randomId"); ok && v != nil {
		in.randomID = v
	}
	if cfgV, ok := body.Get("config"); ok {
		if cfg, ok := cfgV.(*OMap); ok {
			in.nbMaxRetries, _ = cfg.Get("nbMaxRetries")
			in.repeatOnInvalid, _ = cfg.Get("repeatChoicesOnInvalid")
			in.variableName, _ = cfg.Get("variableName")
		}
	}
	return in, nil
}

// effectiveRandomID is `variableName && variableName.length ? variableName: data.randomId`.
func (in *choiceInput) effectiveRandomID() any {
	if vn, ok := in.variableName.(string); ok && vn != "" {
		return vn
	}
	return in.randomID
}

// jsTruthyString returns the JS string form of a value that may be undefined ("undefined").
func jsString(v any) string {
	switch t := v.(type) {
	case nil:
		return "undefined"
	case string:
		return t
	case bool:
		if t {
			return "true"
		}
		return "false"
	case float64:
		return jsNumberString(t)
	case json.Number:
		if f, err := t.Float64(); err == nil {
			return jsNumberString(f)
		}
	}
	b, _ := MarshalJS(v, 0)
	return string(b)
}

func jsNumberString(f float64) string {
	switch {
	case math.IsNaN(f):
		return "NaN"
	case math.IsInf(f, 1):
		return "Infinity"
	case math.IsInf(f, -1):
		return "-Infinity"
	}
	if f == math.Trunc(f) && math.Abs(f) < 1e21 {
		return strconv.FormatFloat(f, 'f', -1, 64)
	}
	return strconv.FormatFloat(f, 'g', -1, 64)
}

// toJSNumber mirrors JS Number(v) for the values a body can carry.
func toJSNumber(v any) float64 {
	switch t := v.(type) {
	case nil:
		return math.NaN()
	case float64:
		return t
	case json.Number:
		f, err := t.Float64()
		if err != nil {
			return math.NaN()
		}
		return f
	case bool:
		if t {
			return 1
		}
		return 0
	case string:
		s := strings.TrimSpace(t)
		if s == "" {
			return 0
		}
		f, err := strconv.ParseFloat(s, 64)
		if err != nil {
			return math.NaN()
		}
		return f
	}
	return math.NaN()
}

// ynBool mirrors the `yn` package on the values used here.
func ynBool(v any) bool {
	switch t := v.(type) {
	case bool:
		return t
	case string:
		switch strings.ToLower(strings.TrimSpace(t)) {
		case "y", "yes", "true", "1", "on":
			return true
		}
	case float64:
		return t == 1
	case json.Number:
		return t.String() == "1"
	}
	return false
}

// jsKeys returns Object.keys order: integer-like keys ascending first, then insertion order.
func jsKeys(m *OMap) []string {
	var ints, rest []string
	for _, k := range m.Keys {
		if isArrayIndex(k) {
			ints = append(ints, k)
		} else {
			rest = append(rest, k)
		}
	}
	sort.SliceStable(ints, func(i, j int) bool {
		a, _ := strconv.ParseUint(ints[i], 10, 32)
		b, _ := strconv.ParseUint(ints[j], 10, 32)
		return a < b
	})
	return append(ints, rest...)
}

func isArrayIndex(k string) bool {
	if k == "" || (len(k) > 1 && k[0] == '0') {
		return false
	}
	n, err := strconv.ParseUint(k, 10, 32)
	return err == nil && n < math.MaxUint32
}

// jsSubstr returns the first n UTF-16 code units of s, as String.prototype.substr(0, n).
func jsSubstr(s string, n int) string {
	u := utf16.Encode([]rune(s))
	if len(u) < n {
		n = len(u)
	}
	return string(utf16.Decode(u[:n]))
}

// jsLength is String.prototype.length (UTF-16 code units).
func jsLength(s string) int { return len(utf16.Encode([]rune(s))) }

func choiceLabel(choice string) string {
	if jsLength(choice) > choiceMaxLabel {
		return jsSubstr(choice, choiceMaxLabel-1) + "..."
	}
	return choice
}

// jsonArgs encodes an args object the way JSON.stringify does (undefined values omitted).
func jsonArgs(m *OMap) string {
	b, _ := MarshalJS(m, 0)
	return string(b)
}

// runAction is the string form of a RunAction with optional args (skill-service actionToString).
func runAction(name string, args *OMap) string {
	if args == nil {
		return name
	}
	return name + " " + jsonArgs(args)
}

// sayElement is the string form of a RenderElement; nil args become {} (as `action.args || {}`).
func sayElement(name string, args *OMap) string {
	if args == nil {
		args = NewOMap()
	}
	return "say " + name + " " + jsonArgs(args)
}

// randomDigits mirrors customAlphabet('1234567890', 6) from nanoid.
func randomDigits(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	out := make([]byte, n)
	for i := range b {
		out[i] = byte('0' + b[i]%10)
	}
	return string(out)
}

// node builds a flow node in the key order legacy produces: the literal keys first, then
// the defaults finalizeFlow fills in (onEnter, onReceive, next, id), with a random id.
func node(literal []kv, defaults ...string) *OMap {
	m := NewOMap()
	for _, p := range literal {
		m.Set(p.k, p.v)
	}
	for _, d := range defaults {
		switch d {
		case "onEnter":
			if _, ok := m.Get("onEnter"); !ok {
				m.Set("onEnter", []any{})
			}
		case "onReceive":
			// legacy leaves onReceive undefined when absent, which JSON omits.
		case "next":
			if _, ok := m.Get("next"); !ok {
				m.Set("next", []any{})
			}
		}
	}
	m.Set("id", randomDigits(6))
	return m
}

type kv struct {
	k string
	v any
}

func trans(cond, to string) *OMap {
	m := NewOMap()
	m.Set("condition", cond)
	m.Set("node", to)
	return m
}

// finishFlow builds {flow:{nodes,catchAll,version,name,location,startNode}, transitions}.
func finishFlow(nodes []any, transitions []any) *OMap {
	name := randomDigits(6)
	flow := NewOMap()
	flow.Set("nodes", nodes)
	flow.Set("catchAll", map[string]any{"next": []any{}})
	flow.Set("version", "0.0")
	flow.Set("name", name)
	flow.Set("location", name)
	flow.Set("startNode", nodeName(nodes[0]))
	out := NewOMap()
	out.Set("flow", flow)
	out.Set("transitions", transitions)
	return out
}

func nodeName(v any) string {
	if m, ok := v.(*OMap); ok {
		n, _ := m.Get("name")
		s, _ := n.(string)
		return s
	}
	return ""
}

// GenerateChoice returns the finalized flow and transitions for a choice skill
// (POST /legacy). isOneFlow selects the one-flow path.
func GenerateChoice(body *OMap, isOneFlow bool) (*OMap, error) {
	in, err := parseChoiceInput(body)
	if err != nil {
		return nil, err
	}
	if isOneFlow {
		return generateOneFlow(in)
	}
	return generateLegacy(in)
}

// retryLimit mirrors Math.min(Number(nbMaxRetries), 10) as printed into a condition.
func retryLimit(in *choiceInput) string {
	n := toJSNumber(in.nbMaxRetries)
	if math.IsNaN(n) {
		return "NaN"
	}
	return jsNumberString(math.Min(n, choiceHardLimit))
}

func keySuffixOf(rid any) string {
	if s, ok := rid.(string); ok && s != "" {
		return "-" + s
	}
	return ""
}

func sorrySteps(in *choiceInput) []any {
	var steps []any
	if in.hasInvalid && jsLength(in.invalidContent) >= 3 {
		steps = append(steps, sayElement("#!"+in.invalidContent, nil))
	}
	if ynBool(in.repeatOnInvalid) {
		args := NewOMap()
		args.Set("skill", "choice")
		steps = append(steps, sayElement("#!"+in.contentID, args))
	}
	if steps == nil {
		steps = []any{}
	}
	return steps
}

func setVar(name, value string) string {
	return "builtin/setVariable {\"type\":\"temp\",\"name\":\"" + name + "\",\"value\": " + value + "}"
}

func randomArgs(rid any) *OMap {
	args := NewOMap()
	if rid != nil {
		args.Set("randomId", rid)
	}
	return args
}

func generateLegacy(in *choiceInput) (*OMap, error) {
	rid := in.effectiveRandomID()
	ridS := jsString(rid)
	suffix := keySuffixOf(rid)
	limit := retryLimit(in)

	// {...data, randomId}: keep the body's key order; randomId is overwritten in place.
	parseArgs := in.body.Clone()
	if rid != nil {
		parseArgs.Set("randomId", rid)
	} else {
		parseArgs.Delete("randomId")
	}

	entryOnEnter := []any{
		setVar("skill-choice-invalid-count"+suffix, "0"),
		setVar("skill-choice-valid"+suffix, "null"),
		setVar("skill-choice-ret"+suffix, "null"),
	}
	sayArgs := NewOMap()
	sayArgs.Set("skill", "choice")
	entryOnEnter = append(entryOnEnter, sayElement("#!"+in.contentID, sayArgs))

	entry := node([]kv{
		{"name", "entry"},
		{"onEnter", entryOnEnter},
		{"next", []any{trans("true", "parse")}},
	}, "onReceive")

	parse := node([]kv{
		{"name", "parse"},
		{"onReceive", []any{runAction("basic-skills/choice_parse_answer", parseArgs)}},
		{"next", []any{
			trans("temp['skill-choice-valid-"+ridS+"'] === true", "#"),
			trans("true", "invalid"),
		}},
		{"triggers", []any{map[string]any{"conditions": []any{map[string]any{"id": "always"}}}}},
	}, "onEnter")

	invalid := node([]kv{
		{"name", "invalid"},
		{"onEnter", []any{runAction("basic-skills/choice_invalid_answer", randomArgs(rid))}},
		{"next", []any{
			trans("Number(temp['skill-choice-invalid-count-"+ridS+"']) > Number("+limit+")", "#"),
			trans("true", "sorry"),
		}},
	})

	sorry := node([]kv{
		{"name", "sorry"},
		{"onEnter", sorrySteps(in)},
		{"next", []any{trans("true", "parse")}},
	})

	var transitions []any
	for _, choice := range jsKeys(in.keywords) {
		transitions = append(transitions, transition(
			"User picked ["+choiceLabel(choice)+"]",
			"temp['skill-choice-ret-"+ridS+"'] == \""+choice+"\"",
		))
	}
	transitions = append(transitions, transition("On failure", "true"))

	return finishFlow([]any{entry, parse, invalid, sorry}, transitions), nil
}

func transition(caption, cond string) *OMap {
	m := NewOMap()
	m.Set("caption", caption)
	m.Set("condition", cond)
	m.Set("node", "")
	return m
}

func generateOneFlow(in *choiceInput) (*OMap, error) {
	rid := in.effectiveRandomID()
	ridS := jsString(rid)
	suffix := keySuffixOf(rid)
	limit := retryLimit(in)

	// One-flow entry uses the spaced form `"value": 0 }` that legacy emits here (legacy has `0}`).
	entryOnEnter := []any{
		"builtin/setVariable {\"type\":\"temp\",\"name\":\"skill-choice-invalid-count" + suffix + "\",\"value\": 0 }",
	}
	sayArgs := NewOMap()
	sayArgs.Set("skill", "choice")
	entryOnEnter = append(entryOnEnter, sayElement("#!"+in.contentID, sayArgs))

	entry := node([]kv{
		{"name", "entry"},
		{"onEnter", entryOnEnter},
		{"onReceive", []any{}},
		{"next", []any{trans("true", "wait")}},
	})
	wait := node([]kv{
		{"name", "wait"},
		{"onReceive", []any{}},
		{"next", []any{trans("true", "wait")}},
	}, "onEnter")

	failureOnEnter := []any{runAction("basic-skills/choice_invalid_answer", randomArgs(rid))}
	failureOnEnter = append(failureOnEnter, sorrySteps(in)...)
	failure := node([]kv{
		{"name", "failure"},
		{"type", "trigger"},
		{"conditions", []any{map[string]any{
			"id":     "custom_confidence",
			"params": map[string]any{"confidence": "0.3"},
		}}},
		{"onEnter", failureOnEnter},
		{"onReceive", []any{}},
		{"next", []any{
			trans("Number(temp['skill-choice-invalid-count-"+ridS+"']) > Number("+limit+")", "#"),
			trans("true", "failure"),
		}},
		{"activeWorkflow", true},
	})

	nodes := []any{entry, wait, failure}
	var transitions []any
	for idx, choice := range jsKeys(in.keywords) {
		index := idx + 1
		success := fmt.Sprintf("success-%d", index)
		val, _ := in.keywords.Get(choice)

		addTrigger := func(kind string, cond *OMap) {
			nodes = append(nodes, node([]kv{
				{"name", fmt.Sprintf("trigger-%d-%s", index, kind)},
				{"type", "trigger"},
				{"activeWorkflow", true},
				{"onEnter", []any{}},
				{"next", []any{trans("true", success)}},
				{"conditions", []any{cond}},
			}))
		}

		entityParams := NewOMap()
		entityParams.Set("type", "system.number")
		entityParams.Set("comparison", "equal")
		entityParams.Set("expectedValue", float64(index))
		entity := NewOMap()
		entity.Set("id", "extracted_entity")
		entity.Set("params", entityParams)
		addTrigger("entity", entity)

		if strings.HasPrefix(choice, "intent:") {
			s, ok := val.(string)
			if !ok {
				return nil, errors.New("intent keyword value must be a string")
			}
			params := NewOMap()
			params.Set("intentName", strings.Replace(s, "intent:", "", 1))
			c := NewOMap()
			c.Set("id", "user_intent_is")
			c.Set("params", params)
			addTrigger("intent", c)
		} else {
			params := NewOMap()
			params.Set("candidate", val)
			params.Set("exactMatch", false)
			c := NewOMap()
			c.Set("id", "type_text")
			c.Set("params", params)
			addTrigger("text", c)
		}

		nodes = append(nodes, node([]kv{
			{"name", success},
			{"type", "success"},
			{"next", []any{trans("true", "#")}},
		}, "onEnter"))

		transitions = append(transitions, transition(
			"User picked ["+choiceLabel(choice)+"]",
			fmt.Sprintf("lastNode=success-%d", index),
		))
	}
	transitions = append(transitions, transition("On failure", "true"))

	return finishFlow(nodes, transitions), nil
}

// generateNotFound is the legacy 404 body for an unknown module or skill.
const generateNotFound = "Invalid module name or flow name"

// ParseGenerateQuery reads the isOneFlow query flag the way legacy does (yn(req.query.isOneFlow)).
func ParseGenerateQuery(v string) bool { return ynBool(v) }
