// Package flow loads bots from botfs into model.Bot and validates them against
// the locked feature scope (plan A0 / A2).
//
// OWNERSHIP: exported signatures in THIS FILE are a shared contract; bodies owned by the engine agent.
package flow

import (
	"context"

	"github.com/ridhomujizat/bot-engine/internal/botfs"
	"github.com/ridhomujizat/bot-engine/internal/model"
)

// Load reads bot.config.json, flows/**/*.json, content-elements/*.json,
// actions/**/*.js, hooks/**/*.js of botID. Other files (media/, qna/, intents/,
// *.json) are not read.
func Load(ctx context.Context, store botfs.Store, botID string) (*model.Bot, error) {
	return load(ctx, store, botID)
}

// Issue is one out-of-scope feature found by Validate.
type Issue struct {
	File    string `json:"file"`
	Message string `json:"message"`
	// Warn marks a finding legacy tolerates at runtime (for example a dangling
	// transition target). Only non-Warn issues reject a bot.
	Warn bool `json:"warn,omitempty"`
}

// Validate checks node types, skills, content types, instruction shapes,
// bp.* usage and require against the A0 scope. Empty result = OK.
func Validate(bot *model.Bot) []Issue { return validate(bot) }
