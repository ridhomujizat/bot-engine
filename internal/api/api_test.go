package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/ridhomujizat/bot-engine/internal/auth"
	"github.com/ridhomujizat/bot-engine/internal/botfs"
	"github.com/ridhomujizat/bot-engine/internal/engine"
	"github.com/ridhomujizat/bot-engine/internal/lock"
	"github.com/ridhomujizat/bot-engine/internal/studioapi"
	"github.com/ridhomujizat/bot-engine/internal/web"
)

// memUsers is an in-memory auth.UserStore for route tests.
type memUsers struct{ u *auth.User }

func (m memUsers) FindUser(_ context.Context, email, strategy string) (*auth.User, error) {
	if m.u == nil || m.u.Email != email || m.u.Strategy != strategy {
		return nil, nil
	}
	cp := *m.u
	cp.Attributes = map[string]any{}
	return &cp, nil
}

func (m memUsers) PatchAttributes(context.Context, string, string, map[string]any) error { return nil }

const (
	pw   = "S3cret!pw"
	salt = "0123456789abcdef"
)

func newTestRouter(t *testing.T) (http.Handler, *auth.Service) {
	t.Helper()
	users := memUsers{u: &auth.User{
		Email: "ops@example.com", Strategy: "default", Salt: salt,
		Password: auth.HashPassword(pw, salt), TokenVersion: 1, Attributes: map[string]any{},
	}}
	authSvc, err := auth.New(users, auth.Options{Secret: []byte("route-secret")})
	if err != nil {
		t.Fatal(err)
	}
	store := botfs.NewDisk(t.TempDir())
	eng := engine.New(engine.Deps{Store: store, Locker: lock.NewMemory(), Global: engine.GlobalDialogConfig{}})
	r := NewRouter(Deps{
		Engine: eng,
		Auth:   authSvc,
		Studio: studioapi.New(store),
		Web:    web.Handler(),
	})
	return r, authSvc
}

func call(r http.Handler, method, url string, headers map[string]string, body string) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	req := httptest.NewRequest(method, url, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	r.ServeHTTP(w, req)
	return w
}

func TestHealth(t *testing.T) {
	r, _ := newTestRouter(t)
	if w := call(r, http.MethodGet, "/health", nil, ""); w.Code != 200 || !strings.Contains(w.Body.String(), `"status":"ok"`) {
		t.Fatalf("health: %d %s", w.Code, w.Body.String())
	}
}

func TestLoginReturnsLegacyShape(t *testing.T) {
	r, _ := newTestRouter(t)
	w := call(r, http.MethodPost, "/api/v1/auth/login/basic/default", nil, `{"email":"OPS@example.com","password":"S3cret!pw"}`)
	if w.Code != 200 {
		t.Fatalf("login: %d %s", w.Code, w.Body.String())
	}
	var body struct {
		Status  string `json:"status"`
		Message string `json:"message"`
		Payload struct {
			JWT string  `json:"jwt"`
			Exp float64 `json:"exp"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Status != "success" || body.Message != "Login successful" || body.Payload.JWT == "" || body.Payload.Exp != 3600000 {
		t.Fatalf("shape: %+v", body)
	}
}

func TestLoginBadCredentials(t *testing.T) {
	r, _ := newTestRouter(t)
	w := call(r, http.MethodPost, "/api/v1/auth/login/basic/default", nil, `{"email":"ops@example.com","password":"nope"}`)
	if w.Code != 400 || !strings.Contains(w.Body.String(), `"errorCode":"BP_0009"`) || !strings.Contains(w.Body.String(), `"message":"Invalid credentials"`) {
		t.Fatalf("bad creds: %d %s", w.Code, w.Body.String())
	}
	if w := call(r, http.MethodPost, "/api/v1/auth/login/basic/default", nil, `{}`); w.Code != 400 {
		t.Fatalf("missing email: %d", w.Code)
	}
}

func TestConverseRequiresBearer(t *testing.T) {
	r, _ := newTestRouter(t)
	w := call(r, http.MethodPost, "/api/v1/bots/example-bot/converse/u1/secured", nil, `{"type":"text","text":"hi"}`)
	if w.Code != 401 || !strings.Contains(w.Body.String(), "Authorization header is missing") {
		t.Fatalf("no token: %d %s", w.Code, w.Body.String())
	}
}

func TestConverseMapsEngineErrors(t *testing.T) {
	r, _ := newTestRouter(t)
	login := call(r, http.MethodPost, "/api/v1/auth/login/basic/default", nil, `{"email":"ops@example.com","password":"S3cret!pw"}`)
	var lb struct {
		Payload struct {
			JWT string `json:"jwt"`
		} `json:"payload"`
	}
	_ = json.Unmarshal(login.Body.Bytes(), &lb)
	bearer := map[string]string{"Authorization": "Bearer " + lb.Payload.JWT}

	// Unknown bot: the engine's *engine.Error must come back with its status and legacy body.
	w := call(r, http.MethodPost, "/api/v1/bots/example-bot/converse/u1/secured?include=state,suggestions", bearer, `{"type":"text","text":"hi","includedContexts":["global"]}`)
	if w.Code != http.StatusNotFound || !strings.Contains(w.Body.String(), `"statusCode":404`) {
		t.Fatalf("engine error mapping: %d %s", w.Code, w.Body.String())
	}
}

func TestParseInclude(t *testing.T) {
	got := parseInclude(" State, suggestions ,,decision")
	want := []string{"state", "suggestions", "decision"}
	if len(got) != len(want) {
		t.Fatalf("got %v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %v", got)
		}
	}
	if parseInclude("") != nil {
		t.Fatal("empty include must be nil")
	}
}

func TestRootRedirectsToEditor(t *testing.T) {
	r, _ := newTestRouter(t)
	w := call(r, http.MethodGet, "/", nil, "")
	if w.Code != http.StatusFound || w.Header().Get("Location") != "/studio/" {
		t.Fatalf("root: %d %s", w.Code, w.Header().Get("Location"))
	}
	if w := call(r, http.MethodGet, "/studio/", nil, ""); w.Code != 200 {
		t.Fatalf("studio: %d", w.Code)
	}
}

func TestStudioRequiresToken(t *testing.T) {
	r, _ := newTestRouter(t)
	if w := call(r, http.MethodGet, "/api/v1/studio/example-bot/flows", nil, ""); w.Code != 401 {
		t.Fatalf("studio without token: %d", w.Code)
	}
}
