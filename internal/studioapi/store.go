package studioapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"

	"github.com/ridhomujizat/bot-engine/internal/botfs"
	"github.com/ridhomujizat/bot-engine/internal/httperr"
	"github.com/ridhomujizat/bot-engine/internal/model"
)

var botIDRe = regexp.MustCompile(`^[A-Z0-9]+[A-Z0-9_-]{1,}[A-Z0-9]+$`)

// validBotID mirrors legacy isValidBotId with the same regex (case-insensitive).
func validBotID(id string) bool {
	return botIDRe.MatchString(strings.ToUpper(id))
}

// botPath returns the BPFS path of a file inside a bot folder.
func botPath(botID, rel string) string {
	return botfs.BotPrefix(botID) + strings.TrimPrefix(rel, "/")
}

// safeRel rejects paths that escape the bot folder. Names come from clients.
func safeRel(rel string) error {
	if rel == "" || strings.HasPrefix(rel, "/") || strings.Contains(rel, "\\") {
		return httperr.BadRequest("invalid path " + rel)
	}
	for _, part := range strings.Split(rel, "/") {
		if part == "" || part == "." || part == ".." {
			return httperr.BadRequest("invalid path " + rel)
		}
	}
	return nil
}

// readJSON reads a file and decodes it with key order kept. Missing files return botfs.ErrNotFound.
func (s *Service) readJSON(ctx context.Context, path string) (any, error) {
	raw, err := s.store.ReadFile(ctx, path)
	if err != nil {
		return nil, err
	}
	v, err := decodeOrdered(raw)
	if err != nil {
		return nil, fmt.Errorf("studioapi: parse %s: %w", path, err)
	}
	return v, nil
}

// writeJSON writes v in legacy layout (2-space indent, no trailing newline).
func (s *Service) writeJSON(ctx context.Context, path string, v any) error {
	b, err := MarshalJS(v, 2)
	if err != nil {
		return err
	}
	return s.store.WriteFile(ctx, path, b)
}

// botConfig returns bot.config.json as an ordered object.
func (s *Service) botConfig(ctx context.Context, botID string) (*OMap, error) {
	v, err := s.readJSON(ctx, botPath(botID, "bot.config.json"))
	if errors.Is(err, botfs.ErrNotFound) {
		return nil, httperr.NotFound("bot " + botID)
	}
	if err != nil {
		return nil, err
	}
	m, ok := v.(*OMap)
	if !ok {
		return nil, httperr.Internal("bot.config.json is not an object")
	}
	return m, nil
}

// assertWritable returns 400 "Bot locked" for locked bots, as legacy ghost writes do.
func (s *Service) assertWritable(ctx context.Context, botID string) error {
	cfg, err := s.botConfig(ctx, botID)
	if err != nil {
		return err
	}
	if locked, _ := cfg.Get("locked"); locked == true {
		return httperr.BadRequest("Bot locked")
	}
	return nil
}

// errorFrom maps service errors to the legacy body. *httperr.Error passes through; the rest is a 500.
func errorFrom(err error) error {
	var he *httperr.Error
	if errors.As(err, &he) {
		return he
	}
	if errors.Is(err, botfs.ErrNotFound) {
		return httperr.NotFound(err.Error())
	}
	return httperr.Internal(err.Error())
}

// decodeBody reads the request body as an ordered JSON value.
func decodeBody(raw []byte) (*OMap, error) {
	v, err := decodeOrdered(raw)
	if err != nil {
		return nil, httperr.BadRequest("invalid JSON body")
	}
	m, ok := v.(*OMap)
	if !ok {
		return nil, httperr.BadRequest("body must be a JSON object")
	}
	return m, nil
}

// modelFlow converts an ordered flow object into model.Flow for flow.Validate.
func modelFlow(name string, m *OMap) (*model.Flow, error) {
	b, err := MarshalJS(m, 0)
	if err != nil {
		return nil, err
	}
	var f model.Flow
	if err := json.Unmarshal(b, &f); err != nil {
		return nil, httperr.BadRequest("invalid flow: " + err.Error())
	}
	f.Name = name
	return &f, nil
}
