package event

import (
	"testing"
	"time"
)

func TestFromConversePayloadAndPreview(t *testing.T) {
	body := map[string]any{"text": "halo", "metadata": map[string]any{"sid": "s1"}, "includedContexts": []string{"x"}}
	ev := FromConverse("bot", "u1", body, []string{"global"}, time.Unix(0, 0))

	if ev["type"] != "text" || ev["channel"] != "api" || ev["direction"] != "incoming" || ev["target"] != "u1" {
		t.Fatalf("event header = %v", ev)
	}
	payload := ev["payload"].(map[string]any)
	if payload["type"] != "text" {
		t.Fatalf("payload.type default not applied: %v", payload)
	}
	if _, ok := payload["includedContexts"]; ok {
		t.Fatalf("includedContexts must be stripped from payload")
	}
	if ev["preview"] != "halo" {
		t.Fatalf("preview = %v, want halo", ev["preview"])
	}
	nlu := ev["nlu"].(map[string]any)
	if nlu["intent"].(map[string]any)["name"] != "none" {
		t.Fatalf("nlu default intent missing: %v", nlu)
	}
	if st := ev["state"].(map[string]any); len(st["__stacktrace"].([]any)) != 0 {
		t.Fatalf("initial stacktrace not empty")
	}
}

func TestPreviewWithoutPayload(t *testing.T) {
	a := Args{Type: "timeout", Channel: "api", Payload: ""}
	if got := Preview(a); got != `"timeout" event on channel api` {
		t.Fatalf("preview = %v", got)
	}
}

func TestFlags(t *testing.T) {
	ev := New(Args{Type: "text", Channel: "api", Direction: DirectionIncoming, Payload: map[string]any{}}, time.Now())
	if HasFlag(ev, FlagSkipDialogEngine) {
		t.Fatal("flag set by default")
	}
	SetFlag(ev, FlagSkipDialogEngine, true)
	if !HasFlag(ev, FlagSkipDialogEngine) {
		t.Fatal("flag not set")
	}
}
