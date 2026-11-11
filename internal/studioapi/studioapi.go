// Package studioapi serves the legacy-compatible editor API (routes
// under /api/v1/studio/:botId), the code-editor API for actions and hooks, and the
// admin bot list and archive import/export. Writes go through botfs in the legacy
// file layout, so legacy and bot-engine can read each other's files.
package studioapi

import (
	"context"

	"github.com/ridhomujizat/bot-engine/internal/botfs"
	"github.com/ridhomujizat/bot-engine/internal/flow"
	"github.com/ridhomujizat/bot-engine/internal/model"
)

// Service holds the dependencies of every studio endpoint.
type Service struct {
	store botfs.Store
	// validate runs flow.Validate; overridable in tests.
	validate func(*model.Bot) []flow.Issue
	// loadBot loads a bot from a store (used by archive import).
	loadBot func(botfs.Store, string) (*model.Bot, error)
	// media holds upload limits from legacy.config.json fileUpload.
	media MediaLimits
}

// New returns the studio service over store.
func New(store botfs.Store) *Service {
	return &Service{
		store:    store,
		validate: flow.Validate,
		loadBot:  func(s botfs.Store, id string) (*model.Bot, error) { return flow.Load(context.Background(), s, id) },
	}
}

// blockingIssues drops warnings: legacy saves and imports flows with dangling transition targets,
// missing content elements or actions (they fail at runtime, into the error flow), so only
// out-of-scope features block a save or import.
func blockingIssues(issues []flow.Issue) []flow.Issue {
	var out []flow.Issue
	for _, is := range issues {
		if !is.Warn {
			out = append(out, is)
		}
	}
	return out
}
