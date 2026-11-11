package studioapi

import (
	"context"
	"regexp"
	"strings"
)

// ActionParam is one @param tag.
type ActionParam struct {
	Name        string `json:"name"`
	Type        string `json:"type"`
	Description string `json:"description"`
	Default     string `json:"default"`
	Required    bool   `json:"required"`
}

// ActionDefinition is one entry of GET /actions (legacy LocalActionDefinition, metadata part).
type ActionDefinition struct {
	Name        string        `json:"name"`
	Scope       string        `json:"scope"`
	Legacy      bool          `json:"legacy"`
	Title       string        `json:"title"`
	Category    string        `json:"category"`
	Author      string        `json:"author"`
	Description string        `json:"description"`
	Hidden      bool          `json:"hidden"`
	Params      []ActionParam `json:"params"`
}

var jsDocRe = regexp.MustCompile(`(?s)/\*\*\s*\n(.*?)\*/`)

// ExtractMetadata reads the first JSDoc block for @title, @category, @author, @hidden, @param
// (legacy extractMetadata with doctrine, reduced to the tags bots use).
func ExtractMetadata(code string) ActionDefinition {
	var def ActionDefinition
	def.Params = []ActionParam{}
	m := jsDocRe.FindStringSubmatch(code)
	if m == nil {
		return def
	}
	var desc []string
	inTags := false
	for _, raw := range strings.Split(m[1], "\n") {
		line := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(raw), "*"))
		if strings.HasPrefix(line, "@") {
			inTags = true
			parseTag(line, &def)
			continue
		}
		if !inTags && line != "" {
			desc = append(desc, line)
		}
	}
	def.Description = strings.Join(desc, "\n")
	return def
}

var paramRe = regexp.MustCompile(`^@param\s+(?:\{([^}]*)\}\s+)?(\[[^\]]+\]|\S+)\s*-?\s*(.*)$`)

func parseTag(line string, def *ActionDefinition) {
	switch {
	case strings.HasPrefix(line, "@title"):
		def.Title = strings.TrimSpace(strings.TrimPrefix(line, "@title"))
	case strings.HasPrefix(line, "@category"):
		def.Category = strings.TrimSpace(strings.TrimPrefix(line, "@category"))
	case strings.HasPrefix(line, "@author"):
		def.Author = strings.TrimSpace(strings.TrimPrefix(line, "@author"))
	case strings.HasPrefix(line, "@hidden"):
		v := strings.ToLower(strings.TrimSpace(strings.TrimPrefix(line, "@hidden")))
		def.Hidden = v == "true" || v == "yes" || v == "y" || v == "1" || v == "on"
	case strings.HasPrefix(line, "@param"):
		m := paramRe.FindStringSubmatch(line)
		if m == nil {
			return
		}
		typ, nameTok, desc := m[1], m[2], strings.TrimSpace(m[3])
		p := ActionParam{Type: typ, Description: desc, Required: true}
		if strings.HasPrefix(nameTok, "[") {
			p.Required = false
			inner := strings.Trim(nameTok, "[]")
			if i := strings.Index(inner, "="); i >= 0 {
				p.Default = inner[i+1:]
				inner = inner[:i]
			}
			p.Name = inner
		} else {
			p.Name = nameTok
		}
		if strings.HasSuffix(typ, "=") {
			p.Required = false
			p.Type = strings.TrimSuffix(typ, "=")
		}
		def.Params = append(def.Params, p)
	}
}

// ListActions returns global and bot actions (GET /actions). Bot actions shadow nothing: both are listed.
func (s *Service) ListActions(ctx context.Context, botID string) ([]ActionDefinition, error) {
	out := []ActionDefinition{}
	global, err := s.listActionFiles(ctx, "data/global/actions/", "global")
	if err != nil {
		return nil, err
	}
	out = append(out, builtinActionDefs()...)
	out = append(out, global...)
	local, err := s.listActionFiles(ctx, botPath(botID, "actions/"), "bot")
	if err != nil {
		return nil, err
	}
	return append(out, local...), nil
}

// builtinActions lists the native legacy instructions the engine runs (internal/builtin) so the
// editor can pick them. Params are the args the native implementation reads. Keep in step with
// the builtin registry: a name missing here is simply not offered in the picker.
var builtinActions = []ActionDefinition{
	{Name: "builtin/setVariable", Title: "Set variable", Category: "Variables", Description: "Store a value in temp, session, user or bot memory.", Params: []ActionParam{
		{Name: "type", Type: "string", Description: "temp, session, user or bot", Required: true},
		{Name: "name", Type: "string", Description: "Variable name", Required: true},
		{Name: "value", Type: "any", Description: "Value to store", Required: true},
	}},
	{Name: "builtin/removeVariable", Title: "Remove variable", Category: "Variables", Params: []ActionParam{
		{Name: "type", Type: "string", Description: "temp, session, user or bot", Required: true},
		{Name: "name", Type: "string", Description: "Variable name", Required: true},
	}},
	{Name: "builtin/resetSession", Title: "Reset session", Category: "Variables"},
	{Name: "builtin/wait", Title: "Wait", Category: "Flow", Params: []ActionParam{
		{Name: "delay", Type: "number", Description: "Milliseconds to wait", Required: true},
	}},
	{Name: "builtin/switchLanguage", Title: "Switch language", Category: "Flow", Params: []ActionParam{
		{Name: "lang", Type: "string", Description: "Language code, e.g. en", Required: true},
	}},
}

// builtinActionDefs returns fresh copies of builtinActions for the listing.
func builtinActionDefs() []ActionDefinition {
	out := make([]ActionDefinition, 0, len(builtinActions))
	for _, d := range builtinActions {
		d.Scope = "global"
		d.Legacy = false
		d.Params = append([]ActionParam{}, d.Params...)
		out = append(out, d)
	}
	return out
}

// listActionFiles reads *.js under prefix (recursive, names may contain "/").
func (s *Service) listActionFiles(ctx context.Context, prefix, scope string) ([]ActionDefinition, error) {
	files, err := s.store.ListFiles(ctx, prefix)
	if err != nil {
		return nil, err
	}
	var out []ActionDefinition
	for _, f := range files {
		rel := strings.TrimPrefix(f.Path, prefix)
		if !strings.HasSuffix(rel, ".js") || strings.Contains(rel, "node_modules/") {
			continue
		}
		raw, err := s.store.ReadFile(ctx, f.Path)
		if err != nil {
			return nil, err
		}
		def := ExtractMetadata(string(raw))
		def.Scope = scope
		if strings.HasSuffix(rel, ".http.js") {
			def.Name = strings.TrimSuffix(rel, ".http.js")
			def.Legacy = false
		} else {
			def.Name = strings.TrimSuffix(rel, ".js")
			def.Legacy = true
		}
		out = append(out, def)
	}
	return out, nil
}
