package studioapi

import (
	"context"
	"errors"
	"net/http"
	"path"
	"regexp"
	"strings"

	"github.com/ridhomujizat/bot-engine/internal/botfs"
	"github.com/ridhomujizat/bot-engine/internal/httperr"

	"github.com/gin-gonic/gin"
)

// EditableFile mirrors the code-editor EditableFile payload.
type EditableFile struct {
	Name     string `json:"name"`
	Type     string `json:"type"`
	Location string `json:"location"`
	BotID    string `json:"botId,omitempty"`
	HookType string `json:"hookType,omitempty"`
	Content  string `json:"content,omitempty"`
}

var hookTypeRe = regexp.MustCompile(`^[a-z_]+$`)

// fileFolder maps an editable file to its BPFS folder and name (legacy getFileLocation).
// Actions live in actions/, hooks in hooks/<hookType>/. Scope decides bot vs global root.
func fileFolder(f EditableFile) (folder, name string, err error) {
	if strings.Contains(f.Location, "..") || strings.HasPrefix(f.Location, "/") {
		return "", "", httperr.BadRequest("invalid location")
	}
	switch f.Type {
	case "action_legacy", "action_http":
		return "actions", f.Location, nil
	case "hook":
		if !hookTypeRe.MatchString(f.HookType) {
			return "", "", httperr.BadRequest("invalid hook type")
		}
		return "hooks/" + f.HookType, strings.TrimPrefix(f.Location, f.HookType+"/"), nil
	}
	return "", "", httperr.BadRequest("unsupported file type " + f.Type)
}

// filePath returns the BPFS path of f inside bot botID, or global when botID is empty.
func filePath(botID string, folder, name string) (string, error) {
	if err := safeRel(folder + "/" + name); err != nil {
		return "", err
	}
	if botID == "" {
		return "data/global/" + folder + "/" + name, nil
	}
	return botPath(botID, folder+"/"+name), nil
}

// listFiles lists editable files of one scope and type (legacy loadFiles).
func (s *Service) listEditable(ctx context.Context, botID, fileType, hookType string) ([]EditableFile, error) {
	var base string
	switch fileType {
	case "action_legacy":
		base = "actions/"
	case "hook":
		base = "hooks/" + hookType + "/"
	default:
		return nil, nil
	}
	root := "data/global/"
	if botID != "" {
		root = botfs.BotPrefix(botID)
	}
	files, err := s.store.ListFiles(ctx, root+base)
	if err != nil {
		return nil, err
	}
	out := []EditableFile{}
	for _, f := range files {
		rel := strings.TrimPrefix(f.Path, root+base)
		if !strings.HasSuffix(rel, ".js") || strings.Contains(rel, "node_modules/") {
			continue
		}
		e := EditableFile{Name: path.Base(rel), Type: fileType, Location: rel, BotID: botID}
		if fileType == "hook" {
			e.HookType = hookType
			e.Location = hookType + "/" + rel
		}
		out = append(out, e)
	}
	return out, nil
}

// registerCodeEditor mounts the code-editor routes under /api/v1/bots/:botId/mod/code-editor.
func (s *Service) registerCodeEditor(g *gin.RouterGroup) {
	g.GET("/files", handle(func(c *gin.Context) error {
		ctx := c.Request.Context()
		botID := c.Param("botId")
		out := map[string]any{}
		for _, scope := range []string{"bot", "global"} {
			id := botID
			if scope == "global" {
				id = ""
			}
			acts, err := s.listEditable(ctx, id, "action_legacy", "")
			if err != nil {
				return err
			}
			out[scope+".actions"] = acts
			hooks := []EditableFile{}
			for _, ht := range hookTypesPresent(ctx, s, id) {
				hs, err := s.listEditable(ctx, id, "hook", ht)
				if err != nil {
					return err
				}
				hooks = append(hooks, hs...)
			}
			out[scope+".hooks"] = hooks
		}
		out["action_example"] = []any{}
		out["hook_example"] = []any{}
		sendJSON(c, http.StatusOK, out)
		return nil
	}))
	g.GET("/permissions", handle(func(c *gin.Context) error {
		perm := func(w bool) map[string]bool { return map[string]bool{"read": true, "write": w} }
		sendJSON(c, http.StatusOK, map[string]any{
			"bot.actions":    map[string]any{"type": "action_legacy", "isGlobal": false, "read": perm(true)["read"], "write": true},
			"global.actions": map[string]any{"type": "action_legacy", "isGlobal": true, "read": true, "write": true},
			"bot.hooks":      map[string]any{"type": "hook", "isGlobal": false, "read": true, "write": true},
			"global.hooks":   map[string]any{"type": "hook", "isGlobal": true, "read": true, "write": true},
		})
		return nil
	}))
	g.POST("/readFile", handle(func(c *gin.Context) error {
		f, err := editableFromBody(c)
		if err != nil {
			return err
		}
		folder, name, err := fileFolder(f)
		if err != nil {
			return err
		}
		p, err := filePath(f.BotID, folder, name)
		if err != nil {
			return err
		}
		raw, err := s.store.ReadFile(c.Request.Context(), p)
		if errors.Is(err, botfs.ErrNotFound) {
			return httperr.NotFound("file " + f.Location)
		}
		if err != nil {
			return err
		}
		sendJSON(c, http.StatusOK, map[string]any{"fileContent": string(raw)})
		return nil
	}))
	g.POST("/exists", handle(func(c *gin.Context) error {
		f, err := editableFromBody(c)
		if err != nil {
			return err
		}
		folder, name, err := fileFolder(f)
		if err != nil {
			return err
		}
		p, err := filePath(f.BotID, folder, name)
		if err != nil {
			return err
		}
		_, err = s.store.ReadFile(c.Request.Context(), p)
		sendJSON(c, http.StatusOK, err == nil)
		return nil
	}))
	g.POST("/save", handle(func(c *gin.Context) error {
		f, err := editableFromBody(c)
		if err != nil {
			return err
		}
		ctx := c.Request.Context()
		if f.BotID != "" {
			if err := s.assertWritable(ctx, f.BotID); err != nil {
				return err
			}
		}
		folder, name, err := fileFolder(f)
		if err != nil {
			return err
		}
		p, err := filePath(f.BotID, folder, name)
		if err != nil {
			return err
		}
		if err := s.store.WriteFile(ctx, p, []byte(f.Content)); err != nil {
			return err
		}
		c.Status(http.StatusOK)
		return nil
	}))
	g.POST("/remove", handle(func(c *gin.Context) error {
		f, err := editableFromBody(c)
		if err != nil {
			return err
		}
		ctx := c.Request.Context()
		if f.BotID != "" {
			if err := s.assertWritable(ctx, f.BotID); err != nil {
				return err
			}
		}
		folder, name, err := fileFolder(f)
		if err != nil {
			return err
		}
		p, err := filePath(f.BotID, folder, name)
		if err != nil {
			return err
		}
		if err := s.store.DeleteFile(ctx, p); errors.Is(err, botfs.ErrNotFound) {
			return httperr.NotFound("file " + f.Location)
		} else if err != nil {
			return err
		}
		c.Status(http.StatusOK)
		return nil
	}))
	g.POST("/rename", handle(func(c *gin.Context) error {
		raw, err := readBody(c)
		if err != nil {
			return err
		}
		body, err := decodeBody(raw)
		if err != nil {
			return err
		}
		fv, _ := body.Get("file")
		fo, ok := fv.(*OMap)
		if !ok {
			return httperr.BadRequest("missing file")
		}
		f, err := editableFromOMap(fo)
		if err != nil {
			return err
		}
		newName, err := stringField(body, "newName")
		if err != nil {
			return err
		}
		if strings.Contains(newName, "/") || newName == "." || newName == ".." {
			return httperr.BadRequest("invalid file name")
		}
		ctx := c.Request.Context()
		if f.BotID != "" {
			if err := s.assertWritable(ctx, f.BotID); err != nil {
				return err
			}
		}
		folder, name, err := fileFolder(f)
		if err != nil {
			return err
		}
		from, err := filePath(f.BotID, folder, name)
		if err != nil {
			return err
		}
		to, err := filePath(f.BotID, folder, newName)
		if err != nil {
			return err
		}
		if _, err := s.store.ReadFile(ctx, to); err == nil {
			return httperr.BadRequest("File already exists")
		}
		raw2, err := s.store.ReadFile(ctx, from)
		if errors.Is(err, botfs.ErrNotFound) {
			return httperr.NotFound("file " + f.Location)
		}
		if err != nil {
			return err
		}
		if err := s.store.WriteFile(ctx, to, raw2); err != nil {
			return err
		}
		if err := s.store.DeleteFile(ctx, from); err != nil {
			return err
		}
		c.Status(http.StatusOK)
		return nil
	}))
}

// hookTypesPresent lists hook type folders that exist for the scope.
func hookTypesPresent(ctx context.Context, s *Service, botID string) []string {
	root := "data/global/hooks/"
	if botID != "" {
		root = botfs.BotPrefix(botID) + "hooks/"
	}
	files, err := s.store.ListFiles(ctx, root)
	if err != nil {
		return nil
	}
	seen := map[string]bool{}
	var out []string
	for _, f := range files {
		rel := strings.TrimPrefix(f.Path, root)
		if i := strings.Index(rel, "/"); i > 0 && !seen[rel[:i]] {
			seen[rel[:i]] = true
			out = append(out, rel[:i])
		}
	}
	return out
}

func editableFromBody(c *gin.Context) (EditableFile, error) {
	raw, err := readBody(c)
	if err != nil {
		return EditableFile{}, err
	}
	body, err := decodeBody(raw)
	if err != nil {
		return EditableFile{}, err
	}
	// Some calls wrap the file in {file:...}; others send it bare.
	if fv, ok := body.Get("file"); ok {
		if fo, ok := fv.(*OMap); ok {
			body = fo
		}
	}
	return editableFromOMap(body)
}

func editableFromOMap(m *OMap) (EditableFile, error) {
	var f EditableFile
	f.Name = strOf(m, "name")
	f.Type = strOf(m, "type")
	f.Location = strOf(m, "location")
	f.BotID = strOf(m, "botId")
	f.HookType = strOf(m, "hookType")
	f.Content = strOf(m, "content")
	if f.Location == "" {
		return f, httperr.BadRequest("missing location")
	}
	return f, nil
}

func strOf(m *OMap, k string) string {
	v, _ := m.Get(k)
	s, _ := v.(string)
	return s
}
