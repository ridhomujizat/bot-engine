package web

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func get(t *testing.T, path string) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	Handler().ServeHTTP(w, httptest.NewRequest(http.MethodGet, path, nil))
	return w
}

func TestStudioServesIndexAndFallsBack(t *testing.T) {
	for _, p := range []string{"/studio/", "/studio", "/studio/flows/abc"} {
		w := get(t, p)
		if w.Code != 200 || !strings.Contains(w.Body.String(), "<html") {
			t.Fatalf("%s: %d", p, w.Code)
		}
		if got := w.Header().Get("Cache-Control"); got != "no-cache" {
			t.Fatalf("%s: index cache header %q", p, got)
		}
	}
}

func TestMissingAssetIs404(t *testing.T) {
	if w := get(t, "/studio/assets/missing.js"); w.Code != 404 {
		t.Fatalf("missing asset: %d", w.Code)
	}
}

func TestPathTraversalStaysInsideDist(t *testing.T) {
	w := get(t, "/studio/../../etc/passwd")
	if strings.Contains(w.Body.String(), "root:") {
		t.Fatal("traversal leaked a file")
	}
}

func TestPostRejected(t *testing.T) {
	w := httptest.NewRecorder()
	Handler().ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/studio/", nil))
	if w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST: %d", w.Code)
	}
}
