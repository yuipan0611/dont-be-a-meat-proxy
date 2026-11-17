package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/rs/zerolog"
	"github.com/zricethezav/gitleaks/v8/detect"
	"github.com/zricethezav/gitleaks/v8/logging"
)

const maxBodyBytes = 1 << 20
const maxCodePoints = 20000

var errAttachment = errors.New("inline attachment")

type allowEntry struct {
	RuleID string `json:"rule_id"`
	SHA256 string `json:"sha256"`
	Reason string `json:"reason"`
}
type allowPolicy struct {
	Entries []allowEntry `json:"entries"`
}

type validator struct {
	detector      *detect.Detector
	allowlistPath string
	proxy         *httputil.ReverseProxy
	slots         chan struct{}
}

func newValidator(upstream, allowlistPath string) (http.Handler, error) {
	logging.Logger = zerolog.Nop() // Trace events can include matches; never emit them.
	u, err := url.Parse(upstream)
	if err != nil || u.Scheme != "http" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Path != "" {
		return nil, errors.New("invalid upstream configuration")
	}
	d, err := detect.NewDetectorDefaultConfig()
	if err != nil {
		return nil, errors.New("default scanner configuration unavailable")
	}
	d.IgnoreGitleaksAllow = true
	p := httputil.NewSingleHostReverseProxy(u)
	director := p.Director
	p.Director = func(r *http.Request) { director(r); r.Host = "mail-a" }
	p.ErrorLog = log.New(io.Discard, "", 0)
	p.ErrorHandler = func(w http.ResponseWriter, r *http.Request, _ error) {
		rpcError(w, 503, nil, -32008, "Validator upstream unavailable", nil)
	}
	p.FlushInterval = -1
	p.Transport = &http.Transport{Proxy: nil, MaxIdleConns: 32, MaxIdleConnsPerHost: 16, IdleConnTimeout: 90 * time.Second, ResponseHeaderTimeout: 10 * time.Second}
	v := &validator{d, allowlistPath, p, make(chan struct{}, 16)}
	if _, err = v.loadAllowlist(); err != nil {
		return nil, errors.New("private validator allowlist unavailable or invalid")
	}
	return v, nil
}

func (v *validator) loadAllowlist() (map[string]bool, error) {
	f, err := os.Open(v.allowlistPath)
	if err != nil {
		return nil, errors.New("policy-open")
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, errors.New("policy-stat")
	}
	if !info.Mode().IsRegular() || info.Mode().Perm() != 0600 || info.Size() > 65536 {
		return nil, errors.New("policy-file-mode-or-size")
	}
	b, err := io.ReadAll(io.LimitReader(f, 65537))
	if err != nil {
		return nil, errors.New("policy-read")
	}
	if _, err = decodeObject(b); err != nil {
		return nil, errors.New("policy-json")
	}
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	var policy allowPolicy
	if err = dec.Decode(&policy); err != nil || policy.Entries == nil {
		return nil, errors.New("policy-schema")
	}
	allow := make(map[string]bool)
	for _, entry := range policy.Entries {
		_, known := v.detector.Config.Rules[entry.RuleID]
		hash, e := hex.DecodeString(entry.SHA256)
		if !known || e != nil || len(hash) != 32 || hex.EncodeToString(hash) != entry.SHA256 || strings.TrimSpace(entry.Reason) == "" {
			return nil, errors.New("policy-entry")
		}
		allow[entry.RuleID+":"+entry.SHA256] = true
	}
	return allow, nil
}

func rpcError(w http.ResponseWriter, status int, id any, code int, message string, classes []string) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	payload := map[string]any{"code": code, "message": message}
	if len(classes) > 0 {
		payload["data"] = map[string]any{"categories": classes}
	}
	json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": id, "error": payload})
}

func (v *validator) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	started := time.Now()
	if r.URL.Path == "/health/readiness" && r.Method == "GET" {
		if _, err := v.loadAllowlist(); err != nil {
			rpcError(w, 503, nil, -32008, "Validator policy unavailable", nil)
			return
		}
	}
	if (r.URL.Path == "/health/liveness" || r.URL.Path == "/health/readiness") && r.Method == "GET" {
		v.proxy.ServeHTTP(w, r)
		return
	}
	if r.URL.Path != "/mcp/" && r.URL.Path != "/mcp" {
		rpcError(w, 404, nil, -32600, "Only Hub MCP is available", nil)
		return
	}
	if r.Method == "GET" || r.Method == "DELETE" {
		v.proxy.ServeHTTP(w, r)
		return
	}
	if r.Method != "POST" {
		rpcError(w, 405, nil, -32600, "Unsupported method", nil)
		return
	}
	if e := r.Header.Get("Content-Encoding"); e != "" && e != "identity" {
		rpcError(w, 415, nil, -32600, "Encoded requests are unsupported", nil)
		return
	}
	select {
	case v.slots <- struct{}{}:
		defer func() { <-v.slots }()
	default:
		rpcError(w, 503, nil, -32008, "Validator busy", nil)
		return
	}
	b, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBodyBytes))
	if err != nil {
		rpcError(w, 413, nil, -32007, "請放 GitHub、訊息附連結（請求過大）", nil)
		return
	}
	obj, err := decodeObject(b)
	if err != nil {
		rpcError(w, 400, nil, -32600, "Invalid single JSON-RPC request", nil)
		return
	}
	id := obj["id"]
	safeID := id
	switch value := id.(type) {
	case json.Number:
	case string:
		// Preserve normal SDK correlation while suppressing detected secrets
		// placed in the correlation field instead of the message body.
		if findings := v.detector.DetectString(value); len(findings) > 0 {
			classes := make(map[string]bool)
			for _, finding := range findings {
				classes[finding.RuleID] = true
			}
			names := make([]string, 0, len(classes))
			for name := range classes {
				names = append(names, name)
			}
			sort.Strings(names)
			rpcError(w, 200, nil, -32007, "訊息含密鑰類別："+strings.Join(names, ", ")+"；未保存", names)
			return
		}
	default:
		safeID = nil
	}
	if obj["jsonrpc"] != "2.0" {
		rpcError(w, 400, safeID, -32600, "Invalid JSON-RPC version", nil)
		return
	}
	method, _ := obj["method"].(string)
	switch method {
	case "initialize", "notifications/initialized", "ping", "tools/list", "resources/list", "resources/templates/list", "resources/read", "notifications/cancelled":
	case "tools/call":
		params, ok := obj["params"].(map[string]any)
		if !ok || id == nil {
			rpcError(w, 400, safeID, -32600, "Invalid tool request", nil)
			return
		}
		name, ok := params["name"].(string)
		args, okArgs := params["arguments"].(map[string]any)
		if !ok || name == "" || !okArgs {
			rpcError(w, 400, safeID, -32600, "Invalid tool arguments", nil)
			return
		}
		for _, field := range []string{"attachment_paths", "attachments"} {
			if value, exists := args[field]; exists && value != nil {
				rpcError(w, 200, safeID, -32007, "Hub 不收附件，請放 GitHub、訊息附連結", nil)
				return
			}
		}
		if args["convert_images"] == true {
			rpcError(w, 200, safeID, -32007, "Hub 不收附件，請放 GitHub、訊息附連結", nil)
			return
		}
		allow, err := v.loadAllowlist()
		if err != nil {
			log.Print("validator policy unavailable: ", err)
			rpcError(w, 503, safeID, -32008, "Validator policy unavailable", nil)
			return
		}
		var text strings.Builder
		for k, value := range args {
			if k == "sender_token" {
				continue
			}
			if err := collectText(value, &text, 0); err != nil {
				if errors.Is(err, errAttachment) {
					rpcError(w, 200, safeID, -32007, "Hub 不收附件，請放 GitHub、訊息附連結", nil)
					return
				}
				rpcError(w, 200, safeID, -32007, "內容超過 20,000 字元或結構限制，請放 GitHub、訊息附連結", nil)
				return
			}
			text.WriteString(k)
			text.WriteByte('\n')
		}
		classes := make(map[string]bool)
		for _, finding := range v.detector.DetectString(text.String()) {
			sum := sha256.Sum256([]byte(finding.Secret))
			if !allow[finding.RuleID+":"+hex.EncodeToString(sum[:])] {
				classes[finding.RuleID] = true
			}
		}
		if len(classes) > 0 {
			names := make([]string, 0, len(classes))
			for name := range classes {
				names = append(names, name)
			}
			sort.Strings(names)
			rpcError(w, 200, safeID, -32007, "訊息含密鑰類別："+strings.Join(names, ", ")+"；未保存", names)
			return
		}
	default:
		rpcError(w, 400, safeID, -32601, "Unsupported MCP method", nil)
		return
	}
	r.Body = io.NopCloser(bytes.NewReader(b))
	r.ContentLength = int64(len(b))
	w.Header().Set("Server-Timing", "hub_validation;dur="+strconv.FormatFloat(float64(time.Since(started).Microseconds())/1000, 'f', 3, 64))
	v.proxy.ServeHTTP(w, r)
}

// Duplicate keys can be interpreted differently by downstream parsers.
func decodeObject(b []byte) (map[string]any, error) {
	value, err := decodeJSON(b)
	if err != nil {
		return nil, err
	}
	obj, ok := value.(map[string]any)
	if !ok {
		return nil, errors.New("object required")
	}
	return obj, nil
}

func decodeJSON(b []byte) (any, error) {
	if !utf8.Valid(b) {
		return nil, errors.New("invalid UTF-8")
	}
	d := json.NewDecoder(bytes.NewReader(b))
	d.UseNumber()
	value, err := readValue(d, 0)
	if err != nil {
		return nil, err
	}
	if _, err = d.Token(); err != io.EOF {
		return nil, errors.New("trailing JSON")
	}
	return value, nil
}
func readValue(d *json.Decoder, depth int) (any, error) {
	if depth > 32 {
		return nil, errors.New("JSON nesting limit")
	}
	tok, err := d.Token()
	if err != nil {
		return nil, err
	}
	switch tok {
	case json.Delim('{'):
		obj := make(map[string]any)
		for d.More() {
			key, err := d.Token()
			if err != nil {
				return nil, err
			}
			k, ok := key.(string)
			if !ok {
				return nil, errors.New("invalid key")
			}
			if _, exists := obj[k]; exists {
				return nil, errors.New("duplicate key")
			}
			value, err := readValue(d, depth+1)
			if err != nil {
				return nil, err
			}
			obj[k] = value
		}
		_, err = d.Token()
		return obj, err
	case json.Delim('['):
		var arr []any
		for d.More() {
			value, err := readValue(d, depth+1)
			if err != nil {
				return nil, err
			}
			arr = append(arr, value)
		}
		_, err = d.Token()
		return arr, err
	default:
		return tok, nil
	}
}

func collectText(value any, out *strings.Builder, depth int) error {
	if depth > 32 || out.Len() > maxBodyBytes {
		return errors.New("content structure limit")
	}
	switch x := value.(type) {
	case string:
		// Native Mail can read server-local images even without explicit paths.
		if strings.Contains(x, "![") || strings.Contains(strings.ToLower(x), "<img") {
			return errAttachment
		}
		var embedded map[string]any
		var decoded any
		trimmed := strings.TrimSpace(x)
		if (strings.HasPrefix(trimmed, "{") || strings.HasPrefix(trimmed, "[")) && json.Valid([]byte(x)) {
			var err error
			decoded, err = decodeJSON([]byte(x))
			if err != nil {
				return err
			}
			embedded, _ = decoded.(map[string]any)
		}
		_, hasText := embedded["text"].(string)
		isEnvelope := embedded["v"] == json.Number("1") && hasText
		if !isEnvelope && utf8.RuneCountInString(x) > maxCodePoints {
			return errors.New("content too long")
		}
		out.WriteString(x)
		out.WriteByte('\n')
		if decoded != nil {
			return collectText(decoded, out, depth+1)
		}
	case map[string]any:
		for k, v := range x {
			out.WriteString(k)
			out.WriteByte('\n')
			if err := collectText(v, out, depth+1); err != nil {
				return err
			}
		}
	case []any:
		for _, v := range x {
			if err := collectText(v, out, depth+1); err != nil {
				return err
			}
		}
	}
	return nil
}
