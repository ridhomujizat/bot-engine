package builtin

import (
	"fmt"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode"
)

// JS value semantics for the JSON-like values held in event/args maps.
// Representation: nil = JSON null, absent map key = undefined (callers pass the present flag).

// jsTruthy ports JS ToBoolean for a present value. nil (null), false, 0, NaN and "" are falsy.
func jsTruthy(v any) bool {
	switch t := v.(type) {
	case nil:
		return false
	case bool:
		return t
	case float64:
		return t != 0 && !math.IsNaN(t)
	case string:
		return t != ""
	}
	return true
}

// jsStrictEqual ports `===` for JSON-like scalars. Objects and arrays compare by identity in JS;
// here they are never equal unless both are nil.
func jsStrictEqual(a, b any) bool {
	switch x := a.(type) {
	case nil:
		return b == nil
	case bool:
		y, ok := b.(bool)
		return ok && x == y
	case float64:
		y, ok := b.(float64)
		return ok && x == y
	case string:
		y, ok := b.(string)
		return ok && x == y
	}
	return false
}

// jsToString ports ToString / ToPropertyKey for JSON-like values.
func jsToString(v any) string {
	switch t := v.(type) {
	case nil:
		return "null"
	case string:
		return t
	case bool:
		if t {
			return "true"
		}
		return "false"
	case float64:
		return jsNumberString(t)
	case []any:
		parts := make([]string, len(t))
		for i, x := range t {
			if x == nil {
				parts[i] = ""
				continue
			}
			parts[i] = jsToString(x)
		}
		return strings.Join(parts, ",")
	case map[string]any:
		return "[object Object]"
	}
	return fmt.Sprint(v)
}

func jsNumberString(f float64) string {
	switch {
	case math.IsNaN(f):
		return "NaN"
	case math.IsInf(f, 1):
		return "Infinity"
	case math.IsInf(f, -1):
		return "-Infinity"
	case f == 0:
		return "0"
	}
	abs := math.Abs(f)
	if abs >= 1e-6 && abs < 1e21 {
		return strconv.FormatFloat(f, 'f', -1, 64)
	}
	s := strconv.FormatFloat(f, 'e', -1, 64) // e.g. 1e+21, 1.5e-07
	mant, exp, _ := strings.Cut(s, "e")
	sign := exp[0]
	digits := strings.TrimLeft(exp[1:], "0")
	return mant + "e" + string(sign) + digits
}

var (
	jsDecimalRe = regexp.MustCompile(`^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$`)
	jsHexRe     = regexp.MustCompile(`^0[xX]([0-9a-fA-F]+)$`)
	jsOctRe     = regexp.MustCompile(`^0[oO]([0-7]+)$`)
	jsBinRe     = regexp.MustCompile(`^0[bB]([01]+)$`)
)

// jsToNumber ports ToNumber for JSON-like values. Absent values must be handled by the caller
// (undefined -> NaN).
func jsToNumber(v any) float64 {
	switch t := v.(type) {
	case nil:
		return 0
	case bool:
		if t {
			return 1
		}
		return 0
	case float64:
		return t
	case string:
		return jsStringToNumber(t)
	case []any:
		if len(t) == 0 {
			return 0
		}
		if len(t) == 1 {
			return jsStringToNumber(jsToString(t[0]))
		}
	}
	return math.NaN()
}

func jsStringToNumber(s string) float64 {
	s = jsTrim(s)
	if s == "" {
		return 0
	}
	switch s {
	case "Infinity", "+Infinity":
		return math.Inf(1)
	case "-Infinity":
		return math.Inf(-1)
	}
	if jsDecimalRe.MatchString(s) {
		f, err := strconv.ParseFloat(s, 64)
		if err != nil {
			return math.NaN()
		}
		return f
	}
	if m := jsHexRe.FindStringSubmatch(s); m != nil {
		return parseIntBase(m[1], 16)
	}
	if m := jsOctRe.FindStringSubmatch(s); m != nil {
		return parseIntBase(m[1], 8)
	}
	if m := jsBinRe.FindStringSubmatch(s); m != nil {
		return parseIntBase(m[1], 2)
	}
	return math.NaN()
}

func parseIntBase(digits string, base int) float64 {
	n, err := strconv.ParseUint(digits, base, 64)
	if err != nil {
		f := 0.0
		for _, c := range digits {
			d, _ := strconv.ParseUint(string(c), base, 8)
			f = f*float64(base) + float64(d)
		}
		return f
	}
	return float64(n)
}

// jsTrim ports String.prototype.trim (whitespace and line terminators, plus BOM).
func jsTrim(s string) string {
	return strings.TrimFunc(s, func(r rune) bool {
		return unicode.IsSpace(r) || r == '\uFEFF'
	})
}

// jsIncrement ports `v++` on a present value: the result is always a number.
func jsIncrement(v any) float64 {
	return jsToNumber(v) + 1
}

// jsPlusOne ports `(v || 0) + 1`: the result keeps JS '+' semantics, so a truthy string
// concatenates ("2" + 1 = "21") and a bool adds as 0/1.
func jsPlusOne(v any) any {
	if !jsTruthy(v) {
		return 1.0
	}
	switch t := v.(type) {
	case bool:
		return 2.0 // true is 1 here, and the falsy case returned above
	case float64:
		return t + 1
	case string:
		return t + "1"
	case map[string]any:
		return "[object Object]1"
	case []any:
		return jsToString(t) + "1"
	}
	return math.NaN()
}

// jsLower ports String.prototype.toLowerCase.
func jsLower(s string) string { return strings.ToLower(s) }

// listOf ports the iteration lodash does in `_.some(x, fn)` / `x.filter`: arrays yield their
// items, objects their values in sorted-key order, strings their characters.
func listOf(v any) []any {
	switch t := v.(type) {
	case []any:
		return t
	case map[string]any:
		keys := sortedKeys(t)
		out := make([]any, len(keys))
		for i, k := range keys {
			out[i] = t[k]
		}
		return out
	case string:
		out := []any{}
		for _, r := range t {
			out = append(out, string(r))
		}
		return out
	}
	return nil
}

// keyedEntries returns the (key, value) pairs of an object (sorted keys) or an array (indices).
func keyedEntries(v any) []keyedEntry {
	switch t := v.(type) {
	case map[string]any:
		keys := sortedKeys(t)
		out := make([]keyedEntry, len(keys))
		for i, k := range keys {
			out[i] = keyedEntry{k, t[k]}
		}
		return out
	case []any:
		out := make([]keyedEntry, len(t))
		for i, x := range t {
			out[i] = keyedEntry{strconv.Itoa(i), x}
		}
		return out
	}
	return nil
}

type keyedEntry struct {
	key   string
	value any
}

// sortedKeys is the only deterministic order available for JSON objects that arrive as Go maps.
// legacy uses insertion order (the order in the flow JSON); see the report.
func sortedKeys(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
