// Package builtin implements legacy builtin actions
// and basic-skills choice actions natively in Go.
//
// OWNERSHIP: exported signatures in THIS FILE are a shared contract (dialog engine
// calls Run). Bodies owned by the state/builtin agent.
package builtin

import (
	"context"
	"fmt"
	"time"

	"github.com/ridhomujizat/bot-engine/internal/model"
	"github.com/ridhomujizat/bot-engine/internal/state"
)

// FlagForcePersistState is the event flag set by resetSession and switchLanguage
// (legacy WellKnownFlags.FORCE_PERSIST_STATE). Flags live in event["flags"] as a map;
// the dialog engine must persist state at the end of the turn when it is set.
const FlagForcePersistState = "forcePersistState"

// BasicSkillsConfig is the basic-skills module config read by choice_parse_answer
// (bp.config.getModuleConfigForBot). Only the two fields this action uses.
type BasicSkillsConfig struct {
	MatchNumbers bool // "1", "2", ... pick the nth choice (needs the element's formData.choices)
	MatchNLU     bool // intent:* keywords; NLU is off in production, so keep false there
}

// DefaultBasicSkillsConfig returns the defaults declared by the legacy basic-skills module.
func DefaultBasicSkillsConfig() BasicSkillsConfig {
	return BasicSkillsConfig{MatchNumbers: true, MatchNLU: true}
}

// Deps are the host services the native actions need.
type Deps struct {
	Bot *model.Bot
	KVS state.KVS
	// Render renders a content element for the current event (used by choice_invalid_answer
	// when repeatChoicesOnInvalid/invalidContentId); appends payloads to the turn's responses.
	// NOTE: the legacy choice_invalid_answer action does not render anything (the flow does it with
	// `say` steps), so no ported action calls Say today.
	Say func(ctx context.Context, contentID string, args map[string]any) error

	// BasicSkills is ADDED to the contract. nil = DefaultBasicSkillsConfig.
	BasicSkills *BasicSkillsConfig
	// Now is ADDED to the contract; it is the clock for setGlobalVariable expiry boxes. nil = time.Now.
	Now func() time.Time
}

func (d Deps) now() time.Time {
	if d.Now != nil {
		return d.Now()
	}
	return time.Now()
}

func (d Deps) basicSkills() BasicSkillsConfig {
	if d.BasicSkills != nil {
		return *d.BasicSkills
	}
	return DefaultBasicSkillsConfig()
}

// call is one action invocation.
type call struct {
	ctx   context.Context
	args  map[string]any
	event map[string]any
	deps  Deps
}

type actionFn func(c *call) error

// actions lists every native action. Names are the legacy instruction names.
var actions = map[string]actionFn{
	"builtin/setVariable":                    setVariable,
	"builtin/removeVariable":                 removeVariable,
	"builtin/resetSession":                   resetSession,
	"builtin/resetContext":                   resetContext,
	"builtin/appendContext":                  appendContext,
	"builtin/removeContext":                  removeContext,
	"builtin/incrementNumberOfConversations": incrementNumberOfConversations,
	"builtin/getNumberOfConversations":       getNumberOfConversations,
	"builtin/getGlobalVariable":              getGlobalVariable,
	"builtin/setGlobalVariable":              setGlobalVariable,
	"builtin/resetGlobalVariable":            resetGlobalVariable,
	"builtin/wait":                           wait,
	"builtin/switchLanguage":                 switchLanguage,
	"basic-skills/choice_parse_answer":       choiceParseAnswer,
	"basic-skills/choice_invalid_answer":     choiceInvalidAnswer,
}

// IsBuiltin reports whether name ("builtin/setVariable", "basic-skills/choice_parse_answer",...) is native.
// Not native (no state effect or needs a service this port does not have): builtin/sendFeedback
// (bp.events.saveUserFeedback), builtin/storeFileLocally (disk), and the realtime push of
// builtin/switchLanguage (the state change is ported, the webchat push is not).
func IsBuiltin(name string) bool {
	_, ok := actions[name]
	return ok
}

// Run executes a native action. args are already Mustache-rendered by the dialog engine
// (legacy ActionStrategy renders args before invoking). Mutations go into event["state"].
// A nil args map is treated as {}. Errors mirror the legacy JS exception cases (for example a
// missing event.state.temp, or a non-string argument where legacy calls a string method).
func Run(ctx context.Context, name string, args map[string]any, event map[string]any, deps Deps) error {
	fn, ok := actions[name]
	if !ok {
		return fmt.Errorf("builtin: %q is not a native action", name)
	}
	if args == nil {
		args = map[string]any{}
	}
	if event == nil {
		return fmt.Errorf("builtin: %s: nil event", name)
	}
	if err := fn(&call{ctx: ctx, args: args, event: event, deps: deps}); err != nil {
		return fmt.Errorf("builtin: %s: %w", name, err)
	}
	return nil
}

// --- shared helpers -------------------------------------------------------

func (c *call) botID() string {
	s, _ := c.event["botId"].(string)
	return s
}

// bag returns event.state[key] as an object. A missing or non-object bag is a legacy TypeError.
func (c *call) bag(key string) (map[string]any, error) {
	st, ok := c.event["state"].(map[string]any)
	if !ok {
		return nil, fmt.Errorf("event.state is not an object")
	}
	m, ok := st[key].(map[string]any)
	if !ok {
		return nil, fmt.Errorf("event.state.%s is not an object", key)
	}
	return m, nil
}

// setTemp ports `temp[key] = value`. An undefined value leaves no key behind: legacy would keep the
// key with value undefined, and JSON.stringify then drops it on persist, so deleting is equivalent.
func (c *call) setTemp(key string, value any, present bool) error {
	temp, err := c.bag("temp")
	if err != nil {
		return err
	}
	if !present {
		delete(temp, key)
		return nil
	}
	temp[key] = value
	return nil
}

func (c *call) setFlag(flag string) {
	flags, ok := c.event["flags"].(map[string]any)
	if !ok {
		flags = map[string]any{}
		c.event["flags"] = flags
	}
	flags[flag] = true
}

// arg returns args[key] and whether the key is present (JS: undefined when absent).
func (c *call) arg(key string) (any, bool) {
	v, ok := c.args[key]
	return v, ok
}

// kvsGet ports bp.kvs.forBot(botId).get(key) (raw, no unboxing).
func (c *call) kvsGet(key string) (any, bool, error) {
	if c.deps.KVS == nil {
		return nil, false, fmt.Errorf("kvs not configured")
	}
	return c.deps.KVS.Get(c.ctx, c.botID(), key)
}

func (c *call) kvsSet(key string, value any, expiry time.Duration) error {
	if c.deps.KVS == nil {
		return fmt.Errorf("kvs not configured")
	}
	return c.deps.KVS.Set(c.ctx, c.botID(), key, value, expiry)
}

// key ports ToPropertyKey of args[name]: an absent argument is "undefined", a null is "null".
func (c *call) key(name string) string {
	v, ok := c.arg(name)
	if !ok {
		return "undefined"
	}
	return jsToString(v)
}

// eventKey ports ToPropertyKey of event[name] (absent -> "undefined").
func (c *call) eventKey(name string) string {
	v, ok := c.event[name]
	if !ok {
		return "undefined"
	}
	return jsToString(v)
}
