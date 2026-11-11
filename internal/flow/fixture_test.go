package flow

import (
	"context"
	"os"
	"testing"
)

// The real synthetic-choice export (testdata/bots) must load and pass the
// A0 scope check. Warnings are allowed, rejections are not.
func TestSyntheticChoiceFixture(t *testing.T) {
	// Export incomplete: content-elements/{builtin_text,builtin_single-choice,builtin_file}.json
	// are not in testdata yet, so every `say #!id` dangles. Remove this skip once exported.
	if _, err := os.Stat("../../testdata/bots/synthetic-choice/content-elements/builtin_text.json"); err != nil {
		t.Skip("synthetic-choice fixture incomplete: content-elements not exported yet")
	}
	store := dirStore{root: "../../testdata/bots"}
	bot, err := Load(context.Background(), store, "synthetic-choice")
	if err != nil {
		t.Fatal(err)
	}
	for _, i := range Validate(bot) {
		if !i.Warn {
			t.Errorf("rejected: %s: %s", i.File, i.Message)
		} else {
			t.Logf("warning: %s: %s", i.File, i.Message)
		}
	}
}
