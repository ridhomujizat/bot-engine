package flow

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/ridhomujizat/bot-engine/internal/botfs"
	"github.com/ridhomujizat/bot-engine/internal/model"
)

// load builds a model.Bot from the files under data/bots/{botID}/.
func load(ctx context.Context, store botfs.Store, botID string) (*model.Bot, error) {
	prefix := botfs.BotPrefix(botID)

	raw, err := store.ReadFile(ctx, prefix+"bot.config.json")
	if err != nil {
		return nil, fmt.Errorf("flow: bot %s: bot.config.json: %w", botID, err)
	}
	var cfg model.BotConfig
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return nil, fmt.Errorf("flow: bot %s: bot.config.json: %w", botID, err)
	}
	cfg.Raw = append(json.RawMessage(nil), raw...)

	bot := &model.Bot{
		ID:              botID,
		Config:          cfg,
		Flows:           map[string]*model.Flow{},
		ContentElements: map[string]*model.ContentElement{},
		Actions:         map[string]string{},
		Hooks:           map[string][]model.Hook{},
		LoadedAt:        time.Now(),
	}

	files, err := store.ListFiles(ctx, prefix)
	if err != nil {
		return nil, fmt.Errorf("flow: bot %s: list files: %w", botID, err)
	}
	for _, f := range files {
		// ModifiedOn covers every file under the prefix, including media, so a
		// media upload also invalidates the cache. Cheap and conservative.
		if f.ModifiedOn.After(bot.ModifiedOn) {
			bot.ModifiedOn = f.ModifiedOn
		}
		rel := strings.TrimPrefix(f.Path, prefix)
		if botfs.IsOSJunk(rel) {
			continue
		}

		switch {
		case strings.HasPrefix(rel, "flows/") && strings.HasSuffix(rel, ".flow.json"):
			data, err := store.ReadFile(ctx, f.Path)
			if err != nil {
				return nil, fmt.Errorf("flow: read %s: %w", rel, err)
			}
			var fl model.Flow
			if err := json.Unmarshal(data, &fl); err != nil {
				return nil, fmt.Errorf("flow: parse %s: %w", rel, err)
			}
			name := strings.TrimPrefix(rel, "flows/")
			fl.Name = name
			bot.Flows[name] = &fl

		case strings.HasPrefix(rel, "content-elements/") && strings.HasSuffix(rel, ".json") &&
			!strings.Contains(strings.TrimPrefix(rel, "content-elements/"), "/"):
			data, err := store.ReadFile(ctx, f.Path)
			if err != nil {
				return nil, fmt.Errorf("flow: read %s: %w", rel, err)
			}
			var els []model.ContentElement
			if err := json.Unmarshal(data, &els); err != nil {
				return nil, fmt.Errorf("flow: parse %s: %w", rel, err)
			}
			contentType := strings.TrimSuffix(strings.TrimPrefix(rel, "content-elements/"), ".json")
			for i := range els {
				els[i].ContentType = contentType
				bot.ContentElements[els[i].ID] = &els[i]
			}

		case strings.HasPrefix(rel, "actions/") && strings.HasSuffix(rel, ".js"):
			data, err := store.ReadFile(ctx, f.Path)
			if err != nil {
				return nil, fmt.Errorf("flow: read %s: %w", rel, err)
			}
			name := strings.TrimSuffix(strings.TrimPrefix(rel, "actions/"), ".js")
			bot.Actions[name] = string(data)

		case strings.HasPrefix(rel, "hooks/") && strings.HasSuffix(rel, ".js"):
			rest := strings.TrimPrefix(rel, "hooks/")
			slash := strings.Index(rest, "/")
			if slash < 0 {
				continue
			}
			hookType := rest[:slash]
			data, err := store.ReadFile(ctx, f.Path)
			if err != nil {
				return nil, fmt.Errorf("flow: read %s: %w", rel, err)
			}
			hook := model.Hook{Name: strings.TrimSuffix(rest[slash+1:], ".js"), Code: string(data)}
			bot.Hooks[hookType] = append(bot.Hooks[hookType], hook)
		}
	}
	return bot, nil
}
