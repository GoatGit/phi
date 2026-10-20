package main

// The page a subscription sign-in ends on. Magpie serves its own: its name in
// the title and the footer, its mark beside it, and a sentence that says the
// account "is added to magpie". Phi's sign-in ends on this page instead, so a
// user who signed in from Phi stays in Phi — the finished sign-in and the
// failed one alike.

import (
	_ "embed"
	"fmt"
	"html"
	"io"
	"net/http"
	"strings"
)

// phiLogo is Phi's mark, the same file the app shows
// (src/assets/icons/logo.svg), kept beside the engine so the page it serves
// needs no files and no network.
//
//go:embed phi-logo.svg
var phiLogo string

// pageText is what the page says, in the app's languages. The browser's
// Accept-Language picks one: a sign-in opened from a Phi whose interface is
// Japanese usually comes from a browser set to Japanese too.
type pageText struct {
	lang        string
	signedIn    string
	added       string // %s is the account
	failed      string
	retry       string
	over        string
	overBody    string
	foreign     string
	foreignBody string
}

var pageTexts = map[string]pageText{
	"zh": {
		lang: "zh-CN", signedIn: "登录成功",
		added:  "%s 已添加到 PHI。可以关闭此标签页，返回 PHI 继续。",
		failed: "登录未完成", retry: "返回 PHI 重试，或重新发起登录。",
		over: "本次登录已结束", overBody: "请在 PHI 中重新发起登录。",
		foreign: "此链接不属于本次登录", foreignBody: "请回到发起登录的 PHI 窗口，或重新发起登录。",
	},
	"zh-TW": {
		lang: "zh-Hant", signedIn: "登入成功",
		added:  "%s 已新增至 PHI。可以關閉此分頁，回到 PHI 繼續。",
		failed: "登入未完成", retry: "回到 PHI 重試，或重新發起登入。",
		over: "本次登入已結束", overBody: "請在 PHI 中重新發起登入。",
		foreign: "此連結不屬於本次登入", foreignBody: "請回到發起登入的 PHI 視窗，或重新發起登入。",
	},
	"ja": {
		lang: "ja", signedIn: "ログインしました",
		added:  "%s を PHI に追加しました。このタブを閉じて PHI に戻れます。",
		failed: "ログインが完了しませんでした", retry: "PHI に戻って再試行するか、ログインをやり直してください。",
		over: "このログインは終了しています", overBody: "PHI でもう一度ログインしてください。",
		foreign: "このリンクは今のログインのものではありません", foreignBody: "ログインを始めた PHI の画面に戻るか、ログインをやり直してください。",
	},
	"en": {
		lang: "en", signedIn: "You're signed in",
		added:  "%s is added to PHI. You can close this tab and return to PHI.",
		failed: "Sign-in didn't finish", retry: "Return to PHI to retry, or start the sign-in again.",
		over: "This sign-in is over", overBody: "Start it again from PHI.",
		foreign: "This link isn't from PHI's sign-in", foreignBody: "Go back to the PHI window that started it, or start the sign-in again.",
	},
}

// pageTextFor is the words for a browser's Accept-Language. A browser with
// none, or with a language the app doesn't speak, gets English.
func pageTextFor(accept string) pageText {
	for _, part := range strings.Split(accept, ",") {
		tag := strings.ToLower(strings.TrimSpace(strings.SplitN(part, ";", 2)[0]))
		switch {
		case strings.HasPrefix(tag, "zh-hant"), strings.HasPrefix(tag, "zh-tw"),
			strings.HasPrefix(tag, "zh-hk"), strings.HasPrefix(tag, "zh-mo"):
			return pageTexts["zh-TW"]
		case strings.HasPrefix(tag, "zh"):
			return pageTexts["zh"]
		case strings.HasPrefix(tag, "ja"):
			return pageTexts["ja"]
		case strings.HasPrefix(tag, "en"):
			return pageTexts["en"]
		}
	}
	return pageTexts["en"]
}

// signInPage writes the page the browser ends on. ok is a sign-in that
// finished; one that didn't is answered with 400, as Magpie's page is.
func signInPage(w http.ResponseWriter, ok bool, copy pageText, title, body string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	if !ok {
		w.WriteHeader(http.StatusBadRequest)
	}
	mark, tint := `<path d="M5 12.5l4.5 4.5L19 7.5"/>`, "ok"
	if !ok {
		mark, tint = `<path d="M7 7l10 10M17 7L7 17"/>`, "bad"
	}
	// The logo is Phi's own file: no escaping needed, and none done, so its
	// gradients stay as they are.
	_, _ = io.WriteString(w, fmt.Sprintf(`<!doctype html><html lang="%[1]s"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>PHI · %[2]s</title><link rel="icon" type="image/svg+xml" href="/favicon.svg"><style>
:root{--bg:#fafafa;--fg:#111;--muted:#6b6b6b;--line:#e4e4e4;--card:#fff;--ok:#2f7f7a;--bad:#c0392b}
@media (prefers-color-scheme:dark){:root{--bg:#0e0e0e;--fg:#f2f2f2;--muted:#9a9a9a;--line:#262626;--card:#161616;--ok:#7fd1cb;--bad:#f08a7e}}
*{box-sizing:border-box}html,body{height:100%%;margin:0}
body{background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;display:grid;place-items:center;padding:16px}
.card{width:100%%;max-width:380px;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:32px 28px;text-align:center;animation:in .4s cubic-bezier(.2,.8,.2,1)}
.mark{width:44px;height:44px;margin:0 auto 18px;border-radius:50%%;display:grid;place-items:center;background:var(--fg);color:var(--bg)}
.mark.ok{background:var(--ok)}.mark.bad{background:var(--bad)}
.mark svg{width:22px;height:22px;fill:none;stroke:currentColor;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round}
h1{font-size:18px;font-weight:620;margin:0 0 6px;letter-spacing:-.01em}
p{margin:0;color:var(--muted);font-size:14px;overflow-wrap:anywhere;white-space:pre-wrap}
.by{margin-top:24px;display:flex;align-items:center;justify-content:center;gap:7px;font-size:12.5px;font-weight:560;color:var(--muted);letter-spacing:.01em}
.by svg{width:18px;height:18px}
@keyframes in{from{opacity:0;transform:translateY(6px) scale(.98)}}
</style></head><body><main class="card"><div class="mark %[5]s"><svg viewBox="0 0 24 24">%[3]s</svg></div>
<h1>%[2]s</h1><p>%[4]s</p><div class="by">%[6]sPHI</div></main></body></html>`,
		copy.lang, html.EscapeString(title), mark, html.EscapeString(body), tint, phiLogo))
}
