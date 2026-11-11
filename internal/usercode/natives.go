package usercode

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/md5"
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/base64"
	"errors"
	"fmt"
	"hash"
	"io"
	"net"
	"net/http"
	"strings"
	"syscall"
	"time"
	"unicode/utf8"

	"github.com/dop251/goja"
)

// natives builds the Go-side helper object handed to js/ It is
// internal: only the prelude calls it.
func (e *execution) natives() *goja.Object {
	n := e.vm.NewObject()
	set := func(name string, f func(goja.FunctionCall) goja.Value) {
		_ = n.Set(name, e.fn(f))
	}
	set("utf8Encode", func(c goja.FunctionCall) goja.Value {
		return e.vm.ToValue(sliceOf([]byte(c.Argument(0).String())))
	})
	set("utf8Decode", func(c goja.FunctionCall) goja.Value {
		b := bytesArg(c.Argument(0))
		if !utf8.Valid(b) {
			return e.vm.ToValue(strings.ToValidUTF8(string(b), "�"))
		}
		return e.vm.ToValue(string(b))
	})
	set("base64Encode", func(c goja.FunctionCall) goja.Value {
		return e.vm.ToValue(base64.StdEncoding.EncodeToString(bytesArg(c.Argument(0))))
	})
	set("base64Decode", func(c goja.FunctionCall) goja.Value {
		return e.vm.ToValue(sliceOf(decodeBase64Lenient(c.Argument(0).String())))
	})
	set("hash", func(c goja.FunctionCall) goja.Value {
		h, err := newHash(c.Argument(0).String())
		if err != nil {
			panic(e.jsError(err))
		}
		h.Write(bytesArg(c.Argument(1)))
		return e.vm.ToValue(sliceOf(h.Sum(nil)))
	})
	set("hmac", func(c goja.FunctionCall) goja.Value {
		alg := c.Argument(0).String()
		if _, err := newHash(alg); err != nil {
			panic(e.jsError(err))
		}
		mac := hmac.New(func() hash.Hash { h, _ := newHash(alg); return h }, bytesArg(c.Argument(1)))
		mac.Write(bytesArg(c.Argument(2)))
		return e.vm.ToValue(sliceOf(mac.Sum(nil)))
	})
	set("randomBytes", func(c goja.FunctionCall) goja.Value {
		n := int(c.Argument(0).ToInteger())
		if n < 0 || n > 1<<20 {
			panic(e.jsError(errors.New("randomBytes: size out of range")))
		}
		b := make([]byte, n)
		_, _ = rand.Read(b)
		return e.vm.ToValue(sliceOf(b))
	})
	set("httpRequest", e.jsHTTPRequest)
	return n
}

// sliceOf returns a []byte as a value the prelude can wrap into a Uint8Array.
// Never nil, so an empty result still has a length.
func sliceOf(b []byte) []byte {
	if b == nil {
		return []byte{}
	}
	return b
}

// bytesArg reads a Uint8Array, Buffer, string or array of numbers as bytes.
func bytesArg(v goja.Value) []byte {
	if v == nil || goja.IsUndefined(v) || goja.IsNull(v) {
		return nil
	}
	switch x := v.Export().(type) {
	case []byte:
		return x
	case string:
		return []byte(x)
	case []any:
		out := make([]byte, len(x))
		for i, item := range x {
			switch n := item.(type) {
			case int64:
				out[i] = byte(n)
			case float64:
				out[i] = byte(int64(n))
			}
		}
		return out
	}
	return []byte(v.String())
}

func decodeBase64Lenient(s string) []byte {
	s = strings.Map(func(r rune) rune {
		switch {
		case r == '-':
			return '+'
		case r == '_':
			return '/'
		case r == ' ' || r == '\n' || r == '\r' || r == '\t':
			return -1
		}
		return r
	}, s)
	s = strings.TrimRight(s, "=")
	b, err := base64.RawStdEncoding.DecodeString(s)
	if err != nil {
		// Decode as much as is valid, like Node does for malformed input.
		out := make([]byte, 0, len(s))
		for len(s) > 1 {
			chunk := s[:len(s)-len(s)%4]
			if chunk == "" {
				break
			}
			d, derr := base64.RawStdEncoding.DecodeString(chunk)
			if derr == nil {
				out = append(out, d...)
				break
			}
			s = s[:len(s)-1]
		}
		return out
	}
	return b
}

func newHash(alg string) (hash.Hash, error) {
	switch strings.ToLower(strings.ReplaceAll(alg, "-", "")) {
	case "md5":
		return md5.New(), nil
	case "sha1":
		return sha1.New(), nil
	case "sha256":
		return sha256.New(), nil
	case "sha384":
		return sha512.New384(), nil
	case "sha512":
		return sha512.New(), nil
	}
	return nil, fmt.Errorf("Digest method not supported: %s", alg)
}

// jsHTTPRequest implements the network half of the axios shim. The prelude
// has already merged defaults and serialized the body; this only performs the
// request and resolves with {status, statusText, headers, body} or rejects
// with {message, code}.
//
// spec: {method, url, headers: {}, body: string|Uint8Array|undefined, timeout ms}
func (e *execution) jsHTTPRequest(call goja.FunctionCall) goja.Value {
	spec, ok := call.Argument(0).(*goja.Object)
	if !ok {
		return e.rejected(errors.New("httpRequest: spec must be an object"))
	}
	req := httpSpec{
		method:  getProp(spec, "method").String(),
		url:     getProp(spec, "url").String(),
		headers: map[string]string{},
		timeout: time.Duration(getProp(spec, "timeout").ToInteger()) * time.Millisecond,
	}
	if hs, isObj := getProp(spec, "headers").(*goja.Object); isObj {
		for _, k := range hs.Keys() {
			req.headers[k] = getProp(hs, k).String()
		}
	}
	if b := getProp(spec, "body"); !goja.IsUndefined(b) && !goja.IsNull(b) {
		req.body = bytesArg(b)
		req.hasBody = true
	}

	p, resolve, reject := e.vm.NewPromise()
	e.spawn(func() (any, error) {
		return e.r.doHTTP(e.ctx, req)
	}, func(res any, err error) {
		if err != nil {
			_ = reject(e.httpErrorObject(err))
			return
		}
		r := res.(httpResult)
		out := e.vm.NewObject()
		_ = out.Set("status", r.status)
		_ = out.Set("statusText", r.statusText)
		_ = out.Set("headers", toJS(e.vm, r.headers))
		_ = out.Set("body", string(r.body))
		_ = resolve(out)
	})
	return e.vm.ToValue(p)
}

type httpSpec struct {
	method  string
	url     string
	headers map[string]string
	body    []byte
	hasBody bool
	timeout time.Duration
}

type httpResult struct {
	status     int
	statusText string
	headers    map[string]any
	body       []byte
}

// httpError carries the Node-style code axios exposes on network errors.
type httpError struct {
	message string
	code    string
}

func (h *httpError) Error() string { return h.message }

func (e *execution) httpErrorObject(err error) goja.Value {
	obj := e.vm.NewObject()
	var he *httpError
	if errors.As(err, &he) {
		_ = obj.Set("message", he.message)
		if he.code != "" {
			_ = obj.Set("code", he.code)
		}
		return obj
	}
	_ = obj.Set("message", err.Error())
	return obj
}

// doHTTP runs on a background goroutine. It must not touch the VM.
func (r *runner) doHTTP(parent context.Context, s httpSpec) (any, error) {
	ctx := parent
	if s.timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(parent, s.timeout)
		defer cancel()
	}

	var body io.Reader
	if s.hasBody {
		body = bytes.NewReader(s.body)
	}
	req, err := http.NewRequestWithContext(ctx, s.method, s.url, body)
	if err != nil {
		return nil, &httpError{message: err.Error(), code: "ERR_INVALID_URL"}
	}
	for k, v := range s.headers {
		req.Header.Set(k, v)
	}

	resp, err := r.opts.HTTPClient.Do(req)
	if err != nil {
		// The per-request timeout fired while the run itself is still alive.
		if errors.Is(ctx.Err(), context.DeadlineExceeded) && parent.Err() == nil {
			return nil, &httpError{
				message: fmt.Sprintf("timeout of %dms exceeded", s.timeout.Milliseconds()),
				code:    "ECONNABORTED",
			}
		}
		return nil, &httpError{message: err.Error(), code: networkErrorCode(err)}
	}
	defer resp.Body.Close()

	payload, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, &httpError{message: err.Error(), code: networkErrorCode(err)}
	}

	headers := make(map[string]any, len(resp.Header))
	for k, vs := range resp.Header {
		headers[strings.ToLower(k)] = strings.Join(vs, ", ")
	}
	statusText := strings.TrimSpace(strings.TrimPrefix(resp.Status, fmt.Sprint(resp.StatusCode)))
	return httpResult{status: resp.StatusCode, statusText: statusText, headers: headers, body: payload}, nil
}

func networkErrorCode(err error) string {
	switch {
	case errors.Is(err, syscall.ECONNREFUSED):
		return "ECONNREFUSED"
	case errors.Is(err, syscall.ECONNRESET):
		return "ECONNRESET"
	case errors.Is(err, syscall.ETIMEDOUT):
		return "ETIMEDOUT"
	}
	var dnsErr *net.DNSError
	if errors.As(err, &dnsErr) {
		return "ENOTFOUND"
	}
	return ""
}
