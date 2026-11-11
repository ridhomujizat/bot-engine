// Package event builds IncomingEvent / OutgoingEvent maps the way the legacy
// event SDK (IOEvent) and the legacy conversation service do. Events are JSON-like maps (map[string]any, []any, string, float64, bool,
// nil) because the user-code sandbox (internal/usercode) and the state manager
// read and write them as such.
package event

import (
	"crypto/rand"
	"encoding/binary"
	"fmt"
	"time"
)

// Well-known flags (legacy WellKnownFlags).
const (
	FlagSkipDialogEngine = "SKIP_DIALOG_ENGINE"
	// FlagForcePersistState matches builtin.FlagForcePersistState (the key is the
	// name set by resetSession/switchLanguage in the flags map).
	FlagForcePersistState = "forcePersistState"
)

// Directions.
const (
	DirectionIncoming = "incoming"
	DirectionOutgoing = "outgoing"
	DirectionInternal = "internal"
)

// ChannelAPI is the only channel the engine serves (converse API).
const ChannelAPI = "api"

// Args mirrors sdk.IO.EventCtorArgs for the fields the engine uses.
type Args struct {
	Type            string
	Channel         string
	Direction       string
	Target          string
	BotID           string
	ThreadID        string
	Payload         any
	Preview         string // optional; computed from payload when empty
	Credentials     any
	IncomingEventID string
	// NLU overrides the default nlu object (only includedContexts is set by converse).
	NLU map[string]any
}

// ISOTime formats t the way JSON.stringify formats a JS Date.
func ISOTime(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05.000Z")
}

// newID mirrors IOEvent.makeId: a nanosecond timestamp followed by three random digits.
func newID(now time.Time) string {
	var b [2]byte
	_, _ = rand.Read(b[:])
	n := binary.BigEndian.Uint16(b[:]) % 1000
	return fmt.Sprintf("%d%03d", now.UnixNano(), n)
}

// New builds an event map (IOEvent constructor). now is the creation time.
func New(a Args, now time.Time) map[string]any {
	ev := map[string]any{
		"id":        newID(now),
		"type":      a.Type,
		"channel":   a.Channel,
		"direction": a.Direction,
		"payload":   a.Payload,
		"target":    a.Target,
		"botId":     a.BotID,
		"createdOn": ISOTime(now),
		"flags":     map[string]any{},
		"state":     map[string]any{"__stacktrace": []any{}},
	}
	if a.ThreadID != "" {
		ev["threadId"] = a.ThreadID
	}
	if a.Preview != "" {
		ev["preview"] = a.Preview
	} else if p := constructPreview(a); p != nil {
		ev["preview"] = p
	}
	if a.Direction == DirectionIncoming {
		ev["suggestions"] = []any{}
		if a.Credentials != nil {
			ev["credentials"] = a.Credentials
		}
	}
	if a.Direction == DirectionOutgoing && a.IncomingEventID != "" {
		ev["incomingEventId"] = a.IncomingEventID
	}
	ev["nlu"] = defaultNLU(a.NLU)
	return ev
}

// defaultNLU is the nlu object legacy builds with the NLU module disabled
// (IOEvent constructor defaults, overridden by args.nlu).
func defaultNLU(override map[string]any) map[string]any {
	nlu := map[string]any{
		"entities":         []any{},
		"language":         "n/a",
		"ambiguous":        false,
		"slots":            map[string]any{},
		"intent":           map[string]any{"name": "none", "confidence": float64(1), "context": "global"},
		"intents":          []any{},
		"errored":          false,
		"includedContexts": []any{"global"},
		"ms":               float64(0),
	}
	for k, v := range override {
		nlu[k] = v
	}
	return nlu
}

// constructPreview mirrors IOEvent.constructPreview: payload.__preview ||
// payload.preview || payload.text, or a description when there is no payload.
func constructPreview(a Args) any {
	if isFalsy(a.Payload) {
		return fmt.Sprintf("\"%s\" event on channel %s", a.Type, a.Channel)
	}
	m, ok := a.Payload.(map[string]any)
	if !ok {
		return nil
	}
	for _, k := range []string{"__preview", "preview", "text"} {
		if s, ok := m[k].(string); ok && s != "" {
			return s
		}
	}
	return nil
}

// isFalsy reports whether a payload is JavaScript-falsy (nil or "").
func isFalsy(v any) bool {
	if v == nil {
		return true
	}
	s, ok := v.(string)
	return ok && s == ""
}

// Preview returns the preview of a payload (exported for the converse path).
func Preview(a Args) any { return constructPreview(a) }

// FromConverse builds the incoming event that creates for
// a message. body is the request body without includedContexts; a missing
// type is set to "text".
func FromConverse(botID, userID string, body map[string]any, includedContexts []string, now time.Time) map[string]any {
	payload := make(map[string]any, len(body)+1)
	for k, v := range body {
		if k == "includedContexts" {
			continue
		}
		payload[k] = v
	}
	if _, ok := payload["type"]; !ok || payload["type"] == nil {
		payload["type"] = "text"
	}
	typ, _ := payload["type"].(string)

	ctxs := make([]any, 0, len(includedContexts))
	for _, c := range includedContexts {
		ctxs = append(ctxs, c)
	}
	if len(ctxs) == 0 {
		ctxs = []any{"global"}
	}

	return New(Args{
		Type:      typ,
		Channel:   ChannelAPI,
		Direction: DirectionIncoming,
		Target:    userID,
		BotID:     botID,
		Payload:   payload,
		NLU:       map[string]any{"includedContexts": ctxs},
	}, now)
}

// NewOutgoing builds an outgoing reply event.
func NewOutgoing(dest map[string]any, payload map[string]any, incomingEventID string, now time.Time) map[string]any {
	typ, _ := payload["type"].(string)
	if typ == "" {
		typ = "text"
	}
	a := Args{
		Type:            typ,
		Channel:         str(dest["channel"]),
		Direction:       DirectionOutgoing,
		Target:          str(dest["target"]),
		BotID:           str(dest["botId"]),
		ThreadID:        str(dest["threadId"]),
		Payload:         payload,
		IncomingEventID: incomingEventID,
	}
	return New(a, now)
}

// SetFlag sets a flag on an event map.
func SetFlag(ev map[string]any, flag string, value bool) {
	flags, ok := ev["flags"].(map[string]any)
	if !ok {
		flags = map[string]any{}
		ev["flags"] = flags
	}
	flags[flag] = value
}

// HasFlag reports whether a flag is set.
func HasFlag(ev map[string]any, flag string) bool {
	flags, _ := ev["flags"].(map[string]any)
	b, _ := flags[flag].(bool)
	return b
}

func str(v any) string {
	s, _ := v.(string)
	return s
}
