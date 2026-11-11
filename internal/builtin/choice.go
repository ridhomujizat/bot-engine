package builtin

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"github.com/ridhomujizat/bot-engine/internal/model"
)

// Ports of legacy and
// The temp keys carry a randomId suffix ("skill-choice-valid-<id>") when the flow sets one;
// flows generated before randomId existed use the bare names.

const intentPrefix = "intent:"

// choiceNumberRe is /^[#).!]?([\d]{1,2})[#).!]?$/ from
var choiceNumberRe = regexp.MustCompile(`^[#).!]?([0-9]{1,2})[#).!]?$`)

// choiceKeySuffix ports `args.randomId ? '-' + args.randomId: ”`.
func (c *call) choiceKeySuffix() string {
	v, ok := c.arg("randomId")
	if !ok || !jsTruthy(v) {
		return ""
	}
	return "-" + jsToString(v)
}

// contentElementChoice ports `_.get(element, 'formData.choices.<index>.value')` on the raw
// element from bp.cms.getContentElement. Stored single-choice elements keep their keys as
// "choices$en", so `formData.choices` is usually absent and
// the number match finds nothing. legacy behaves the same, so this is kept.
func contentElementChoice(bot *model.Bot, contentID string, index int) any {
	if bot == nil || index < 0 {
		return nil
	}
	el := bot.ContentElements[contentID]
	if el == nil {
		return nil
	}
	choices, ok := el.FormData["choices"].([]any)
	if !ok || index >= len(choices) {
		return nil
	}
	obj, _ := choices[index].(map[string]any)
	return obj["value"]
}

// lcstr ports `value => typeof value === 'string' ? value.toLowerCase: ”`.
func lcstr(v any) string {
	if s, ok := v.(string); ok {
		return jsLower(s)
	}
	return ""
}

func choiceParseAnswer(c *call) error {
	cfg := c.deps.basicSkills()
	keywordsRaw, _ := c.arg("keywords")
	keywords := keyedEntries(keywordsRaw)

	preview, _ := c.event["preview"]
	var choice any // nil = undefined or falsy

	// const nb = event.preview && event.preview.match(...)
	nb, nbMatched := "", false
	if jsTruthy(preview) {
		ps, ok := preview.(string)
		if !ok {
			return fmt.Errorf("event.preview.match is not a function")
		}
		if m := choiceNumberRe.FindStringSubmatch(ps); m != nil {
			nb, nbMatched = m[1], true
		}
	}

	if cfg.MatchNumbers && nbMatched {
		index, _ := strconv.Atoi(nb)
		index--
		choice = contentElementChoice(c.deps.Bot, jsToString(c.argOrUndef("contentId")), index)
	}

	if !jsTruthy(choice) && cfg.MatchNLU {
		key, found, err := c.matchIntent(keywords)
		if err != nil {
			return err
		}
		if found {
			choice = key
		}
	}

	if !jsTruthy(choice) {
		previewLC := lcstr(preview)
		payload, _ := c.event["payload"].(map[string]any)
		userText := lcstr(payload["text"])
		choiceValue := lcstr(payload["payload"])

		// First pass: exact match on any keyword.
		choice = findKey(keywords, func(k any) bool {
			kw := lcstr(k)
			return previewLC == kw || userText == kw || choiceValue == kw
		})
		if !jsTruthy(choice) {
			// Second pass: substring match. An empty keyword matches everything (JS includes("") is true).
			choice = findKey(keywords, func(k any) bool {
				kw := lcstr(k)
				return strings.Contains(previewLC, kw) || strings.Contains(userText, kw) || strings.Contains(choiceValue, kw)
			})
		}
	}

	suffix := c.choiceKeySuffix()
	temp, err := c.bag("temp")
	if err != nil {
		return err
	}
	if jsTruthy(choice) {
		temp["skill-choice-valid"+suffix] = true
		temp["skill-choice-ret"+suffix] = choice
	} else {
		temp["skill-choice-valid"+suffix] = false
	}
	return nil
}

// argOrUndef returns args[name] or nil when absent (for ToString/truthiness use only).
func (c *call) argOrUndef(name string) any {
	v, _ := c.arg(name)
	return v
}

// findKey ports _.findKey(keywords, fn): the first key (in iteration order) whose keyword list
// satisfies fn for some item. It returns the key as a string, or nil when none match. The
// keyword list itself is checked with `_.some(keywords || [],...)`.
func findKey(entries []keyedEntry, pred func(k any) bool) any {
	for _, e := range entries {
		items := e.value
		if items == nil {
			items = []any{}
		}
		for _, k := range listOf(items) {
			if pred(k) {
				return e.key
			}
		}
	}
	return nil
}

// matchIntent ports the matchNLU branch: keywords starting with "intent:" compare against
// event.nlu.intent.name. A missing event.nlu.intent throws in JS, so it is an error here.
func (c *call) matchIntent(entries []keyedEntry) (string, bool, error) {
	for _, e := range entries {
		arr, ok := e.value.([]any)
		if !ok {
			return "", false, fmt.Errorf("keywords.filter is not a function")
		}
		var intents []string
		for _, x := range arr {
			if !jsTruthy(x) {
				continue
			}
			s, ok := x.(string)
			if !ok {
				return "", false, fmt.Errorf("keyword.toLowerCase is not a function")
			}
			if strings.HasPrefix(jsLower(s), intentPrefix) && len(s) >= len(intentPrefix) {
				intents = append(intents, s[len(intentPrefix):])
			}
		}
		for _, k := range intents {
			name, err := c.nluIntentName()
			if err != nil {
				return "", false, err
			}
			if name == k {
				return e.key, true, nil
			}
		}
	}
	return "", false, nil
}

func (c *call) nluIntentName() (string, error) {
	nlu, ok := c.event["nlu"].(map[string]any)
	if !ok {
		return "", fmt.Errorf("event.nlu is undefined")
	}
	intent, ok := nlu["intent"].(map[string]any)
	if !ok {
		return "", fmt.Errorf("event.nlu.intent is undefined")
	}
	name, _ := intent["name"].(string)
	return name, nil
}

// choiceInvalidAnswer ports temp[key] = (temp[key] || 0) + 1.
func choiceInvalidAnswer(c *call) error {
	suffix := c.choiceKeySuffix()
	key := "skill-choice-invalid-count" + suffix
	temp, err := c.bag("temp")
	if err != nil {
		return err
	}
	temp[key] = jsPlusOne(temp[key])
	return nil
}
