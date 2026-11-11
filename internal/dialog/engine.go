// Package dialog ports the legacy dialog engine: processing of events, transitions,
// subflows, jumps, timeouts and end of flow, plus the instruction strategies (say, action,
// transition) and flow navigation. The event is a JSON-like map shared with the engine package.
//
// The engine keeps no per-turn state of its own: everything lives in the event
// map, so one *Engine can serve many turns concurrently.
package dialog

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/ridhomujizat/bot-engine/internal/builtin"
	"github.com/ridhomujizat/bot-engine/internal/cms"
	"github.com/ridhomujizat/bot-engine/internal/event"
	"github.com/ridhomujizat/bot-engine/internal/model"
	"github.com/ridhomujizat/bot-engine/internal/state"
	"github.com/ridhomujizat/bot-engine/internal/usercode"
)

const (
	mainFlow       = "main.flow.json"
	errorFlowName  = "error.flow.json"
	timeoutFlow    = "timeout.flow.json"
	convEndFlow    = "conversation_end.flow.json"
	skillsPrefix   = "skills/"
	beforeConvEnd  = "before_conversation_end"
	defaultErrorTo = errorFlowName
)

// Outbox receives payloads in the order legacy would send them (outgoing events).
// The engine collects them into the converse response.
type Outbox interface {
	Emit(ctx context.Context, payloads []map[string]any) error
}

// Inserter backs bp.database.insertAndRetrieve.
type Inserter interface {
	InsertAndRetrieve(ctx context.Context, botID, table string, data map[string]any, returnColumns []string, idColumn string) (map[string]any, error)
}

// Deps are the collaborators of an Engine.
type Deps struct {
	Bot      *model.Bot
	UserCode usercode.Runner
	KVS      state.KVS
	Outbox   Outbox
	Inserter Inserter // optional; nil makes bp.database.insertAndRetrieve fail
	Picker   cms.Picker
	Logger   *slog.Logger // optional
	Now      func() time.Time
	// BasicSkills is the basic-skills module config (nil = builtin defaults).
	// Production sets MatchNumbers true and MatchNLU false (NLU is off).
	BasicSkills *builtin.BasicSkillsConfig
}

// Engine runs the dialog for one bot. It implements usercode.Host.
type Engine struct {
	d Deps
}

// New returns a dialog engine for d.Bot.
func New(d Deps) *Engine {
	if d.Logger == nil {
		d.Logger = slog.Default()
	}
	if d.Now == nil {
		d.Now = time.Now
	}
	return &Engine{d: d}
}

// ErrNoOutbox is returned when a reply is emitted without an Outbox.
var ErrNoOutbox = errors.New("dialog: no outbox configured")

func (e *Engine) botID() string { return e.d.Bot.ID }

func (e *Engine) now() time.Time { return e.d.Now() }

// FlowError mirrors FlowError.
type FlowError struct {
	Msg   string
	BotID string
	Flow  string
	Node  string
}

func (e *FlowError) Error() string {
	flow, node := e.Flow, e.Node
	if flow == "" {
		flow = "N/A"
	}
	if node == "" {
		node = "N/A"
	}
	return fmt.Sprintf("%s, Bot: %s, Flow: %s, Node: %s", e.Msg, e.BotID, flow, node)
}

// InfiniteLoopError mirrors InfiniteLoopError.
type InfiniteLoopError struct {
	FlowError
	RecurringPath []string
}

func (e *InfiniteLoopError) Error() string {
	return fmt.Sprintf("Infinite loop detected. (%s), Bot: %s, Flow: %s, Node: %s",
		strings.Join(e.RecurringPath, " --> "), e.BotID, orNA(e.Flow), orNA(e.Node))
}

func orNA(s string) string {
	if s == "" {
		return "N/A"
	}
	return s
}

// ---- flow lookup -----------------------------------------------------------

// findFlow mirrors _findFlow: name gets ". on" appended when missing,
// matched case-insensitively.
func (e *Engine) findFlow(name string) (*model.Flow, error) {
	if name == "" {
		return nil, &FlowError{Msg: "Could not find any flow.", BotID: e.botID()}
	}
	file := name
	if !strings.HasSuffix(file, ".flow.json") {
		file += ".flow.json"
	}
	if f, ok := e.d.Bot.Flows[file]; ok {
		return f, nil
	}
	for k, f := range e.d.Bot.Flows {
		if strings.EqualFold(k, file) {
			return f, nil
		}
	}
	return nil, &FlowError{Msg: "Flow not found: " + name, BotID: e.botID(), Flow: name}
}

func (e *Engine) findFlowWithoutError(name string) *model.Flow {
	f, err := e.findFlow(name)
	if err != nil {
		return nil
	}
	return f
}

// findNode mirrors _findNode.
func (e *Engine) findNode(flow *model.Flow, name string) (*model.FlowNode, error) {
	for _, n := range flow.Nodes {
		if n != nil && n.Name == name {
			return n, nil
		}
	}
	return nil, &FlowError{Msg: "Node not found: " + name, BotID: e.botID(), Flow: flow.Name, Node: name}
}

func (e *Engine) findNodeWithoutError(flow *model.Flow, name string) *model.FlowNode {
	if flow == nil {
		return nil
	}
	n, err := e.findNode(flow, name)
	if err != nil {
		return nil
	}
	return n
}

// ---- entry points ----------------------------------------------------------

// ProcessEvent runs processEvent on ev, mutating it in place.
func (e *Engine) ProcessEvent(ctx context.Context, ev map[string]any) error {
	return e.processEvent(ctx, ev)
}

// processEvent ports DialogEngine.processEvent.
func (e *Engine) processEvent(ctx context.Context, ev map[string]any) error {
	c := contextOf(ev)
	if len(c) == 0 {
		c = e.initializeContext(ev)
	}

	flow, err := e.findFlow(str(c, "currentFlow"))
	if err != nil {
		return err
	}
	node, err := e.findNode(flow, str(c, "currentNode"))
	if err != nil {
		return err
	}

	// skill-call nodes point to a subflow; skip when returning from it.
	if node.Type == "skill-call" && !e.exitingSubflow(ev) {
		return e.goToSubflow(ctx, ev, flow, node)
	}

	var q *queue
	if truthy(c["hasJumped"]) {
		q = newQueueBuilder(node, flow).withJumped().build()
		c["hasJumped"] = false
	} else if existing := loadQueue(c); existing != nil {
		q = existing
	} else {
		q = newQueueBuilder(node, flow).build()
	}

	instr, ok := q.dequeue()
	if !ok {
		// end session when no instruction is left.
		return e.endFlow(ctx, ev)
	}

	res, err := e.processInstruction(ctx, instr, ev)
	if err != nil {
		// errors while processing an instruction are logged, not thrown.
		e.reportProcessingError(ev, instr, err)
		return nil
	}

	switch res.kind {
	case resultNone:
		saveQueue(contextOf(ev), q)
		return e.processEvent(ctx, ev) // errors propagate, as in legacy
	case resultWait:
		saveQueue(contextOf(ev), q)
		return nil
	case resultTransition:
		dest := res.to
		if dest == "" {
			// red port: no destination, end the flow (inside legacy's try block).
			if err := e.endFlow(ctx, ev); err != nil {
				e.reportProcessingError(ev, instr, err)
			}
			return nil
		}
		// the queue is rebuilt from the next node.
		saveQueue(contextOf(ev), nil)

		err := e.transition(ctx, ev, dest)
		if err == nil {
			return nil
		}
		var loop *InfiniteLoopError
		if errors.As(err, &loop) {
			// Never transition to the error flow on a loop: clean up and report.
			e.cleanState(ev)
			e.reportProcessingError(ev, instr, err)
			return nil
		}
		errorFlow := e.errorFlowName(ev)
		if err2 := e.transition(ctx, ev, errorFlow); err2 != nil {
			e.reportProcessingError(ev, instr, err2)
		}
		return nil
	}
	return nil
}

// errorFlowName is temp.onErrorFlowTo, defaulting to error.flow.json.
func (e *Engine) errorFlowName(ev map[string]any) string {
	t := tempOf(ev)
	if hasStr(t, "onErrorFlowTo") {
		return str(t, "onErrorFlowTo")
	}
	return defaultErrorTo
}

// initializeContext ports DialogEngine.initializeContext.
func (e *Engine) initializeContext(ev map[string]any) map[string]any {
	flow, err := e.findFlow(mainFlow)
	if err != nil {
		// Surfaced by the caller's subsequent findFlow; keep an empty context.
		return contextOf(ev)
	}
	start, err := e.findNode(flow, flow.StartNode)
	if err != nil {
		return contextOf(ev)
	}
	pushStack(ev, flow.Name, start.Name)
	c := map[string]any{"currentNode": start.Name, "currentFlow": flow.Name}
	setContext(ev, c)
	return c
}

// exitingSubflow ports DialogEngine._exitingSubflow.
func (e *Engine) exitingSubflow(ev map[string]any) bool {
	c := contextOf(ev)
	var lastJump map[string]any
	for _, j := range jumpPoints(c) {
		if m, ok := j.(map[string]any); ok && truthy(m["used"]) {
			lastJump = m
			break
		}
	}
	if lastJump != nil && truthy(lastJump["executeNode"]) {
		return false
	}
	return lastJump != nil && str(lastJump, "flow") == str(c, "currentFlow") && str(lastJump, "node") == str(c, "currentNode")
}

// goToSubflow ports DialogEngine._goToSubflow.
func (e *Engine) goToSubflow(ctx context.Context, ev map[string]any, parentFlow *model.Flow, parentNode *model.FlowNode) error {
	sub, err := e.findFlow(parentNode.Flow)
	if err != nil {
		return err
	}
	start, err := e.findNode(sub, sub.StartNode)
	if err != nil {
		return err
	}
	old := contextOf(ev)
	jp := append(append([]any{}, jumpPoints(old)...), map[string]any{"flow": parentFlow.Name, "node": parentNode.Name})
	setContext(ev, map[string]any{
		"currentFlow":  sub.Name,
		"currentNode":  start.Name,
		"previousFlow": parentFlow.Name,
		"previousNode": parentNode.Name,
		"jumpPoints":   jp,
	})
	return e.processEvent(ctx, ev)
}

// transition ports DialogEngine._transition.
func (e *Engine) transition(ctx context.Context, ev map[string]any, to string) error {
	if err := detectInfiniteLoop(stacktrace(ev), e.botID()); err != nil {
		return err
	}

	c := contextOf(ev)
	filterUnusedJumpPoints(c)

	switch {
	case strings.Contains(to, ".flow.json"):
		// Transition to another flow, optionally at "#node".
		flowName, nodeName := to, ""
		if i := strings.Index(to, "#"); i != -1 {
			flowName, nodeName = to[:i], to[i+1:]
		}
		flow, err := e.findFlow(flowName)
		if err != nil {
			return err
		}
		if nodeName == "" {
			nodeName = flow.StartNode
		}
		start, err := e.findNode(flow, nodeName)
		if err != nil {
			return err
		}
		pushStack(ev, flow.Name, start.Name)

		jp := append(append([]any{}, jumpPoints(c)...), map[string]any{
			"flow": str(c, "currentFlow"),
			"node": str(c, "currentNode"),
		})
		nc := map[string]any{
			"currentFlow": flow.Name,
			"currentNode": start.Name,
			"jumpPoints":  jp,
		}
		if v, ok := c["currentFlow"]; ok {
			nc["previousFlow"] = v
		}
		if v, ok := c["currentNode"]; ok {
			nc["previousNode"] = v
		}
		setContext(ev, nc)

	case strings.HasPrefix(to, "#"):
		// Return to the calling node.
		jp := jumpPoints(c)
		prev := findLastUnused(jp)
		if jp == nil || prev == nil {
			return nil // no previous flow: the event is returned unchanged
		}
		execParent := strings.HasPrefix(to, "##")
		sep := "#"
		if execParent {
			sep = "##"
		}
		specific := ""
		if parts := strings.Split(to, sep); len(parts) > 1 {
			specific = parts[1]
		}
		if execParent {
			prev["executeNode"] = true
		}
		// Multiple transitions on a node each call processEvent; marking the jump used keeps
		// the second one from re-entering the exit path.
		prev["used"] = true

		parentFlow, err := e.findFlow(str(prev, "flow"))
		if err != nil {
			return err
		}
		parentNodeName := specific
		if parentNodeName == "" {
			parentNodeName = str(prev, "node")
		}
		parentNode, err := e.findNode(parentFlow, parentNodeName)
		if err != nil {
			return err
		}

		b := newQueueBuilder(parentNode, parentFlow)
		var q *queue
		if truthy(prev["executeNode"]) {
			q = b.build()
		} else {
			q = b.withOnlyTransitions().build()
		}
		pushStack(ev, parentFlow.Name, parentNode.Name)

		nc := copyMap(c)
		nc["currentNode"] = parentNode.Name
		nc["currentFlow"] = parentFlow.Name
		nc["jumpPoints"] = jp
		saveQueue(nc, q)
		setContext(ev, nc)

	case to == "END":
		return e.endFlow(ctx, ev)

	default:
		// Transition to a node of the current flow.
		pushStack(ev, str(c, "currentFlow"), to)
		flow, err := e.findFlow(str(c, "currentFlow"))
		if err != nil {
			return err
		}
		nc := copyMap(c)
		if strings.HasPrefix(flow.Name, skillsPrefix) {
			nc["currentNode"] = to
		} else {
			nc["previousNode"] = str(c, "currentNode")
			nc["currentNode"] = to
		}
		setContext(ev, nc)
	}

	return e.processEvent(ctx, ev)
}

// detectInfiniteLoop ports DialogEngine.detectInfiniteLoop:
// the first flow|node pair seen at least three times in the stacktrace.
func detectInfiniteLoop(stack []any, botID string) error {
	type group struct {
		entries []map[string]any
	}
	var order []string
	groups := map[string]*group{}
	for _, item := range stack {
		m, ok := item.(map[string]any)
		if !ok {
			continue
		}
		k := str(m, "flow") + "|" + str(m, "node")
		g, ok := groups[k]
		if !ok {
			g = &group{}
			groups[k] = g
			order = append(order, k)
		}
		g.entries = append(g.entries, m)
	}
	for _, k := range order {
		g := groups[k]
		if len(g.entries) < 3 {
			continue
		}
		first := g.entries[0]
		flow, node := str(first, "flow"), str(first, "node")
		var path []string
		r := 0
		for i := 0; i < len(stack) && r < 2; i++ {
			m, ok := stack[i].(map[string]any)
			if !ok {
				continue
			}
			if str(m, "flow") == flow && str(m, "node") == node {
				r++
			}
			if r > 0 {
				path = append(path, fmt.Sprintf("%s (%s)", str(m, "flow"), str(m, "node")))
			}
		}
		return &InfiniteLoopError{
			FlowError:     FlowError{Msg: "", BotID: botID, Flow: flow, Node: node},
			RecurringPath: path,
		}
	}
	return nil
}

// endFlow ports DialogEngine._endFlow.
func (e *Engine) endFlow(ctx context.Context, ev map[string]any) error {
	c := contextOf(ev)
	flow, err := e.findFlow(str(c, "currentFlow"))
	if err != nil {
		return err
	}
	switch flow.Name {
	case timeoutFlow:
		e.cleanState(ev)
		return nil
	case convEndFlow:
		return nil
	}

	hookJumped, err := e.runConvEndHook(ctx, ev)
	if err != nil {
		return err
	}
	if hookJumped {
		return nil
	}
	flowJumped, err := e.runConvEndFlow(ctx, ev)
	if err != nil {
		return err
	}
	if flowJumped {
		return nil
	}
	e.cleanState(ev)
	return nil
}

// runConvEndHook runs before_conversation_end hooks and reports whether they jumped.
func (e *Engine) runConvEndHook(ctx context.Context, ev map[string]any) (bool, error) {
	for _, h := range e.d.Bot.Hooks[beforeConvEnd] {
		sb := &usercode.Sandbox{BotID: e.botID(), Event: ev}
		err := e.d.UserCode.RunHook(ctx, beforeConvEnd, h.Name, h.Code, sb, e)
		replaceContents(ev, sb.Event)
		if err != nil {
			e.d.Logger.Warn("before_conversation_end hook failed", "botId", e.botID(), "hook", h.Name, "err", err)
		}
	}
	if truthy(contextOf(ev)["hasJumped"]) {
		return true, e.processEvent(ctx, ev)
	}
	return false, nil
}

// runConvEndFlow runs conversation_end.flow.json when present (not in the locked
// scope, kept for parity).
func (e *Engine) runConvEndFlow(ctx context.Context, ev map[string]any) (bool, error) {
	conv := e.findFlowWithoutError(convEndFlow)
	if conv == nil {
		return false, nil
	}
	c := contextOf(ev)
	cur := e.findFlowWithoutError(str(c, "currentFlow"))
	curNode := e.findNodeWithoutError(cur, str(c, "currentNode"))
	start, err := e.findNode(conv, conv.StartNode)
	if err != nil {
		return false, err
	}
	e.fillContextForTransition(ev, cur, curNode, conv, start)

	before := len(jumpPoints(contextOf(ev)))
	if err := e.processEvent(ctx, ev); err != nil {
		return false, err
	}
	return len(jumpPoints(contextOf(ev))) != before, nil
}

// fillContextForTransition ports DialogEngine.fillContextForTransition.
func (e *Engine) fillContextForTransition(ev map[string]any, cur *model.Flow, curNode *model.FlowNode, next *model.Flow, nextNode *model.FlowNode) {
	old := contextOf(ev)
	nc := copyMap(old)
	nc["currentNode"] = nextNode.Name
	nc["currentFlow"] = next.Name
	delete(nc, "queue")
	nc["hasJumped"] = true
	nc["previousFlow"] = ""
	nc["previousNode"] = ""
	if cur != nil {
		nc["previousFlow"] = cur.Name
	}
	if curNode != nil {
		nc["previousNode"] = curNode.Name
	}
	if cur != nil {
		entry := map[string]any{"flow": cur.Name}
		if curNode != nil {
			entry["node"] = curNode.Name
		}
		nc["jumpPoints"] = append(append([]any{}, jumpPoints(old)...), entry)
	}
	setContext(ev, nc)
}

// ProcessTimeout ports DialogEngine.processTimeout, without
// the global before_session_timeout hook (no bot hook of that type is in scope).
// It reports whether the event was processed (a timeout node or flow was found
// or the context already jumped).
func (e *Engine) ProcessTimeout(ctx context.Context, ev map[string]any) error {
	c := contextOf(ev)
	cur := e.findFlowWithoutError(str(c, "currentFlow"))
	curNode := e.findNodeWithoutError(cur, str(c, "currentNode"))

	// timeout node in the current flow, then the
	// previous flow for skills/, then the flow-level timeoutNode, then timeout.flow.json.
	var tNode *model.FlowNode
	tFlow := cur
	tNode = e.findNodeWithoutError(cur, "timeout")
	if tNode == nil && cur != nil && strings.HasPrefix(cur.Name, skillsPrefix) && hasStr(c, "previousFlow") {
		prev := e.findFlowWithoutError(str(c, "previousFlow"))
		tNode = e.findNodeWithoutError(prev, "timeout")
		tFlow = prev
	}
	if tNode == nil && tFlow != nil && tFlow.TimeoutNode != "" {
		tNode = e.findNodeWithoutError(tFlow, tFlow.TimeoutNode)
	}
	if tNode == nil {
		tFlow = e.findFlowWithoutError(timeoutFlow)
		if tFlow != nil {
			tNode = e.findNodeWithoutError(tFlow, tFlow.StartNode)
		}
	}

	if tNode != nil && tFlow != nil {
		e.fillContextForTransition(ev, cur, curNode, tFlow, tNode)
	} else if !truthy(contextOf(ev)["hasJumped"]) {
		return nil
	}
	return e.processEvent(ctx, ev)
}

// cleanState ports DialogEngine.cleanState.
func (e *Engine) cleanState(ev map[string]any) {
	stateOf(ev)["context"] = map[string]any{}
	stateOf(ev)["temp"] = map[string]any{}
}

// JumpTo ports DialogEngine.jumpTo for the error handler.
func (e *Engine) JumpTo(ctx context.Context, ev map[string]any, flowName, nodeName string) error {
	flow, err := e.findFlow(flowName)
	if err != nil {
		return err
	}
	name := flow.StartNode
	if nodeName != "" {
		name = nodeName
	}
	node, err := e.findNode(flow, name)
	if err != nil {
		return err
	}
	pushStack(ev, flow.Name, node.Name)
	c := contextOf(ev)
	c["currentFlow"] = flow.Name
	c["currentNode"] = node.Name
	delete(c, "queue")
	c["hasJumped"] = true
	return nil
}

// ---- instruction processing ------------------------------------------------

type resultKind int

const (
	resultNone resultKind = iota
	resultWait
	resultTransition
)

type result struct {
	kind resultKind
	to   string
}

// processInstruction ports InstructionProcessor.process.
func (e *Engine) processInstruction(ctx context.Context, in instruction, ev map[string]any) (result, error) {
	switch in.Type {
	case "on-enter", "on-receive":
		if strings.HasPrefix(in.Fn, "say ") {
			return e.sayInstruction(ctx, in, ev)
		}
		return e.actionInstruction(ctx, in, ev)
	case "transition":
		return e.transitionInstruction(ctx, in, ev)
	case "wait":
		return result{kind: resultWait}, nil
	}
	return result{}, fmt.Errorf("Undefined instruction type %q", in.Type)
}

// sayInstruction ports ActionStrategy.invokeOutputProcessor.
// Only `say #!<id> [json]` is in scope; `say @type` is rejected by the validator.
func (e *Engine) sayInstruction(ctx context.Context, in instruction, ev map[string]any) (result, error) {
	chunks := strings.Split(in.Fn, " ")
	if len(chunks) < 2 {
		return result{}, errors.New(`Invalid text instruction. Expected an instruction along "say #text Something"`)
	}
	params := strings.Join(chunks[2:], " ")
	outputType := chunks[1]

	if strings.HasPrefix(outputType, "@") {
		return result{}, fmt.Errorf("%w: %s", cms.ErrUnsupported, outputType)
	}
	args := map[string]any{}
	if params != "" {
		if err := json.Unmarshal([]byte(params), &args); err != nil {
			return result{}, fmt.Errorf("Say %q has invalid arguments (not a valid JSON string): %s", outputType, params)
		}
	}

	e.d.Logger.Debug("render element", "botId", e.botID(), "element", outputType)

	msg := map[string]any{
		"eventId":         ev["id"],
		"incomingPreview": ev["preview"],
		"replyConfidence": float64(1),
		"replySource":     "dialogManager",
		"replyDate":       event.ISOTime(e.now()),
		"replyPreview":    outputType,
	}
	s := sessionOf(ev)
	history, _ := s["lastMessages"].([]any)
	s["lastMessages"] = append(history, msg)

	rendered, err := e.renderWithEventArgs(outputType, args, ev)
	if err != nil {
		return result{}, err
	}
	if err := e.emit(ctx, rendered); err != nil {
		return result{}, err
	}
	return result{kind: resultNone}, nil
}

// renderWithEventArgs runs cms.RenderElement with extractEventCommonArgs(event, args).
func (e *Engine) renderWithEventArgs(id string, args map[string]any, ev map[string]any) ([]map[string]any, error) {
	return cms.RenderElement(e.d.Bot, id, commonArgs(ev, args), e.d.Picker)
}

// commonArgs ports extractEventCommonArgs: args merged with
// event, user, session, temp, bot and workflow. Args keys are overwritten by the
// common keys, as in JS object spread.
func commonArgs(ev map[string]any, args map[string]any) map[string]any {
	out := copyMap(args)
	st := stateOf(ev)
	out["event"] = ev
	out["user"] = objOr(st, "user")
	out["session"] = objOr(st, "session")
	out["temp"] = objOr(st, "temp")
	out["bot"] = objOr(st, "bot")
	out["workflow"] = map[string]any{}
	return out
}

// actionInstruction ports ActionStrategy.invokeAction.
func (e *Engine) actionInstruction(ctx context.Context, in instruction, ev map[string]any) (result, error) {
	name, argsStr, serverID := parseActionInstruction(in.Fn)

	args := map[string]any{}
	if argsStr != "" {
		if err := json.Unmarshal([]byte(argsStr), &args); err != nil {
			return result{}, fmt.Errorf("Action %q has invalid arguments (not a valid JSON string): %s", name, argsStr)
		}
	}

	actionArgs := commonArgs(ev, args)
	rendered := make(map[string]any, len(args))
	for k, v := range args {
		if s, ok := v.(string); ok {
			out, err := cms.RenderTemplate(s, actionArgs)
			if err != nil {
				return result{}, err
			}
			rendered[k] = out
			continue
		}
		rendered[k] = v
	}

	if serverID != "" {
		// Action servers are not part of the locked scope. legacy warns and does nothing
		// when the server is missing.
		e.d.Logger.Warn("action server not supported, skipping", "botId", e.botID(), "server", serverID, "action", name)
		return result{kind: resultNone}, nil
	}

	if err := e.runAction(ctx, name, rendered, ev); err != nil {
		e.d.Logger.Warn("action failed", "botId", e.botID(), "action", name, "err", err)
		return result{kind: resultTransition, to: e.errorFlowName(ev)}, nil
	}
	return result{kind: resultNone}, nil
}

// parseActionInstruction ports common/ parseActionInstruction.
func parseActionInstruction(s string) (name, argsStr, serverID string) {
	chunks := strings.Split(s, " ")
	head := chunks[0]
	if len(chunks) > 1 {
		argsStr = strings.Replace(s, head+" ", "", 1)
	}
	parts := strings.Split(head, ":")
	if len(parts) == 1 {
		return parts[0], argsStr, ""
	}
	return parts[1], argsStr, parts[0]
}

// runAction dispatches to a builtin action or to user code.
func (e *Engine) runAction(ctx context.Context, name string, args map[string]any, ev map[string]any) error {
	if builtin.IsBuiltin(name) {
		return builtin.Run(ctx, name, args, ev, builtin.Deps{
			Bot:         e.d.Bot,
			KVS:         e.d.KVS,
			BasicSkills: e.d.BasicSkills,
			Now:         e.d.Now,
			Say: func(ctx context.Context, contentID string, a map[string]any) error {
				payloads, err := cms.RenderElement(e.d.Bot, contentID, commonArgs(ev, a), e.d.Picker)
				if err != nil {
					return err
				}
				return e.emit(ctx, payloads)
			},
		})
	}

	code, ok := e.d.Bot.Actions[name]
	if !ok {
		c := contextOf(ev)
		return fmt.Errorf("Action %q not found in %s:%s", name, str(c, "currentFlow"), str(c, "currentNode"))
	}
	sb := &usercode.Sandbox{BotID: e.botID(), Event: ev, Args: args}
	_, err := e.d.UserCode.RunAction(ctx, name, code, sb, e)
	replaceContents(ev, sb.Event)
	return err
}

// transitionInstruction ports TransitionStrategy.processInstruction.
func (e *Engine) transitionInstruction(ctx context.Context, in instruction, ev map[string]any) (result, error) {
	sb := &usercode.Sandbox{BotID: e.botID(), Event: ev}
	ok, err := e.d.UserCode.EvalCondition(ctx, in.Fn, sb)
	replaceContents(ev, sb.Event)
	if err != nil {
		return result{}, err
	}
	if ok {
		return result{kind: resultTransition, to: in.Node}, nil
	}
	return result{kind: resultNone}, nil
}

// emit sends payloads through the outbox.
func (e *Engine) emit(ctx context.Context, payloads []map[string]any) error {
	if e.d.Outbox == nil {
		return ErrNoOutbox
	}
	return e.d.Outbox.Emit(ctx, payloads)
}

// reportProcessingError ports DialogEngine._reportProcessingError.
func (e *Engine) reportProcessingError(ev map[string]any, in instruction, err error) {
	c := contextOf(ev)
	nodeName, flowName := str(c, "currentNode"), str(c, "currentFlow")
	if nodeName == "" {
		nodeName = "N/A"
	}
	if flowName == "" {
		flowName = "N/A"
	}
	fn := in.Fn
	if fn == "" {
		fn = in.Type
	}
	e.d.Logger.Warn(fmt.Sprintf("Error processing '%s'\nErr: %s\nBotId: %s\nFlow: %s\nNode: %s",
		fn, err.Error(), e.botID(), flowName, nodeName))
}

// ---- usercode.Host ----------------------------------------------------------

// LogInfo implements usercode.Host.
func (e *Engine) LogInfo(botID string, args ...any) {
	e.d.Logger.Info(fmt.Sprint(args...), "botId", botID)
}

// LogError implements usercode.Host.
func (e *Engine) LogError(botID string, args ...any) {
	e.d.Logger.Error(fmt.Sprint(args...), "botId", botID)
}

// LogWarn implements usercode.Host.
func (e *Engine) LogWarn(botID string, args ...any) {
	e.d.Logger.Warn(fmt.Sprint(args...), "botId", botID)
}

// RenderElement implements usercode.Host (bp.cms.renderElement). A "#!id" or a
// bare content type ("text", "builtin_single-choice") is accepted.
func (e *Engine) RenderElement(ctx context.Context, botID, contentTypeOrID string, args map[string]any, _ map[string]any) ([]map[string]any, error) {
	if strings.HasPrefix(contentTypeOrID, "#") {
		return cms.RenderElement(e.d.Bot, contentTypeOrID, args, e.d.Picker)
	}
	ct := contentTypeOrID
	if !strings.HasPrefix(ct, "builtin_") {
		ct = "builtin_" + ct
	}
	// Render args as the form data of a transient element (bp.cms.renderElement with a content type).
	tmp := *e.d.Bot
	tmp.ContentElements = map[string]*model.ContentElement{
		"__js__": {ID: "__js__", ContentType: ct, FormData: args},
	}
	return cms.RenderElement(&tmp, "#!__js__", args, e.d.Picker)
}

// ReplyToEvent implements usercode.Host (bp.events.replyToEvent).
func (e *Engine) ReplyToEvent(ctx context.Context, _ map[string]any, payloads []map[string]any) error {
	return e.emit(ctx, payloads)
}

// InsertAndRetrieve implements usercode.Host (bp.database.insertAndRetrieve).
func (e *Engine) InsertAndRetrieve(ctx context.Context, botID, table string, data map[string]any, returnColumns []string, idColumn string) (map[string]any, error) {
	if e.d.Inserter == nil {
		return nil, errors.New("bp.database.insertAndRetrieve is not configured")
	}
	return e.d.Inserter.InsertAndRetrieve(ctx, botID, table, data, returnColumns, idColumn)
}

// Decide is the non-NDU decision engine ( processEvent without
// suggestions). It runs the dialog unless the event carries SKIP_DIALOG_ENGINE.
// It returns processed=true when the dialog ran successfully and the caller
// should persist; on error the caller runs ErrorFlow.
func (e *Engine) Decide(ctx context.Context, ev map[string]any) (processed bool, err error) {
	if event.HasFlag(ev, event.FlagSkipDialogEngine) {
		return false, nil
	}
	ev["decision"] = map[string]any{
		"decision":      map[string]any{"reason": "no suggestion matched", "status": "elected"},
		"confidence":    float64(1),
		"payloads":      []any{},
		"source":        "decisionEngine",
		"sourceDetails": "execute default flow",
	}
	ev["suggestions"] = []any{}
	if err := e.processEvent(ctx, ev); err != nil {
		return false, err
	}
	// remove skills/ flows from the stacktrace after success.
	st := stateOf(ev)
	if arr, ok := st["__stacktrace"].([]any); ok {
		out := make([]any, 0, len(arr))
		for _, item := range arr {
			if m, ok := item.(map[string]any); ok && strings.HasPrefix(str(m, "flow"), skillsPrefix) {
				continue
			}
			out = append(out, item)
		}
		st["__stacktrace"] = out
	}
	return true, nil
}

// ErrorFlow ports DecisionEngine._processErrorFlow: jump to error.flow.json:entry
// and run it. The caller persists on success.
func (e *Engine) ErrorFlow(ctx context.Context, ev map[string]any) error {
	if err := e.JumpTo(ctx, ev, "error", "entry"); err != nil {
		return err
	}
	return e.processEvent(ctx, ev)
}
