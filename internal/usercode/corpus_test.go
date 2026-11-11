package usercode

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeTransport answers every request without touching the network. Bot
// actions point at production hosts, so tests must never reach them.
type fakeTransport struct {
	mu     sync.Mutex
	calls  []*http.Request
	bodies []string
	reply  func(r *http.Request, body string) (int, string, error)
}

func (f *fakeTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	var body string
	if r.Body != nil {
		b, _ := io.ReadAll(r.Body)
		body = string(b)
	}
	f.mu.Lock()
	f.calls = append(f.calls, r)
	f.bodies = append(f.bodies, body)
	f.mu.Unlock()

	status, text, err := f.reply(r, body)
	if err != nil {
		return nil, err
	}
	return &http.Response{
		StatusCode: status,
		Status:     http.StatusText(status),
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Body:       io.NopCloser(strings.NewReader(text)),
		Request:    r,
	}, nil
}

func (f *fakeTransport) snapshot() ([]*http.Request, []string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]*http.Request(nil), f.calls...), append([]string(nil), f.bodies...)
}

var errNetwork = io.ErrUnexpectedEOF

// sessionOf reads event.state.session after the run; the sandbox holds the
// written-back state, not the map the test built.
func sessionOf(sb *Sandbox) map[string]any {
	return sb.Event["state"].(map[string]any)["session"].(map[string]any)
}

func loadCorpus(t *testing.T, rel string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", "corpus", rel))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func corpusRunner(t *testing.T, ft *fakeTransport) Runner {
	t.Helper()
	return New(Options{
		Console:    testWriter{t},
		HTTPClient: &http.Client{Transport: ft},
		Timeout:    5 * time.Second,
	})
}

func TestCorpusQueuePositionSignsRequest(t *testing.T) {
	ft := &fakeTransport{reply: func(r *http.Request, _ string) (int, string, error) {
		return 200, `{"listQueue": 4}`, nil
	}}
	r := corpusRunner(t, ft)
	state := map[string]any{
		"session": map[string]any{"menu_channel": "general_service", "accountId": "acc", "unique_id": "u1", "group_id": "g9"},
	}
	sb := &Sandbox{BotID: "synthetic-signed", Event: map[string]any{"state": state}}
	if _, err := r.RunAction(context.Background(), "queuePosition", loadCorpus(t, "synthetic-signed/queuePosition.js"), sb, &nopHost{}); err != nil {
		t.Fatal(err)
	}
	calls, _ := ft.snapshot()
	if len(calls) != 1 {
		t.Fatalf("calls = %d, want 1", len(calls))
	}
	req := calls[0]
	if req.URL.Host != "signed.example.test" || req.URL.Query().Get("conv_id") != "acc_u1" || req.URL.Query().Get("group_id") != "g9" {
		t.Fatalf("url = %s", req.URL)
	}
	wantAuth := "Basic " + base64.StdEncoding.EncodeToString([]byte("example-user:example-pass"))
	if req.Header.Get("Authorization") != wantAuth {
		t.Fatalf("authorization = %q", req.Header.Get("Authorization"))
	}
	mac := hmac.New(sha256.New, []byte("example-secret-key"))
	mac.Write([]byte("xmen:" + req.Header.Get("x-time")))
	if got := req.Header.Get("x-encrypt"); got != hex.EncodeToString(mac.Sum(nil)) {
		t.Fatalf("x-encrypt = %q", got)
	}
	if got := sessionOf(sb)["queuePosition"]; got != 4.0 {
		t.Fatalf("session.queuePosition = %v, want 4", got)
	}
}

func TestCorpusHandoverFallsBackToNotifyOnError(t *testing.T) {
	ft := &fakeTransport{reply: func(r *http.Request, body string) (int, string, error) {
		switch {
		case r.Method == "GET":
			return 200, `{"Data": "riwayat"}`, nil
		case strings.Contains(r.URL.Host, "webhook"):
			return 500, `{"error":"down"}`, nil
		case strings.Contains(r.URL.Host, "notify"):
			return 200, `{"ok":true}`, nil
		}
		return 404, "", nil
	}}
	r := corpusRunner(t, ft)
	state := map[string]any{"session": map[string]any{"sid": "S-1", "group_id": "G"}}
	ev := map[string]any{
		"state": state,
		"payload": map[string]any{
			"metadata": map[string]any{
				"sid": "S-1", "accountId": "A", "unique_id": "U",
				"cust_message": "pesan",
				"profile":      map[string]any{"email": "a@b.test", "username": "budi", "mobilePhone": "0812"},
			},
		},
	}
	sb := &Sandbox{BotID: "synthetic-choice", Event: ev}
	if _, err := r.RunAction(context.Background(), "handover", loadCorpus(t, "synthetic-handover/handover.js"), sb, &nopHost{}); err != nil {
		t.Fatal(err)
	}
	calls, bodies := ft.snapshot()
	if len(calls) != 3 {
		t.Fatalf("calls = %d, want history GET, webhook POST, notify POST", len(calls))
	}
	if !strings.Contains(bodies[1], `"message":"riwayat"`) || !strings.Contains(bodies[1], `"sid":"S-1"`) {
		t.Fatalf("webhook body = %s", bodies[1])
	}
	if !strings.Contains(bodies[2], "Error handover") || !strings.Contains(bodies[2], "chat_id") {
		t.Fatalf("notify body = %s", bodies[2])
	}
}

func TestCorpusCreateTicketSuccessAndErrorPaths(t *testing.T) {
	cases := []struct {
		name       string
		status     int
		transport  error
		wantErr    bool
		wantTicket string
		wantCode   any
		wantReason string
	}{
		{name: "created", status: 201, wantTicket: "T-99"},
		{name: "bad request", status: 400, wantCode: 400.0, wantReason: "Bad Request"},
		{name: "server error", status: 500, wantCode: 500.0, wantReason: "Server Error"},
		{name: "network failure has no response", transport: errNetwork, wantErr: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ft := &fakeTransport{reply: func(r *http.Request, body string) (int, string, error) {
				if tc.transport != nil {
					return 0, "", tc.transport
				}
				if tc.status >= 300 {
					return tc.status, `{}`, nil
				}
				return tc.status, `{"createTicketWithAttributeResponse":{"eaiBody":{"ticketId":"T-99"},"eaiHeader":{"responseTimestamp":"2026-01-01"}}}`, nil
			}}
			r := corpusRunner(t, ft)
			state := map[string]any{"session": map[string]any{"phone": "0812", "name": "Budi", "accessToken": "tok", "serviceId": "SID", "detailKendala": "lambat", "symptom": "internet"}}
			sb := &Sandbox{BotID: "synthetic-ticket", Event: map[string]any{"state": state}}
			sb.Args = map[string]any{"name": "x", "value": "y"}
			_, err := r.RunAction(context.Background(), "createTicket", loadCorpus(t, "synthetic-ticket/createTicket.js"), sb, &nopHost{})
			if tc.wantErr {
				if err == nil {
					t.Fatal("expected action to reject: e.response is undefined in the catch block")
				}
				if !strings.Contains(err.Error(), "Cannot read property 'status' of undefined") {
					t.Fatalf("error = %v", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			session := sessionOf(sb)
			if tc.wantTicket != "" && session["ticketID"] != tc.wantTicket {
				t.Fatalf("ticketID = %v", session["ticketID"])
			}
			if tc.wantCode != nil && session["codeApi"] != tc.wantCode {
				t.Fatalf("codeApi = %v", session["codeApi"])
			}
			if tc.wantReason != "" && session["statusNameError"] != tc.wantReason {
				t.Fatalf("statusNameError = %v", session["statusNameError"])
			}
			_, bodies := ft.snapshot()
			if !strings.Contains(bodies[0], `"channel":79`) || !strings.Contains(bodies[0], `"contactPhone":"0812"`) {
				t.Fatalf("payload = %s", bodies[0])
			}
		})
	}
}

func TestCorpusHandoverSuccessRendersReply(t *testing.T) {
	ft := &fakeTransport{reply: func(r *http.Request, body string) (int, string, error) {
		if r.Method == "GET" {
			return 200, `{"Data": "riwayat"}`, nil
		}
		return 200, `{"ok":true}`, nil
	}}
	r := corpusRunner(t, ft)
	ev := map[string]any{
		"state": map[string]any{"session": map[string]any{"sid": "S-2", "group_id": "G"}},
		"payload": map[string]any{
			"metadata": map[string]any{
				"sid": "S-2", "accountId": "A", "unique_id": "U",
				"cust_message": "pesan",
				"profile":      map[string]any{"email": "a@b.test", "username": "budi", "mobilePhone": "0812"},
			},
		},
	}
	sb := &Sandbox{BotID: "synthetic-handover", Event: ev}
	if _, err := r.RunAction(context.Background(), "handover", loadCorpus(t, "synthetic-handover/handover.js"), sb, &nopHost{}); err != nil {
		t.Fatal(err)
	}
	calls, bodies := ft.snapshot()
	if len(calls) != 2 {
		t.Fatalf("calls = %d, want history GET and webhook POST only", len(calls))
	}
	if !strings.Contains(bodies[1], `"message":"riwayat"`) {
		t.Fatalf("webhook body = %s", bodies[1])
	}
}
