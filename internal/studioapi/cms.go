package studioapi

import (
	"context"
	"crypto/rand"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/ridhomujizat/bot-engine/internal/botfs"
	"github.com/ridhomujizat/bot-engine/internal/httperr"
)

// contentTypesJSON holds jsonSchema/uiSchema for the six in-scope builtin content types,
// generated from the legacy content types (see docs/studioapi.md).
//
//go:embed contenttypes/types.json
var contentTypesJSON []byte

const (
	elementsDir  = "content-elements/"
	defaultCount = 50
	nanoAlphabet = "_-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
	elementIDLen = 6
)

// ContentType is one registered content type with its form schema.
type ContentType struct {
	ID         string         `json:"id"`
	Title      string         `json:"title"`
	Group      string         `json:"group"`
	JSONSchema map[string]any `json:"jsonSchema"`
	UISchema   map[string]any `json:"uiSchema"`
}

// contentTypes returns the registered types keyed by id.
func contentTypes() (map[string]ContentType, error) {
	var m map[string]ContentType
	if err := json.Unmarshal(contentTypesJSON, &m); err != nil {
		return nil, fmt.Errorf("studioapi: content types: %w", err)
	}
	return m, nil
}

func nanoID(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	out := make([]byte, n)
	for i := range b {
		out[i] = nanoAlphabet[b[i]&63]
	}
	return string(out), nil
}

// ListContentTypes returns the registered types, with counts per type (GET /cms/types).
func (s *Service) ListContentTypes(ctx context.Context, botID string) ([]map[string]any, error) {
	types, err := contentTypes()
	if err != nil {
		return nil, err
	}
	ids := make([]string, 0, len(types))
	for id := range types {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	out := make([]map[string]any, 0, len(ids))
	for _, id := range ids {
		t := types[id]
		count, err := s.countElements(ctx, botID, id)
		if err != nil {
			return nil, err
		}
		out = append(out, map[string]any{
			"id":     t.ID,
			"count":  count,
			"title":  t.Title,
			"hidden": false,
			"schema": map[string]any{"json": t.JSONSchema, "ui": t.UISchema, "title": t.Title, "renderer": t.ID},
		})
	}
	return out, nil
}

// elementRecord is one element as stored in content-elements/<type>.json.
type elementRecord struct {
	ID          string         `json:"id"`
	FormData    map[string]any `json:"formData"`
	CreatedBy   string         `json:"createdBy,omitempty"`
	CreatedOn   string         `json:"createdOn,omitempty"`
	ModifiedOn  string         `json:"modifiedOn,omitempty"`
	ContentType string         `json:"contentType"`
}

func (s *Service) elementFile(ctx context.Context, botID, contentType string) ([]*OMap, error) {
	v, err := s.readJSON(ctx, botPath(botID, elementsDir+contentType+".json"))
	if errors.Is(err, botfs.ErrNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	arr, ok := v.([]any)
	if !ok {
		return nil, fmt.Errorf("%s: element file is not an array", contentType)
	}
	out := make([]*OMap, 0, len(arr))
	for _, e := range arr {
		if m, ok := e.(*OMap); ok {
			out = append(out, m)
		}
	}
	return out, nil
}

// allElements loads all element files of the bot, or one type when contentType != "".
func (s *Service) allElements(ctx context.Context, botID, contentType string) ([]*OMap, error) {
	types := []string{contentType}
	if contentType == "" {
		files, err := s.store.ListFiles(ctx, botPath(botID, elementsDir))
		if err != nil {
			return nil, err
		}
		prefix := botPath(botID, elementsDir)
		types = nil
		for _, f := range files {
			rel := strings.TrimPrefix(f.Path, prefix)
			if strings.HasSuffix(rel, ".json") && !strings.Contains(rel, "/") {
				types = append(types, strings.TrimSuffix(rel, ".json"))
			}
		}
		sort.Strings(types)
	}
	var out []*OMap
	for _, t := range types {
		els, err := s.elementFile(ctx, botID, t)
		if err != nil {
			return nil, err
		}
		for _, e := range els {
			e.Set("contentType", t)
			out = append(out, e)
		}
	}
	return out, nil
}

func (s *Service) countElements(ctx context.Context, botID, contentType string) (int, error) {
	els, err := s.allElements(ctx, botID, contentType)
	return len(els), err
}

// augment adds the schema block the editor uses (cms-router _augmentElement).
func augment(el *OMap, types map[string]ContentType) *OMap {
	out := el.Clone()
	ct, _ := el.Get("contentType")
	id, _ := ct.(string)
	t := types[id]
	out.Set("schema", map[string]any{"json": t.JSONSchema, "ui": t.UISchema, "title": t.Title, "renderer": t.ID})
	return out
}

// SearchParams mirrors the body of POST /cms/:type/elements.
type SearchParams struct {
	Count      int
	From       int
	SearchTerm string
	IDs        []string
}

// ListElements returns elements matching params, sorted by createdOn (legacy DefaultSearchParams).
func (s *Service) ListElements(ctx context.Context, botID, contentType string, p SearchParams) ([]*OMap, error) {
	types, err := contentTypes()
	if err != nil {
		return nil, err
	}
	els, err := s.allElements(ctx, botID, contentType)
	if err != nil {
		return nil, err
	}
	idSet := map[string]bool{}
	for _, id := range p.IDs {
		idSet[id] = true
	}
	var filtered []*OMap
	for _, e := range els {
		id, _ := e.Get("id")
		if len(idSet) > 0 && !idSet[fmt.Sprint(id)] {
			continue
		}
		if p.SearchTerm != "" {
			raw, _ := MarshalJS(e, 0)
			if !strings.Contains(strings.ToLower(string(raw)), strings.ToLower(p.SearchTerm)) {
				continue
			}
		}
		filtered = append(filtered, e)
	}
	sort.SliceStable(filtered, func(i, j int) bool {
		return createdOn(filtered[i]) < createdOn(filtered[j])
	})
	count := p.Count
	if count <= 0 {
		count = defaultCount
	}
	from := p.From
	if from > len(filtered) {
		from = len(filtered)
	}
	end := from + count
	if end > len(filtered) {
		end = len(filtered)
	}
	out := make([]*OMap, 0, end-from)
	for _, e := range filtered[from:end] {
		out = append(out, augment(e, types))
	}
	return out, nil
}

func createdOn(e *OMap) string {
	v, _ := e.Get("createdOn")
	s, _ := v.(string)
	return s
}

// GetElement returns one element by id (GET /cms/element/:id); ok=false when missing.
func (s *Service) GetElement(ctx context.Context, botID, id string) (*OMap, bool, error) {
	types, err := contentTypes()
	if err != nil {
		return nil, false, err
	}
	els, err := s.allElements(ctx, botID, "")
	if err != nil {
		return nil, false, err
	}
	for _, e := range els {
		if v, _ := e.Get("id"); v == id {
			return augment(e, types), true, nil
		}
	}
	return nil, false, nil
}

// UpsertElement creates (no id, or unknown id) or updates an element and returns its id
// (legacy createOrUpdateContentElement).
func (s *Service) UpsertElement(ctx context.Context, botID, contentType string, formData *OMap, id string) (string, error) {
	if err := s.assertWritable(ctx, botID); err != nil {
		return "", err
	}
	contentType = strings.ToLower(contentType)
	types, err := contentTypes()
	if err != nil {
		return "", err
	}
	if _, ok := types[contentType]; !ok {
		return "", httperr.BadRequest(fmt.Sprintf(`Content type "%s" is not a valid registered content type ID`, contentType))
	}
	if formData == nil {
		formData = NewOMap()
	}
	now := time.Now().UTC().Format("2006-01-02T15:04:05.000Z")

	els, err := s.elementFile(ctx, botID, contentType)
	if err != nil {
		return "", err
	}
	if id == "" {
		suffix, err := nanoID(elementIDLen)
		if err != nil {
			return "", err
		}
		id = contentType + "-" + suffix
	}
	found := false
	for _, e := range els {
		if v, _ := e.Get("id"); v == id {
			found = true
			e.Set("formData", formData)
			e.Set("modifiedOn", now)
		}
	}
	if !found {
		rec := NewOMap()
		rec.Set("id", id)
		rec.Set("formData", formData)
		rec.Set("createdOn", now)
		rec.Set("modifiedOn", now)
		els = append(els, rec)
	}
	if err := s.writeElementFile(ctx, botID, contentType, els); err != nil {
		return "", err
	}
	return id, nil
}

func (s *Service) writeElementFile(ctx context.Context, botID, contentType string, els []*OMap) error {
	arr := make([]any, 0, len(els))
	for _, e := range els {
		out := NewOMap()
		for _, k := range []string{"id", "formData", "createdBy", "createdOn", "modifiedOn"} {
			if v, ok := e.Get(k); ok {
				out.Set(k, v)
			}
		}
		arr = append(arr, out)
	}
	return s.writeJSON(ctx, botPath(botID, elementsDir+contentType+".json"), arr)
}

// DeleteElements removes elements by id across all files (POST /cms/elements/bulk_delete).
func (s *Service) DeleteElements(ctx context.Context, botID string, ids []string) error {
	if err := s.assertWritable(ctx, botID); err != nil {
		return err
	}
	drop := map[string]bool{}
	for _, id := range ids {
		drop[id] = true
	}
	all, err := s.allElements(ctx, botID, "")
	if err != nil {
		return err
	}
	byType := map[string][]*OMap{}
	touched := map[string]bool{}
	for _, e := range all {
		ct, _ := e.Get("contentType")
		t := fmt.Sprint(ct)
		if _, ok := byType[t]; !ok {
			byType[t] = nil
		}
		id, _ := e.Get("id")
		if drop[fmt.Sprint(id)] {
			touched[t] = true
			continue
		}
		byType[t] = append(byType[t], e)
	}
	for t := range touched {
		if err := s.writeElementFile(ctx, botID, t, byType[t]); err != nil {
			return err
		}
	}
	return nil
}

// ParseIntDefault reads an optional numeric body field (JSON number or numeric string).
func ParseIntDefault(v any, def int) int {
	switch n := v.(type) {
	case json.Number:
		if i, err := n.Int64(); err == nil {
			return int(i)
		}
	case float64:
		return int(n)
	case string:
		if i, err := strconv.Atoi(n); err == nil {
			return i
		}
	}
	return def
}
