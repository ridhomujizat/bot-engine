package studioapi

import "testing"

// Native builtins are offered in the action picker with the params the engine reads.
func TestBuiltinActionDefsAreGlobalAndHaveParams(t *testing.T) {
	defs := builtinActionDefs()
	if len(defs) == 0 {
		t.Fatal("no builtin actions listed")
	}
	seen := map[string]bool{}
	for _, d := range defs {
		if d.Scope != "global" || d.Params == nil {
			t.Fatalf("%s: scope=%q params=%v", d.Name, d.Scope, d.Params)
		}
		seen[d.Name] = true
	}
	if !seen["builtin/setVariable"] {
		t.Fatal("builtin/setVariable missing")
	}
}
