// Package usercode runs bot-authored JavaScript (actions, hooks, transition
// conditions) in goja with the legacy-compatible sandbox and shims
// (bp.logger, bp.cms.renderElement, bp.events.replyToEvent,
// bp.database.insertAndRetrieve, require('axios'|'form-data'|'qs'|'moment'|'crypto'|'lodash'), Buffer, console).
//
// OWNERSHIP: the types and interfaces in THIS FILE are a shared contract
// (dialog engine calls them). Implementation (runtime.go, shims,...) owned by the usercode agent.
package usercode

import "context"

// Sandbox carries the JS-visible state. Event is the full IncomingEvent as a
// JSON-like map (map[string]any / []any / string / float64 / bool / nil).
// Event["state"] holds "user", "session", "temp", "bot", "context", "__stacktrace",...
// User/Session/Temp/Bot in JS MUST alias event.state.user/session/temp/bot
// (legacy: `user === event.state.user`).
//
// After a run returns, every mutation made by JS (to event, event.state.*,
// including reassigned/deleted keys) MUST be visible in sb.Event when the call returns.
type Sandbox struct {
	BotID string
	Event map[string]any
	Args  map[string]any // actions only; already Mustache-rendered by the dialog engine
}

// Host is implemented by the dialog engine and exposed to JS as bp.*.
type Host interface {
	LogInfo(botID string, args ...any)
	LogError(botID string, args ...any)
	LogWarn(botID string, args ...any)
	// bp.cms.renderElement(contentTypeOrId, args, event) -> payload array
	RenderElement(ctx context.Context, botID, contentTypeOrID string, args map[string]any, event map[string]any) ([]map[string]any, error)
	// bp.events.replyToEvent(event, payloads) -> appended to the current turn's responses (in call order)
	ReplyToEvent(ctx context.Context, event map[string]any, payloads []map[string]any) error
	// bp.database.insertAndRetrieve(table, data, returnColumns?, idColumnName?) -> inserted row
	InsertAndRetrieve(ctx context.Context, botID, table string, data map[string]any, returnColumns []string, idColumn string) (map[string]any, error)
}

type Runner interface {
	// RunAction executes actions/{name}.js. legacy wraps the body as an async function
	// with params (bp, event, user, temp, session, args, process) and awaits the result
	// (top-level `return` allowed). ctx carries the deadline.
	RunAction(ctx context.Context, name, code string, sb *Sandbox, host Host) (any, error)
	// RunHook executes a hook script; params for before_conversation_end: (bp, event).
	RunHook(ctx context.Context, hookType, name, code string, sb *Sandbox, host Host) error
	// EvalCondition evaluates a transition condition exactly like legacy TransitionStrategy.runCode:
	// "true" -> true; "lastNode=X" handled natively; else `try { return <expr> } catch (TypeError) { return false }`
	// with sandbox vars from extractEventCommonArgs(event): event, user, temp, session, bot?,...
	EvalCondition(ctx context.Context, expr string, sb *Sandbox) (bool, error)
}
