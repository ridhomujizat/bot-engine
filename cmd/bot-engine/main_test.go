package main

import (
	"bytes"
	"context"
	"strings"
	"testing"

	"github.com/ridhomujizat/bot-engine/config"
	"github.com/ridhomujizat/bot-engine/internal/botfs"
	"github.com/ridhomujizat/bot-engine/internal/engine"
)

func TestGlobalDialogPrecedence(t *testing.T) {
	bc, err := config.ParseLegacyConfig([]byte(`{"dialog":{"timeoutInterval":"25m"},"converse":{"maxMessageLength":66000}}`))
	if err != nil {
		t.Fatal(err)
	}
	cfg := config.Config{DialogSessionTimeoutInterval: "45m"}
	g := globalDialog(cfg, bc)
	want := engine.GlobalDialogConfig{
		TimeoutInterval: "25m", SessionTimeoutInterval: "45m", JanitorInterval: "10s",
		ConverseTimeout: "5s", MaxMessageLength: 66000,
	}
	if g != want {
		t.Fatalf("got %+v want %+v", g, want)
	}
}

func TestValidateCmdReportsEveryBot(t *testing.T) {
	dir := t.TempDir()
	disk := botfs.NewDisk(dir)
	if err := disk.WriteFile(context.Background(), "data/bots/example-bot/bot.config.json", []byte(`{"id":"example-bot"}`)); err != nil {
		t.Fatal(err)
	}
	t.Setenv("BOTFS_DIR", dir)
	var out bytes.Buffer
	// The fixture bot has no flows: the outcome depends on the loader, so only the report shape is checked.
	_ = run([]string{"validate", "--all"}, &out, &out)
	if !strings.Contains(out.String(), "example-bot: ") || !strings.Contains(out.String(), "bots with issues") {
		t.Fatalf("report shape: %s", out.String())
	}
}

func TestValidateRejectsBothFlags(t *testing.T) {
	t.Setenv("BOTFS_DIR", t.TempDir())
	var out bytes.Buffer
	if err := run([]string{"validate", "--bot", "x", "--all"}, &out, &out); err == nil {
		t.Fatal("--bot with --all accepted")
	}
}

func TestUnknownCommand(t *testing.T) {
	t.Setenv("BOTFS_DIR", t.TempDir())
	var out bytes.Buffer
	if err := run([]string{"frobnicate"}, &out, &out); err == nil {
		t.Fatal("unknown command accepted")
	}
}
