// Package web serves the embedded editor SPA (built by ui/ into internal/web/dist) under /studio/.
package web

import (
	"embed"
	"io/fs"
	"mime"
	"net/http"
	"path"
	"strings"
)

//go:embed all:dist
var distFS embed.FS

const prefix = "/studio"

// Handler serves /studio/* from the embedded build. Unknown paths without a file
// extension fall back to index.html so client-side routes work on reload.
func Handler() http.Handler {
	sub, err := fs.Sub(distFS, "dist")
	if err != nil {
		panic(err) // embed root is fixed at compile time
	}
	return &handler{fsys: sub}
}

type handler struct {
	fsys fs.FS
}

func (h *handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	rel := strings.TrimPrefix(r.URL.Path, prefix)
	rel = strings.TrimPrefix(path.Clean("/"+rel), "/")
	if rel == "" {
		rel = "index.html"
	}

	if info, err := fs.Stat(h.fsys, rel); err == nil && !info.IsDir() {
		h.serve(w, r, rel)
		return
	}
	if path.Ext(rel) != "" {
		http.NotFound(w, r)
		return
	}
	h.serve(w, r, "index.html")
}

func (h *handler) serve(w http.ResponseWriter, r *http.Request, name string) {
	b, err := fs.ReadFile(h.fsys, name)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	if ct := mime.TypeByExtension(path.Ext(name)); ct != "" {
		w.Header().Set("Content-Type", ct)
	} else {
		w.Header().Set("Content-Type", http.DetectContentType(b))
	}
	if name == "index.html" {
		w.Header().Set("Cache-Control", "no-cache")
	} else if strings.HasPrefix(name, "assets/") {
		// Vite emits content-hashed file names under assets/.
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	}
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)
	if r.Method == http.MethodGet {
		_, _ = w.Write(b)
	}
}
