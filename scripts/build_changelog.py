#!/usr/bin/env python3
"""Render the static changelog pages for every locale.

Sources the entries from scripts/changelog.json and writes:

    website/changelog/index.html            website/changelog/<version>/index.html
    website/en/changelog/...                website/ja/changelog/...

The in-app "what's new" popup links to https://phi.semibot.ai/<lang>/changelog/<version>,
so a page must exist for every published version. Use --check in CI.
"""

import argparse
import html
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WEBSITE = ROOT / "website"
DATA = ROOT / "scripts" / "changelog.json"
ORIGIN = "https://phi.semibot.ai"
STYLE_VERSION = "flow-5"

LOCALES = {
    "zh": {
        "prefix": "",
        "html_lang": "zh-CN",
        "og_locale": "zh_CN",
        "label": "中文",
        "title": "更新日志 — PHI",
        "description": "PHI 每个版本改了什么：新功能、改进与修复。",
        "heading": "更新日志",
        "intro": "每个版本改了什么，都记在这里。应用内更新弹窗的「详情」也会指向这些页面。",
        "date_prefix": "",
        "all_versions": "全部版本",
        "more_items": "查看完整条目",
        "back_to_site": "返回首页",
        "skip": "跳到正文",
        "nav_label": "切换语言",
        "home_label": "PHI 首页",
        "footer_note": "完整的逐条变更也记录在仓库的 CHANGELOG 里。",
        "footer_link": "查看源码变更记录",
    },
    "en": {
        "prefix": "en/",
        "html_lang": "en",
        "og_locale": "en_US",
        "label": "English",
        "title": "Changelog — PHI",
        "description": "What changed in each PHI release: new features, improvements and fixes.",
        "heading": "Changelog",
        "intro": "Every release, and what changed in it. The in-app update note links here too.",
        "date_prefix": "",
        "all_versions": "All versions",
        "more_items": "See all items",
        "back_to_site": "Back to the site",
        "skip": "Skip to content",
        "nav_label": "Choose language",
        "home_label": "PHI home",
        "footer_note": "The itemised history also lives in the repository CHANGELOG.",
        "footer_link": "Read the source changelog",
    },
    "ja": {
        "prefix": "ja/",
        "html_lang": "ja",
        "og_locale": "ja_JP",
        "label": "日本語",
        "title": "変更履歴 — PHI",
        "description": "PHI の各リリースでの変更点：新機能、改善、修正。",
        "heading": "変更履歴",
        "intro": "各バージョンで何が変わったかをまとめています。アプリ内の更新通知もここへリンクします。",
        "date_prefix": "",
        "all_versions": "すべてのバージョン",
        "more_items": "すべての項目を見る",
        "back_to_site": "サイトに戻る",
        "skip": "本文へスキップ",
        "nav_label": "言語を選択",
        "home_label": "PHI ホーム",
        "footer_note": "項目ごとの履歴はリポジトリの CHANGELOG にもあります。",
        "footer_link": "ソースの変更履歴を読む",
    },
}

LANGUAGE_ORDER = ("zh", "en", "ja")


def load_entries():
    rows = json.loads(DATA.read_text(encoding="utf-8"))
    seen = set()
    for row in rows:
        version = row["version"]
        if version in seen:
            raise ValueError(f"Duplicate version in changelog: {version}")
        seen.add(version)
        missing = [locale for locale in LOCALES if not row["items"].get(locale)]
        if missing:
            raise ValueError(f"{version} is missing {', '.join(missing)}")
        for locale in LOCALES:
            if len(row["items"][locale]) != len(row["items"]["zh"]):
                raise ValueError(f"{version}/{locale} has a different item count")
    return rows


def page_path(locale, version=None):
    base = WEBSITE / (LOCALES[locale]["prefix"] or "") / "changelog"
    return base / (version + "/index.html" if version else "index.html")


def url(locale, version=None):
    base = f"{ORIGIN}/{LOCALES[locale]['prefix']}changelog/"
    return base + (f"{version}/" if version else "")


def escape(value):
    return html.escape(value, quote=True)


def render_switcher(locale, version):
    options = []
    links = []
    for key in LANGUAGE_ORDER:
        cfg = LOCALES[key]
        current = ' aria-current="page"' if key == locale else ""
        selected = " selected" if key == locale else ""
        options.append(
            f'          <option value="{url(key, version)}" lang="{cfg["html_lang"]}"{selected}>{cfg["label"]}</option>'
        )
        links.append(
            f'          <a href="{url(key, version)}" lang="{cfg["html_lang"]}" hreflang="{cfg["html_lang"]}"{current}>{cfg["label"]}</a>'
        )
    return (
        f'      <nav class="language-switch" aria-label="{LOCALES[locale]["nav_label"]}">\n'
        '        <select aria-label="' + LOCALES[locale]["nav_label"] + '" onchange="if (this.value) window.location.href = this.value;">\n'
        + "\n".join(options)
        + "\n        </select>\n        <noscript>\n"
        + "\n".join(links)
        + "\n        </noscript>\n      </nav>"
    )


def shell(locale, title, description, canonical, version, body):
    cfg = LOCALES[locale]
    alternates = "\n".join(
        f'  <link rel="alternate" hreflang="{LOCALES[key]["html_lang"]}" href="{url(key, version)}">'
        for key in LANGUAGE_ORDER
    )
    return f"""<!DOCTYPE html>
<html lang="{cfg["html_lang"]}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="light">
  <meta name="theme-color" content="#fffdfa">
  <title>{escape(title)}</title>
  <meta name="description" content="{escape(description)}">
  <link rel="canonical" href="{canonical}">
{alternates}
  <link rel="alternate" hreflang="x-default" href="{url("zh", version)}">
  <meta property="og:title" content="{escape(title)}">
  <meta property="og:description" content="{escape(description)}">
  <meta property="og:type" content="website">
  <meta property="og:url" content="{canonical}">
  <meta property="og:locale" content="{cfg["og_locale"]}">
  <link rel="icon" type="image/svg+xml" href="/assets/phi-app.svg">
  <link rel="stylesheet" href="/css/style.css?v={STYLE_VERSION}">
</head>
<body>
  <a class="skip-link" href="#main">{cfg["skip"]}</a>

  <header class="site-header">
    <div class="wrap header-inner">
      <a class="brand" href="/{cfg["prefix"]}" aria-label="{cfg["home_label"]}"><img src="/assets/phi-app.svg" width="34" height="34" alt=""><span>PHI</span></a>
{render_switcher(locale, version)}
    </div>
  </header>

  <main id="main" class="changelog">
{body}
  </main>

  <footer class="wrap">
    <div class="footer-main">
      <a class="brand" href="/{cfg["prefix"]}" aria-label="{cfg["home_label"]}"><img src="/assets/phi-app.svg" width="26" height="26" alt=""><span>PHI</span></a>
      <div class="footer-links"><a href="https://github.com/GoatGit/phi">{cfg["footer_link"]}</a><a href="https://github.com/GoatGit/phi/releases/latest">Releases</a></div>
    </div>
    <p class="credits">{cfg["footer_note"]}</p>
  </footer>
</body>
</html>
"""


def render_index(locale, entries):
    cfg = LOCALES[locale]
    cards = []
    for entry in entries:
        items = "".join(f"\n            <li>{html.escape(text)}</li>" for text in entry["items"][locale][:3])
        cards.append(
            f"""        <li class="changelog-entry">
          <h2><a href="{entry["version"]}/">{entry["version"]}</a><time datetime="{entry["date"]}">{entry["date"]}</time></h2>
          <ul>{items}
          </ul>
          <p class="changelog-more"><a href="{entry["version"]}/">{cfg["more_items"]} →</a></p>
        </li>"""
        )
    body = f"""    <section class="chapter wrap" aria-labelledby="changelog-title">
      <div class="chapter-intro">
        <h1 id="changelog-title">{cfg["heading"]}</h1>
        <div class="chapter-copy">
          <p>{cfg["intro"]}</p>
        </div>
      </div>
      <ol class="changelog-list">
{chr(10).join(cards)}
      </ol>
      <p class="changelog-back"><a href="/{cfg["prefix"]}">← {cfg["back_to_site"]}</a></p>
    </section>"""
    return shell(
        locale,
        cfg["title"],
        cfg["description"],
        url(locale),
        None,
        body,
    )


def render_version(locale, entry, entries):
    cfg = LOCALES[locale]
    items = "".join(f"\n          <li>{html.escape(text)}</li>" for text in entry["items"][locale])
    others = [other for other in entries if other["version"] != entry["version"]]
    previous = ""
    if others:
        newer_first = sorted(others, key=lambda item: item["date"], reverse=True)
        previous = (
            f'\n      <p class="changelog-back"><a href="../">← {cfg["all_versions"]}</a>'
            f' · <a href="../{newer_first[0]["version"]}/">{newer_first[0]["version"]} →</a></p>'
        )
    body = f"""    <section class="chapter wrap" aria-labelledby="version-title">
      <div class="chapter-intro">
        <p class="changelog-kicker">{cfg["heading"]}</p>
        <h1 id="version-title">{entry["version"]}</h1>
        <time class="changelog-date" datetime="{entry["date"]}">{entry["date"]}</time>
      </div>
      <ul class="changelog-items">
{items}
      </ul>{previous}
    </section>"""
    return shell(
        locale,
        f'{entry["version"]} — {cfg["title"]}',
        cfg["description"],
        url(locale, entry["version"]),
        entry["version"],
        body,
    )


def build():
    entries = load_entries()
    pages = {}
    for locale in LOCALES:
        pages[page_path(locale)] = render_index(locale, entries)
        for entry in entries:
            pages[page_path(locale, entry["version"])] = render_version(locale, entry, entries)
    return pages


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Fail if the generated pages are out of date")
    args = parser.parse_args()
    pages = build()
    for path, content in pages.items():
        if args.check:
            if not path.exists() or path.read_text(encoding="utf-8") != content:
                raise SystemExit(f"Outdated page: {path.relative_to(ROOT)}")
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8")
    print(f"{'Checked' if args.check else 'Generated'} {len(pages)} changelog pages")


if __name__ == "__main__":
    main()
