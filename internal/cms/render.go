package cms

import (
	"errors"
	"fmt"
	"math/rand/v2"
	"strings"

	"github.com/ridhomujizat/bot-engine/internal/model"
)

var (
	// ErrNotFound: `say #!id` references an id missing from content-elements.
	ErrNotFound = errors.New("cms: content element not found")
	// ErrUnsupported: content type or reference form outside the locked scope.
	ErrUnsupported = errors.New("cms: unsupported content")
)

// Picker chooses a text variation index in [0, n). *rand.Rand satisfies it.
type Picker interface{ IntN(n int) int }

// contentProps lists the jsonSchema.properties keys of each in-scope builtin
// content type. Only these keys
// survive language translation.
var contentProps = map[string][]string{
	"builtin_text":          {"text", "variations", "markdown", "typing"},
	"builtin_single-choice": {"text", "isDropdown", "dropdownPlaceholder", "choices", "markdown", "disableFreeText", "displayInMessage", "typing"},
	"builtin_card":          {"title", "subtitle", "image", "actions", "markdown"},
	"builtin_carousel":      {"items", "typing"},
	"builtin_image":         {"image", "title"},
	"builtin_file":          {"file", "title"},
}

// deletedArgKeys are removed from the payload by extractPayload.
var deletedArgKeys = map[string]bool{
	"event": true, "temp": true, "user": true, "session": true, "bot": true, "BOT_URL": true,
}

// undefinedT is JavaScript `undefined`. Go nil stands for JavaScript `null`.
// Keys holding undefined are omitted from payloads (JSON.stringify drops them).
type undefinedT struct{}

var jsUndefined any = undefinedT{}

func isUndef(v any) bool {
	_, ok := v.(undefinedT)
	return ok
}

// truthy follows JavaScript truthiness.
func truthy(v any) bool {
	switch x := v.(type) {
	case nil, undefinedT:
		return false
	case bool:
		return x
	case float64:
		return x != 0 && x == x // NaN is falsy
	case int:
		return x != 0
	case int64:
		return x != 0
	case string:
		return x != ""
	default:
		return true
	}
}

// jsOr is `a || b`: returns the operand value, not a boolean.
func jsOr(a, b any) any {
	if truthy(a) {
		return a
	}
	return b
}

// jsAnd is `a && b`.
func jsAnd(a, b any) any {
	if !truthy(a) {
		return a
	}
	return b
}

// langKey stringifies a language like a JS template literal would
// (`${prop}$${lang}`), so an undefined language looks up "prop$undefined".
func langKey(lang any) string {
	if isUndef(lang) {
		return "undefined"
	}
	return stringify(lang)
}

func getOrUndef(m map[string]any, key string) any {
	if v, ok := m[key]; ok {
		return v
	}
	return jsUndefined
}

// translateFormData mirrors getOriginalProps. For each schema
// property it takes `prop$lang`, else `prop$defaultLang`, else a nested dict
// `prop[lang]`/`prop[defaultLang]`. The JS `||`/`&&` chain is reproduced
// exactly, including its drop of falsy values.
// Example: `markdown$en: false` is dropped from the payload.
func translateFormData(formData map[string]any, contentType string, userLang, defaultLang any) map[string]any {
	props := contentProps[contentType]
	out := make(map[string]any, len(props))
	for _, prop := range props {
		sep := jsOr(
			getOrUndef(formData, prop+"$"+langKey(userLang)),
			jsAnd(defaultLang, getOrUndef(formData, prop+"$"+langKey(defaultLang))),
		)
		base := getOrUndef(formData, prop)
		nested := jsAnd(base, jsOr(
			nestedGet(base, userLang),
			jsAnd(defaultLang, nestedGet(base, defaultLang)),
		))
		if v := jsOr(sep, nested); !isUndef(v) {
			out[prop] = v
		}
	}
	return out
}

// nestedGet is `base[lang]` for a dict-valued base; other types yield undefined.
func nestedGet(base any, lang any) any {
	m, ok := base.(map[string]any)
	if !ok {
		return jsUndefined
	}
	return getOrUndef(m, langKey(lang))
}

// eventUserLanguage is `_.get(args, 'event.state.user.language')`.
func eventUserLanguage(args map[string]any) any {
	cur := any(args)
	for _, seg := range []string{"event", "state", "user", "language"} {
		m, ok := cur.(map[string]any)
		if !ok {
			return jsUndefined
		}
		v, ok := m[seg]
		if !ok {
			return jsUndefined
		}
		cur = v
	}
	return cur
}

// RenderElement mirrors renderElement for the `say #!<id>`
// form and returns the payloads legacy collects for the channel "api".
// args is the instruction context (event, temp, user, session, bot,...).
// pick may be nil; the global random source is then used.
func RenderElement(bot *model.Bot, contentID string, args map[string]any, pick Picker) ([]map[string]any, error) {
	id := strings.TrimPrefix(contentID, "#") // legacy engine behavior: one leading '#' is stripped from the content id
	if !strings.HasPrefix(id, "!") {
		return nil, fmt.Errorf("%w: %q (only #!<id> is supported)", ErrUnsupported, contentID)
	}
	id = id[1:]
	el, ok := bot.ContentElements[id]
	if !ok {
		return nil, fmt.Errorf("%w: %s", ErrNotFound, id)
	}
	if _, ok := contentProps[el.ContentType]; !ok {
		return nil, fmt.Errorf("%w: content type %q", ErrUnsupported, el.ContentType)
	}

	var defaultLang any = jsUndefined
	if bot.Config.DefaultLanguage != "" {
		defaultLang = bot.Config.DefaultLanguage
	}
	formData := translateFormData(el.FormData, el.ContentType, eventUserLanguage(args), defaultLang)

	renderedAny, err := RenderRecursive(formData, args)
	if err != nil {
		return nil, err
	}
	rendered := renderedAny.(map[string]any)

	// pick one of [text,...variations] at random.
	// Only string variations are spread; a non-array value is ignored.
	candidates := []any{getOrUndef(rendered, "text")}
	if vs, ok := getOrUndef(rendered, "variations").([]any); ok {
		candidates = append(candidates, vs...)
	}
	idx := 0
	if pick != nil {
		idx = pick.IntN(len(candidates))
	} else {
		idx = rand.IntN(len(candidates))
	}
	if chosen := candidates[idx]; truthy(chosen) {
		if s, ok := chosen.(string); ok {
			out, err := RenderTemplate(s, args)
			if err != nil {
				return nil, err
			}
			rendered["text"] = out
		} else {
			rendered["text"] = chosen
		}
	}

	// args = {...args,...content.formData}
	merged := make(map[string]any, len(args)+len(rendered))
	for k, v := range args {
		merged[k] = v
	}
	for k, v := range rendered {
		merged[k] = v
	}
	// args.text = renderTemplate(args.text, args)
	if t := getOrUndef(merged, "text"); truthy(t) {
		if s, ok := t.(string); ok {
			out, err := RenderTemplate(s, merged)
			if err != nil {
				return nil, err
			}
			merged["text"] = out
		}
	}

	return []map[string]any{extractPayload(strings.TrimPrefix(el.ContentType, "builtin_"), merged)}, nil
}

// extractPayload mirrors extractPayload: {type,...data} minus the
// event context keys. Undefined values are dropped.
func extractPayload(typ string, data map[string]any) map[string]any {
	out := map[string]any{"type": typ}
	for k, v := range data {
		if deletedArgKeys[k] || isUndef(v) {
			continue
		}
		out[k] = v
	}
	return out
}
