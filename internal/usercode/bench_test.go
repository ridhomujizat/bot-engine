package usercode

import (
	"context"
	"testing"
)

// BenchmarkEvalCondition measures one transition condition, the hottest path:
// a fresh goja runtime per call, with the compiled program cached.
func BenchmarkEvalCondition(b *testing.B) {
	r := New(Options{})
	sb := &Sandbox{Event: map[string]any{"state": condState()}}
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		if _, err := r.EvalCondition(context.Background(), "temp['skill-choice-ret-abc'] == 'ya'", sb); err != nil {
			b.Fatal(err)
		}
	}
}

// BenchmarkRunAction measures a small action, including the prelude and bp setup.
func BenchmarkRunAction(b *testing.B) {
	r := New(Options{})
	code := "const v = await Promise.resolve(1)\nsession.n = session.n + v\nreturn session.n"
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		sb := &Sandbox{Event: map[string]any{"state": map[string]any{"session": map[string]any{"n": 1.0}}}}
		if _, err := r.RunAction(context.Background(), "bench", code, sb, nil); err != nil {
			b.Fatal(err)
		}
	}
}
