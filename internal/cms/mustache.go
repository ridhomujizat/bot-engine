// Package cms renders content elements into the
// payloads legacy hands to the converse collector. Port of
// legacy/legacy and the builtin
// content-types in legacy (channel "api" only).
package cms

import (
	"fmt"
	"math"
	"strconv"
	"strings"
)

// ErrTemplate reports a template that cannot be rendered (unclosed tag or a
// Mustache feature outside the locked scope).
var ErrTemplate = fmt.Errorf("cms: template error")

// ErrUnsupportedTag marks Mustache sections, inverted sections, partials and
// delimiter changes. Bot content never uses them (plan 2a, Templating).
var ErrUnsupportedTag = fmt.Errorf("%w: unsupported tag", ErrTemplate)

// htmlEscaper matches escapeHtml:
// & < > " ' / ` =
var htmlEscaper = strings.NewReplacer(
	"&", "&amp;",
	"<", "&lt;",
	">", "&gt;",
	`"`, "&quot;",
	"'", "&#39;",
	"/", "&#x2F;",
	"`", "&#x60;",
	"=", "&#x3D;",
)

// mustacheRender renders one pass of the Mustache subset used by bot content:
// {{name}} (HTML-escaped), {{&name}} and {{{name}}} (raw), {{! comment}}.
// Missing variables render as the empty string, as in
func mustacheRender(tpl string, ctx map[string]any) (string, error) {
	var b strings.Builder
	rest := tpl
	for {
		open := strings.Index(rest, "{{")
		if open < 0 {
			b.WriteString(rest)
			return b.String(), nil
		}
		b.WriteString(rest[:open])
		rest = rest[open+2:]

		triple := strings.HasPrefix(rest, "{")
		closeTok := "}}"
		if triple {
			closeTok = "}}}"
			rest = rest[1:]
		}
		end := strings.Index(rest, closeTok)
		if end < 0 {
			return "", fmt.Errorf("%w: unclosed tag", ErrTemplate)
		}
		tag := strings.TrimSpace(rest[:end])
		rest = rest[end+len(closeTok):]

		if triple {
			b.WriteString(stringify(lookup(ctx, tag)))
			continue
		}
		switch {
		case tag == "":
			// looks up "" as an ordinary (missing) name.
			b.WriteString("")
		case tag[0] == '!':
			// comment
		case tag[0] == '&':
			b.WriteString(stringify(lookup(ctx, strings.TrimSpace(tag[1:]))))
		case strings.ContainsRune("#^/>=", rune(tag[0])):
			return "", ErrUnsupportedTag
		default:
			b.WriteString(htmlEscaper.Replace(stringify(lookup(ctx, tag))))
		}
	}
}

// lookup resolves a dotted name against the context. Missing keys yield nil.
func lookup(ctx map[string]any, name string) any {
	if name == "." {
		return ctx
	}
	var cur any = ctx
	for _, seg := range strings.Split(name, ".") {
		switch c := cur.(type) {
		case map[string]any:
			v, ok := c[seg]
			if !ok {
				return nil
			}
			cur = v
		case []any:
			idx, err := strconv.Atoi(seg)
			if err != nil || idx < 0 || idx >= len(c) {
				return nil
			}
			cur = c[idx]
		default:
			return nil
		}
	}
	return cur
}

// stringify follows JavaScript String(value) as sees it:
// null/undefined -> "", arrays join with ",", objects -> "[object Object]".
func stringify(v any) string {
	switch x := v.(type) {
	case nil, undefinedT:
		return ""
	case string:
		return x
	case bool:
		if x {
			return "true"
		}
		return "false"
	case float64:
		return jsNumber(x)
	case int:
		return strconv.Itoa(x)
	case int64:
		return strconv.FormatInt(x, 10)
	case []any:
		parts := make([]string, len(x))
		for i, e := range x {
			parts[i] = stringify(e)
		}
		return strings.Join(parts, ",")
	case map[string]any:
		return "[object Object]"
	default:
		return fmt.Sprint(x)
	}
}

func jsNumber(f float64) string {
	switch {
	case math.IsNaN(f):
		return "NaN"
	case math.IsInf(f, 1):
		return "Infinity"
	case math.IsInf(f, -1):
		return "-Infinity"
	case f == math.Trunc(f) && math.Abs(f) < 1e21:
		return strconv.FormatFloat(f, 'f', -1, 64)
	case math.Abs(f) >= 1e-6 && math.Abs(f) < 1e21:
		return strconv.FormatFloat(f, 'f', -1, 64)
	default:
		return strconv.FormatFloat(f, 'g', -1, 64)
	}
}

// RenderTemplate mirrors renderTemplate: repeat Mustache
// rendering while the string still looks like it has a tag, at most three
// times, so values that contain templates are resolved too.
func RenderTemplate(template string, ctx map[string]any) (string, error) {
	for i := 0; i < maxNestingLevel && containsTemplate(template); i++ {
		out, err := mustacheRender(template, ctx)
		if err != nil {
			return "", err
		}
		template = out
	}
	return template, nil
}

const maxNestingLevel = 3

// containsTemplate reproduces containsTemplate exactly:
// `value.indexOf('{{') < value.indexOf('}}')`. A string with "}}" but no
// "{{" (indexOf -1) therefore also counts as a template. The result is the
// same text either way, since Mustache leaves plain text untouched.
func containsTemplate(s string) bool {
	return strings.Index(s, "{{") < strings.Index(s, "}}")
}

// RenderRecursive mirrors renderRecursive.
func RenderRecursive(v any, ctx map[string]any) (any, error) {
	switch x := v.(type) {
	case []any:
		out := make([]any, len(x))
		for i, e := range x {
			r, err := RenderRecursive(e, ctx)
			if err != nil {
				return nil, err
			}
			out[i] = r
		}
		return out, nil
	case map[string]any:
		out := make(map[string]any, len(x))
		for k, e := range x {
			r, err := RenderRecursive(e, ctx)
			if err != nil {
				return nil, err
			}
			out[k] = r
		}
		return out, nil
	case nil:
		// typeof null === 'object', and _.mapValues(null)
		// returns {}, so JSON null inside a rendered value becomes {}.
		return map[string]any{}, nil
	case string:
		return RenderTemplate(x, ctx)
	default:
		return v, nil
	}
}
