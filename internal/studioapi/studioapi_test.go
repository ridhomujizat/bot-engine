package studioapi

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/ridhomujizat/bot-engine/internal/botfs"
	"github.com/ridhomujizat/bot-engine/internal/flow"
	"github.com/ridhomujizat/bot-engine/internal/model"

	"github.com/gin-gonic/gin"
)

const botID = "example-bot"

// legacy layout: JSON.stringify(x, undefined, 2), no trailing newline.
const flowJSON = `{
  "version": "0.0.1",
  "startNode": "entry",
  "label": "Main",
  "nodes": [
    {
      "name": "entry",
      "onEnter": [
        "say #!builtin_text-pSsHWg"
      ],
      "onReceive": null,
      "next": [
        {
          "condition": "true",
          "node": "end"
        }
      ],
      "id": "n1"
    },
    {
      "name": "end",
      "onEnter": [],
      "onReceive": [],
      "next": [],
      "id": "n2"
    }
  ]
}`

const uiJSON = `{
  "nodes": [
    {
      "id": "n1",
      "position": {
        "x": 100,
        "y": 200
      }
    },
    {
      "id": "n2",
      "position": {
        "x": 300,
        "y": 200
      }
    }
  ],
  "links": []
}`

const configJSON = `{
  "id": "example-bot",
  "name": "example-bot",
  "defaultLanguage": "en",
  "languages": [
    "en"
  ]
}`

func writeBotFixture(t *testing.T, dir string) botfs.Store {
	t.Helper()
	disk := botfs.NewDisk(dir)
	ctx := context.Background()
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(disk.WriteFile(ctx, botfs.BotPrefix(botID)+"bot.config.json", []byte(configJSON)))
	must(disk.WriteFile(ctx, botfs.BotPrefix(botID)+"flows/main.flow.json", []byte(flowJSON)))
	must(disk.WriteFile(ctx, botfs.BotPrefix(botID)+"flows/main.ui.json", []byte(uiJSON)))
	return disk
}

// passThrough stands in for auth in route tests.
func passThrough(c *gin.Context) { c.Next() }

func newRouter(t *testing.T, store botfs.Store) (*gin.Engine, *Service) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	svc := New(store)
	// Isolate studio logic from the engine's validator; gate behaviour is tested separately.
	svc.validate = func(*model.Bot) []flow.Issue { return nil }
	r := gin.New()
	svc.Register(r, passThrough, "")
	svc.RegisterPublic(r)
	return r, svc
}

func do(t *testing.T, r http.Handler, method, url, contentType string, body []byte) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	req := httptest.NewRequest(method, url, bytes.NewReader(body))
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	r.ServeHTTP(w, req)
	return w
}

func readFile(t *testing.T, s botfs.Store, p string) string {
	t.Helper()
	b, err := s.ReadFile(context.Background(), p)
	if err != nil {
		t.Fatalf("read %s: %v", p, err)
	}
	return string(b)
}

// TestFlowRoundTripThroughHTTPIsByteIdentical: GET a flow, POST it back unchanged,
// and the files on disk must not change by a single byte.
func TestFlowRoundTripThroughHTTPIsByteIdentical(t *testing.T) {
	store := writeBotFixture(t, t.TempDir())
	r, _ := newRouter(t, store)

	w := do(t, r, http.MethodGet, "/api/v1/studio/"+botID+"/flows", "", nil)
	if w.Code != 200 {
		t.Fatalf("GET flows: %d %s", w.Code, w.Body.String())
	}
	raw0 := w.Body.Bytes()
	var flows []map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &flows); err != nil {
		t.Fatal(err)
	}
	if len(flows) != 1 || flows[0]["name"] != "main.flow.json" {
		t.Fatalf("flows: %s", w.Body.String())
	}
	// Node positions come from the ui file.
	nodes := flows[0]["nodes"].([]any)
	if n0 := nodes[0].(map[string]any); n0["x"].(float64) != 100 || n0["y"].(float64) != 200 {
		t.Fatalf("positions not merged: %v", n0)
	}

	// Post the exact bytes the editor received (key order matters for byte identity).
	var raw []json.RawMessage
	if err := json.Unmarshal(raw0, &raw); err != nil {
		t.Fatal(err)
	}
	body := []byte(`{"flow":` + string(raw[0]) + `}`)
	w = do(t, r, http.MethodPost, "/api/v1/studio/"+botID+"/flows/main.flow.json", "application/json", body)
	if w.Code != 200 {
		t.Fatalf("POST flow: %d %s", w.Code, w.Body.String())
	}

	if got := readFile(t, store, botfs.BotPrefix(botID)+"flows/main.flow.json"); got != flowJSON {
		t.Fatalf("flow.json changed:\n%s", got)
	}
	if got := readFile(t, store, botfs.BotPrefix(botID)+"flows/main.ui.json"); got != uiJSON {
		t.Fatalf("ui.json changed:\n%s", got)
	}
}

func TestFlowInsertRenameDelete(t *testing.T) {
	store := writeBotFixture(t, t.TempDir())
	r, _ := newRouter(t, store)
	base := "/api/v1/studio/" + botID + "/flows"

	newFlow := `{"flow":{"name":"skills/choice-a1.flow.json","location":"skills/choice-a1.flow.json","startNode":"s","nodes":[{"name":"s","id":"x1","x":10,"y":20,"onEnter":[],"onReceive":null,"next":[]}],"links":[]}}`
	if w := do(t, r, http.MethodPost, base, "application/json", []byte(newFlow)); w.Code != 200 {
		t.Fatalf("insert: %d %s", w.Code, w.Body.String())
	}
	if w := do(t, r, http.MethodPost, base, "application/json", []byte(newFlow)); w.Code != 400 {
		t.Fatalf("duplicate insert should be 400, got %d", w.Code)
	}
	ui := readFile(t, store, botfs.BotPrefix(botID)+"flows/skills/choice-a1.ui.json")
	if !strings.Contains(ui, `"position": {`) || !strings.Contains(ui, `"x": 10`) {
		t.Fatalf("ui not written: %s", ui)
	}
	// x/y must not leak into the flow file.
	if strings.Contains(readFile(t, store, botfs.BotPrefix(botID)+"flows/skills/choice-a1.flow.json"), `"x"`) {
		t.Fatal("x/y leaked into flow.json")
	}

	rename := `{"flow":{"name":"skills/renamed.flow.json"}}`
	if w := do(t, r, http.MethodPost, base+"/skills/choice-a1.flow.json", "application/json", []byte(rename)); w.Code != 200 {
		t.Fatalf("rename: %d %s", w.Code, w.Body.String())
	}
	if _, err := store.ReadFile(context.Background(), botfs.BotPrefix(botID)+"flows/skills/choice-a1.flow.json"); err == nil {
		t.Fatal("old flow still present after rename")
	}
	if got := readFile(t, store, botfs.BotPrefix(botID)+"flows/skills/renamed.ui.json"); !strings.Contains(got, `"x": 10`) {
		t.Fatal("ui not moved with rename")
	}

	if w := do(t, r, http.MethodPost, base+"/skills/renamed.flow.json/delete", "", nil); w.Code != 200 {
		t.Fatalf("delete: %d %s", w.Code, w.Body.String())
	}
	if _, err := store.ReadFile(context.Background(), botfs.BotPrefix(botID)+"flows/skills/renamed.ui.json"); err == nil {
		t.Fatal("ui not deleted")
	}
}

func TestFlowPathTraversalRejected(t *testing.T) {
	store := writeBotFixture(t, t.TempDir())
	r, _ := newRouter(t, store)
	bad := `{"flow":{"name":"../../x.flow.json","location":"x","startNode":"s","nodes":[]}}`
	if w := do(t, r, http.MethodPost, "/api/v1/studio/"+botID+"/flows", "application/json", []byte(bad)); w.Code != 400 {
		t.Fatalf("traversal name: want 400, got %d", w.Code)
	}
}

func TestUnknownAndLockedBots(t *testing.T) {
	store := writeBotFixture(t, t.TempDir())
	r, _ := newRouter(t, store)

	if w := do(t, r, http.MethodGet, "/api/v1/studio/nobody/flows", "", nil); w.Code != 404 {
		t.Fatalf("unknown bot: %d", w.Code)
	}
	if w := do(t, r, http.MethodGet, "/api/v1/studio/bad!id/flows", "", nil); w.Code != 404 {
		t.Fatalf("invalid bot id: %d", w.Code)
	}

	locked := strings.Replace(configJSON, `"languages"`, `"locked": true,
  "languages"`, 1)
	_ = store.WriteFile(context.Background(), botfs.BotPrefix(botID)+"bot.config.json", []byte(locked))
	w := do(t, r, http.MethodPost, "/api/v1/studio/"+botID+"/flows/main.flow.json", "application/json", []byte(`{"flow":{"startNode":"entry","nodes":[]}}`))
	if w.Code != 400 || !strings.Contains(w.Body.String(), "Bot locked") {
		t.Fatalf("locked bot write: %d %s", w.Code, w.Body.String())
	}
}

func TestFlowValidationGateBlocksSave(t *testing.T) {
	store := writeBotFixture(t, t.TempDir())
	r, svc := newRouter(t, store)
	svc.validate = func(*model.Bot) []flow.Issue {
		return []flow.Issue{{File: "flows/main.flow.json", Message: "node type not in scope"}}
	}
	w := do(t, r, http.MethodPost, "/api/v1/studio/"+botID+"/flows/main.flow.json", "application/json", []byte(`{"flow":{"startNode":"entry","nodes":[]}}`))
	if w.Code != 400 {
		t.Fatalf("validation failure should block save: %d", w.Code)
	}
	if readFile(t, store, botfs.BotPrefix(botID)+"flows/main.flow.json") != flowJSON {
		t.Fatal("file changed despite validation failure")
	}
}

// legacy saves flows with dangling transition targets; warnings must not block a save.
func TestFlowValidationWarningsDoNotBlockSave(t *testing.T) {
	store := writeBotFixture(t, t.TempDir())
	r, svc := newRouter(t, store)
	svc.validate = func(*model.Bot) []flow.Issue {
		return []flow.Issue{{File: "flows/main.flow.json", Message: `transition target "gone" not found`, Warn: true}}
	}
	w := do(t, r, http.MethodPost, "/api/v1/studio/"+botID+"/flows/main.flow.json", "application/json", []byte(`{"flow":{"startNode":"entry","nodes":[]}}`))
	if w.Code != 200 {
		t.Fatalf("warning blocked save: %d %s", w.Code, w.Body.String())
	}
}

func TestCMSElementLifecycle(t *testing.T) {
	store := writeBotFixture(t, t.TempDir())
	r, _ := newRouter(t, store)
	base := "/api/v1/studio/" + botID + "/cms"

	w := do(t, r, http.MethodPost, base+"/builtin_text/element", "application/json", []byte(`{"formData":{"text$en":"Hello","typing$en":true}}`))
	if w.Code != 200 || !strings.HasPrefix(w.Body.String(), "builtin_text-") {
		t.Fatalf("create: %d %s", w.Code, w.Body.String())
	}
	id := w.Body.String()

	w = do(t, r, http.MethodGet, base+"/element/"+id, "", nil)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"text$en":"Hello"`) || !strings.Contains(w.Body.String(), `"schema"`) {
		t.Fatalf("get: %d %s", w.Code, w.Body.String())
	}

	w = do(t, r, http.MethodPost, base+"/builtin_text/element/"+id, "application/json", []byte(`{"formData":{"text$en":"Bye"}}`))
	if w.Code != 200 || w.Body.String() != id {
		t.Fatalf("update: %d %s", w.Code, w.Body.String())
	}
	w = do(t, r, http.MethodPost, base+"/elements", "application/json", []byte(`{"count":10,"from":0}`))
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"text$en":"Bye"`) {
		t.Fatalf("list: %d %s", w.Code, w.Body.String())
	}
	if w := do(t, r, http.MethodGet, base+"/elements/count", "", nil); w.Body.String() != `{"count":1}` {
		t.Fatalf("count: %s", w.Body.String())
	}
	if w := do(t, r, http.MethodPost, base+"/elements/bulk_delete", "application/json", []byte(`["`+id+`"]`)); w.Code != 200 {
		t.Fatalf("bulk delete: %d", w.Code)
	}
	if w := do(t, r, http.MethodGet, base+"/element/"+id, "", nil); w.Code != 404 {
		t.Fatalf("deleted element still found: %d", w.Code)
	}
	if w := do(t, r, http.MethodPost, base+"/nope/element", "application/json", []byte(`{"formData":{}}`)); w.Code != 400 {
		t.Fatalf("unknown content type: %d", w.Code)
	}
}

func TestExtractMetadataFromJSDoc(t *testing.T) {
	code := `/**
 * Search a product in the catalogue.
 * @title Search product
 * @category Stock
 * @author example
 * @hidden false
 * @param {string} query - text to search
 * @param {number=} [limit=10] max results
 */
return 1`
	def := ExtractMetadata(code)
	if def.Title != "Search product" || def.Category != "Stock" || def.Author != "example" || def.Hidden {
		t.Fatalf("tags: %+v", def)
	}
	if def.Description != "Search a product in the catalogue." {
		t.Fatalf("description: %q", def.Description)
	}
	if len(def.Params) != 2 || def.Params[0].Name != "query" || !def.Params[0].Required || def.Params[1].Name != "limit" || def.Params[1].Required || def.Params[1].Default != "10" {
		t.Fatalf("params: %+v", def.Params)
	}
	if empty := ExtractMetadata("return 1"); empty.Params == nil || empty.Title != "" {
		t.Fatalf("no jsdoc: %+v", empty)
	}
}

func TestActionsListScopes(t *testing.T) {
	store := writeBotFixture(t, t.TempDir())
	ctx := context.Background()
	_ = store.WriteFile(ctx, "data/global/actions/basic-skills/choice_parse_answer.js", []byte("/**\n * @title Parse\n */\nreturn 1"))
	_ = store.WriteFile(ctx, botfs.BotPrefix(botID)+"actions/check-stock/search.js", []byte("return 2"))
	_ = store.WriteFile(ctx, botfs.BotPrefix(botID)+"actions/http-thing.http.js", []byte("return 3"))
	r, _ := newRouter(t, store)

	w := do(t, r, http.MethodGet, "/api/v1/studio/"+botID+"/actions", "", nil)
	var defs []ActionDefinition
	if err := json.Unmarshal(w.Body.Bytes(), &defs); err != nil {
		t.Fatalf("%v %s", err, w.Body.String())
	}
	names := map[string]string{}
	for _, d := range defs {
		names[d.Scope+":"+d.Name] = d.Title
	}
	if names["global:basic-skills/choice_parse_answer"] != "Parse" || names["bot:check-stock/search"] != "" {
		t.Fatalf("names: %v", names)
	}
	if _, ok := names["bot:http-thing"]; !ok {
		t.Fatalf("http action name wrong: %v", names)
	}
}

func TestBotConfigUpdateKeepsId(t *testing.T) {
	store := writeBotFixture(t, t.TempDir())
	r, _ := newRouter(t, store)
	w := do(t, r, http.MethodPost, "/api/v1/studio/"+botID+"/config", "application/json", []byte(`{"name":"example-bot 2","id":"other"}`))
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"message":"Updated bot"`) {
		t.Fatalf("config: %d %s", w.Code, w.Body.String())
	}
	got := readFile(t, store, botfs.BotPrefix(botID)+"bot.config.json")
	if !strings.Contains(got, `"name": "example-bot 2"`) || !strings.Contains(got, `"id": "example-bot"`) {
		t.Fatalf("config not written correctly: %s", got)
	}
}

// TestArchiveRoundTrip: export a bot, import it under another id, and check the files
// match, with the bot id placeholder rewritten.
func TestArchiveRoundTrip(t *testing.T) {
	store := writeBotFixture(t, t.TempDir())
	ctx := context.Background()
	_ = store.WriteFile(ctx, botfs.BotPrefix(botID)+"models/skip.bin", []byte("x"))
	_ = store.WriteFile(ctx, botfs.BotPrefix(botID)+"flows/ref.flow.json", []byte(`{"startNode":"a","nodes":[],"label":"/bots/`+botID+`/x"}`))
	svc := New(store)
	svc.validate = func(*model.Bot) []flow.Issue { return nil }
	svc.loadBot = func(botfs.Store, string) (*model.Bot, error) { return &model.Bot{}, nil }

	archive, err := svc.ExportBot(ctx, botID)
	if err != nil {
		t.Fatal(err)
	}
	files, err := readArchive(archive)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := files["models/skip.bin"]; ok {
		t.Fatal("models/ must be excluded")
	}
	if !strings.Contains(string(files["flows/ref.flow.json"]), "/bots/"+botIDPlaceholder+"/x") {
		t.Fatalf("placeholder not applied: %s", files["flows/ref.flow.json"])
	}

	dest := botfs.NewDisk(t.TempDir())
	svc2 := New(dest)
	svc2.validate = func(*model.Bot) []flow.Issue { return nil }
	svc2.loadBot = svc.loadBot
	if err := svc2.ImportBot(ctx, "imported", archive, false); err != nil {
		t.Fatalf("import: %v", err)
	}
	got := readFile(t, dest, botfs.BotPrefix("imported")+"flows/ref.flow.json")
	if !strings.Contains(got, "/bots/imported/x") {
		t.Fatalf("id not rewritten on import: %s", got)
	}
	if readFile(t, dest, botfs.BotPrefix("imported")+"flows/main.flow.json") != flowJSON {
		t.Fatal("flow bytes changed through archive")
	}
	cfg := readFile(t, dest, botfs.BotPrefix("imported")+"bot.config.json")
	if !strings.Contains(cfg, `"id": "imported"`) || !strings.Contains(cfg, `"name": "example-bot (imported)"`) {
		t.Fatalf("config naming: %s", cfg)
	}
	if err := svc2.ImportBot(ctx, "imported", archive, false); err == nil {
		t.Fatal("re-import without overwrite must fail")
	}
	if err := svc2.ImportBot(ctx, "imported", archive, true); err != nil {
		t.Fatalf("overwrite import: %v", err)
	}
}

func TestImportRejectsUnsafeArchivePaths(t *testing.T) {
	var buf bytes.Buffer
	_ = writeRawTar(&buf, map[string]string{"../evil.js": "x", "bot.config.json": "{}"})
	if _, err := readArchive(buf.Bytes()); err == nil {
		t.Fatal("unsafe path accepted")
	}
}

func TestAdminListBots(t *testing.T) {
	store := writeBotFixture(t, t.TempDir())
	r, _ := newRouter(t, store)
	w := do(t, r, http.MethodGet, "/api/v1/admin/workspace/bots", "", nil)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"message":"Retrieved bots"`) || !strings.Contains(w.Body.String(), `"id":"example-bot"`) {
		t.Fatalf("admin list: %d %s", w.Code, w.Body.String())
	}
}

func TestImportNeedsArchiveContentType(t *testing.T) {
	store := writeBotFixture(t, t.TempDir())
	r, _ := newRouter(t, store)
	w := do(t, r, http.MethodPost, "/api/v1/admin/workspace/bots/x/import", "application/json", []byte("{}"))
	if w.Code != 400 || !strings.Contains(w.Body.String(), "Bot should be imported from archive") {
		t.Fatalf("content type check: %d %s", w.Code, w.Body.String())
	}
}

// writeRawTar builds a gzip tar with the given names (used to craft hostile archives).
func writeRawTar(buf *bytes.Buffer, files map[string]string) error {
	gz := gzip.NewWriter(buf)
	tw := tar.NewWriter(gz)
	for name, body := range files {
		if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0o644, Size: int64(len(body)), Typeflag: tar.TypeReg}); err != nil {
			return err
		}
		if _, err := tw.Write([]byte(body)); err != nil {
			return err
		}
	}
	if err := tw.Close(); err != nil {
		return err
	}
	return gz.Close()
}
