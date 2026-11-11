package usercode

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"reflect"
	"sort"
	"strconv"

	"github.com/dop251/goja"
)

// errCircular is returned when JS data contains a cycle that cannot be
// represented as JSON.
var errCircular = errors.New("usercode: converting circular structure to JSON")

// toGo converts a JS value to a JSON-like Go value following JSON.stringify
// rules: objects become map[string]any, arrays []any, numbers float64, and
// undefined/functions/symbols report ok=false so callers can drop them.
// Objects with a callable toJSON (Date, Buffer) are converted through it.
func toGo(v goja.Value) (out any, ok bool, err error) {
	return toGoRec(v, map[*goja.Object]bool{})
}

func toGoRec(v goja.Value, stack map[*goja.Object]bool) (any, bool, error) {
	if v == nil || goja.IsUndefined(v) {
		return nil, false, nil
	}
	if goja.IsNull(v) {
		return nil, true, nil
	}
	switch x := v.Export().(type) {
	case bool:
		return x, true, nil
	case string:
		return x, true, nil
	}
	obj, isObj := v.(*goja.Object)
	if !isObj {
		switch v.ExportType().Kind() {
		case reflect.Float64, reflect.Int64, reflect.Int:
			return numberOf(v.ToFloat()), true, nil
		}
		return v.String(), true, nil
	}
	if _, callable := goja.AssertFunction(obj); callable {
		return nil, false, nil
	}
	if stack[obj] {
		return nil, false, errCircular
	}
	stack[obj] = true
	defer delete(stack, obj)

	if toJSON, callable := goja.AssertFunction(getProp(obj, "toJSON")); callable {
		res, err := toJSON(obj, goja.Undefined())
		if err != nil {
			return nil, false, err
		}
		if res != obj {
			return toGoRec(res, stack)
		}
	}

	if obj.ClassName() == "Array" {
		n := int(getProp(obj, "length").ToInteger())
		arr := make([]any, 0, n)
		for i := 0; i < n; i++ {
			item, ok, err := toGoRec(obj.GetIdx(int64(i)), stack)
			if err != nil {
				return nil, false, err
			}
			if !ok {
				item = nil // JSON.stringify turns undefined array items into null
			}
			arr = append(arr, item)
		}
		return arr, true, nil
	}

	m := map[string]any{}
	for _, key := range obj.Keys() {
		item, ok, err := toGoRec(getProp(obj, key), stack)
		if err != nil {
			return nil, false, err
		}
		if ok {
			m[key] = item
		}
	}
	return m, true, nil
}

// numberOf mirrors JSON.stringify: NaN and infinities become null.
func numberOf(f float64) any {
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return nil
	}
	return f
}

// toGoMap converts a JS value that must be an object into map[string]any.
// Non-objects yield an empty map.
func toGoMap(v goja.Value) (map[string]any, error) {
	out, ok, err := toGo(v)
	if err != nil {
		return nil, err
	}
	m, isMap := out.(map[string]any)
	if !ok || !isMap {
		return map[string]any{}, nil
	}
	return m, nil
}

// toJS builds a JS value from a JSON-like Go value. The result is a deep copy:
// JS mutations do not touch the Go value until the caller writes them back.
func toJS(vm *goja.Runtime, v any) goja.Value {
	switch x := v.(type) {
	case nil:
		return goja.Null()
	case bool, string, float64:
		return vm.ToValue(x)
	case float32:
		return vm.ToValue(float64(x))
	case int:
		return vm.ToValue(x)
	case int64:
		return vm.ToValue(x)
	case json.Number:
		f, err := x.Float64()
		if err != nil {
			return vm.ToValue(x.String())
		}
		return vm.ToValue(f)
	case map[string]any:
		obj := vm.NewObject()
		keys := make([]string, 0, len(x))
		for k := range x {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			_ = obj.Set(k, toJS(vm, x[k]))
		}
		return obj
	case []any:
		items := make([]any, len(x))
		for i, item := range x {
			items[i] = toJS(vm, item)
		}
		return vm.NewArray(items...)
	case goja.Value:
		return x
	}
	// Any other Go type (ints of other widths, structs, time.Time,...) goes
	// through JSON so the JS side sees the same shape a JSON payload would have.
	raw, err := json.Marshal(v)
	if err != nil {
		return vm.ToValue(fmt.Sprint(v))
	}
	var generic any
	if err := json.Unmarshal(raw, &generic); err != nil {
		return vm.ToValue(fmt.Sprint(v))
	}
	if generic == nil && !isNilValue(v) {
		return vm.ToValue(string(raw))
	}
	return toJS(vm, generic)
}

func isNilValue(v any) bool {
	rv := reflect.ValueOf(v)
	switch rv.Kind() {
	case reflect.Ptr, reflect.Map, reflect.Slice, reflect.Interface:
		return rv.IsNil()
	}
	return false
}

// getProp reads a property, treating a missing property as undefined.
func getProp(obj *goja.Object, name string) goja.Value {
	if obj == nil {
		return goja.Undefined()
	}
	v := obj.Get(name)
	if v == nil {
		return goja.Undefined()
	}
	return v
}

// jsString renders a Go JSON-like value the way a JS template literal would
// render it for the common cases (strings, numbers, booleans, null, undefined).
func jsString(v any, present bool) string {
	if !present {
		return "undefined"
	}
	switch x := v.(type) {
	case nil:
		return "null"
	case string:
		return x
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64)
	case bool:
		return strconv.FormatBool(x)
	}
	return fmt.Sprint(v)
}
