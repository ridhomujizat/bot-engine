package studioapi

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"strings"
	"testing"
)

func uploadRequest(t *testing.T, name, partType string, content []byte) (string, []byte) {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	h := make(textproto.MIMEHeader)
	h.Set("Content-Disposition", `form-data; name="file"; filename="`+name+`"`)
	h.Set("Content-Type", partType)
	part, err := mw.CreatePart(h)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = part.Write(content)
	_ = mw.Close()
	return mw.FormDataContentType(), buf.Bytes()
}

func TestMediaUploadServeDelete(t *testing.T) {
	store := writeBotFixture(t, t.TempDir())
	r, _ := newRouter(t, store)
	ct, body := uploadRequest(t, "logo.png", "image/png", []byte("PNGDATA"))

	w := do(t, r, http.MethodPost, "/api/v1/studio/"+botID+"/media", ct, body)
	if w.Code != 200 {
		t.Fatalf("upload: %d %s", w.Code, w.Body.String())
	}
	var res struct {
		URL string `json:"url"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &res); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(res.URL, "/api/v1/bots/"+botID+"/media/") || !strings.HasSuffix(res.URL, "-logo.png") {
		t.Fatalf("url shape: %s", res.URL)
	}

	// Served publicly, with the legacy cache header and the type from the extension.
	get := do(t, r, http.MethodGet, res.URL, "", nil)
	if get.Code != 200 || get.Body.String() != "PNGDATA" || get.Header().Get("Content-Type") != "image/png" {
		t.Fatalf("serve: %d %q %q", get.Code, get.Body.String(), get.Header().Get("Content-Type"))
	}
	if get.Header().Get("Cache-Control") != "max-age=31556926" {
		t.Fatalf("cache header: %q", get.Header().Get("Cache-Control"))
	}

	// Delete through the element's formData, which is how the editor sends it.
	del := `{"image$en":"https://old.example/x` + res.URL[strings.Index(res.URL, "/media/"):] + `"}`
	if w := do(t, r, http.MethodPost, "/api/v1/studio/"+botID+"/media/delete", "application/json", []byte(del)); w.Code != 200 {
		t.Fatalf("delete: %d %s", w.Code, w.Body.String())
	}
	if w := do(t, r, http.MethodGet, res.URL, "", nil); w.Code != 404 {
		t.Fatalf("deleted media still served: %d", w.Code)
	}
}

func TestMediaTypeAndSizeRules(t *testing.T) {
	store := writeBotFixture(t, t.TempDir())
	r, svc := newRouter(t, store)

	ct, body := uploadRequest(t, "setup.exe", "application/x-msdownload", []byte("MZ"))
	if w := do(t, r, http.MethodPost, "/api/v1/studio/"+botID+"/media", ct, body); w.Code != 400 || !strings.Contains(w.Body.String(), "This type of file is not allowed") {
		t.Fatalf("disallowed type: %d %s", w.Code, w.Body.String())
	}
	ct, body = uploadRequest(t, "noext", "image/png", []byte("x"))
	if w := do(t, r, http.MethodPost, "/api/v1/studio/"+botID+"/media", ct, body); w.Code != 400 || !strings.Contains(w.Body.String(), "has no extension") {
		t.Fatalf("no extension: %d %s", w.Code, w.Body.String())
	}

	svc.SetMediaLimits(MediaLimits{MaxBytes: 4})
	ct, body = uploadRequest(t, "big.png", "image/png", []byte("0123456789"))
	if w := do(t, r, http.MethodPost, "/api/v1/studio/"+botID+"/media", ct, body); w.Code != 400 || w.Body.String() != "File too large" {
		t.Fatalf("size limit: %d %s", w.Code, w.Body.String())
	}
}

func TestMediaFilesFromFormData(t *testing.T) {
	fd, _ := decodeOrdered([]byte(`{
		"image$en": "https://h/api/v1/bots/b/media/abc-1.png",
		"text$en": "/media/not-an-image",
		"items$en": [ {"image": "/api/v1/bots/b/media/xyz.jpg"}, {"image": "plain"} ]
	}`))
	got := MediaFilesFromFormData(fd.(*OMap))
	if len(got) != 2 || got[0] != "abc-1.png" || got[1] != "xyz.jpg" {
		t.Fatalf("files: %v", got)
	}
}

func TestParseSize(t *testing.T) {
	cases := map[string]int64{"25mb": 25 << 20, "1gb": 1 << 30, "512kb": 512 << 10, "100": 100}
	for in, want := range cases {
		got, err := ParseSize(in)
		if err != nil || got != want {
			t.Fatalf("%s: %d %v", in, got, err)
		}
	}
	if _, err := ParseSize("big"); err == nil {
		t.Fatal("bad size accepted")
	}
}

func TestSanitizeFileName(t *testing.T) {
	if got := sanitizeFileName(`a/b:c*?"d.png`); got != "abcd.png" {
		t.Fatalf("sanitize: %q", got)
	}
	if got := sanitizeFileName(".."); got != "" {
		t.Fatalf("reserved name kept: %q", got)
	}
}

func TestGenerateFlowRoutes(t *testing.T) {
	store := writeBotFixture(t, t.TempDir())
	r, _ := newRouter(t, store)

	if w := do(t, r, http.MethodGet, "/api/v1/studio/"+botID+"/modules/skills", "", nil); w.Code != 200 || !strings.Contains(w.Body.String(), `"moduleName":"basic-skills"`) {
		t.Fatalf("skills: %d %s", w.Code, w.Body.String())
	}

	body := `{"contentId":"builtin_single-choice-x","invalidContentId":"","keywords":{"A":"A"},"config":{"nbMaxRetries":2,"repeatChoicesOnInvalid":false,"variableName":""},"randomId":"rid1"}`
	w := do(t, r, http.MethodPost, "/api/v1/studio/"+botID+"/modules/basic-skills/skill/choice/generateFlow", "application/json", []byte(body))
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"transitions"`) || !strings.Contains(w.Body.String(), `"startNode":"entry"`) {
		t.Fatalf("generate: %d %s", w.Code, w.Body.String())
	}
	if w := do(t, r, http.MethodPost, "/api/v1/studio/"+botID+"/modules/other/skill/choice/generateFlow", "application/json", []byte(body)); w.Code != 404 || w.Body.String() != "Invalid module name or flow name" {
		t.Fatalf("unknown module: %d %s", w.Code, w.Body.String())
	}
	if w := do(t, r, http.MethodPost, "/api/v1/studio/"+botID+"/modules/basic-skills/skill/choice/generateFlow", "application/json", []byte(`{}`)); w.Code != 500 {
		t.Fatalf("missing keywords: %d", w.Code)
	}
}
