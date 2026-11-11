// Package state ports legacy dialog state persistence: StateManager.restore/persist
// , SessionRepository (dialog_sessions),
// chat users (srv_channel_users attributes) and KVS (srv_kvs).
// Rows written here MUST stay readable by legacy (rollback requirement).
//
// OWNERSHIP: types/interfaces/signatures in THIS FILE are a shared contract
// (dialog/engine call them). Bodies + implementations owned by the state agent.
package state

import (
	"context"
	"fmt"
	"time"

	"github.com/ridhomujizat/bot-engine/internal/model"
)

// DialogSession mirrors a dialog_sessions row.
type DialogSession struct {
	ID            string
	Context       map[string]any // context column
	TempData      map[string]any // temp_data
	SessionData   map[string]any // session_data
	ContextExpiry *time.Time
	SessionExpiry *time.Time
	CreatedOn     time.Time
	ModifiedOn    time.Time
}

type Sessions interface {
	GetOrCreate(ctx context.Context, id string) (*DialogSession, error)
	Get(ctx context.Context, id string) (*DialogSession, error) // nil, nil when missing
	Update(ctx context.Context, s *DialogSession) error
	Delete(ctx context.Context, id string) error
	ExpiredContextIDs(ctx context.Context, now time.Time) ([]string, error) // legacy getExpiredContextSessionIds
	DeleteExpired(ctx context.Context, now time.Time) error                 // legacy deleteExpiredSessions
}

// Users is srv_channel_users (user.* attributes).
type Users interface {
	GetOrCreate(ctx context.Context, channel, userID string) (attributes map[string]any, err error)
	SetAttributes(ctx context.Context, channel, userID string, attributes map[string]any) error
}

// KVS is srv_kvs (bot-scoped and global keys) as used by builtin global-variable actions.
type KVS interface {
	Get(ctx context.Context, botID, key string) (value any, ok bool, err error) // botID "" = global
	Set(ctx context.Context, botID, key string, value any, expiry time.Duration) error
	Delete(ctx context.Context, botID, key string) error
}

// KeyLikeDeleter is an optional KVS extension (ADDED to the contract). It deletes every row
// whose key matches the SQL LIKE pattern, across ALL bots, because legacy
// KvsService.removeStorageKeysStartingWith issues `DELETE... WHERE key LIKE ?` with no botId
// filter. Implemented by the memory and Postgres KVS.
type KeyLikeDeleter interface {
	DeleteKeysLike(ctx context.Context, pattern string) error
}

// Config holds the dialog expiry settings used by persist (bot overrides global).
type Config struct {
	TimeoutInterval        time.Duration // context expiry, legacy dialog.timeoutInterval
	SessionTimeoutInterval time.Duration // session expiry, legacy dialog.sessionTimeoutInterval
}

// Manager ports StateManager.
type Manager struct {
	Sessions Sessions
	Users    Users
	KVS      KVS
	// Now is the clock used for expiry computation. nil = time.Now.
	Now func() time.Time
}

func (m *Manager) now() time.Time {
	if m.Now != nil {
		return m.Now()
	}
	return time.Now()
}

// SessionID ports SessionIdFactory.createIdFromEvent:
// "{botId}::{channel}::{target}" plus "::{threadId}" when threadId is non-empty.
func SessionID(botID, channel, target, threadID string) string {
	id := botID + "::" + channel + "::" + target
	if threadID != "" {
		id += "::" + threadID
	}
	return id
}

// DefaultConfig holds the global legacy.config.json dialog values seen in the
// production instances (plan 2a): timeoutInterval 25m, sessionTimeoutInterval 30m.
func DefaultConfig() Config {
	return Config{TimeoutInterval: 25 * time.Minute, SessionTimeoutInterval: 30 * time.Minute}
}

// ResolveConfig ports createExpiry's lookup: a bot-level
// dialog.timeoutInterval / dialog.sessionTimeoutInterval overrides the global value.
// An unparseable interval becomes 0, which matches legacy (ms returns undefined and
// moment.add(undefined) is a no-op, so the expiry is "now").
func ResolveConfig(bot *model.BotConfig, global Config) Config {
	cfg := global
	if bot == nil || bot.Dialog == nil {
		return cfg
	}
	if s := bot.Dialog.TimeoutInterval; s != "" {
		cfg.TimeoutInterval = msToDuration(s)
	}
	if s := bot.Dialog.SessionTimeoutInterval; s != "" {
		cfg.SessionTimeoutInterval = msToDuration(s)
	}
	return cfg
}

const (
	globalKVSKey      = "global" // StateManager.BOT_GLOBAL_KEY
	lastMessagesLimit = 5        // StateManager.LAST_MESSAGES_HISTORY_COUNT
)

// Restore fills event["state"] = {user, context, session, temp, bot, __stacktrace} exactly like
// StateManager.restore. Session id = "{botId}::{channel}::{target}".
//
// Not ported: the Redis fast path (USE_REDIS_STATE) and the `workflow` getter
// (state.session.workflows[state.session.currentWorkflow]). The dialog engine must
// derive `workflow` itself.
func (m *Manager) Restore(ctx context.Context, event map[string]any, cfg Config) error {
	botID := strOf(event["botId"])
	channel := strOf(event["channel"])
	target := strOf(event["target"])
	sessionID := SessionID(botID, channel, target, strOf(event["threadId"]))

	user, err := m.Users.GetOrCreate(ctx, channel, target)
	if err != nil {
		return fmt.Errorf("state: restore user: %w", err)
	}
	if user == nil {
		user = map[string]any{}
	}

	sess, err := m.Sessions.Get(ctx, sessionID)
	if err != nil {
		return fmt.Errorf("state: restore session: %w", err)
	}

	ctxData := map[string]any{}
	sessData := map[string]any{"lastMessages": []any{}, "workflows": map[string]any{}, "slots": map[string]any{}}
	temp := map[string]any{}
	if sess != nil {
		if sess.Context != nil {
			ctxData = sess.Context
		}
		if sess.SessionData != nil {
			sessData = sess.SessionData
		}
		if sess.TempData != nil {
			temp = sess.TempData
		}
	}

	bot, _, err := m.KVS.Get(ctx, botID, globalKVSKey)
	if err != nil {
		return fmt.Errorf("state: restore bot state: %w", err)
	}

	st := stateMap(event)
	st["user"] = user
	st["context"] = ctxData
	if _, ok := sessData["slots"]; !ok { // legacy always has session.slots (sessions written before it existed)
		sessData["slots"] = map[string]any{}
	}
	st["session"] = sessData
	st["temp"] = temp
	if bot != nil { // legacy only exposes state.bot when the bot KVS entry exists
		st["bot"] = bot
	}
	st["__stacktrace"] = []any{}
	return nil
}

// Persist writes event["state"] back exactly like StateManager._saveState:
// user attributes, last 5 messages, session/context expiry, session_data and, unless
// ignoreContext is set, context and temp_data. Writes are immediate (no batching; the
// legacy Redis/batch path is not ported).
func (m *Manager) Persist(ctx context.Context, event map[string]any, ignoreContext bool, cfg Config) error {
	botID := strOf(event["botId"])
	channel := strOf(event["channel"])
	target := strOf(event["target"])
	sessionID := SessionID(botID, channel, target, strOf(event["threadId"]))

	st := stateMap(event)

	// _.omitBy(user, _.isNil): top-level nil values are dropped. A missing user becomes {}
	// and overwrites attributes, as in legacy.
	attrs := map[string]any{}
	for k, v := range asMap(st["user"]) {
		if v != nil {
			attrs[k] = v
		}
	}
	if err := m.Users.SetAttributes(ctx, channel, target, attrs); err != nil {
		return fmt.Errorf("state: persist user: %w", err)
	}

	session := asMap(st["session"])
	if session != nil {
		if lm, ok := session["lastMessages"].([]any); ok && len(lm) > lastMessagesLimit {
			session["lastMessages"] = lm[len(lm)-lastMessagesLimit:]
		}
	}

	ds, err := m.Sessions.GetOrCreate(ctx, sessionID)
	if err != nil {
		return fmt.Errorf("state: persist session: %w", err)
	}

	now := m.now()
	ctxExp := now.Add(cfg.TimeoutInterval)
	sessExp := now.Add(cfg.SessionTimeoutInterval)
	ds.SessionData = orEmpty(session)
	ds.SessionExpiry = &sessExp
	ds.ContextExpiry = &ctxExp

	if !ignoreContext {
		ds.Context = orEmpty(asMap(st["context"]))
		ds.TempData = orEmpty(asMap(st["temp"]))
	}

	if err := m.Sessions.Update(ctx, ds); err != nil {
		return fmt.Errorf("state: persist session update: %w", err)
	}
	return nil
}

// DeleteDialogSession ports StateManager.deleteDialogSession.
func (m *Manager) DeleteDialogSession(ctx context.Context, sessionID string) error {
	return m.Sessions.Delete(ctx, sessionID)
}

// stateMap returns event["state"] as a map, creating it when missing.
func stateMap(event map[string]any) map[string]any {
	if st, ok := event["state"].(map[string]any); ok {
		return st
	}
	st := map[string]any{}
	event["state"] = st
	return st
}

func asMap(v any) map[string]any {
	m, _ := v.(map[string]any)
	return m
}

func orEmpty(m map[string]any) map[string]any {
	if m == nil {
		return map[string]any{}
	}
	return m
}

func strOf(v any) string {
	s, _ := v.(string)
	return s
}
