package flow

import (
	"fmt"
	"regexp"
	"sort"
	"strings"

	"github.com/ridhomujizat/bot-engine/internal/model"
)

// Locked scope (plan 2a, 3). Anything else is rejected at load time.

var allowedNodeTypes = map[string]bool{"": true, "standard": true, "skill-call": true}

var allowedContentTypes = map[string]bool{
	"builtin_text":          true,
	"builtin_single-choice": true,
	"builtin_carousel":      true,
	"builtin_card":          true,
	"builtin_image":         true,
	"builtin_file":          true,
}

var allowedBuiltinActions = map[string]bool{
	"builtin/setVariable":                    true,
	"builtin/removeVariable":                 true,
	"builtin/resetSession":                   true,
	"builtin/resetContext":                   true,
	"builtin/appendContext":                  true,
	"builtin/incrementNumberOfConversations": true,
	"builtin/getGlobalVariable":              true,
	"builtin/resetGlobalVariable":            true,
	"builtin/wait":                           true,
	"basic-skills/choice_parse_answer":       true,
	"basic-skills/choice_invalid_answer":     true,
}

var allowedHooks = map[string]bool{"before_conversation_end": true}

// bp.* members a bot action may use. "logger" accepts any member.
var allowedBP = map[string]bool{
	"cms.renderElement":          true,
	"events.replyToEvent":        true,
	"database.insertAndRetrieve": true,
}

var allowedRequire = map[string]bool{
	"axios": true, "form-data": true, "qs": true, "moment": true, "crypto": true, "lodash": true,
}

var (
	reBP          = regexp.MustCompile(`\bbp\.([A-Za-z_$][\w$]*)(?:\.([A-Za-z_$][\w$]*))?`)
	reRequireAll  = regexp.MustCompile(`\brequire\s*\(`)
	reRequireLit  = regexp.MustCompile(`\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)`)
	reMustacheBlk = regexp.MustCompile(`\{\{\s*[#^/>=]`)
)

func validate(bot *model.Bot) []Issue {
	var v validator
	v.bot = bot

	for _, name := range sortedKeys(bot.Flows) {
		v.flow(name, bot.Flows[name])
	}
	for _, id := range sortedKeys(bot.ContentElements) {
		v.element(id, bot.ContentElements[id])
	}
	for _, name := range sortedKeys(bot.Actions) {
		v.code("actions/"+name+".js", bot.Actions[name])
	}
	for _, hookType := range sortedKeys(bot.Hooks) {
		if !allowedHooks[hookType] {
			v.add("hooks/"+hookType, "hook type %q is not supported (only before_conversation_end)", hookType)
		}
		for _, h := range bot.Hooks[hookType] {
			v.code("hooks/"+hookType+"/"+h.Name+".js", h.Code)
		}
	}
	return v.issues
}

type validator struct {
	bot    *model.Bot
	issues []Issue
}

func (v *validator) add(file, format string, args ...any) {
	v.issues = append(v.issues, Issue{File: file, Message: fmt.Sprintf(format, args...)})
}

func (v *validator) flow(name string, fl *model.Flow) {
	file := "flows/" + name
	nodes := map[string]bool{}
	for _, n := range fl.Nodes {
		if n != nil {
			nodes[n.Name] = true
		}
	}
	if !nodes[fl.StartNode] {
		v.add(file, "startNode %q does not exist", fl.StartNode)
	}
	if fl.TimeoutNode != "" && !nodes[fl.TimeoutNode] {
		v.add(file, "timeoutNode %q does not exist", fl.TimeoutNode)
	}
	if fl.CatchAll != nil {
		v.actions(file+" (catchAll)", fl.CatchAll, name, nodes)
	}
	for _, n := range fl.Nodes {
		if n == nil {
			continue
		}
		where := fmt.Sprintf("%s (node %q)", file, n.Name)
		if !allowedNodeTypes[n.Type] {
			v.add(where, "node type %q is not supported (only standard and skill-call)", n.Type)
		}
		if n.Type == "skill-call" {
			if n.Skill != "choice" {
				v.add(where, "skill %q is not supported (only choice)", n.Skill)
			}
			if _, ok := v.bot.Flows[n.Flow]; n.Flow == "" || !ok {
				v.add(where, "skill flow %q not found", n.Flow)
			}
		}
		if n.TimeoutNode != "" && !nodes[n.TimeoutNode] {
			v.add(where, "timeoutNode %q does not exist", n.TimeoutNode)
		}
		v.actions(where, &n.NodeActions, name, nodes)
	}
}

// actions checks instructions and transition targets of one node or catchAll.
func (v *validator) actions(where string, na *model.NodeActions, flowName string, nodes map[string]bool) {
	for _, ins := range na.OnEnter {
		v.instruction(where, ins)
	}
	if na.OnReceive != nil {
		for _, ins := range *na.OnReceive {
			v.instruction(where, ins)
		}
	}
	for _, t := range na.Next {
		if t == nil {
			continue
		}
		v.target(where, t.Node, flowName, nodes)
	}
}

// instruction checks one "say #!id", "builtin/x {json}" or "action {json}" string.
func (v *validator) instruction(where, ins string) {
	s := strings.TrimSpace(ins)
	head, rest := s, ""
	if i := strings.IndexAny(s, " \t\n"); i >= 0 {
		head, rest = s[:i], strings.TrimSpace(s[i+1:])
	}
	if head == "say" {
		if !strings.HasPrefix(rest, "#!") {
			v.add(where, "instruction %q not supported (only say #!<id>)", ins)
			return
		}
		id := strings.Fields(rest[2:])
		if len(id) == 0 || v.bot.ContentElements[id[0]] == nil {
			// legacy accepts this at save time and fails at runtime (error flow): warn, don't reject.
			v.warn(where, "content element %q not found", rest)
		}
		return
	}
	if allowedBuiltinActions[head] {
		return
	}
	if strings.HasPrefix(head, "builtin/") || strings.HasPrefix(head, "basic-skills/") {
		v.add(where, "builtin action %q is not supported", head)
		return
	}
	if _, ok := v.bot.Actions[head]; !ok {
		// legacy missing action -> runtime error -> error flow. Warn, don't reject.
		v.warn(where, "action %q not found", head)
	}
}

// target checks a transition destination.
func (v *validator) target(where, t, flowName string, nodes map[string]bool) {
	switch t {
	case "", "#", "##", "END":
		return
	}
	if strings.HasPrefix(t, "#") {
		// "#node": jump to a node in the current flow.
		if !nodes[t[1:]] {
			v.warn(where, "transition target %q not found in flow %s", t, flowName)
		}
		return
	}
	if idx := strings.Index(t, ".flow.json"); idx >= 0 {
		end := idx + len(".flow.json")
		flowRef := t[:end]
		fl, ok := v.bot.Flows[flowRef]
		if !ok {
			v.warn(where, "transition target flow %q not found", flowRef)
			return
		}
		if end < len(t) && t[end] == '#' {
			node := t[end+1:]
			found := false
			for _, n := range fl.Nodes {
				if n != nil && n.Name == node {
					found = true
					break
				}
			}
			if !found {
				v.warn(where, "transition target node %q not found in %s", node, flowRef)
			}
		}
		return
	}
	if !nodes[t] {
		v.warn(where, "transition target %q not found in flow %s", t, flowName)
	}
}

// warn records a finding legacy tolerates at runtime (for example a dangling
// transition target). It does not reject the bot.
func (v *validator) warn(file, format string, args ...any) {
	v.issues = append(v.issues, Issue{File: file, Message: fmt.Sprintf(format, args...), Warn: true})
}

func (v *validator) element(id string, el *model.ContentElement) {
	file := "content-elements/" + el.ContentType + ".json#" + id
	if !allowedContentTypes[el.ContentType] {
		v.add(file, "content type %q is not supported", el.ContentType)
		return
	}
	for _, key := range sortedKeys(el.FormData) {
		val := el.FormData[key]
		if s, ok := val.(string); ok && reMustacheBlk.MatchString(s) {
			v.add(file, "property %q uses Mustache sections or partials (not supported)", key)
		}
		if arr, ok := val.([]any); ok {
			for _, item := range arr {
				if s, ok := item.(string); ok && reMustacheBlk.MatchString(s) {
					v.add(file, "property %q uses Mustache sections or partials (not supported)", key)
				}
			}
		}
	}
}

// code rejects bp.* members and require modules outside the A0 scope.
func (v *validator) code(file, src string) {
	for _, m := range reBP.FindAllStringSubmatch(src, -1) {
		if m[1] == "logger" {
			continue
		}
		key := m[1]
		if m[2] != "" {
			key += "." + m[2]
		}
		if !allowedBP[key] {
			v.add(file, "bp.%s is not supported", key)
		}
	}
	lits := reRequireLit.FindAllStringSubmatch(src, -1)
	if len(lits) != len(reRequireAll.FindAllStringIndex(src, -1)) {
		v.add(file, "require() with a non-literal argument is not supported")
	}
	for _, m := range lits {
		if !allowedRequire[m[1]] {
			v.add(file, "require(%q) is not supported", m[1])
		}
	}
}

func sortedKeys[T any](m map[string]T) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
