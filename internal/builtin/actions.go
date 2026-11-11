package builtin

import (
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/ridhomujizat/bot-engine/internal/state"
)

// Ports of legacy builtin actions. Each function mirrors one JS body line by line;
// the legacy file is named in the comment above it.

// isoMillis is moment's toJSON layout (UTC, millisecond precision).
const isoMillis = "2006-01-02T15:04:05.000Z"

// keepOnReset is PROPERTIES_TO_KEEP in
var keepOnReset = map[string]bool{"lastMessages": true, "nluContexts": true, "workflows": true}

// botGlobal ports bp.kvs.forBot(botId).get('global') copied with a spread ({...original}).
// A non-object original spreads to nothing in this port (JS would spread string characters or
// array indices; bot state is always an object in practice).
func (c *call) botGlobal() (map[string]any, error) {
	v, _, err := c.kvsGet("global")
	if err != nil {
		return nil, err
	}
	out := map[string]any{}
	if m, ok := v.(map[string]any); ok {
		for k, x := range m {
			out[k] = x
		}
	}
	return out, nil
}

// getStorageWithExpiry ports KeyValueStore.forBot(...).getStorageWithExpiry(key)
// = unboxWithExpiry(get(key)). Returns (value, present, err).
func (c *call) getStorageWithExpiry(key string) (any, bool, error) {
	raw, ok, err := c.kvsGet(key)
	if err != nil || !ok {
		return nil, false, err
	}
	box, _ := raw.(map[string]any)
	if box == nil || !jsTruthy(box["expiry"]) {
		return nil, false, nil
	}
	if !jsStrictEqual(box["expiry"], "never") && !c.expiryAfterNow(box["expiry"]) {
		return nil, false, nil
	}
	v, has := box["value"]
	return v, has, nil
}

// expiryAfterNow ports moment(expiry).isAfter: invalid dates compare false.
func (c *call) expiryAfterNow(exp any) bool {
	now := c.deps.now()
	switch e := exp.(type) {
	case string:
		t, err := time.Parse(time.RFC3339Nano, e)
		return err == nil && t.After(now)
	case float64:
		if math.IsNaN(e) || math.IsInf(e, 0) {
			return false
		}
		return time.UnixMilli(int64(e)).After(now)
	}
	return false
}

// setStorageWithExpiry ports KeyValueStore.forBot(...).setStorageWithExpiry(key, value, expiry)
// = set(key, boxWithExpiry(value, expiry)). The box is stored with no
// row-level expireOn, exactly like legacy. expiryPresent=false means undefined, which defaults to "never".
func (c *call) setStorageWithExpiry(key string, value any, hasValue bool, expiry any, expiryPresent bool) error {
	exp := any("never")
	if expiryPresent && !jsStrictEqual(expiry, "never") {
		s, ok := expiry.(string)
		if !ok {
			// ms(null) throws in JS. Numbers return a formatted string in JS and then add
			// unpredictably; flows only pass strings, so refuse rather than guess.
			return fmt.Errorf("unsupported expiry value %s", jsToString(expiry))
		}
		if s == "" {
			return fmt.Errorf("val is not a non-empty string or a valid number")
		}
		ms, ok := state.ParseMs(s)
		if !ok {
			ms = 0 // ms() returns undefined, moment().add(undefined) keeps "now"
		}
		exp = c.deps.now().Add(time.Duration(ms * float64(time.Millisecond))).UTC().Format(isoMillis)
	}
	box := map[string]any{"expiry": exp}
	if hasValue {
		box["value"] = value
	}
	return c.kvsSet(key, box, 0)
}

// --- builtin/ ---------------------------------------------------

func setVariable(c *call) error {
	typ, _ := c.arg("type")
	value, hasValue := c.arg("value")
	if jsStrictEqual(typ, "bot") {
		orig, err := c.botGlobal()
		if err != nil {
			return err
		}
		key := c.key("name")
		if hasValue {
			orig[key] = value
		} else {
			delete(orig, key) // { ...original, [name]: undefined } drops the key on JSON.stringify
		}
		return c.kvsSet("global", orig, 0)
	}
	if !hasValue || jsStrictEqual(value, "null") || jsStrictEqual(value, "") {
		b, err := c.bag(c.key("type"))
		if err != nil {
			return err
		}
		delete(b, c.key("name"))
		return nil
	}
	b, err := c.bag(c.key("type"))
	if err != nil {
		return err
	}
	b[c.key("name")] = value
	return nil
}

// --- builtin/ ------------------------------------------------

func removeVariable(c *call) error {
	typ, _ := c.arg("type")
	if jsStrictEqual(typ, "bot") {
		orig, err := c.botGlobal()
		if err != nil {
			return err
		}
		// legacy stores the STRING 'null', it does not delete the key.
		orig[c.key("name")] = "null"
		return c.kvsSet("global", orig, 0)
	}
	b, err := c.bag(c.key("type"))
	if err != nil {
		return err
	}
	delete(b, c.key("name"))
	return nil
}

// --- builtin/ --------------------------------------------------

func resetSession(c *call) error {
	temp, err := c.bag("temp")
	if err != nil {
		return err
	}
	for k := range temp {
		if !keepOnReset[k] {
			delete(temp, k)
		}
	}
	session, err := c.bag("session")
	if err != nil {
		return err
	}
	for k := range session {
		if !keepOnReset[k] {
			delete(session, k)
		}
	}
	c.setFlag(FlagForcePersistState)
	return nil
}

// --- builtin/ --------------------------------------------------

func resetContext(c *call) error {
	session, err := c.bag("session")
	if err != nil {
		return err
	}
	session["nluContexts"] = []any{}
	return nil
}

// --- builtin/ -------------------------------------------------

// appendContext merges contexts into session.nluContexts. For each distinct context name the
// entry with the highest ttl is kept (ties: first occurrence), in first-occurrence order.
func appendContext(c *call) error {
	cv, ok := c.arg("contexts")
	contexts, isStr := cv.(string)
	if !ok || !isStr {
		return fmt.Errorf("contexts.trim is not a function")
	}
	// isNaN(Number(ttl)) ? 1000: Number(ttl). An absent ttl is undefined -> NaN -> 1000.
	ttl := 1000.0
	if tv, present := c.arg("ttl"); present {
		if n := jsToNumber(tv); !math.IsNaN(n) {
			ttl = n
		}
	}

	session, err := c.bag("session")
	if err != nil {
		return err
	}
	var existing []any
	switch e := session["nluContexts"].(type) {
	case nil:
	case []any:
		existing = e
	default:
		return fmt.Errorf("session.nluContexts is not iterable")
	}

	type entry struct {
		obj any     // the object pushed into the final list (original object, or a new one)
		ctx any     // entry.context
		ttl float64 // entry.ttl used for ordering (NaN sorts lowest)
	}
	var merged []entry
	for _, x := range existing {
		m, _ := x.(map[string]any)
		merged = append(merged, entry{obj: x, ctx: m["context"], ttl: sortTTL(m["ttl"])})
	}
	for _, name := range strings.Split(jsTrim(contexts), ",") {
		obj := map[string]any{"context": name, "ttl": ttl}
		merged = append(merged, entry{obj: obj, ctx: name, ttl: ttl})
	}

	visited := map[string]bool{}
	final := []any{}
	for _, m := range merged {
		k := jsToString(m.ctx)
		if visited[k] {
			continue
		}
		best := -1
		for i, o := range merged {
			if !jsStrictEqual(o.ctx, m.ctx) {
				continue
			}
			if best < 0 || sortTTLGreater(o.ttl, merged[best].ttl) {
				best = i
			}
		}
		final = append(final, merged[best].obj)
		visited[k] = true
	}
	session["nluContexts"] = final
	return nil
}

// sortTTL is the numeric key used by lodash orderBy for ttl. Non-numeric ttl sorts lowest.
func sortTTL(v any) float64 {
	n := jsToNumber(v)
	if math.IsNaN(n) {
		return math.Inf(-1)
	}
	return n
}

func sortTTLGreater(a, b float64) bool { return a > b }

// --- builtin/ -------------------------------------------------

func removeContext(c *call) error {
	cv, ok := c.arg("contexts")
	s, isStr := cv.(string)
	if !ok || !isStr {
		return fmt.Errorf("contexts.split is not a function")
	}
	remove := strings.Split(s, ",")
	session, err := c.bag("session")
	if err != nil {
		return err
	}
	var existing []any
	switch e := session["nluContexts"].(type) {
	case nil:
	case []any:
		existing = e
	default:
		return fmt.Errorf("session.nluContexts.filter is not a function")
	}
	out := []any{}
	for _, x := range existing {
		if m, ok := x.(map[string]any); ok {
			if cx, ok := m["context"].(string); ok && containsStr(remove, cx) {
				continue
			}
		}
		out = append(out, x)
	}
	session["nluContexts"] = out
	return nil
}

func containsStr(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// --- builtin/ --------------------------------

func incrementNumberOfConversations(c *call) error {
	key := "storage/users/" + c.eventKey("target") + "/numberOfConversations"
	v, has, err := c.getStorageWithExpiry(key)
	if err != nil {
		return err
	}
	var value any
	if !has {
		value = 0.0 // "Value could be 0": the first call outputs 0, not 1
	} else {
		value = jsIncrement(v)
	}
	if err := c.setStorageWithExpiry(key, value, true, nil, false); err != nil {
		return err
	}
	return c.setTemp(c.key("output"), value, true)
}

// --- builtin/ --------------------------------------

func getNumberOfConversations(c *call) error {
	key := "storage/users/" + c.eventKey("target") + "/numberOfConversations"
	v, has, err := c.getStorageWithExpiry(key)
	if err != nil {
		return err
	}
	return c.setTemp(c.key("output"), v, has)
}

// --- builtin/ ---------------------------------------------

func getGlobalVariable(c *call) error {
	key := "storage/global/" + c.key("name")
	v, has, err := c.getStorageWithExpiry(key)
	if err != nil {
		return err
	}
	return c.setTemp(c.key("output"), v, has)
}

// --- builtin/ ---------------------------------------------

func setGlobalVariable(c *call) error {
	key := "storage/global/" + c.key("name")
	value, hasValue := c.arg("value")
	expiry, expPresent := c.arg("expiry")
	if err := c.setStorageWithExpiry(key, value, hasValue, expiry, expPresent); err != nil {
		return err
	}
	if out, ok := c.arg("output"); ok && jsTruthy(out) {
		return c.setTemp(c.key("output"), value, hasValue)
	}
	return nil
}

// --- builtin/ -------------------------------------------

// resetGlobalVariable deletes "storage/global/<name>%" as a SQL LIKE pattern. legacy has NO botId
// filter here, so the delete runs across every bot. Kept on purpose for
// byte-for-byte parity; the Postgres and memory KVS implement it the same way.
func resetGlobalVariable(c *call) error {
	d, ok := c.deps.KVS.(state.KeyLikeDeleter)
	if !ok {
		return fmt.Errorf("kvs does not support LIKE deletes")
	}
	return d.DeleteKeysLike(c.ctx, "storage/global/"+c.key("name")+"%")
}

// --- builtin/ ----------------------------------------------------------

// wait sleeps `args.delay || 1000` ms. Node's setTimeout clamps values that are NaN, below 1 or
// above 2^31-1 to 1 ms, so this port does the same.
func wait(c *call) error {
	ms := 1000.0
	if d, ok := c.arg("delay"); ok && jsTruthy(d) {
		ms = jsToNumber(d)
	}
	if math.IsNaN(ms) || ms < 1 || ms > 2147483647 {
		ms = 1
	}
	timer := time.NewTimer(time.Duration(ms * float64(time.Millisecond)))
	defer timer.Stop()
	select {
	case <-timer.C:
		return nil
	case <-c.ctx.Done():
		return c.ctx.Err()
	}
}

// --- builtin/ ------------------------------------------------

// switchLanguage sets user.language (lower-cased) and forces a state persist. The webchat
// realtime push (bp.realtime.sendPayload, skipped for channel "api") is not ported.
func switchLanguage(c *call) error {
	lv, ok := c.arg("lang")
	lang, isStr := lv.(string)
	if !ok || !isStr {
		return fmt.Errorf("args.lang.toLowerCase is not a function")
	}
	user, err := c.bag("user")
	if err != nil {
		return err
	}
	user["language"] = jsLower(lang)
	c.setFlag(FlagForcePersistState)
	return nil
}
