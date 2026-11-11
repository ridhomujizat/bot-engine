package studioapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/ridhomujizat/bot-engine/internal/botfs"
	"github.com/ridhomujizat/bot-engine/internal/httperr"
	"github.com/ridhomujizat/bot-engine/internal/model"
)

const (
	flowDir     = "flows/"
	flowSuffix  = ".flow.json"
	uiSuffix    = ".ui.json"
	placingStep = 250
	minPosX     = 50
)

// flowMetaKeys are the top-level on keys legacy copies into FlowView and back (lodash pick order).
var flowMetaKeys = []string{"version", "catchAll", "startNode", "skillData", "label", "description"}

func uiPath(flowRel string) string {
	return strings.TrimSuffix(flowRel, flowSuffix) + uiSuffix
}

func validFlowName(name string) error {
	if !strings.HasSuffix(name, flowSuffix) {
		return httperr.BadRequest("flow name must end with " + flowSuffix)
	}
	return safeRel(flowDir + name)
}

// parseFlow builds the FlowView legacy returns: flow.json content plus node positions from the ui file.
func (s *Service) parseFlow(ctx context.Context, botID, name string) (*OMap, error) {
	fv, err := s.readJSON(ctx, botPath(botID, flowDir+name))
	if err != nil {
		return nil, err
	}
	flowObj, ok := fv.(*OMap)
	if !ok {
		return nil, fmt.Errorf("flow %s is not an object", name)
	}
	nodesAny, _ := flowObj.Get("nodes")
	nodes, _ := nodesAny.([]any)

	// Positions from the UI file. A missing UI file is tolerated (legacy would throw).
	positions := map[string]*OMap{}
	var links any
	hasLinks := false
	if uv, err := s.readJSON(ctx, botPath(botID, flowDir+uiPath(name))); err == nil {
		if uo, ok := uv.(*OMap); ok {
			if ln, ok := uo.Get("nodes"); ok {
				for _, n := range asSlice(ln) {
					if no, ok := n.(*OMap); ok {
						id, _ := no.Get("id")
						if p, ok := no.Get("position"); ok {
							if po, ok := p.(*OMap); ok {
								positions[fmt.Sprint(id)] = po
							}
						}
					}
				}
			}
			links, hasLinks = uo.Get("links")
		}
	}

	// lodash maxBy over raw nodes' y (absent in legacy files), defaulting to 0.
	maxY := 0.0
	for _, n := range nodes {
		if no, ok := n.(*OMap); ok {
			if y, ok := no.Get("y"); ok {
				if f, ok := toFloat(y); ok && f > maxY {
					maxY = f
				}
			}
		}
	}

	unplaced := -1
	outNodes := make([]any, 0, len(nodes))
	for _, n := range nodes {
		no, ok := n.(*OMap)
		if !ok {
			continue
		}
		id, _ := no.Get("id")
		pos, placed := positions[fmt.Sprint(id)]
		if !placed {
			unplaced++
		}
		view := no.Clone()
		if placed {
			// A stored position without finite coordinates (legacy writes `position: {}` for some skill
			// nodes) is no position: legacy omits x and y, and the editor lays such nodes out itself.
			x, hasX := pos.Get("x")
			y, hasY := pos.Get("y")
			if hasX && hasY && x != nil && y != nil {
				view.Set("x", x)
				view.Set("y", y)
			}
		} else {
			view.Set("x", float64(minPosX+unplaced*placingStep))
			view.Set("y", maxY+placingStep)
		}
		outNodes = append(outNodes, view)
	}

	out := NewOMap()
	out.Set("name", name)
	out.Set("location", name)
	out.Set("nodes", outNodes)
	if hasLinks {
		out.Set("links", links)
	}
	for _, k := range flowMetaKeys {
		if v, ok := flowObj.Get(k); ok {
			out.Set(k, v)
		}
	}
	return out, nil
}

func asSlice(v any) []any {
	s, _ := v.([]any)
	return s
}

func toFloat(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case json.Number:
		f, err := n.Float64()
		return f, err == nil
	}
	return 0, false
}

// listFlowNames returns flow file names under flows/, sorted by path (legacy sortOrder filePath).
func (s *Service) listFlowNames(ctx context.Context, botID string) ([]string, error) {
	files, err := s.store.ListFiles(ctx, botPath(botID, flowDir))
	if err != nil {
		return nil, err
	}
	prefix := botPath(botID, flowDir)
	var names []string
	for _, f := range files {
		rel := strings.TrimPrefix(f.Path, prefix)
		if strings.HasSuffix(rel, flowSuffix) && !strings.Contains(rel, "/..") {
			names = append(names, rel)
		}
	}
	sort.Strings(names)
	return names, nil
}

// LoadFlows returns every flow as FlowView (GET /flows).
func (s *Service) LoadFlows(ctx context.Context, botID string) ([]*OMap, error) {
	names, err := s.listFlowNames(ctx, botID)
	if err != nil {
		return nil, err
	}
	out := make([]*OMap, 0, len(names))
	for _, n := range names {
		v, err := s.parseFlow(ctx, botID, n)
		if err != nil {
			return nil, fmt.Errorf("could not load flow %s: %w", n, err)
		}
		out = append(out, v)
	}
	return out, nil
}

// flowNameExists compares case-insensitively, as legacy isFlowNameValid does.
func (s *Service) flowNameExists(ctx context.Context, botID, name string) (bool, error) {
	names, err := s.listFlowNames(ctx, botID)
	if err != nil {
		return false, err
	}
	for _, n := range names {
		if strings.EqualFold(n, name) {
			return true, nil
		}
	}
	return false, nil
}

// flowFromBody reads {flow: {...}} from a request body.
func flowFromBody(raw []byte) (*OMap, error) {
	body, err := decodeBody(raw)
	if err != nil {
		return nil, err
	}
	fv, ok := body.Get("flow")
	if !ok {
		return nil, httperr.BadRequest("missing flow")
	}
	flow, ok := fv.(*OMap)
	if !ok {
		return nil, httperr.BadRequest("flow must be an object")
	}
	return flow, nil
}

// InsertFlow creates a flow (POST /flows).
func (s *Service) InsertFlow(ctx context.Context, botID string, flowObj *OMap) error {
	if err := s.assertWritable(ctx, botID); err != nil {
		return err
	}
	name, err := stringField(flowObj, "name")
	if err != nil {
		return err
	}
	if err := validFlowName(name); err != nil {
		return err
	}
	exists, err := s.flowNameExists(ctx, botID, name)
	if err != nil {
		return err
	}
	if exists {
		return httperr.BadRequest(fmt.Sprintf("Can not create an already existent flow : %s", name))
	}
	return s.saveFlow(ctx, botID, name, flowObj)
}

// UpdateFlow saves a flow in place (POST /flows/:name with no rename).
func (s *Service) UpdateFlow(ctx context.Context, botID, name string, flowObj *OMap) error {
	if err := s.assertWritable(ctx, botID); err != nil {
		return err
	}
	if err := validFlowName(name); err != nil {
		return err
	}
	if _, err := s.readJSON(ctx, botPath(botID, flowDir+name)); errors.Is(err, botfs.ErrNotFound) {
		return httperr.NotFound("flow " + name)
	}
	return s.saveFlow(ctx, botID, name, flowObj)
}

// saveFlow writes the flow and ui files in the legacy layout.
func (s *Service) saveFlow(ctx context.Context, botID, name string, flowObj *OMap) error {
	nodesAny, _ := flowObj.Get("nodes")
	nodes := asSlice(nodesAny)

	flowContent := NewOMap()
	for _, k := range flowMetaKeys {
		if v, ok := flowObj.Get(k); ok {
			flowContent.Set(k, v)
		}
	}
	flowNodes := make([]any, 0, len(nodes))
	uiNodes := make([]any, 0, len(nodes))
	for _, n := range nodes {
		no, ok := n.(*OMap)
		if !ok {
			return httperr.BadRequest("every node must be an object")
		}
		flowNodes = append(flowNodes, no.Omit("x", "y", "lastModified"))
		id, _ := no.Get("id")
		ui := NewOMap()
		ui.Set("id", id)
		ui.Set("position", pickXY(no))
		uiNodes = append(uiNodes, ui)
	}
	flowContent.Set("nodes", flowNodes)

	if err := s.validateSingleFlow(ctx, botID, name, flowContent); err != nil {
		return err
	}

	uiContent := NewOMap()
	uiContent.Set("nodes", uiNodes)
	if links, ok := flowObj.Get("links"); ok {
		uiContent.Set("links", links)
	}

	if err := s.writeJSON(ctx, botPath(botID, flowDir+name), flowContent); err != nil {
		return err
	}
	return s.writeJSON(ctx, botPath(botID, flowDir+uiPath(name)), uiContent)
}

// pickXY returns {x, y} for keys that exist (lodash _.pick(node, 'x', 'y')).
func pickXY(no *OMap) *OMap { return no.Pick("x", "y") }

// validateSingleFlow runs flow.Validate on the bot as it would be after this save: the
// current bot is loaded from the store and the edited flow replaces its entry, so
// cross-file checks (content elements, subflow targets) see the real bot. If the bot
// cannot be loaded (for example it is already broken), only the saved flow is validated.
func (s *Service) validateSingleFlow(ctx context.Context, botID, name string, flowContent *OMap) error {
	mf, err := modelFlow(name, flowContent)
	if err != nil {
		return err
	}
	bot, err := s.loadBot(s.store, botID)
	if err != nil || bot == nil {
		bot = &model.Bot{Flows: map[string]*model.Flow{}}
	}
	if bot.Flows == nil {
		bot.Flows = map[string]*model.Flow{}
	}
	bot.Flows[name] = mf
	if issues := blockingIssues(s.validate(bot)); len(issues) > 0 {
		msgs := make([]string, 0, len(issues))
		for _, is := range issues {
			msgs = append(msgs, is.File+": "+is.Message)
		}
		return httperr.BadRequest("flow is out of scope: " + strings.Join(msgs, "; "))
	}
	return nil
}

// RenameFlow moves flow and UI files byte for byte to newName (legacy renameFlow).
func (s *Service) RenameFlow(ctx context.Context, botID, from, to string) error {
	if err := s.assertWritable(ctx, botID); err != nil {
		return err
	}
	if err := validFlowName(from); err != nil {
		return err
	}
	if err := validFlowName(to); err != nil {
		return err
	}
	if _, err := s.store.ReadFile(ctx, botPath(botID, flowDir+from)); errors.Is(err, botfs.ErrNotFound) {
		return httperr.NotFound("flow " + from)
	}
	if exists, err := s.flowNameExists(ctx, botID, to); err != nil {
		return err
	} else if exists {
		return httperr.BadRequest(fmt.Sprintf("New flow name %s is already in use", to))
	}
	for _, pair := range [][2]string{{flowDir + from, flowDir + to}, {flowDir + uiPath(from), flowDir + uiPath(to)}} {
		raw, err := s.store.ReadFile(ctx, botPath(botID, pair[0]))
		if errors.Is(err, botfs.ErrNotFound) {
			continue
		}
		if err != nil {
			return err
		}
		if err := s.store.WriteFile(ctx, botPath(botID, pair[1]), raw); err != nil {
			return err
		}
		if err := s.store.DeleteFile(ctx, botPath(botID, pair[0])); err != nil && !errors.Is(err, botfs.ErrNotFound) {
			return err
		}
	}
	return nil
}

// DeleteFlow removes flow and UI files (POST /flows/:name/delete).
func (s *Service) DeleteFlow(ctx context.Context, botID, name string) error {
	if err := s.assertWritable(ctx, botID); err != nil {
		return err
	}
	if err := validFlowName(name); err != nil {
		return err
	}
	if err := s.store.DeleteFile(ctx, botPath(botID, flowDir+name)); errors.Is(err, botfs.ErrNotFound) {
		return httperr.BadRequest(fmt.Sprintf("Can not delete a flow that does not exist: %s", name))
	} else if err != nil {
		return err
	}
	if err := s.store.DeleteFile(ctx, botPath(botID, flowDir+uiPath(name))); err != nil && !errors.Is(err, botfs.ErrNotFound) {
		return err
	}
	return nil
}

func stringField(m *OMap, k string) (string, error) {
	v, ok := m.Get(k)
	if !ok {
		return "", httperr.BadRequest("missing " + k)
	}
	s, ok := v.(string)
	if !ok || s == "" {
		return "", httperr.BadRequest(k + " must be a non-empty string")
	}
	return s, nil
}
