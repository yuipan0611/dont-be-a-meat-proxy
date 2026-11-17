package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// Synthetic PAT plus the published Gitleaks Slack test sample; never issued credentials.
const fakePAT = "\x67hp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"
const fakeSlack = "\x78oxb-781236542736-2364535789652-" + "GkwFDQoHqzXDVsC6GzqYUypD"

func fixture(t *testing.T) (http.Handler, *atomic.Int32, string) {
	t.Helper()
	var received atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		received.Add(1)
		if r.Host != "mail-a" {
			t.Error("upstream Host must be fixed")
		}
		if r.Header.Get("Mcp-Session-Id") != "session-fixture" {
			t.Error("session header lost")
		}
		w.Header().Set("Mcp-Session-Id", "session-returned")
		io.Copy(w, r.Body)
	}))
	t.Cleanup(upstream.Close)
	path := filepath.Join(t.TempDir(), "allowlist.json")
	if err := os.WriteFile(path, []byte(`{"entries":[]}`), 0600); err != nil {
		t.Fatal(err)
	}
	h, err := newValidator(upstream.URL, path)
	if err != nil {
		t.Fatal(err)
	}
	return h, &received, path
}

func post(t *testing.T, h http.Handler, name string, args map[string]any) *httptest.ResponseRecorder {
	t.Helper()
	b, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": map[string]any{"name": name, "arguments": args}})
	return raw(h, "/mcp/", string(b))
}
func raw(h http.Handler, path, b string) *httptest.ResponseRecorder {
	r := httptest.NewRequest("POST", path, strings.NewReader(b))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Mcp-Session-Id", "session-fixture")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func TestCodePointBoundary(t *testing.T) {
	h, n, _ := fixture(t)
	for _, body := range []string{strings.Repeat("文", 20000), strings.Repeat("😀", 20000), `{"v":1,"text":"` + strings.Repeat("😀", 20000) + `","summary":"ok"}`} {
		if w := post(t, h, "send_message", map[string]any{"body_md": body}); w.Code != 200 {
			t.Fatalf("boundary denied: %d %s", w.Code, w.Body)
		}
	}
	for _, body := range []string{strings.Repeat("文", 20001), strings.Repeat("😀", 20001), `{"v":1,"text":"` + strings.Repeat("😀", 20001) + `"}`} {
		w := post(t, h, "send_message", map[string]any{"body_md": body})
		if !strings.Contains(w.Body.String(), "放 GitHub、訊息附連結") {
			t.Fatal("length rejection missing guidance")
		}
	}
	if n.Load() != 3 {
		t.Fatalf("rejected contents reached Mail: received=%d", n.Load())
	}
}
func TestSecretsBlockedWithoutEcho(t *testing.T) {
	h, n, _ := fixture(t)
	for _, name := range []string{"send_message", "reply_message", "macro_contact_handshake"} {
		for _, value := range []string{fakePAT, fakePAT + " # gitleaks:allow", `{"v":1,"text":"\u0067hp_` + `A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"}`, fakeSlack} {
			w := post(t, h, name, map[string]any{"body_md": value})
			var rpc map[string]any
			if err := json.Unmarshal(w.Body.Bytes(), &rpc); err != nil {
				t.Fatal(err)
			}
			if rpc["error"] == nil {
				t.Errorf("%s secret accepted", name)
			}
			if strings.Contains(w.Body.String(), "A1b2C3d4") || strings.Contains(w.Body.String(), "GkwFDQo") {
				t.Fatal("secret echoed")
			}
		}
	}
	if n.Load() != 0 {
		t.Fatal("secret request reached Mail")
	}
}
func TestAllowlistReloadAndFailClosed(t *testing.T) {
	h, n, path := fixture(t)
	sum := sha256.Sum256([]byte(fakePAT))
	b, _ := json.Marshal(map[string]any{"entries": []any{map[string]any{"rule_id": "github-pat", "sha256": hex.EncodeToString(sum[:]), "reason": "published test sample"}}})
	os.WriteFile(path, b, 0600)
	post(t, h, "send_message", map[string]any{"body_md": fakePAT})
	if n.Load() != 1 {
		t.Fatal("allowlisted exact sample blocked")
	}
	post(t, h, "send_message", map[string]any{"body_md": strings.Replace(fakePAT, "ghp_A", "ghp_Z", 1)})
	if n.Load() != 1 {
		t.Fatal("allowlist leaked to a different secret")
	}
	os.WriteFile(path, []byte(`{"entries":[]}`), 0600)
	post(t, h, "send_message", map[string]any{"body_md": fakePAT})
	if n.Load() != 1 {
		t.Fatal("allowlist removal not effective")
	}
	for _, body := range []string{`bad-json`, `{"entries":[],"disable_all":true}`, `{"entries":[{"rule_id":"unknown","sha256":"no","reason":"x"}]}`} {
		os.WriteFile(path, []byte(body), 0600)
		if w := post(t, h, "send_message", map[string]any{"body_md": "normal"}); w.Code != 503 {
			t.Error("invalid allowlist not fail closed")
		}
	}
	os.WriteFile(path, []byte(`{"entries":[]}`), 0600)
	os.Chmod(path, 0644)
	if w := post(t, h, "send_message", map[string]any{"body_md": "normal"}); w.Code != 503 {
		t.Error("public-readable allowlist accepted")
	}
	os.Remove(path)
	post(t, h, "send_message", map[string]any{"body_md": "normal"})
	if n.Load() != 1 {
		t.Fatal("unavailable policy forwarded")
	}
}
func TestAlternateIngressRejected(t *testing.T) {
	h, n, _ := fixture(t)
	for _, path := range []string{"/api/messages", "/mail/api/send", "/mcp/extra", "/mcp//"} {
		if w := raw(h, path, `{}`); w.Code < 400 {
			t.Error("alternate ingress open", path)
		}
	}
	for _, b := range []string{
		`[{"jsonrpc":"2.0","id":1,"method":"tools/call"}]`,
		`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"send_message","arguments":{"body_md":"` + fakePAT + `","body_md":"ok"}}}`,
		`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"send_message","arguments":{"body_md":"ok","body_md":"` + fakePAT + `"}}}`,
		`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"send_message","arguments":{"body_md":"ok"}}} {}`,
	} {
		if w := raw(h, "/mcp/", b); w.Code < 400 {
			t.Error("ambiguous JSON accepted")
		}
	}
	if n.Load() != 0 {
		t.Fatal("invalid input reached upstream")
	}
}
func TestProtocolAndCredentialForwarding(t *testing.T) {
	h, n, _ := fixture(t)
	w := post(t, h, "send_message", map[string]any{"body_md": "合法內容 😀", "sender_token": fakePAT})
	if w.Code != 200 || w.Header().Get("Mcp-Session-Id") != "session-returned" || n.Load() != 1 {
		t.Fatal("protocol forwarding broken")
	}
	w = raw(h, "/mcp/", `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26"}}`)
	if w.Code != 200 || n.Load() != 2 {
		t.Fatal("initialize broken")
	}
}

func TestNestedDuplicateKeysCannotHideEscapedSecrets(t *testing.T) {
	h, n, _ := fixture(t)
	for _, body := range []string{
		`{"v":1,"text":"ok","text":"\u0067hp_` + `A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"}`,
		`[{"text":"ok","text":"\u0067hp_` + `A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"}]`,
	} {
		w := post(t, h, "send_message", map[string]any{"body_md": body})
		var rpc map[string]any
		json.Unmarshal(w.Body.Bytes(), &rpc)
		if rpc["error"] == nil {
			t.Error("nested duplicate keys evaded validation")
		}
	}
	if n.Load() != 0 {
		t.Fatal("ambiguous content reached Mail")
	}
}
func TestBoundedInputAndDisabledInlineAllow(t *testing.T) {
	h, n, _ := fixture(t)
	for _, b := range []string{strings.Repeat(" ", maxBodyBytes+1), "{\"bad\":\"" + string([]byte{0xff}) + "\"}"} {
		if w := raw(h, "/mcp/", b); w.Code < 400 {
			t.Error("invalid input accepted")
		}
	}
	r := httptest.NewRequest("POST", "/mcp/", strings.NewReader(`{}`))
	r.Header.Set("Content-Encoding", "gzip")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 415 {
		t.Error("compressed body accepted")
	}
	// Upstream's low-entropy false-positive sample should remain allowed.
	w = post(t, h, "send_message", map[string]any{"body_md": "ghp_x\x78xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"})
	if w.Code != 200 || n.Load() != 1 {
		t.Fatal("upstream false-positive semantics changed")
	}
}

func TestAttachmentsCannotBypassContentScan(t *testing.T) {
	h, n, _ := fixture(t)
	for _, args := range []map[string]any{
		{"body_md": "ordinary", "attachment_paths": []string{"/data/archive/private.txt"}},
		{"body_md": "ordinary", "attachments": []any{map[string]any{"path": "/data/archive/private.txt"}}},
		{"body_md": "ordinary", "convert_images": true},
	} {
		w := post(t, h, "send_message", args)
		var rpc map[string]any
		json.Unmarshal(w.Body.Bytes(), &rpc)
		if rpc["error"] == nil {
			t.Error("unscanned attachment path accepted")
		}
	}
	if n.Load() != 0 {
		t.Fatal("attachment request reached Mail")
	}
}

func TestReadinessFailsClosedDuringPolicyReplacement(t *testing.T) {
	h, n, path := fixture(t)
	os.Remove(path)
	r := httptest.NewRequest("GET", "/health/readiness", nil)
	r.Header.Set("Mcp-Session-Id", "session-fixture")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 503 || n.Load() != 0 {
		t.Fatal("readiness ignored missing private policy")
	}
}

func TestInlineAttachmentsCannotLoadUnscannedServerFiles(t *testing.T) {
	h, n, _ := fixture(t)
	for _, body := range []string{`![image](/data/private.png)`, `{"v":1,"text":"!\u005bimage](/data/private.png)"}`, `<IMG src="file:///data/private.png">`} {
		w := post(t, h, "send_message", map[string]any{"body_md": body})
		var rpc map[string]any
		json.Unmarshal(w.Body.Bytes(), &rpc)
		if rpc["error"] == nil {
			t.Error("inline attachment escaped server validation")
		}
	}
	if n.Load() != 0 {
		t.Fatal("inline attachment reached Mail")
	}
}

func TestValidationTimingExcludesSlowUpstream(t *testing.T) {
	_, _, path := fixture(t)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { time.Sleep(150 * time.Millisecond); w.WriteHeader(200) }))
	defer upstream.Close()
	h, err := newValidator(upstream.URL, path)
	if err != nil {
		t.Fatal(err)
	}
	w := post(t, h, "send_message", map[string]any{"body_md": "合法內容"})
	timing := strings.TrimPrefix(w.Header().Get("Server-Timing"), "hub_validation;dur=")
	ms, err := strconv.ParseFloat(timing, 64)
	if err != nil || ms < 0 || ms >= 100 {
		t.Fatal("validation timing is absent or includes upstream delay")
	}
}

func TestErrorCorrelatesStringIDsWithoutSecretReflection(t *testing.T) {
	h, n, _ := fixture(t)
	for i, id := range []string{"native-sdk-request-17", fakePAT, fakePAT} {
		body := fakePAT
		if i == 2 {
			body = "ordinary content"
		}
		b, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "method": "tools/call", "params": map[string]any{"name": "send_message", "arguments": map[string]any{"body_md": body}}})
		w := raw(h, "/mcp/", string(b))
		var rpc map[string]any
		json.Unmarshal(w.Body.Bytes(), &rpc)
		if id == fakePAT {
			if rpc["id"] != nil || strings.Contains(w.Body.String(), fakePAT) {
				t.Fatal("secret-bearing ID reflected")
			}
		} else if rpc["id"] != id {
			t.Fatal("safe SDK string ID lost correlation")
		}
	}
	if n.Load() != 0 {
		t.Fatal("rejected content reached Mail")
	}
}
