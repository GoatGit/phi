// Phi's subscription engine reuses Magpie's login, refresh, plugin and protocol
// implementations. It never runs Magpie's GUI or changes Phi's app connections.
package main

import (
	"bytes"
	"context"
	"crypto/subtle"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/yetone/magpie/internal/appdir"
	"github.com/yetone/magpie/internal/gateway"
	"github.com/yetone/magpie/internal/plugin"
	"github.com/yetone/magpie/internal/provider"
)

//go:embed providers.json
var manifest []byte

type subscription struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Website string `json:"website"`
}
type input struct {
	ID      string            `json:"id"`
	Session string            `json:"session"`
	Method  int               `json:"method"`
	Inputs  map[string]string `json:"inputs"`
	Value   string            `json:"value"`
	Site    string            `json:"site"`
}

type engine struct {
	gateway http.Handler
	token   string
}

func types() []subscription {
	var all []subscription
	_ = json.Unmarshal(manifest, &all)
	seen := map[string]bool{}
	for _, s := range all {
		seen[s.ID] = true
	}
	for _, p := range plugin.Cached() {
		id := provider.PluginID(p.ID)
		if !seen[id] {
			all = append(all, subscription{ID: id, Name: p.Name})
			seen[id] = true
		}
	}
	return all
}
func known(id string) bool {
	for _, s := range types() {
		if s.ID == id {
			return true
		}
	}
	return false
}
func models(id string) ([]string, error) {
	return availableModels(id)
}
func (e engine) manage(r *http.Request, action string, in input) (any, error) {
	ctx := r.Context()
	if action == "types" {
		return types(), nil
	}
	if action == "status" {
		st, ok := provider.SignInStatus(in.Session)
		if !ok {
			return nil, errors.New("sign-in session expired")
		}
		// A sign-in that just ended changes which account's models these are: the
		// next ask must reach the vendor, not the list cached before it.
		if st.State != "waiting" && st.State != "installing" {
			forgetModels(in.ID)
		}
		return relayStatus(st), nil
	}
	if action == "callback" {
		err := provider.SubmitSignInCallback(in.Session, in.Value)
		if err == nil {
			forgetModels(in.ID)
		}
		return true, err
	}
	if action == "cancel" {
		provider.CancelSignIn(in.Session)
		closeCodexRelay(in.Session)
		return true, nil
	}
	if !known(in.ID) {
		return nil, errors.New("unknown subscription type")
	}
	switch action {
	case "prepare":
		// Retired built-ins are served by their plugins. Adopt installs the exact
		// package Magpie selects and preserves its account IDs and refresh behavior.
		if provider.BuiltinRetired(in.ID) {
			if err := provider.Adopt(ctx, in.ID); err != nil {
				return nil, err
			}
		}
		if pp, ok := provider.PluginOf(in.ID); ok {
			return pp.Methods, nil
		}
		return []plugin.Method{{Type: "oauth", Label: "Browser login"}}, nil
	case "prompt":
		pp, ok := provider.PluginOf(in.ID)
		if !ok {
			return nil, nil
		}
		return plugin.NextPrompt(ctx, pp.ID, in.Method, in.Inputs)
	case "login":
		if pp, ok := provider.PluginOf(in.ID); ok {
			if in.Method < 0 || in.Method >= len(pp.Methods) {
				return nil, errors.New("invalid login method")
			}
			if pp.Methods[in.Method].Type == "api" {
				_, err := provider.PluginAPIKey(ctx, pp.ID, in.Method, in.Inputs, in.Value)
				if err != nil {
					return nil, err
				}
				return provider.SignInState{State: "done", Agent: in.ID}, nil
			}
			return provider.StartPluginSignIn(pp.ID, in.Method, in.Inputs)
		}
		return startBuiltinLogin(in.ID, in.Site)
	case "models":
		return subscriptionModels(ctx, in.ID)
	default:
		return nil, errors.New("unknown action")
	}
}
func (e engine) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Browser origins cannot call management or inference, even from loopback.
	if r.Header.Get("Origin") != "" || subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+e.token)) != 1 {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	if action, ok := strings.CutPrefix(r.URL.Path, "/manage/"); ok {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", 405)
			return
		}
		var in input
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&in); err != nil {
			http.Error(w, "invalid input", 400)
			return
		}
		result, err := e.manage(r, action, in)
		w.Header().Set("Content-Type", "application/json")
		if err != nil {
			w.WriteHeader(400)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
			return
		}
		_ = json.NewEncoder(w).Encode(result)
		return
	}
	path := strings.TrimPrefix(r.URL.Path, "/provider/")
	id, rest, ok := strings.Cut(path, "/")
	if !strings.HasPrefix(r.URL.Path, "/provider/") || !ok || !known(id) {
		http.NotFound(w, r)
		return
	}
	if rest == "v1/models" && r.Method == http.MethodGet {
		ids, err := models(id)
		if err != nil {
			http.Error(w, "subscription is not signed in", 409)
			return
		}
		data := []map[string]string{}
		for _, m := range ids {
			data = append(data, map[string]string{"id": m, "object": "model"})
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"object": "list", "data": data})
		return
	}
	if rest != "v1/chat/completions" || r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 128<<20))
	if err != nil {
		http.Error(w, "request too large", 413)
		return
	}
	var payload map[string]json.RawMessage
	if json.Unmarshal(body, &payload) != nil {
		http.Error(w, "invalid request", 400)
		return
	}
	var model string
	if json.Unmarshal(payload["model"], &model) != nil || model == "" {
		http.Error(w, "model required", 400)
		return
	}
	payload["model"], _ = json.Marshal(id + "/" + model)
	body, err = json.Marshal(payload)
	if err != nil {
		http.Error(w, "invalid request", 400)
		return
	}
	r.Body = io.NopCloser(bytes.NewReader(body))
	r.ContentLength = int64(len(body))
	r.Header.Del("Content-Length")
	r.Header.Del("Content-Encoding")
	r.Header.Set("Authorization", "Bearer "+gateway.Token)
	r.URL.Path = "/v1/chat/completions"
	e.gateway.ServeHTTP(w, r)
}
func main() {
	// Phi supplies private XDG config/cache roots. Ignore portable Magpie data
	// next to the executable; never write to the user's Magpie installation.
	appdir.UseExecutable("")
	token := os.Getenv("PHI_SUBSCRIPTION_TOKEN")
	_ = os.Unsetenv("PHI_SUBSCRIPTION_TOKEN")
	if len(token) < 32 {
		log.Fatal("missing runtime token")
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		log.Fatal(err)
	}
	srv := &http.Server{Handler: engine{gateway: gateway.New().Handler(), token: token}, ReadHeaderTimeout: 10 * time.Second}
	// The parent keeps stdin open. An app crash or exit closes it, stopping all
	// login listeners and plugin children with the engine process.
	go func() { _, _ = io.Copy(io.Discard, os.Stdin); _ = srv.Close(); os.Exit(0) }()
	_ = json.NewEncoder(os.Stdout).Encode(map[string]string{"address": listener.Addr().String()})
	// Load the plugin catalog in the background, as Magpie does. prepare/adopt
	// still reports an installation failure to the caller rather than hiding it.
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		defer cancel()
		_, _ = plugin.Providers(ctx)
	}()
	if err := srv.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
