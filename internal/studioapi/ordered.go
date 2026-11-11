package studioapi

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strconv"
	"unicode/utf8"
)

// OMap is a JSON object that keeps key order, so files written here match the
// bytes legacy writes with JSON.stringify(x, undefined, 2).
type OMap struct {
	Keys []string
	Vals map[string]any
}

// NewOMap returns an empty ordered object.
func NewOMap() *OMap { return &OMap{Vals: map[string]any{}} }

// Set appends key (or replaces its value in place when it already exists).
func (m *OMap) Set(k string, v any) {
	if _, ok := m.Vals[k]; !ok {
		m.Keys = append(m.Keys, k)
	}
	m.Vals[k] = v
}

// Get returns the value for k.
func (m *OMap) Get(k string) (any, bool) {
	v, ok := m.Vals[k]
	return v, ok
}

// Delete removes k if present.
func (m *OMap) Delete(k string) {
	if _, ok := m.Vals[k]; !ok {
		return
	}
	delete(m.Vals, k)
	for i, key := range m.Keys {
		if key == k {
			m.Keys = append(m.Keys[:i], m.Keys[i+1:]...)
			break
		}
	}
}

// Pick returns a new object with the listed keys that exist, in the listed order (lodash _.pick).
func (m *OMap) Pick(keys ...string) *OMap {
	out := NewOMap()
	for _, k := range keys {
		if v, ok := m.Vals[k]; ok {
			out.Set(k, v)
		}
	}
	return out
}

// Omit returns a copy without the listed keys (lodash _.omit).
func (m *OMap) Omit(keys ...string) *OMap {
	drop := map[string]bool{}
	for _, k := range keys {
		drop[k] = true
	}
	out := NewOMap()
	for _, k := range m.Keys {
		if !drop[k] {
			out.Set(k, m.Vals[k])
		}
	}
	return out
}

// Clone returns a shallow copy.
func (m *OMap) Clone() *OMap { return m.Omit() }

// MarshalJSON writes keys in order (no HTML escaping; see writeValue for the layout).
func (m *OMap) MarshalJSON() ([]byte, error) {
	var buf bytes.Buffer
	if err := writeValue(&buf, m, ""); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// UnmarshalJSON decodes an object preserving key order, recursively.
func (m *OMap) UnmarshalJSON(data []byte) error {
	v, err := decodeOrdered(data)
	if err != nil {
		return err
	}
	om, ok := v.(*OMap)
	if !ok {
		return fmt.Errorf("studioapi: expected JSON object")
	}
	*m = *om
	return nil
}

// decodeOrdered parses one JSON value. Objects become *OMap, arrays []any,
// numbers json.Number (literal text kept), others as encoding/json would.
func decodeOrdered(data []byte) (any, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	v, err := decodeValue(dec)
	if err != nil {
		return nil, err
	}
	if _, err := dec.Token(); err == nil {
		return nil, fmt.Errorf("studioapi: trailing data after JSON value")
	}
	return v, nil
}

func decodeValue(dec *json.Decoder) (any, error) {
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	switch t := tok.(type) {
	case json.Delim:
		switch t {
		case '{':
			m := NewOMap()
			for dec.More() {
				kt, err := dec.Token()
				if err != nil {
					return nil, err
				}
				k, ok := kt.(string)
				if !ok {
					return nil, fmt.Errorf("studioapi: object key is not a string")
				}
				v, err := decodeValue(dec)
				if err != nil {
					return nil, err
				}
				m.Set(k, v)
			}
			if _, err := dec.Token(); err != nil { // '}'
				return nil, err
			}
			return m, nil
		case '[':
			arr := []any{}
			for dec.More() {
				v, err := decodeValue(dec)
				if err != nil {
					return nil, err
				}
				arr = append(arr, v)
			}
			if _, err := dec.Token(); err != nil { // ']'
				return nil, err
			}
			return arr, nil
		}
	}
	return tok, nil
}

// MarshalJS encodes v the way JavaScript's JSON.stringify(v, undefined, indent) does for
// the value kinds used here. indent is the number of spaces per level (2 for legacy files).
func MarshalJS(v any, indent int) ([]byte, error) {
	var buf bytes.Buffer
	pad := ""
	if indent > 0 {
		pad = fmt.Sprintf("%*s", indent, "")
	}
	if err := writeValue(&buf, v, pad); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// writeValue emits v. unit is the indent unit ("" for compact output).
func writeValue(buf *bytes.Buffer, v any, unit string) error {
	return writeAt(buf, v, unit, "")
}

func writeAt(buf *bytes.Buffer, v any, unit, cur string) error {
	switch t := v.(type) {
	case nil:
		buf.WriteString("null")
	case bool:
		if t {
			buf.WriteString("true")
		} else {
			buf.WriteString("false")
		}
	case string:
		writeString(buf, t)
	case json.Number:
		buf.WriteString(t.String())
	case int:
		buf.WriteString(strconv.Itoa(t))
	case int64:
		buf.WriteString(strconv.FormatInt(t, 10))
	case float64:
		b, err := json.Marshal(t)
		if err != nil {
			return err
		}
		buf.Write(b)
	case *OMap:
		return writeObject(buf, t.Keys, t.Vals, unit, cur)
	case []any:
		if len(t) == 0 {
			buf.WriteString("[]")
			return nil
		}
		buf.WriteByte('[')
		inner := cur + unit
		for i, e := range t {
			if i > 0 {
				buf.WriteByte(',')
			}
			newline(buf, unit, inner)
			if err := writeAt(buf, e, unit, inner); err != nil {
				return err
			}
		}
		newline(buf, unit, cur)
		buf.WriteByte(']')
	case map[string]any:
		keys := make([]string, 0, len(t))
		for k := range t {
			keys = append(keys, k)
		}
		sortStrings(keys)
		return writeObject(buf, keys, t, unit, cur)
	default:
		b, err := json.Marshal(t)
		if err != nil {
			return err
		}
		buf.Write(b)
	}
	return nil
}

func writeObject(buf *bytes.Buffer, keys []string, vals map[string]any, unit, cur string) error {
	if len(keys) == 0 {
		buf.WriteString("{}")
		return nil
	}
	buf.WriteByte('{')
	inner := cur + unit
	for i, k := range keys {
		if i > 0 {
			buf.WriteByte(',')
		}
		newline(buf, unit, inner)
		writeString(buf, k)
		buf.WriteByte(':')
		if unit != "" {
			buf.WriteByte(' ')
		}
		if err := writeAt(buf, vals[k], unit, inner); err != nil {
			return err
		}
	}
	newline(buf, unit, cur)
	buf.WriteByte('}')
	return nil
}

func newline(buf *bytes.Buffer, unit, cur string) {
	if unit == "" {
		return
	}
	buf.WriteByte('\n')
	buf.WriteString(cur)
}

// writeString escapes like JSON.stringify: only ", \, control characters are escaped.
// Go's encoder would also escape <, >, &, U+2028 and U+2029, which JS does not.
func writeString(buf *bytes.Buffer, s string) {
	const hex = "0123456789abcdef"
	buf.WriteByte('"')
	for i := 0; i < len(s); {
		r, size := utf8.DecodeRuneInString(s[i:])
		switch {
		case r == '"':
			buf.WriteString(`\"`)
		case r == '\\':
			buf.WriteString(`\\`)
		case r == '\b':
			buf.WriteString(`\b`)
		case r == '\f':
			buf.WriteString(`\f`)
		case r == '\n':
			buf.WriteString(`\n`)
		case r == '\r':
			buf.WriteString(`\r`)
		case r == '\t':
			buf.WriteString(`\t`)
		case r < 0x20:
			buf.WriteString(`\u00`)
			buf.WriteByte(hex[r>>4])
			buf.WriteByte(hex[r&0xf])
		default:
			buf.WriteString(s[i : i+size])
		}
		i += size
	}
	buf.WriteByte('"')
}

func sortStrings(a []string) {
	// insertion sort keeps this file free of extra imports; key counts are small
	for i := 1; i < len(a); i++ {
		for j := i; j > 0 && a[j] < a[j-1]; j-- {
			a[j], a[j-1] = a[j-1], a[j]
		}
	}
}
