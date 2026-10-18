#!/usr/bin/env python3
"""Render static English/Japanese pages from the Chinese homepage and catalog.

No dependencies. Use --check in CI or --stdout en/ja to inspect a rendered page.
"""

import argparse
import html
import json
from html.parser import HTMLParser
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
WEBSITE = ROOT / "website"
CATALOG = ROOT / "scripts" / "website-translations.json"
ORIGIN = "https://phi.semibot.ai"
LOCALES = {"en": "en_US", "ja": "ja_JP"}
CJK = re.compile(r"[\u3400-\u9fff]")


def normalize(text):
    return " ".join(text.split())


def load_catalog():
    rows = json.loads(CATALOG.read_text(encoding="utf-8"))
    translations = {}
    for row in rows:
        if len(row) != 3 or any(not isinstance(x, str) or not x.strip() for x in row):
            raise ValueError("Each translation needs nonempty source, English and Japanese text")
        source, en, ja = row
        if source != normalize(source) or source in translations:
            raise ValueError(f"Duplicate or unnormalized source: {source}")
        translations[source] = {"en": en, "ja": ja}
    return translations


class LocalizedPage(HTMLParser):
    def __init__(self, locale, catalog):
        super().__init__(convert_charrefs=True)
        self.locale = locale
        self.catalog = catalog
        self.output = []
        self.in_languages = False
        self.in_schema = False
        self.schema = []
        self.used = set()
        self.missing = set()

    def translate(self, value):
        source = normalize(value)
        if not CJK.search(source):
            return value
        if source not in self.catalog:
            self.missing.add(source)
            return value
        self.used.add(source)
        translated = self.catalog[source][self.locale]
        leading = value[: len(value) - len(value.lstrip())]
        trailing = value[len(value.rstrip()):]
        if self.locale == "en" and translated.startswith((",", ".")):
            leading = ""
        return leading + translated + trailing

    def handle_decl(self, decl):
        self.output.append(f"<!{decl}>")

    def handle_comment(self, data):
        self.output.append(f"<!--{data}-->")

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        language_nav = tag == "nav" and attributes.get("class") == "language-switch"
        for key in ("alt", "aria-label", "content"):
            if key in attributes:
                attributes[key] = self.translate(attributes[key])
        if tag == "html":
            attributes["lang"] = self.locale
        if tag == "link" and attributes.get("rel") == "canonical":
            attributes["href"] = f"{ORIGIN}/{self.locale}/"
        if tag == "meta":
            prop = attributes.get("property")
            if prop == "og:url":
                attributes["content"] = f"{ORIGIN}/{self.locale}/"
            elif prop == "og:locale":
                attributes["content"] = LOCALES[self.locale]
            elif prop == "og:locale:alternate" and attributes.get("content") == LOCALES[self.locale]:
                attributes["content"] = "zh_CN"
        if tag == "a" and self.in_languages:
            target = attributes["hreflang"]
            attributes["href"] = "../" if target == "zh-CN" else f"../{target}/"
            attributes.pop("aria-current", None)
            if target == self.locale:
                attributes["aria-current"] = "page"
        if tag == "option" and self.in_languages:
            target = attributes.get("lang")
            if target:
                attributes["value"] = "../" if target == "zh-CN" else f"../{target}/"
            attributes.pop("selected", None)
            if target == self.locale:
                attributes["selected"] = None
        for key in ("src", "href"):
            if attributes.get(key, "").startswith(("assets/", "css/")):
                attributes[key] = "../" + attributes[key]
        if language_nav:
            self.in_languages = True
        if tag == "script":
            if attributes.get("type") != "application/ld+json":
                raise ValueError("Only JSON-LD scripts are supported in the static homepage")
            self.in_schema = True
            self.schema = []
        rendered = "".join(
            f' {key}="{html.escape(value, quote=True)}"' if value is not None else f" {key}"
            for key, value in attributes.items()
        )
        self.output.append(f"<{tag}{rendered}>")

    def handle_endtag(self, tag):
        if tag == "script" and self.in_schema:
            schema = json.loads("".join(self.schema))
            schema["description"] = self.translate(schema["description"])
            schema["url"] = f"{ORIGIN}/{self.locale}/"
            schema["inLanguage"] = self.locale
            self.output.append("\n  " + json.dumps(schema, ensure_ascii=False) + "\n  ")
            self.in_schema = False
        self.output.append(f"</{tag}>")
        if tag == "nav":
            self.in_languages = False

    def handle_data(self, data):
        if self.in_schema:
            self.schema.append(data)
        else:
            text = data if self.in_languages else self.translate(data)
            self.output.append(html.escape(text, quote=False))


def render(locale, source, catalog):
    page = LocalizedPage(locale, catalog)
    page.feed(source)
    page.close()
    if page.missing:
        raise ValueError("Missing translations:\n" + "\n".join(sorted(page.missing)))
    unused = catalog.keys() - page.used
    if unused:
        raise ValueError("Outdated translation sources:\n" + "\n".join(sorted(unused)))
    return "".join(page.output)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--check", action="store_true", help="Fail if generated pages are out of date")
    group.add_argument("--stdout", choices=LOCALES, help="Print one page without writing files")
    args = parser.parse_args()
    source = (WEBSITE / "index.html").read_text(encoding="utf-8")
    catalog = load_catalog()
    pages = {locale: render(locale, source, catalog) for locale in LOCALES}
    if args.stdout:
        print(pages[args.stdout], end="")
        return
    for locale, content in pages.items():
        target = WEBSITE / locale / "index.html"
        if args.check:
            if not target.exists() or target.read_text(encoding="utf-8") != content:
                raise SystemExit(f"Outdated page: {target.relative_to(ROOT)}")
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content, encoding="utf-8")
    print(f"{'Checked' if args.check else 'Generated'} en/ja pages; {len(catalog)} translations per locale")


if __name__ == "__main__":
    main()
