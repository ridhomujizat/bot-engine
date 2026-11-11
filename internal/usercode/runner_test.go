package usercode

import (
	"context"
	"reflect"
	"testing"
)

// TestSyntaxCoverage is the spike result from plan 4.2: goja runs the syntax
// bot code uses, with the body wrapped as an async function.
func TestSyntaxCoverage(t *testing.T) {
	cases := map[string]struct {
		code string
		want any
	}{
		"await on resolved promise": {"return await Promise.resolve(3)", 3.0},
		"template literal":          {"const a = 1; return `x${a + 1}y`", "x2y"},
		"spread array":              {"const a = [1, 2]; return [...a, 3].length", 3.0},
		"spread object":             {"const o = { a: 1 }; return { ...o, b: 2 }", map[string]any{"a": 1.0, "b": 2.0}},
		"destructuring":             {"const { x, y: z } = { x: 1, y: 2 }; const [p] = [9]; return x + z + p", 12.0},
		"top-level return":          {"return 'ok'", "ok"},
		"optional chaining":         {"const o = {}; return o?.a?.b ?? 7", 7.0},
		"async arrow":               {"const g = async (v) => v * 2; return await g(4)", 8.0},
		"class":                     {"class A { m() { return 1 } }; return new A().m()", 1.0},
		"for-of with await":         {"let s = 0; for (const v of [1, 2]) { s += await v } return s", 3.0},
		"regexp and string methods": {"return 'a-b'.replace(/-/g, '+').padStart(5, '*')", "**a+b"},
		"try catch TypeError":       {"try { undefined.x } catch (e) { return e instanceof TypeError }", true},
		"no return yields null":     {"const a = 1", nil},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			res, _, err := runCode(t, tc.code, map[string]any{})
			if err != nil {
				t.Fatalf("err = %v", err)
			}
			if !reflect.DeepEqual(res, tc.want) {
				t.Fatalf("result = %#v, want %#v", res, tc.want)
			}
		})
	}
}

func TestRunActionAsyncHostPromiseAndWriteBack(t *testing.T) {
	state := map[string]any{
		"session": map[string]any{"n": 1.0},
		"temp":    map[string]any{},
	}
	sb := &Sandbox{BotID: "b", Event: map[string]any{"state": state}}
	code := "const v = await Promise.resolve(41)\nsession.n = session.n + v\ntemp.x = `t${v}`\nbp.logger.info('hi', v)\nreturn {ok: true, v}"
	r := New(Options{Console: testWriter{t}})
	res, err := r.RunAction(context.Background(), "smoke", code, sb, &nopHost{})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(res, map[string]any{"ok": true, "v": 41.0}) {
		t.Fatalf("result = %#v", res)
	}
	st := sb.Event["state"].(map[string]any)
	if st["session"].(map[string]any)["n"] != 42.0 || st["temp"].(map[string]any)["x"] != "t41" {
		t.Fatalf("state = %#v", st)
	}
}

func TestRunActionArgsAndNilSandbox(t *testing.T) {
	r := New(Options{Console: testWriter{t}})
	sb := &Sandbox{Event: map[string]any{}, Args: map[string]any{"name": "x", "value": 3.0}}
	res, err := r.RunAction(context.Background(), "args", "return [args.name, args.value]", sb, nil)
	if err != nil || !reflect.DeepEqual(res, []any{"x", 3.0}) {
		t.Fatalf("res=%#v err=%v", res, err)
	}
	if _, err := r.RunAction(context.Background(), "nil", "return 1", nil, nil); err != nil {
		t.Fatalf("nil sandbox: %v", err)
	}
}

func TestRunActionSyntaxErrorNamesAction(t *testing.T) {
	r := New(Options{Console: testWriter{t}})
	_, err := r.RunAction(context.Background(), "broken", "const = 1", &Sandbox{Event: map[string]any{}}, nil)
	if err == nil {
		t.Fatal("expected syntax error")
	}
	if got := err.Error(); len(got) < len("actions/broken.js") || got[:len("actions/broken.js")] != "actions/broken.js" {
		t.Fatalf("error should name the file: %v", got)
	}
}
