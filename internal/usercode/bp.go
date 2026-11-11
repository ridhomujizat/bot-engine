package usercode

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/dop251/goja"
)

// newBP builds the bp object: logger, cms, events and database shims.
// Host calls are synchronous (they run on the loop goroutine, in call order)
// and the returned Promise is already settled.
func (e *execution) newBP() goja.Value {
	bp := e.vm.NewObject()
	_ = bp.Set("logger", e.newLogger(e.botID))

	cms := e.vm.NewObject()
	_ = cms.Set("renderElement", e.fn(e.jsRenderElement))
	_ = bp.Set("cms", cms)

	events := e.vm.NewObject()
	_ = events.Set("replyToEvent", e.fn(e.jsReplyToEvent))
	_ = bp.Set("events", events)

	database := e.vm.NewObject()
	_ = database.Set("insertAndRetrieve", e.fn(e.jsInsertAndRetrieve))
	_ = bp.Set("database", database)
	return bp
}

func (e *execution) fn(f func(goja.FunctionCall) goja.Value) goja.Value {
	return e.vm.ToValue(f)
}

// newLogger returns a bp.logger bound to botID. forBot(id) returns another
// logger bound to id, matching the legacy SDK chaining style.
func (e *execution) newLogger(botID string) goja.Value {
	logger := e.vm.NewObject()
	level := func(name string) func(goja.FunctionCall) goja.Value {
		return func(call goja.FunctionCall) goja.Value {
			if e.host == nil {
				return goja.Undefined()
			}
			args := make([]any, 0, len(call.Arguments))
			for _, a := range call.Arguments {
				args = append(args, logArg(a))
			}
			switch name {
			case "info", "debug":
				e.host.LogInfo(botID, args...)
			case "warn":
				e.host.LogWarn(botID, args...)
			default:
				e.host.LogError(botID, args...)
			}
			return goja.Undefined()
		}
	}
	for _, name := range []string{"info", "warn", "error", "debug"} {
		_ = logger.Set(name, e.fn(level(name)))
	}
	_ = logger.Set("forBot", e.fn(func(call goja.FunctionCall) goja.Value {
		id := botID
		if s := call.Argument(0); !goja.IsUndefined(s) && !goja.IsNull(s) {
			id = s.String()
		}
		return e.newLogger(id)
	}))
	return logger
}

// logArg renders one log argument: errors as their stack, everything else as
// its JSON-like value.
func logArg(v goja.Value) any {
	if obj, ok := v.(*goja.Object); ok && obj.ClassName() == "Error" {
		if s := getProp(obj, "stack"); !goja.IsUndefined(s) {
			return s.String()
		}
		return obj.String()
	}
	out, ok, err := toGo(v)
	if err != nil {
		return v.String()
	}
	if !ok {
		return nil
	}
	return out
}

func (e *execution) rejected(err error) goja.Value {
	p, _, reject := e.vm.NewPromise()
	_ = reject(e.vm.NewGoError(err))
	return e.vm.ToValue(p)
}

func (e *execution) resolved(v goja.Value) goja.Value {
	p, resolve, _ := e.vm.NewPromise()
	_ = resolve(v)
	return e.vm.ToValue(p)
}

// bp.cms.renderElement(contentIdOrType, args, eventDestination) -> Promise<payloads>
func (e *execution) jsRenderElement(call goja.FunctionCall) goja.Value {
	if e.host == nil {
		return e.rejected(errors.New("bp.cms.renderElement is not available in this context"))
	}
	args, err := toGoMap(call.Argument(1))
	if err != nil {
		return e.rejected(err)
	}
	event, err := toGoMap(call.Argument(2))
	if err != nil {
		return e.rejected(err)
	}
	payloads, err := e.host.RenderElement(e.ctx, e.botID, call.Argument(0).String(), args, event)
	if err != nil {
		return e.rejected(err)
	}
	items := make([]any, len(payloads))
	for i, p := range payloads {
		items[i] = toJS(e.vm, p)
	}
	return e.resolved(e.vm.NewArray(items...))
}

// bp.events.replyToEvent(eventDestination, payloads[, incomingEventId]) -> Promise<void>
func (e *execution) jsReplyToEvent(call goja.FunctionCall) goja.Value {
	if e.host == nil {
		return e.rejected(errors.New("bp.events.replyToEvent is not available in this context"))
	}
	event, err := toGoMap(call.Argument(0))
	if err != nil {
		return e.rejected(err)
	}
	payloads, err := payloadList(call.Argument(1))
	if err != nil {
		return e.rejected(err)
	}
	if err := e.host.ReplyToEvent(e.ctx, event, payloads); err != nil {
		return e.rejected(err)
	}
	return e.resolved(goja.Undefined())
}

func payloadList(v goja.Value) ([]map[string]any, error) {
	out, ok, err := toGo(v)
	if err != nil {
		return nil, err
	}
	if !ok || out == nil {
		return nil, nil
	}
	switch list := out.(type) {
	case []any:
		payloads := make([]map[string]any, 0, len(list))
		for _, item := range list {
			m, isMap := item.(map[string]any)
			if !isMap {
				return nil, fmt.Errorf("payload must be an object, got %T", item)
			}
			payloads = append(payloads, m)
		}
		return payloads, nil
	case map[string]any:
		return []map[string]any{list}, nil
	}
	return nil, fmt.Errorf("payloads must be an array, got %T", out)
}

// bp.database.insertAndRetrieve(table, data[, returnColumns][, idColumnName]) -> Promise<row>
func (e *execution) jsInsertAndRetrieve(call goja.FunctionCall) goja.Value {
	if e.host == nil {
		return e.rejected(errors.New("bp.database.insertAndRetrieve is not available in this context"))
	}
	data, err := toGoMap(call.Argument(1))
	if err != nil {
		return e.rejected(err)
	}
	var cols []string
	if rc := call.Argument(2); !goja.IsUndefined(rc) && !goja.IsNull(rc) {
		if s, isArr := rc.Export().([]any); isArr {
			for _, c := range s {
				cols = append(cols, fmt.Sprint(c))
			}
		} else {
			cols = append(cols, rc.String())
		}
	}
	idColumn := ""
	if ic := call.Argument(3); !goja.IsUndefined(ic) && !goja.IsNull(ic) {
		idColumn = ic.String()
	}
	row, err := e.host.InsertAndRetrieve(e.ctx, e.botID, call.Argument(0).String(), data, cols, idColumn)
	if err != nil {
		return e.rejected(err)
	}
	return e.resolved(toJS(e.vm, row))
}

// installConsole adds console.* writing to Options.Console.
func (e *execution) installConsole() {
	console := e.vm.NewObject()
	write := func(call goja.FunctionCall) goja.Value {
		parts := make([]string, 0, len(call.Arguments))
		for _, a := range call.Arguments {
			parts = append(parts, consoleString(a))
		}
		fmt.Fprintln(e.r.opts.Console, strings.Join(parts, " "))
		return goja.Undefined()
	}
	for _, name := range []string{"log", "info", "warn", "error", "debug"} {
		_ = console.Set(name, e.fn(write))
	}
	_ = e.vm.Set("console", console)
}

func consoleString(v goja.Value) string {
	if obj, ok := v.(*goja.Object); ok && obj.ClassName() == "Error" {
		if s := getProp(obj, "stack"); !goja.IsUndefined(s) {
			return s.String()
		}
	}
	if v == nil || goja.IsUndefined(v) {
		return "undefined"
	}
	if _, isObj := v.(*goja.Object); !isObj {
		return v.String()
	}
	out, ok, err := toGo(v)
	if err != nil || !ok {
		return v.String()
	}
	raw, err := json.Marshal(out)
	if err != nil {
		return v.String()
	}
	return string(raw)
}
