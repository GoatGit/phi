package main

// What a subscription account can use, asked of the account itself.
//
// Magpie's Available() lists what the vendor is known to serve: the vendor's
// own list when one was fetched — and for a ChatGPT account, what Codex's model
// cache or the pinned Magpie version says when none was. Neither is the list of
// the account signed in now. So a login, and every refresh after it, asks the
// account's own models endpoint (Magpie's Refetch, the call its window makes),
// and only a failed ask falls back to what is known, saying so.

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/yetone/magpie/internal/catalog"
	"github.com/yetone/magpie/internal/provider"
)

const (
	// modelsFresh is how long an answer is reused: a dialog asks once when it
	// opens and once when the sign-in ends, and the second ask is the first
	// account's list already.
	modelsFresh = 30 * time.Second
	// modelsWait bounds one ask. A vendor that doesn't answer in this leaves
	// the sign-in's saved list in place.
	modelsWait = 30 * time.Second
	// modelsLimit is what Phi's resource pool takes of a list; its own catalog
	// refuses more.
	modelsLimit = 200
)

// modelList is a subscription's models as the dialog shows them: the vendor's
// own list, or the one Magpie saved when the vendor couldn't be asked.
type modelList struct {
	Models    []string `json:"models"`
	Source    string   `json:"source"`              // "vendor" or "cached"
	FetchedAt string   `json:"fetchedAt,omitempty"` // when the vendor listed them
	Warning   string   `json:"warning,omitempty"`   // why the vendor wasn't asked
}

var listedNow struct {
	sync.Mutex
	m map[string]listed
}

type listed struct {
	ids []string
	at  time.Time
}

// subscriptionModels is the models id's account can use now, asking the vendor.
func subscriptionModels(ctx context.Context, id string) (modelList, error) {
	p, err := provider.Find(id)
	if err != nil {
		return modelList{}, err
	}
	if p.Account == nil {
		return modelList{}, errors.New("subscription is not signed in")
	}
	if ids, at, ok := cachedModels(id); ok && time.Since(at) < modelsFresh {
		return modelList{Models: ids, Source: "vendor", FetchedAt: at.UTC().Format(time.RFC3339)}, nil
	}
	// The vendor's own list, as Magpie's window asks for it: a ChatGPT
	// account's from the Codex backend, a plugin's from its plugin.
	fetchCtx, cancel := context.WithTimeout(ctx, modelsWait)
	defer cancel()
	fetched, _, fetchErr := p.Refetch(fetchCtx)
	if ids := modelIDs(fetched); fetchErr == nil && len(ids) > 0 {
		keepModels(id, ids)
		return modelList{Models: ids, Source: "vendor", FetchedAt: time.Now().UTC().Format(time.RFC3339)}, nil
	}
	// What Magpie knows, which is what the account had last time: the account's
	// own list, or the one saved when the vendor answered before.
	ids := modelIDs(p.Available())
	if len(ids) == 0 {
		if fetchErr != nil {
			return modelList{}, fmt.Errorf("the vendor listed no models: %w", fetchErr)
		}
		return modelList{}, errors.New("this subscription lists no models")
	}
	out := modelList{Models: ids, Source: "cached"}
	if at, ok := p.Listed(); ok {
		out.FetchedAt = at.UTC().Format(time.RFC3339)
	}
	if fetchErr != nil {
		out.Warning = fetchErr.Error()
	} else {
		out.Warning = "the vendor listed no models"
	}
	return out, nil
}

// availableModels is the list Magpie keeps for id, without asking the vendor:
// what the engine's OpenAI-compatible /v1/models answers.
func availableModels(id string) ([]string, error) {
	p, err := provider.Find(id)
	if err != nil {
		return nil, err
	}
	if p.Account == nil {
		return nil, errors.New("subscription is not signed in")
	}
	ids := modelIDs(p.Available())
	if len(ids) == 0 {
		return nil, errors.New("this subscription lists no models")
	}
	return ids, nil
}

// modelIDs is a model list's ids, deduplicated and bounded: the resource pool
// refuses a supplier with more than modelsLimit models.
func modelIDs(ms []catalog.Model) []string {
	seen := make(map[string]bool, len(ms))
	ids := make([]string, 0, min(len(ms), modelsLimit))
	for _, m := range ms {
		if m.ID == "" || seen[m.ID] {
			continue
		}
		seen[m.ID] = true
		ids = append(ids, m.ID)
		if len(ids) == modelsLimit {
			break
		}
	}
	return ids
}

// forgetModels drops what was listed for id: a sign-in that just ended changes
// which account's models these are, so the next ask must reach the vendor.
func forgetModels(id string) {
	if id == "" {
		return
	}
	listedNow.Lock()
	delete(listedNow.m, id)
	listedNow.Unlock()
}

func cachedModels(id string) ([]string, time.Time, bool) {
	listedNow.Lock()
	defer listedNow.Unlock()
	v, ok := listedNow.m[id]
	return v.ids, v.at, ok
}

func keepModels(id string, ids []string) {
	listedNow.Lock()
	defer listedNow.Unlock()
	if listedNow.m == nil {
		listedNow.m = map[string]listed{}
	}
	listedNow.m[id] = listed{ids: ids, at: time.Now()}
}
