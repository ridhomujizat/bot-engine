package usercode

import (
	"context"
	"fmt"
	"sync"
	"testing"
)

// TestConcurrentRunsAreIsolated runs many actions and conditions at once on a
// single Runner. Each run must see only its own state; the race detector
// guards the shared program cache and runner options.
func TestConcurrentRunsAreIsolated(t *testing.T) {
	r := New(Options{Console: testWriter{t}})
	const workers = 32
	const rounds = 20
	var wg sync.WaitGroup
	errs := make(chan error, workers*rounds)

	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			for i := 0; i < rounds; i++ {
				tag := fmt.Sprintf("w%d-r%d", w, i)
				sb := &Sandbox{BotID: "b", Event: map[string]any{"state": map[string]any{
					"session": map[string]any{"tag": tag},
					"temp":    map[string]any{},
				}}}
				code := `
const v = await Promise.resolve(session.tag)
temp.seen = v
return v + '!'`
				res, err := r.RunAction(context.Background(), "conc", code, sb, nil)
				if err != nil {
					errs <- err
					continue
				}
				if res != tag+"!" {
					errs <- fmt.Errorf("result %v, want %s!", res, tag)
				}
				if got := sb.Event["state"].(map[string]any)["temp"].(map[string]any)["seen"]; got != tag {
					errs <- fmt.Errorf("temp.seen %v, want %s", got, tag)
				}
				ok, err := r.EvalCondition(context.Background(), "session.tag === '"+tag+"'", sb)
				if err != nil || !ok {
					errs <- fmt.Errorf("condition for %s: ok=%v err=%v", tag, ok, err)
				}
			}
		}(w)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Error(err)
	}
}
