package main

// Phi's own callback for a ChatGPT (Codex) sign-in.
//
// Magpie's browser sign-in serves the page the browser ends on, so the page a
// Phi user saw was Magpie's. The engine takes the one port OpenAI sends Codex's
// OAuth client back to before the sign-in starts: Magpie's flow then reports
// that port as taken and waits for its address, and whatever the browser sends
// there is handed to Magpie's own sign-in — the same state check, the same
// exchange — and answered with Phi's page (page.go). Nothing about the tokens'
// handling changes; only who writes the page.

import (
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/yetone/magpie/internal/provider"
)

// codexCallbackAddr is where a ChatGPT (Codex) sign-in sends the browser back.
// OpenAI only ever redirects Codex's OAuth client to this port, which is why
// the engine can own it. It must be Magpie's own port or the flow would keep
// its listener and serve its page: the sign-in says which port it is waiting on
// (SignInState.CallbackPort), and a relay on another one steps aside.
const codexCallbackAddr = "127.0.0.1:1455"

// codexRelayWait bounds a relay: Magpie's sign-in gives up after ten minutes,
// and no browser can end one later.
const codexRelayWait = 11 * time.Minute

// startBuiltinLogin starts a built-in subscription's browser sign-in. A ChatGPT
// (Codex) sign-in's browser ends on Phi's page: the engine holds its callback
// port first, and what the browser sends there is finished through Magpie's own
// sign-in. Another built-in signs in as Magpie runs it.
func startBuiltinLogin(id, site string) (any, error) {
	if id != "codex" {
		return provider.StartSignInAt(id, site)
	}
	relay, err := startCodexRelay()
	if err != nil {
		// The port is another program's, or a `codex login` of the user's own:
		// Magpie's flow waits for the address its page ends on, pasted back.
		return provider.StartSignInAt(id, site)
	}
	st, err := provider.StartSignInAt(id, site)
	if err != nil {
		relay.close()
		return nil, err
	}
	if !relay.attach(st) {
		relay.close()
		return st, nil
	}
	return relayedState(st), nil
}

// codexRelay is the port held for one sign-in, and the page it answers with.
type codexRelay struct {
	mu      sync.Mutex
	session string
	srv     *http.Server
	ln      net.Listener
	closed  bool
}

// codexRelayNow is the relay a sign-in may still come back to; only one at a
// time, as there is one Codex callback port.
var codexRelayNow struct {
	sync.Mutex
	r *codexRelay
}

// startCodexRelay takes the callback port. Its error means the port belongs to
// something else — a `codex login` of the user's own, or another program — and
// the sign-in goes on as Magpie runs it, finished from the address pasted back.
func startCodexRelay() (*codexRelay, error) {
	codexRelayNow.Lock()
	old := codexRelayNow.r
	codexRelayNow.r = nil
	codexRelayNow.Unlock()
	if old != nil {
		old.cancel()
	}
	ln, err := net.Listen("tcp", codexCallbackAddr)
	if err != nil {
		return nil, err
	}
	r := &codexRelay{ln: ln, srv: &http.Server{ReadHeaderTimeout: 10 * time.Second}}
	mux := http.NewServeMux()
	mux.HandleFunc("/", r.serve)
	r.srv.Handler = mux
	codexRelayNow.Lock()
	codexRelayNow.r = r
	codexRelayNow.Unlock()
	go func() { _ = r.srv.Serve(ln) }()
	return r, nil
}

// attach ties the relay to a sign-in that is waiting on this port, and says
// whether it is: a sign-in that took its own listener serves its own page and
// is left alone. A sign-in still installing the Codex CLI isn't waiting yet; it
// is tied now, and checked when it starts (watch).
func (r *codexRelay) attach(st provider.SignInState) bool {
	if st.ID == "" {
		return false
	}
	if st.State == "installing" {
		r.tie(st.ID)
		go r.watch(st.ID)
		return true
	}
	if st.CallbackBlocked == "" {
		return false
	}
	if port, ok := relayPort(r); !ok || port != st.CallbackPort {
		return false
	}
	r.tie(st.ID)
	go r.watch(st.ID)
	return true
}

func (r *codexRelay) tie(session string) {
	r.mu.Lock()
	r.session = session
	r.mu.Unlock()
}

func (r *codexRelay) serve(w http.ResponseWriter, req *http.Request) {
	switch req.URL.Path {
	case "/favicon.svg", "/favicon.ico":
		w.Header().Set("Content-Type", "image/svg+xml")
		w.Header().Set("Cache-Control", "max-age=86400")
		_, _ = io.WriteString(w, phiLogo)
		return
	case "/cancel":
		// `codex login` asks the port to free itself the way Magpie does. This
		// listener isn't that sign-in's; Phi cancels its own from the dialog.
		w.WriteHeader(http.StatusNoContent)
		return
	case "/callback", "/auth/callback", "/oauth2callback", "/oauth-callback":
	default:
		http.NotFound(w, req)
		return
	}
	copy := pageTextFor(req.Header.Get("Accept-Language"))
	session := r.current()
	if session == "" {
		signInPage(w, false, copy, copy.over, copy.overBody)
		return
	}
	port, _ := relayPort(r)
	raw := "http://localhost:" + strconv.Itoa(port) + req.URL.RequestURI()
	err := provider.SubmitSignInCallback(session, raw)
	st, known := provider.SignInStatus(session)
	switch {
	case known && st.State == "done":
		r.closeSoon()
		signInPage(w, true, copy, copy.signedIn, fmt.Sprintf(copy.added, st.User))
	case known && st.State == "waiting":
		// not this sign-in's: someone else's page, or a stale tab
		signInPage(w, false, copy, copy.foreign, copy.foreignBody)
	case known && st.State == "failed":
		why := st.Error
		if why == "" && err != nil {
			why = err.Error()
		}
		r.closeSoon()
		signInPage(w, false, copy, copy.failed, why+"\n\n"+copy.retry)
	default:
		r.closeSoon()
		signInPage(w, false, copy, copy.over, copy.overBody)
	}
}

// watch releases the port once the sign-in is over, however it ended: a
// browser that never came back would otherwise keep `codex login` from its port
// until the engine stopped. A sign-in that starts on another port — a Magpie
// whose Codex callback moved — leaves the port to it, page and all.
func (r *codexRelay) watch(session string) {
	deadline := time.Now().Add(codexRelayWait)
	port, _ := relayPort(r)
	checked := false
	for time.Now().Before(deadline) {
		st, ok := provider.SignInStatus(session)
		if !ok {
			r.closeSoon()
			return
		}
		switch st.State {
		case "installing":
		case "waiting":
			if !checked {
				checked = true
				if st.CallbackBlocked == "" || st.CallbackPort != port {
					r.release()
					return
				}
			}
		default:
			r.closeSoon()
			return
		}
		time.Sleep(time.Second)
	}
	r.close()
}

func (r *codexRelay) current() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return ""
	}
	return r.session
}

// cancel stops the sign-in this relay belongs to, if any, and frees the port.
func (r *codexRelay) cancel() {
	if session := r.current(); session != "" {
		provider.CancelSignIn(session)
	}
	r.close()
}

// closeSoon frees the port after the browser has had its page.
func (r *codexRelay) closeSoon() {
	go func() {
		time.Sleep(time.Second)
		r.close()
	}()
}

// release frees the port for a sign-in that isn't waiting on it.
func (r *codexRelay) release() {
	r.mu.Lock()
	r.session = ""
	r.mu.Unlock()
	r.close()
}

func (r *codexRelay) close() {
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return
	}
	r.closed = true
	srv := r.srv
	r.mu.Unlock()
	if srv != nil {
		_ = srv.Close()
	}
	codexRelayNow.Lock()
	if codexRelayNow.r == r {
		codexRelayNow.r = nil
	}
	codexRelayNow.Unlock()
}

// closeCodexRelay frees the port when its sign-in is canceled from Phi.
func closeCodexRelay(session string) {
	codexRelayNow.Lock()
	r := codexRelayNow.r
	codexRelayNow.Unlock()
	if r != nil && r.current() == session {
		r.close()
	}
}

// relayPort is the port the relay took.
func relayPort(r *codexRelay) (int, bool) {
	addr, ok := r.ln.Addr().(*net.TCPAddr)
	if !ok {
		return 0, false
	}
	return addr.Port, true
}

// relayedState is a sign-in whose browser ends on Phi's page: the port is this
// machine's, so nothing is pasted back, and the port being taken is expected
// rather than a blocked sign-in.
func relayedState(st provider.SignInState) provider.SignInState {
	st.PasteCallback = false
	st.CallbackBlocked = ""
	st.CallbackPort = 0
	return st
}

// relayStatus is a sign-in's status as Phi's dialog shows it: one whose browser
// ends on Phi's page isn't a sign-in whose callback port is blocked.
func relayStatus(st provider.SignInState) provider.SignInState {
	codexRelayNow.Lock()
	r := codexRelayNow.r
	codexRelayNow.Unlock()
	if r == nil || r.current() != st.ID {
		return st
	}
	return relayedState(st)
}
