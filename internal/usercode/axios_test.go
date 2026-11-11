package usercode

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestAxiosJSONRoundTrip(t *testing.T) {
	var gotBody map[string]any
	var gotHeader http.Header
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotHeader = r.Header.Clone()
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"echo":`+mustJSON(gotBody)+`,"q":"`+r.URL.Query().Get("q")+`"}`)
	}))
	defer srv.Close()

	code := `
const axios = require('axios')
const r = await axios.post('` + srv.URL + `/x', { name: 'a', n: 2 }, { headers: { 'X-Test': 'yes' }, params: { q: 'hello world' } })
return { status: r.status, data: r.data, ct: r.headers['content-type'] }
`
	res, _, err := runCode(t, code, map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	m := res.(map[string]any)
	if m["status"] != 200.0 {
		t.Fatalf("status = %v", m["status"])
	}
	data := m["data"].(map[string]any)
	if data["q"] != "hello world" {
		t.Fatalf("query = %v", data["q"])
	}
	if gotHeader.Get("Content-Type") != "application/json;charset=utf-8" {
		t.Fatalf("content-type = %q", gotHeader.Get("Content-Type"))
	}
	if gotHeader.Get("X-Test") != "yes" {
		t.Fatalf("custom header missing")
	}
	if gotBody["name"] != "a" || gotBody["n"] != 2.0 {
		t.Fatalf("body = %v", gotBody)
	}
}

func TestAxiosErrorsAndTimeout(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/404":
			w.WriteHeader(404)
			_, _ = io.WriteString(w, `{"error":"nope"}`)
		case "/slow":
			select {
			case <-time.After(2 * time.Second):
			case <-r.Context().Done():
			}
		default:
			_, _ = io.WriteString(w, "not json")
		}
	}))
	defer srv.Close()

	code := `
const axios = require('axios')
let out = {}
try { await axios.get('` + srv.URL + `/404') } catch (e) {
  out.msg = e.message; out.status = e.response.status; out.data = e.response.data; out.isAxios = e.isAxiosError
}
try { await axios.get('` + srv.URL + `/slow', { timeout: 50 }) } catch (e) { out.timeoutMsg = e.message; out.timeoutCode = e.code }
const plain = await axios.get('` + srv.URL + `/plain')
out.plain = plain.data
return out
`
	res, _, err := runCode(t, code, map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	m := res.(map[string]any)
	if m["msg"] != "Request failed with status code 404" || m["status"] != 404.0 || m["isAxios"] != true {
		t.Fatalf("error shape = %v", m)
	}
	if m["data"].(map[string]any)["error"] != "nope" {
		t.Fatalf("error data = %v", m["data"])
	}
	if m["timeoutMsg"] != "timeout of 50ms exceeded" || m["timeoutCode"] != "ECONNABORTED" {
		t.Fatalf("timeout = %v / %v", m["timeoutMsg"], m["timeoutCode"])
	}
	if m["plain"] != "not json" {
		t.Fatalf("non-JSON body should stay a string, got %v", m["plain"])
	}
}

func TestAxiosFormDataAndCreate(t *testing.T) {
	var ct string
	var body string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ct = r.Header.Get("Content-Type")
		b, _ := io.ReadAll(r.Body)
		body = string(b)
		w.WriteHeader(201)
		_, _ = io.WriteString(w, "ok")
	}))
	defer srv.Close()

	code := `
const axios = require('axios')
const FormData = require('form-data')
const api = axios.create({ baseURL: '` + srv.URL + `/base/', headers: { 'X-Bot': 'example' }, timeout: 5000 })
const fd = new FormData()
fd.append('name', 'Budi')
fd.append('summary', 'sudah "fix"')
const r = await api.post('upload', fd, { headers: { 'Content-Type': 'multipart/form-data; boundary=' + fd._boundary } })
return { status: r.status, text: r.data, b: fd._boundary.length > 10 }
`
	res, _, err := runCode(t, code, map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	m := res.(map[string]any)
	if m["status"] != 201.0 || m["text"] != "ok" {
		t.Fatalf("result = %v", m)
	}
	if !strings.HasPrefix(ct, "multipart/form-data; boundary=") {
		t.Fatalf("content-type = %q", ct)
	}
	if !strings.Contains(body, `name="name"`) || !strings.Contains(body, "Budi") || !strings.Contains(body, `name="summary"`) {
		t.Fatalf("multipart body = %q", body)
	}
}

func TestFormDataGetHeadersAndURLSearchParams(t *testing.T) {
	code := `
const FormData = require('form-data')
const fd = new FormData()
fd.append('a', '1')
const h = fd.getHeaders()
const usp = new URLSearchParams({ x: 'a b', y: 2 })
return { ct: h['content-type'].indexOf('boundary=' + fd._boundary) > 0, usp: usp.toString(), len: fd.getBuffer().length > 0 }
`
	res, _, err := runCode(t, code, map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	m := res.(map[string]any)
	if m["ct"] != true || m["usp"] != "x=a+b&y=2" || m["len"] != true {
		t.Fatalf("result = %v", m)
	}
}

func mustJSON(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}
