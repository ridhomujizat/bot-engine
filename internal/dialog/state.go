package dialog

// Accessors over the JSON-like event map. Everything here reads state fresh on
// every call: the user-code runner replaces sb.Event after each call, and the
// engine copies the new contents back into the caller's map (replaceContents).
// Nothing in this package keeps a pointer to a nested state map across calls.

import "reflect"

// stateOf returns event.state, creating it when missing.
func stateOf(ev map[string]any) map[string]any {
	st, ok := ev["state"].(map[string]any)
	if !ok {
		st = map[string]any{}
		ev["state"] = st
	}
	return st
}

// contextOf returns event.state.context, creating an empty object when missing.
// The returned map is the live object: callers that replace the context must use setContext.
func contextOf(ev map[string]any) map[string]any {
	st := stateOf(ev)
	c, ok := st["context"].(map[string]any)
	if !ok {
		c = map[string]any{}
		st["context"] = c
	}
	return c
}

func setContext(ev map[string]any, c map[string]any) {
	stateOf(ev)["context"] = c
}

// tempOf returns event.state.temp, creating it when missing.
func tempOf(ev map[string]any) map[string]any {
	st := stateOf(ev)
	t, ok := st["temp"].(map[string]any)
	if !ok {
		t = map[string]any{}
		st["temp"] = t
	}
	return t
}

// sessionOf returns event.state.session, creating it when missing.
func sessionOf(ev map[string]any) map[string]any {
	st := stateOf(ev)
	s, ok := st["session"].(map[string]any)
	if !ok {
		s = map[string]any{"lastMessages": []any{}, "workflows": map[string]any{}}
		st["session"] = s
	}
	return s
}

// objOr returns m[key] as a map, or an empty map when absent (JS `x ?? {}`).
func objOr(m map[string]any, key string) map[string]any {
	if v, ok := m[key].(map[string]any); ok {
		return v
	}
	return map[string]any{}
}

// str returns m[key] when it is a non-empty string (JS truthy string), else "".
func str(m map[string]any, key string) string {
	s, _ := m[key].(string)
	return s
}

// strOrNil returns the string value and whether it was present and a string.
func hasStr(m map[string]any, key string) bool {
	s, ok := m[key].(string)
	return ok && s != ""
}

// truthy follows JavaScript truthiness for the value kinds used in state.
func truthy(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case float64:
		return x != 0
	case string:
		return x != ""
	default:
		return true
	}
}

// copyMap is a shallow copy: `{...obj}`.
func copyMap(m map[string]any) map[string]any {
	out := make(map[string]any, len(m)+4)
	for k, v := range m {
		out[k] = v
	}
	return out
}

// replaceContents makes dst hold exactly the top-level keys of src. Used to
// rebind the caller's event map after user code replaced sb.Event.
func replaceContents(dst, src map[string]any) {
	if src == nil || sameMap(dst, src) {
		return
	}
	for k := range dst {
		delete(dst, k)
	}
	for k, v := range src {
		dst[k] = v
	}
}

// sameMap reports whether two maps are the same object.
func sameMap(a, b map[string]any) bool {
	return reflect.ValueOf(a).Pointer() == reflect.ValueOf(b).Pointer()
}

// jumpPoints returns context.jumpPoints as a slice of maps.
func jumpPoints(c map[string]any) []any {
	jp, _ := c["jumpPoints"].([]any)
	return jp
}

// filterUnusedJumpPoints mirrors `context.jumpPoints = context.jumpPoints?.filter(x => !x.used)`.
func filterUnusedJumpPoints(c map[string]any) {
	jp, ok := c["jumpPoints"].([]any)
	if !ok {
		return
	}
	out := make([]any, 0, len(jp))
	for _, j := range jp {
		if m, ok := j.(map[string]any); ok && truthy(m["used"]) {
			continue
		}
		out = append(out, j)
	}
	c["jumpPoints"] = out
}

// findLastUnused mirrors `_.findLast(jumpPoints, j => !j.used)`.
func findLastUnused(jp []any) map[string]any {
	for i := len(jp) - 1; i >= 0; i-- {
		if m, ok := jp[i].(map[string]any); ok && !truthy(m["used"]) {
			return m
		}
	}
	return nil
}

// stacktrace returns event.state.__stacktrace entries.
func stacktrace(ev map[string]any) []any {
	arr, _ := stateOf(ev)["__stacktrace"].([]any)
	return arr
}

// pushStack appends {flow, node} to event.state.__stacktrace.
func pushStack(ev map[string]any, flow, node string) {
	st := stateOf(ev)
	arr, _ := st["__stacktrace"].([]any)
	st["__stacktrace"] = append(arr, map[string]any{"flow": flow, "node": node})
}

// queue is the InstructionQueue of legacy. It is stored in
// context.queue as {"instructions": [...]} so the persisted JSON stays readable by legacy.
type queue struct {
	instrs []instruction
}

type instruction struct {
	Type string
	Fn   string
	Node string
}

func (q *queue) dequeue() (instruction, bool) {
	if len(q.instrs) == 0 {
		return instruction{}, false
	}
	i := q.instrs[0]
	q.instrs = q.instrs[1:]
	return i, true
}

func (q *queue) enqueue(in ...instruction) {
	q.instrs = append(q.instrs, in...)
}

// wait mirrors InstructionQueue.wait (unshift a wait instruction).
func (q *queue) wait() {
	q.instrs = append([]instruction{{Type: "wait"}}, q.instrs...)
}

func (i instruction) toMap() map[string]any {
	m := map[string]any{"type": i.Type}
	if i.Fn != "" {
		m["fn"] = i.Fn
	}
	if i.Node != "" {
		m["node"] = i.Node
	}
	return m
}

// loadQueue returns context.queue when present (JS truthy object), else nil.
func loadQueue(c map[string]any) *queue {
	qv, ok := c["queue"].(map[string]any)
	if !ok {
		return nil
	}
	list, _ := qv["instructions"].([]any)
	q := &queue{}
	for _, item := range list {
		m, _ := item.(map[string]any)
		q.instrs = append(q.instrs, instruction{Type: str(m, "type"), Fn: str(m, "fn"), Node: str(m, "node")})
	}
	return q
}

// saveQueue writes q into context.queue. A nil queue is `undefined` (key removed).
func saveQueue(c map[string]any, q *queue) {
	if q == nil {
		delete(c, "queue")
		return
	}
	list := make([]any, 0, len(q.instrs))
	for _, in := range q.instrs {
		list = append(list, in.toMap())
	}
	c["queue"] = map[string]any{"instructions": list}
}
