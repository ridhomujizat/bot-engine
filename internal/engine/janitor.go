package engine

import (
	"context"
	"strings"
	"time"

	"github.com/ridhomujizat/bot-engine/internal/event"
)

// janitorTick is one run of runTask. Only the replica that holds the
// "janitor" lock does the work.
func (e *Engine) janitorTick(ctx context.Context, interval time.Duration) {
	release, ok, err := e.deps.Locker.TryAcquire(ctx, "janitor", 3*interval)
	if err != nil {
		e.deps.Logger.Error("janitor: lock failed", "err", err)
		return
	}
	if !ok {
		return
	}
	defer release()

	now := e.deps.Now()
	// delete expired sessions first.
	if err := e.deps.Sessions.DeleteExpired(ctx, now); err != nil {
		e.deps.Logger.Error("janitor: delete expired sessions failed", "err", err)
	}
	ids, err := e.deps.Sessions.ExpiredContextIDs(ctx, now)
	if err != nil {
		e.deps.Logger.Error("janitor: expired context lookup failed", "err", err)
		return
	}
	for _, id := range ids {
		if ctx.Err() != nil {
			return
		}
		e.processSessionTimeout(ctx, id)
	}
}

// parseSessionID splits "{botId}::{channel}::{target}[::{threadId}]" (state.SessionID).
// A target containing "::" is not representable in this format; legacy has the same limit.
func parseSessionID(id string) (botID, channel, target, threadID string) {
	parts := strings.Split(id, "::")
	if len(parts) < 3 {
		return id, "", "", ""
	}
	if len(parts) > 3 {
		threadID = parts[3]
	}
	return parts[0], parts[1], parts[2], threadID
}

// processSessionTimeout ports DialogJanitor._processSessionTimeout.
func (e *Engine) processSessionTimeout(ctx context.Context, sessionID string) {
	botID, channel, target, threadID := parseSessionID(sessionID)
	log := e.deps.Logger.With("botId", botID, "session", sessionID)

	bot, err := e.Bot(ctx, botID)
	if err != nil {
		log.Error("janitor: bot not loadable, skipping session timeout", "err", err)
		return
	}
	cfg := e.stateConfig(bot)

	release, ok, err := e.deps.Locker.TryAcquire(ctx, "timeout."+sessionID, cfg.SessionTimeoutInterval)
	if err != nil {
		log.Error("janitor: session lock failed", "err", err)
		return
	}
	if !ok {
		log.Debug("janitor: timeout already processed by another replica")
		return
	}
	defer release()

	newEvent := func() map[string]any {
		return event.New(event.Args{
			Type:      "timeout",
			Channel:   channel,
			Direction: event.DirectionInternal,
			Target:    target,
			BotID:     botID,
			ThreadID:  threadID,
			Payload:   "",
		}, e.deps.Now())
	}

	ev := newEvent()
	if err := e.deps.State.Restore(ctx, ev, cfg); err != nil {
		log.Error("janitor: restore failed", "err", err)
		return
	}
	// the timeout runs on the stored context without its queue.
	st := stateMap(ev)
	sessionCtx := copyObj(st["context"])
	delete(sessionCtx, "queue")
	st["context"] = sessionCtx

	// when processing left queued instructions, keep the context.
	reset := true
	d := e.dialogFor(bot, &collector{})
	if err := d.ProcessTimeout(ctx, ev); err != nil {
		// legacy logs the error (TimeoutNodeNotFound is silent) and resets the session
		// with the stored session data, so start again from the stored state.
		log.Error("janitor: could not process the timeout event", "err", err)
		ev = newEvent()
		if err := e.deps.State.Restore(ctx, ev, cfg); err != nil {
			log.Error("janitor: restore after failed timeout failed", "err", err)
			return
		}
	} else if queueHasInstructions(stateMap(ev)["context"]) {
		reset = false
	}

	st = stateMap(ev)
	if reset {
		st["context"] = map[string]any{}
		st["temp"] = map[string]any{}
	}
	if err := e.deps.State.Persist(ctx, ev, false, cfg); err != nil {
		log.Error("janitor: persist failed", "err", err)
	}
}

func stateMap(ev map[string]any) map[string]any {
	st, ok := ev["state"].(map[string]any)
	if !ok {
		st = map[string]any{}
		ev["state"] = st
	}
	return st
}

func copyObj(v any) map[string]any {
	src, _ := v.(map[string]any)
	out := make(map[string]any, len(src))
	for k, val := range src {
		out[k] = val
	}
	return out
}

func queueHasInstructions(ctx any) bool {
	c, _ := ctx.(map[string]any)
	q, _ := c["queue"].(map[string]any)
	list, _ := q["instructions"].([]any)
	return len(list) > 0
}
