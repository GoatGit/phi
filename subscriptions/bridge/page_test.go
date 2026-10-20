package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/yetone/magpie/internal/catalog"
	"github.com/yetone/magpie/internal/provider"
)

func TestPageSpeaksTheBrowsersLanguage(t *testing.T) {
	for accept, want := range map[string]string{
		"zh-CN,zh;q=0.9,en;q=0.8": "zh-CN",
		"zh-TW,zh;q=0.9":          "zh-Hant",
		"ja-JP,ja;q=0.9":          "ja",
		"en-US,en;q=0.9":          "en",
		"de-DE,de;q=0.9":          "en",
		"":                        "en",
	} {
		if got := pageTextFor(accept).lang; got != want {
			t.Errorf("pageTextFor(%q).lang = %q, want %q", accept, got, want)
		}
	}
}

func TestSignInPageIsPhisAlone(t *testing.T) {
	copy := pageTextFor("zh-CN")
	for _, tc := range []struct {
		ok     bool
		body   string
		status int
	}{{true, "someone@example.com 已添加到 PHI。", http.StatusOK}, {false, "the code expired", http.StatusBadRequest}} {
		rec := httptest.NewRecorder()
		signInPage(rec, tc.ok, copy, copy.signedIn, tc.body)
		page := rec.Body.String()
		if rec.Code != tc.status {
			t.Errorf("status = %d, want %d", rec.Code, tc.status)
		}
		for _, want := range []string{"<title>PHI · " + copy.signedIn, "PHI</div>", tc.body, "<svg"} {
			if !strings.Contains(page, want) {
				t.Errorf("page misses %q:\n%s", want, page)
			}
		}
		if strings.Contains(strings.ToLower(page), "magpie") {
			t.Errorf("Phi's page names Magpie:\n%s", page)
		}
	}
}

func TestRelayedStateKeepsTheBrowserOnThisMachine(t *testing.T) {
	st := provider.SignInState{
		ID:              "abc",
		Agent:           "codex",
		State:           "waiting",
		PasteCallback:   true,
		CallbackBlocked: "busy",
		CallbackPort:    1455,
	}
	got := relayedState(st)
	if got.PasteCallback || got.CallbackBlocked != "" || got.CallbackPort != 0 {
		t.Fatalf("a relayed sign-in still asks for a pasted address: %+v", got)
	}
	if got.ID != st.ID || got.Agent != st.Agent {
		t.Fatalf("relayedState changed the sign-in: %+v", got)
	}
}

func TestRelayAnswersTheBrowsersRequests(t *testing.T) {
	relay, err := startCodexRelay()
	if err != nil {
		t.Skipf("port %s is taken: %v", codexCallbackAddr, err)
	}
	defer relay.close()
	put := func(path string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		relay.serve(rec, httptest.NewRequest(http.MethodGet, path, nil))
		return rec
	}
	if rec := put("/favicon.svg"); rec.Code != http.StatusOK || !strings.HasPrefix(rec.Body.String(), "<svg") {
		t.Errorf("favicon = %d", rec.Code)
	}
	// `codex login` asks a busy port to free itself, as Magpie's own does.
	if rec := put("/cancel"); rec.Code != http.StatusNoContent {
		t.Errorf("cancel = %d, want 204", rec.Code)
	}
	if rec := put("/somewhere"); rec.Code != http.StatusNotFound {
		t.Errorf("unknown path = %d, want 404", rec.Code)
	}
	// No sign-in is attached yet: a browser that lands here is told so.
	rec := put("/auth/callback?code=x&state=y")
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "<title>PHI · ") {
		t.Errorf("callback without a sign-in = %d", rec.Code)
	}
}

func TestModelIDsAreBoundedAndUnique(t *testing.T) {
	ids := modelIDs([]catalog.Model{{ID: "a"}, {ID: "a"}, {ID: ""}, {ID: "b"}})
	if len(ids) != 2 || ids[0] != "a" || ids[1] != "b" {
		t.Fatalf("modelIDs = %v", ids)
	}
	many := make([]catalog.Model, modelsLimit+5)
	for i := range many {
		many[i].ID = fmt.Sprintf("model-%d", i)
	}
	if got := len(modelIDs(many)); got != modelsLimit {
		t.Fatalf("modelIDs kept %d models, want %d", got, modelsLimit)
	}
}

func TestForgettingAListAsksTheVendorAgain(t *testing.T) {
	keepModels("codex", []string{"gpt-5"})
	if _, _, ok := cachedModels("codex"); !ok {
		t.Fatal("a listed list wasn't kept")
	}
	forgetModels("codex")
	if _, _, ok := cachedModels("codex"); ok {
		t.Fatal("a finished sign-in kept the list it had before it")
	}
}
