package studioapi

import (
	"context"
	"fmt"

	"github.com/ridhomujizat/bot-engine/internal/httperr"
)

// GetBotConfig returns bot.config.json (GET /config).
func (s *Service) GetBotConfig(ctx context.Context, botID string) (*OMap, error) {
	return s.botConfig(ctx, botID)
}

// UpdateBotConfig shallow-merges body into bot.config.json and keeps the id (POST /config).
func (s *Service) UpdateBotConfig(ctx context.Context, botID string, body *OMap) error {
	if err := s.assertWritable(ctx, botID); err != nil {
		return err
	}
	cfg, err := s.botConfig(ctx, botID)
	if err != nil {
		return err
	}
	for _, k := range body.Keys {
		cfg.Set(k, body.Vals[k])
	}
	cfg.Set("id", botID)
	return s.writeJSON(ctx, botPath(botID, "bot.config.json"), cfg)
}

// Env returns the variables the editor reads at boot (GET /env). Subset of the legacy engine's list.
func (s *Service) Env(ctx context.Context, botID, externalPrefix string) (map[string]any, error) {
	cfg, err := s.botConfig(ctx, botID)
	if err != nil {
		return nil, err
	}
	name, _ := cfg.Get("name")
	locked, _ := cfg.Get("locked")
	return map[string]any{
		"BOT_API_PATH":    fmt.Sprintf("%s/api/v1/bots/%s", externalPrefix, botID),
		"STUDIO_API_PATH": fmt.Sprintf("%s/api/v1/studio/%s", externalPrefix, botID),
		"BOT_ID":          botID,
		"BOT_NAME":        name,
		"BP_BASE_PATH":    fmt.Sprintf("%s/studio/%s", externalPrefix, botID),
		"BOT_LOCKED":      locked == true,
		"IS_BOT_MOUNTED":  true,
		"IS_PRO_ENABLED":  false,
	}, nil
}

// assertBotExists is used by routes that must 404 for unknown bots.
func (s *Service) assertBotExists(ctx context.Context, botID string) error {
	if !validBotID(botID) {
		return httperr.NotFound("Invalid Bot ID")
	}
	_, err := s.botConfig(ctx, botID)
	return err
}
