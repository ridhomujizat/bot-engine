package engine

import (
	"context"
	"fmt"
	"net/http"
	"unicode/utf16"

	"github.com/ridhomujizat/bot-engine/internal/event"
	"github.com/ridhomujizat/bot-engine/internal/model"
)

// flagForcePersist is WellKnownFlags.FORCE_PERSIST_STATE.
const flagForcePersist = event.FlagForcePersistState

// validateConverse ports Only text payloads are
// checked; the secured route does not validate schema on purpose.
func (e *Engine) validateConverse(bot *model.Bot, body map[string]any) error {
	typ, _ := body["type"].(string)
	if typ == "" {
		typ = "text"
	}
	if typ != "text" {
		return nil
	}
	maxLen := e.maxMessageLength(bot)
	text, ok := body["text"].(string)
	if !ok || text == "" || utf16Len(text) > maxLen {
		return &Error{
			Status:  http.StatusBadRequest,
			Message: fmt.Sprintf("Text must be a valid string of less than %d chars", maxLen),
			Type:    "InvalidParameterError",
		}
	}
	return nil
}

// utf16Len is JavaScript string length (UTF-16 code units).
func utf16Len(s string) int { return len(utf16.Encode([]rune(s))) }

// newIncomingEvent builds the incoming event.
func (e *Engine) newIncomingEvent(botID, userID string, body map[string]any, includedContexts []string) map[string]any {
	return event.FromConverse(botID, userID, body, includedContexts, e.deps.Now())
}

// InsertAndRetrieve backs bp.database.insertAndRetrieve (plugin shim for one
// example action). The row is inserted with RETURNING so the caller gets the
// stored values back, as knex insertAndRetrieve does.
func (e *Engine) InsertAndRetrieve(ctx context.Context, botID, table string, data map[string]any, returnColumns []string, idColumn string) (map[string]any, error) {
	if e.deps.DB == nil {
		return nil, fmt.Errorf("bp.database.insertAndRetrieve: no database configured")
	}
	row := make(map[string]any, len(data))
	for k, v := range data {
		row[k] = v
	}
	tx := e.deps.DB.WithContext(ctx).Table(table)
	if err := tx.Create(&row).Error; err != nil {
		return nil, err
	}
	out := map[string]any{}
	if len(returnColumns) == 0 {
		return row, nil
	}
	for _, c := range returnColumns {
		out[c] = row[c]
	}
	return out, nil
}

// collector receives outgoing payloads of one turn, in order (legacy _responseMap.responses).
type collector struct {
	payloads []map[string]any
}

// Emit implements dialog.Outbox.
func (c *collector) Emit(_ context.Context, payloads []map[string]any) error {
	c.payloads = append(c.payloads, payloads...)
	return nil
}

func (c *collector) list() []any {
	out := make([]any, 0, len(c.payloads))
	for _, p := range c.payloads {
		out = append(out, p)
	}
	return out
}

func str(ev map[string]any, key string) string {
	s, _ := ev[key].(string)
	return s
}

func setSkipFlag(ev map[string]any) { event.SetFlag(ev, event.FlagSkipDialogEngine, true) }

func hasFlag(ev map[string]any, flag string) bool { return event.HasFlag(ev, flag) }
