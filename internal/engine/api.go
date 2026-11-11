// Package engine orchestrates one converse turn (legacy converse-service +
// event engine + decision engine + dialog engine + state manager) and the janitor.
//
// OWNERSHIP: the exported API in THIS FILE is a shared contract (internal/api
// and cmd call it). Bodies are owned by the engine agent; keep signatures.
package engine

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/ridhomujizat/bot-engine/internal/botfs"
	"github.com/ridhomujizat/bot-engine/internal/builtin"
	"github.com/ridhomujizat/bot-engine/internal/dialog"
	"github.com/ridhomujizat/bot-engine/internal/flow"
	"github.com/ridhomujizat/bot-engine/internal/lock"
	"github.com/ridhomujizat/bot-engine/internal/model"
	"github.com/ridhomujizat/bot-engine/internal/state"
	"github.com/ridhomujizat/bot-engine/internal/usercode"

	"gorm.io/gorm"
)

// Error carries the HTTP status/body legacy would return (legacy error handler in
// legacy: {statusCode, type, message}).
type Error struct {
	Status  int
	Message string
	Type    string // error class name reported as "type"; defaults to "Exception"
}

func (e *Error) Error() string { return e.Message }

var ErrNotImplemented = &Error{Status: http.StatusNotImplemented, Message: "not implemented"}

type GlobalDialogConfig struct {
	TimeoutInterval        string // legacy.config.json dialog.timeoutInterval, default "15m"
	SessionTimeoutInterval string // default "30m"
	JanitorInterval        string // default "10s"
	ConverseTimeout        string // converse.timeout default "5s"
	MaxMessageLength       int    // converse.maxMessageLength default 360
}

// StateStore is the part of state.Manager the engine uses. Tests can supply a fake.
type StateStore interface {
	Restore(ctx context.Context, event map[string]any, cfg state.Config) error
	Persist(ctx context.Context, event map[string]any, ignoreContext bool, cfg state.Config) error
}

type Deps struct {
	Store    botfs.Store
	DB       *gorm.DB // tenant legacy DB (dialog_sessions, srv_channel_users, srv_kvs, bp.database)
	Locker   lock.Locker
	UserCode usercode.Runner
	Global   GlobalDialogConfig

	State    StateStore     // restore/persist of dialog state (state.Manager in production)
	Sessions state.Sessions // janitor: expired contexts and sessions
	KVS      state.KVS      // builtin global-variable actions

	Logger *slog.Logger // optional, slog.Default when nil
	Now    func() time.Time
	// BotRecheck throttles the botfs LastModified check per bot. Default 2s.
	BotRecheck time.Duration
}

type Engine struct {
	deps Deps

	mu    sync.Mutex
	cache map[string]*cachedBot
}

func New(deps Deps) *Engine {
	if deps.Logger == nil {
		deps.Logger = slog.Default()
	}
	if deps.Now == nil {
		deps.Now = time.Now
	}
	if deps.BotRecheck <= 0 {
		deps.BotRecheck = 2 * time.Second
	}
	return &Engine{deps: deps, cache: map[string]*cachedBot{}}
}

// Converse handles POST /api/v1/bots/{botId}/converse/{userId}/secured.
// body is the decoded request JSON ({type, text, payload, metadata,...}).
// include is the parsed ?include= list (e.g. state,suggestions,decision,nlu).
// Returns the exact response body legacy sends (responses + included keys).
func (e *Engine) Converse(ctx context.Context, botID, userID string, body map[string]any, include []string) (map[string]any, error) {
	bot, err := e.Bot(ctx, botID)
	if err != nil {
		return nil, err
	}

	includedContexts := stringList(body["includedContexts"])
	if err := e.validateConverse(bot, body); err != nil {
		return nil, err
	}

	timeout := e.converseTimeout(bot)
	release, err := e.deps.Locker.Acquire(ctx, "converse:"+botID+":"+userID, 2*timeout+5*time.Second, timeout)
	if err != nil {
		if errors.Is(err, lock.ErrTimeout) {
			return nil, &Error{Status: http.StatusBadRequest, Message: "Request timed out.", Type: "Error"}
		}
		return nil, err
	}
	defer release()

	ev := e.newIncomingEvent(botID, userID, body, includedContexts)
	cfg := e.stateConfig(bot)
	if err := e.deps.State.Restore(ctx, ev, cfg); err != nil {
		return nil, err
	}

	out := &collector{}
	d := e.dialogFor(bot, out)

	// builtin after_incoming_middleware/00_dialog_engine: these message types skip the dialog.
	if discardedType(str(ev, "type")) {
		setSkipFlag(ev)
	}

	persist := false
	processed, decideErr := d.Decide(ctx, ev)
	switch {
	case decideErr != nil:
		// _processErrorFlow: run error.flow.json and persist if it works.
		e.deps.Logger.Error("an unexpected error occurred", "botId", botID, "err", decideErr)
		if errFlowErr := d.ErrorFlow(ctx, ev); errFlowErr != nil {
			e.deps.Logger.Error("an error occurred in the error handler. Abandoning.", "botId", botID, "err", errFlowErr)
		} else {
			persist = true
		}
	case processed:
		persist = true
	case hasFlag(ev, flagForcePersist):
		persist = true
	}

	if persist {
		if err := e.deps.State.Persist(ctx, ev, false, cfg); err != nil {
			return nil, err
		}
	}

	return buildResponse(ev, out, include), nil
}

// Bot returns the cached loaded bot, reloading when srv_ghost_files changed (modified_on).
func (e *Engine) Bot(ctx context.Context, botID string) (*model.Bot, error) {
	now := e.deps.Now()

	e.mu.Lock()
	c := e.cache[botID]
	e.mu.Unlock()
	if c != nil && now.Sub(c.checked) < e.deps.BotRecheck {
		return c.bot, c.err
	}

	last, err := e.deps.Store.LastModified(ctx, botfs.BotPrefix(botID))
	if err != nil {
		return nil, err
	}
	if last.IsZero() {
		e.evict(botID)
		return nil, &Error{Status: http.StatusNotFound, Message: "Bot not found: " + botID, Type: "NotFoundError"}
	}
	if c != nil && last.Equal(c.seen) {
		e.mu.Lock()
		c.checked = now
		e.mu.Unlock()
		return c.bot, c.err
	}

	bot, loadErr := e.loadBot(ctx, botID)
	nc := &cachedBot{seen: last, checked: now}
	if loadErr != nil {
		nc.err = loadErr
	} else {
		nc.bot = bot
	}
	e.mu.Lock()
	e.cache[botID] = nc
	e.mu.Unlock()
	return nc.bot, nc.err
}

// RunJanitor runs the timeout janitor loop until ctx is done. Only one replica
// does work per tick (lock "janitor").
func (e *Engine) RunJanitor(ctx context.Context) {
	interval := parseDuration(e.deps.Global.JanitorInterval, 10*time.Second)
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			e.janitorTick(ctx, interval)
		}
	}
}

// ---- helpers ---------------------------------------------------------------

type cachedBot struct {
	bot     *model.Bot
	err     error
	seen    time.Time // srv_ghost_files max(modified_on) when the bot was loaded
	checked time.Time // last LastModified check
}

func (e *Engine) evict(botID string) {
	e.mu.Lock()
	delete(e.cache, botID)
	e.mu.Unlock()
}

// loadBot loads a bot and rejects it when it uses features outside the locked scope.
func (e *Engine) loadBot(ctx context.Context, botID string) (*model.Bot, error) {
	bot, err := flow.Load(ctx, e.deps.Store, botID)
	if err != nil {
		return nil, &Error{Status: http.StatusInternalServerError, Message: "Could not load bot " + botID + ": " + err.Error(), Type: "Error"}
	}
	var blocking []string
	for _, issue := range flow.Validate(bot) {
		if !issue.Warn {
			blocking = append(blocking, issue.File+": "+issue.Message)
		}
	}
	if len(blocking) > 0 {
		return nil, &Error{
			Status:  http.StatusInternalServerError,
			Message: "Bot " + botID + " uses features outside the supported scope: " + strings.Join(blocking, "; "),
			Type:    "UnsupportedBot",
		}
	}
	return bot, nil
}

func (e *Engine) dialogFor(bot *model.Bot, out *collector) *dialog.Engine {
	// NLU is off in production, so choice matching uses numbers and keywords only.
	return dialog.New(dialog.Deps{
		Bot:         bot,
		UserCode:    e.deps.UserCode,
		KVS:         e.deps.KVS,
		Outbox:      out,
		Inserter:    e,
		Logger:      e.deps.Logger,
		Now:         e.deps.Now,
		BasicSkills: &builtin.BasicSkillsConfig{MatchNumbers: true, MatchNLU: false},
	})
}

func (e *Engine) converseTimeout(bot *model.Bot) time.Duration {
	if bot.Config.Converse != nil {
		switch v := bot.Config.Converse.Timeout.(type) {
		case string:
			return parseDuration(v, 5*time.Second)
		case float64:
			return time.Duration(v) * time.Millisecond
		}
	}
	return parseDuration(e.deps.Global.ConverseTimeout, 5*time.Second)
}

func (e *Engine) maxMessageLength(bot *model.Bot) int {
	if bot.Config.Converse != nil && bot.Config.Converse.MaxMessageLength > 0 {
		return bot.Config.Converse.MaxMessageLength
	}
	if e.deps.Global.MaxMessageLength > 0 {
		return e.deps.Global.MaxMessageLength
	}
	return 360
}

// stateConfig resolves the dialog expiry settings (bot overrides global, state.ResolveConfig).
func (e *Engine) stateConfig(bot *model.Bot) state.Config {
	def := state.DefaultConfig()
	global := state.Config{
		TimeoutInterval:        parseDuration(e.deps.Global.TimeoutInterval, def.TimeoutInterval),
		SessionTimeoutInterval: parseDuration(e.deps.Global.SessionTimeoutInterval, def.SessionTimeoutInterval),
	}
	return state.ResolveConfig(&bot.Config, global)
}

// discardedType lists the message types the builtin hook 00_dialog_engine skips.
func discardedType(t string) bool {
	switch t {
	case "session_reset", "typing", "visit", "session_reference":
		return true
	}
	return false
}

// buildResponse assembles the converse body.
func buildResponse(ev map[string]any, out *collector, include []string) map[string]any {
	resp := map[string]any{"responses": out.list()}

	parts := make(map[string]bool, len(include))
	for _, p := range include {
		parts[strings.ToLower(p)] = true
	}
	if parts["nlu"] {
		resp["nlu"] = ev["nlu"]
	}
	if parts["state"] {
		resp["state"] = ev["state"]
	}
	if parts["suggestions"] {
		if s, ok := ev["suggestions"]; ok {
			resp["suggestions"] = s
		} else {
			resp["suggestions"] = []any{}
		}
	}
	if parts["decision"] {
		if d, ok := ev["decision"]; ok {
			resp["decision"] = d
		} else {
			resp["decision"] = map[string]any{}
		}
	}
	return resp
}

func stringList(v any) []string {
	list, _ := v.([]any)
	out := make([]string, 0, len(list))
	for _, item := range list {
		if s, ok := item.(string); ok {
			out = append(out, s)
		}
	}
	if len(out) == 0 {
		return []string{"global"}
	}
	return out
}

func parseDuration(s string, def time.Duration) time.Duration {
	if s == "" {
		return def
	}
	d, err := time.ParseDuration(s)
	if err != nil {
		return def
	}
	return d
}
