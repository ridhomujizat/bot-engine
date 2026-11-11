package state

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
)

// globalBotID is the botId legacy stores for global KVS rows.
const globalBotID = "__global__"

// marshalJS encodes v like legacy safeStringify/JSON.stringify for the columns we write:
// HTML characters are not escaped, and NaN/Infinity become null as in JS.
// Map key order is sorted by Go (semantically identical JSON).
func marshalJS(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(jsonSafe(v)); err != nil {
		return nil, fmt.Errorf("state: marshal json: %w", err)
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}

func jsonSafe(v any) any {
	switch t := v.(type) {
	case float64:
		if math.IsNaN(t) || math.IsInf(t, 0) {
			return nil
		}
		return t
	case map[string]any:
		out := make(map[string]any, len(t))
		for k, x := range t {
			out[k] = jsonSafe(x)
		}
		return out
	case []any:
		out := make([]any, len(t))
		for i, x := range t {
			out[i] = jsonSafe(x)
		}
		return out
	}
	return v
}

// unmarshalJS decodes a JSON column value. "null" and "" decode to nil.
func unmarshalJS(b []byte) (any, error) {
	if len(b) == 0 {
		return nil, nil
	}
	var v any
	if err := json.Unmarshal(b, &v); err != nil {
		return nil, fmt.Errorf("state: unmarshal json: %w", err)
	}
	return v, nil
}

// unmarshalMap decodes a JSON column that must hold an object. nil when null/absent.
func unmarshalMap(b []byte) (map[string]any, error) {
	v, err := unmarshalJS(b)
	if err != nil {
		return nil, err
	}
	m, _ := v.(map[string]any)
	return m, nil
}

// defaultSessionData is the session_data of a new dialog session
// .
func defaultSessionData() map[string]any {
	return map[string]any{"lastMessages": []any{}, "workflows": map[string]any{}}
}
