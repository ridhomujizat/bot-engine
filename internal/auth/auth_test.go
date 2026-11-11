package auth

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/ridhomujizat/bot-engine/internal/httperr"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
)

// Test vector produced by node: crypto.createHmac('sha512', salt).update(pw).digest('hex').
const (
	vecSalt = "0123456789abcdef"
	vecPW   = "S3cret!pw"
	vecHash = "3808a56601cbcd4e497e73fa02b050c57aab794123f94817a204c605060510ce3e3dde3cc765266dbb70825fd657fa1cbad097e8418808dbd436a72e420ef590"
)

func TestVerifyPasswordMatchesLegacyVector(t *testing.T) {
	if !VerifyPassword(vecPW, vecHash, vecSalt) {
		t.Fatal("legacy vector did not verify")
	}
	if VerifyPassword("other", vecHash, vecSalt) {
		t.Fatal("wrong password verified")
	}
	if VerifyPassword(vecPW, "", vecSalt) || VerifyPassword(vecPW, vecHash, "") {
		t.Fatal("empty hash or salt must not verify")
	}
	if HashPassword(vecPW, vecSalt) != vecHash {
		t.Fatal("HashPassword differs from legacy")
	}
}

// memStore is an in-memory UserStore.
type memStore struct {
	users map[string]*User
}

func key(email, strategy string) string { return strategy + "|" + email }

func (m *memStore) FindUser(_ context.Context, email, strategy string) (*User, error) {
	u, ok := m.users[key(email, strategy)]
	if !ok {
		return nil, nil
	}
	cp := *u
	cp.Attributes = map[string]any{}
	for k, v := range u.Attributes {
		cp.Attributes[k] = v
	}
	return &cp, nil
}

func (m *memStore) PatchAttributes(_ context.Context, email, strategy string, patch map[string]any) error {
	u, ok := m.users[key(email, strategy)]
	if !ok {
		return errors.New("no user")
	}
	for k, v := range patch {
		if v == nil {
			delete(u.Attributes, k)
		} else {
			u.Attributes[k] = v
		}
	}
	return nil
}

func newTestService(t *testing.T, now func() time.Time) (*Service, *memStore) {
	t.Helper()
	ms := &memStore{users: map[string]*User{
		key("admin@example.com", "default"): {
			Email: "admin@example.com", Strategy: "default", Password: vecHash, Salt: vecSalt,
			TokenVersion: 3, Attributes: map[string]any{},
		},
	}}
	svc, err := New(ms, Options{
		Secret:      []byte("test-secret"),
		SuperAdmins: []Account{{Email: "admin@example.com", Strategy: "default"}},
		Strategies:  map[string]StrategyOptions{"default": {MaxLoginAttempt: 2, LockoutDuration: 10 * time.Minute}},
		Now:         now,
	})
	if err != nil {
		t.Fatal(err)
	}
	return svc, ms
}

func httpErr(t *testing.T, err error) *httperr.Error {
	t.Helper()
	var he *httperr.Error
	if !errors.As(err, &he) {
		t.Fatalf("want *httperr.Error, got %T %v", err, err)
	}
	return he
}

func TestLoginSuccessIssuesVerifiableToken(t *testing.T) {
	now := time.Date(2026, 11, 11, 10, 0, 0, 0, time.UTC)
	svc, _ := newTestService(t, func() time.Time { return now })

	res, err := svc.Login(context.Background(), "default", "ADMIN@example.com", vecPW)
	if err != nil {
		t.Fatal(err)
	}
	if res.Exp != int64(time.Hour/time.Millisecond) {
		t.Fatalf("exp = %d, want 3600000", res.Exp)
	}
	tu, err := svc.Verify(context.Background(), res.JWT)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if tu.Email != "admin@example.com" || tu.Strategy != "default" || tu.TokenVersion != 3 || !tu.IsSuperAdmin {
		t.Fatalf("claims: %+v", tu)
	}

	// Claim layout must match legacy generateUserToken.
	parsed, _, _ := new(jwt.Parser).ParseUnverified(res.JWT, jwt.MapClaims{})
	claims := parsed.Claims.(jwt.MapClaims)
	if claims["aud"] != "collaborators" {
		t.Fatalf("aud = %v", claims["aud"])
	}
}

func TestLoginBadCredentialsUsesLegacyError(t *testing.T) {
	svc, _ := newTestService(t, time.Now)
	_, err := svc.Login(context.Background(), "default", "admin@example.com", "nope")
	he := httpErr(t, err)
	if he.Status != 400 || he.Code != "BP_0009" || he.Message != "Invalid credentials" {
		t.Fatalf("got %+v", he)
	}
	_, err = svc.Login(context.Background(), "default", "ghost@example.com", "x")
	if httpErr(t, err).Code != "BP_0009" {
		t.Fatal("unknown user must look like bad credentials")
	}
	_, err = svc.Login(context.Background(), "default", "server::modules", vecPW)
	if httpErr(t, err).Code != "BP_0009" {
		t.Fatal("server user must not log in")
	}
}

func TestLockoutAfterMaxAttemptsAndExpiry(t *testing.T) {
	now := time.Date(2026, 11, 11, 10, 0, 0, 0, time.UTC)
	svc, ms := newTestService(t, func() time.Time { return now })
	ctx := context.Background()

	for i := 0; i < 3; i++ {
		_, _ = svc.Login(ctx, "default", "admin@example.com", "bad")
	}
	if locked, _ := ms.users[key("admin@example.com", "default")].Attributes["locked_out"].(bool); !locked {
		t.Fatal("account not locked after exceeding maxLoginAttempt")
	}
	_, err := svc.Login(ctx, "default", "admin@example.com", vecPW)
	if he := httpErr(t, err); he.Code != "BP_0011" {
		t.Fatalf("locked login: %+v", he)
	}
	now = now.Add(11 * time.Minute)
	if _, err := svc.Login(ctx, "default", "admin@example.com", vecPW); err != nil {
		t.Fatalf("login after lockout expiry: %v", err)
	}
}

func TestVerifyRejectsWrongAudienceExpiryAndStaleVersion(t *testing.T) {
	now := time.Date(2026, 11, 11, 10, 0, 0, 0, time.UTC)
	svc, ms := newTestService(t, func() time.Time { return now })
	ctx := context.Background()

	res, _ := svc.Login(ctx, "default", "admin@example.com", vecPW)

	// Wrong audience.
	other := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{"email": "a", "strategy": "default", "tokenVersion": 3, "aud": "chat_users", "exp": now.Add(time.Hour).Unix()})
	otherStr, _ := other.SignedString([]byte("test-secret"))
	if _, err := svc.Verify(ctx, otherStr); err == nil {
		t.Fatal("chat_users audience accepted")
	}

	// Expired.
	now = now.Add(2 * time.Hour)
	if _, err := svc.Verify(ctx, res.JWT); err == nil {
		t.Fatal("expired token accepted")
	}
	now = now.Add(-2 * time.Hour)

	// Password reset bumps tokenVersion: old token must stop working.
	ms.users[key("admin@example.com", "default")].TokenVersion = 4
	if _, err := svc.Verify(ctx, res.JWT); err == nil {
		t.Fatal("stale tokenVersion accepted")
	}
}

func TestParseDuration(t *testing.T) {
	cases := map[string]time.Duration{"": time.Hour, "1h": time.Hour, "30m": 30 * time.Minute, "2d": 48 * time.Hour, "90": 90 * time.Second}
	for in, want := range cases {
		got, err := ParseDuration(in)
		if err != nil || got != want {
			t.Fatalf("%q: got %v %v want %v", in, got, err, want)
		}
	}
	if _, err := ParseDuration("soon"); err == nil {
		t.Fatal("bad duration accepted")
	}
}

func TestRequireTokenResponses(t *testing.T) {
	gin.SetMode(gin.TestMode)
	svc, _ := newTestService(t, time.Now)
	res, _ := svc.Login(context.Background(), "default", "admin@example.com", vecPW)

	r := gin.New()
	r.GET("/secure", svc.RequireToken(), func(c *gin.Context) {
		tu, _ := UserFrom(c)
		c.String(http.StatusOK, tu.Email)
	})

	cases := []struct {
		name, header, wantMsg string
	}{
		{"missing", "", "Unauthorized: Authorization header is missing"},
		{"scheme", "Basic abc", `Unauthorized: Unknown scheme "Basic"`},
		{"empty token", "Bearer ", "Unauthorized: Authentication token is missing"},
		{"garbage", "Bearer nope", "Unauthorized: Invalid authentication token"},
	}
	for _, tc := range cases {
		w := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/secure", nil)
		if tc.header != "" {
			req.Header.Set("Authorization", tc.header)
		}
		r.ServeHTTP(w, req)
		if w.Code != 401 {
			t.Fatalf("%s: status %d", tc.name, w.Code)
		}
		var body httperr.Body
		if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if body.Message != tc.wantMsg || body.ErrorCode != "BP_0041" || body.Type != "UnauthorizedError" || body.StatusCode != 401 {
			t.Fatalf("%s: body %+v", tc.name, body)
		}
	}

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/secure", nil)
	req.Header.Set("Authorization", "bearer "+res.JWT)
	r.ServeHTTP(w, req)
	if w.Code != 200 || !strings.Contains(w.Body.String(), "admin@example.com") {
		t.Fatalf("valid token: %d %s", w.Code, w.Body.String())
	}
}
