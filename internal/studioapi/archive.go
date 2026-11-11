package studioapi

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/ridhomujizat/bot-engine/internal/botfs"
	"github.com/ridhomujizat/bot-engine/internal/httperr"
)

// botIDPlaceholder replaces the bot id inside JSON files of an exported archive
// , so an archive can be imported under another id.
const botIDPlaceholder = "BOT_ID_PLACEHOLDER"

// excludedFromArchive is legacy exportBot's exclusion list.
var excludedFromArchive = []string{"models/", "libraries/node_modules/"}

// ListBots returns every bot's bot.config.json (GET /api/v1/admin/workspace/bots).
func (s *Service) ListBots(ctx context.Context) ([]*OMap, error) {
	files, err := s.store.ListFiles(ctx, "data/bots/")
	if err != nil {
		return nil, err
	}
	var out []*OMap
	for _, f := range files {
		if !strings.HasSuffix(f.Path, "/bot.config.json") {
			continue
		}
		id := strings.TrimSuffix(strings.TrimPrefix(f.Path, "data/bots/"), "/bot.config.json")
		if strings.Contains(id, "/") {
			continue
		}
		cfg, err := s.botConfig(ctx, id)
		if err != nil {
			return nil, err
		}
		out = append(out, cfg)
	}
	return out, nil
}

// ExportBot builds the legacy-compatible.tgz: bot files at the archive root, JSON bot ids
// replaced by the placeholder. The ui file is not written (botfs has no revision read).
func (s *Service) ExportBot(ctx context.Context, botID string) ([]byte, error) {
	if !validBotID(botID) {
		return nil, httperr.NotFound("Invalid Bot ID")
	}
	if _, err := s.botConfig(ctx, botID); err != nil {
		return nil, err
	}
	prefix := botfs.BotPrefix(botID)
	files, err := s.store.ListFiles(ctx, prefix)
	if err != nil {
		return nil, err
	}
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	idRe := regexp.MustCompile(regexp.QuoteMeta("/bots/" + botID + "/"))
	for _, f := range files {
		rel := strings.TrimPrefix(f.Path, prefix)
		if excluded(rel) {
			continue
		}
		raw, err := s.store.ReadFile(ctx, f.Path)
		if err != nil {
			return nil, err
		}
		if strings.HasSuffix(rel, ".json") {
			raw = idRe.ReplaceAll(raw, []byte("/bots/"+botIDPlaceholder+"/"))
		}
		if err := writeTarFile(tw, rel, raw, f.ModifiedOn); err != nil {
			return nil, err
		}
	}
	if err := tw.Close(); err != nil {
		return nil, err
	}
	if err := gz.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func excluded(rel string) bool {
	for _, p := range excludedFromArchive {
		if strings.HasPrefix(rel, p) || strings.Contains(rel, "/"+p) {
			return true
		}
	}
	return false
}

func writeTarFile(tw *tar.Writer, name string, body []byte, mod time.Time) error {
	if mod.IsZero() {
		mod = time.Now()
	}
	hdr := &tar.Header{Name: name, Mode: 0o644, Size: int64(len(body)), ModTime: mod, Typeflag: tar.TypeReg}
	if err := tw.WriteHeader(hdr); err != nil {
		return err
	}
	_, err := tw.Write(body)
	return err
}

// ImportBot validates and writes a legacy or bot-engine archive under botID (POST /:botId/import).
// Validation runs before anything is written.
func (s *Service) ImportBot(ctx context.Context, botID string, archive []byte, overwrite bool) error {
	if !validBotID(botID) {
		return httperr.BadRequest("Can't import bot; the bot ID contains invalid characters")
	}
	exists := false
	if _, err := s.botConfig(ctx, botID); err == nil {
		exists = true
	}
	if exists && !overwrite {
		return httperr.BadRequest(fmt.Sprintf("Cannot import the bot %s, it already exists, and overwriting is not allowed", botID))
	}

	files, err := readArchive(archive)
	if err != nil {
		return err
	}
	root, err := botRootInArchive(files)
	if err != nil {
		return err
	}

	// Rewrite the placeholder and collect the bot's files relative to its folder.
	idRe := regexp.MustCompile(regexp.QuoteMeta("/bots/" + botIDPlaceholder + "/"))
	bundle := map[string][]byte{}
	for name, body := range files {
		if !strings.HasPrefix(name, root) {
			continue
		}
		rel := strings.TrimPrefix(name, root)
		if rel == "" || excluded(rel) {
			continue
		}
		if strings.HasSuffix(rel, ".json") {
			body = idRe.ReplaceAll(body, []byte("/bots/"+botID+"/"))
		}
		bundle[rel] = body
	}

	cfgRaw := bundle["bot.config.json"]
	cfgV, err := decodeOrdered(cfgRaw)
	if err != nil {
		return httperr.BadRequest("bot.config.json is not valid JSON")
	}
	cfg, ok := cfgV.(*OMap)
	if !ok {
		return httperr.BadRequest("bot.config.json is not an object")
	}
	// Validate the bot in a scratch store before writing anything.
	if err := s.validateBundle(ctx, botID, bundle); err != nil {
		return err
	}

	if exists && overwrite {
		existing, err := s.store.ListFiles(ctx, botfs.BotPrefix(botID))
		if err != nil {
			return err
		}
		for _, f := range existing {
			rel := strings.TrimPrefix(f.Path, botfs.BotPrefix(botID))
			if _, keep := bundle[rel]; !keep {
				if err := s.store.DeleteFile(ctx, f.Path); err != nil && !errors.Is(err, botfs.ErrNotFound) {
					return err
				}
			}
		}
	}
	for rel, body := range bundle {
		if err := s.store.WriteFile(ctx, botPath(botID, rel), body); err != nil {
			return err
		}
	}

	// Same naming rule as legacy: the imported name is kept, suffixed with the id when the id differs.
	name, _ := cfg.Get("name")
	nameStr, _ := name.(string)
	if nameStr != botID {
		cfg.Set("name", fmt.Sprintf("%s (%s)", nameStr, botID))
	}
	cfg.Set("id", botID)
	return s.writeJSON(ctx, botPath(botID, "bot.config.json"), cfg)
}

// validateBundle loads the bundle into a temporary disk store and runs flow.Load + flow.Validate.
func (s *Service) validateBundle(ctx context.Context, botID string, bundle map[string][]byte) error {
	dir, err := os.MkdirTemp("", "bot-import-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	disk := botfs.NewDisk(dir)
	for rel, body := range bundle {
		if err := disk.WriteFile(ctx, botPath(botID, rel), body); err != nil {
			return err
		}
	}
	bot, err := s.loadBot(disk, botID)
	if err != nil {
		return httperr.BadRequest("bot could not be loaded: " + err.Error())
	}
	if issues := blockingIssues(s.validate(bot)); len(issues) > 0 {
		msgs := make([]string, 0, len(issues))
		for _, is := range issues {
			msgs = append(msgs, is.File+": "+is.Message)
		}
		return httperr.BadRequest("bot is out of scope: " + strings.Join(msgs, "; "))
	}
	return nil
}

// readArchive extracts a.tgz into memory, rejecting entries that escape the archive root.
func readArchive(archive []byte) (map[string][]byte, error) {
	gz, err := gzip.NewReader(bytes.NewReader(archive))
	if err != nil {
		return nil, httperr.BadRequest("archive is not gzip")
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	out := map[string][]byte{}
	for {
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, httperr.BadRequest("archive is not a valid tar")
		}
		if hdr.Typeflag != tar.TypeReg && hdr.Typeflag != tar.TypeRegA {
			continue
		}
		name := path.Clean(filepath.ToSlash(hdr.Name))
		if strings.HasPrefix(name, "/") || name == ".." || strings.HasPrefix(name, "../") || strings.Contains(name, "/../") {
			return nil, httperr.BadRequest("archive contains an unsafe path")
		}
		if botfs.IsOSJunk(name) {
			continue // macOS tar AppleDouble sidecars and similar; not bot content
		}
		body, err := io.ReadAll(io.LimitReader(tr, 100<<20))
		if err != nil {
			return nil, err
		}
		out[name] = body
	}
	return out, nil
}

// botRootInArchive returns the folder prefix ("" or "x/") holding the single bot.config.json.
func botRootInArchive(files map[string][]byte) (string, error) {
	var roots []string
	for name := range files {
		if strings.HasSuffix(name, "bot.config.json") && (name == "bot.config.json" || strings.HasSuffix(name, "/bot.config.json")) {
			roots = append(roots, strings.TrimSuffix(name, "bot.config.json"))
		}
	}
	switch len(roots) {
	case 0:
		return "", httperr.BadRequest("The archive doesn't seem to contain a bot")
	case 1:
		return roots[0], nil
	default:
		return "", httperr.BadRequest("Bots must be imported in separate archives")
	}
}

func nowMillis() string { return fmt.Sprint(time.Now().UnixMilli()) }
