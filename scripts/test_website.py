#!/usr/bin/env python3
"""Dependency-free checks for the three static PHI website locales."""

from html.parser import HTMLParser
import json
import sys
import unittest
from urllib.parse import urlsplit

# Keep the dependency-free website checks from leaving cache files in scripts/.
sys.dont_write_bytecode = True

from build_website import CJK, LOCALES, ORIGIN, WEBSITE, load_catalog, render

VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}


class Page(HTMLParser):
    def __init__(self, source):
        super().__init__(convert_charrefs=True)
        self.elements = []
        self.text = []
        self.stack = []
        self.language_links = []
        self.language_options = []
        self.in_languages = False
        self.schema_text = ""
        self.in_script = False
        self.feed(source)
        self.close()
        if self.stack:
            raise AssertionError(f"Unclosed tags: {self.stack}")

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        self.elements.append((tag, a))
        if tag == "nav" and a.get("class") == "language-switch":
            self.in_languages = True
        if self.in_languages and tag == "a":
            self.language_links.append(a)
        if self.in_languages and tag == "option":
            self.language_options.append(a)
        if tag == "script":
            if a.get("type") != "application/ld+json":
                raise AssertionError("Unexpected executable script")
            self.in_script = True
        if tag not in VOID:
            self.stack.append(tag)

    def handle_endtag(self, tag):
        if not self.stack or self.stack.pop() != tag:
            raise AssertionError(f"Mismatched closing tag: {tag}")
        if tag == "nav":
            self.in_languages = False
        if tag == "script":
            self.in_script = False

    def handle_data(self, data):
        if self.in_script:
            self.schema_text += data
        elif not self.in_languages:
            self.text.append(data)


class WebsiteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = (WEBSITE / "index.html").read_text(encoding="utf-8")
        cls.catalog = load_catalog()
        cls.pages = {
            "zh-CN": (WEBSITE / "index.html", Page(cls.source)),
            **{locale: (WEBSITE / locale / "index.html", Page((WEBSITE / locale / "index.html").read_text(encoding="utf-8"))) for locale in LOCALES},
        }

    def test_generated_pages_are_current(self):
        for locale in LOCALES:
            with self.subTest(locale=locale):
                self.assertEqual(self.pages[locale][0].read_text(encoding="utf-8"), render(locale, self.source, self.catalog))

    def test_missing_or_outdated_translations_fail(self):
        for locale in LOCALES:
            with self.subTest(locale=locale):
                missing = dict(self.catalog)
                missing.pop("下载 PHI")
                with self.assertRaisesRegex(ValueError, "Missing translations"):
                    render(locale, self.source, missing)
                with self.assertRaisesRegex(ValueError, "Outdated translation sources"):
                    render(locale, self.source, {**self.catalog, "过期文案": {"en": "Old copy", "ja": "古い文言"}})

    def test_structure_assets_anchors_and_accessibility(self):
        expected_structure = [tag for tag, _ in self.pages["zh-CN"][1].elements]
        for locale, (path, page) in self.pages.items():
            with self.subTest(locale=locale):
                self.assertEqual([tag for tag, _ in page.elements], expected_structure)
                ids = [a["id"] for _, a in page.elements if "id" in a]
                self.assertEqual(len(ids), len(set(ids)))
                self.assertEqual(sum(tag == "h1" for tag, _ in page.elements), 1)
                self.assertEqual(sum(tag == "summary" for tag, _ in page.elements), 5)
                for tag, a in page.elements:
                    if tag == "img":
                        self.assertIn("alt", a)
                    for ref in a.get("aria-labelledby", "").split():
                        self.assertIn(ref, ids)
                    for key in ("href", "src"):
                        url = a.get(key, "")
                        if url.startswith("#"):
                            self.assertIn(url[1:], ids)
                        elif url and not urlsplit(url).scheme:
                            target = path.parent / urlsplit(url).path
                            self.assertTrue(target.exists(), str(target))

    def test_language_switch_all_nine_routes(self):
        targets = {locale: path.resolve() for locale, (path, _) in self.pages.items()}
        for locale, (path, page) in self.pages.items():
            with self.subTest(locale=locale):
                selects = [a for tag, a in page.elements if tag == "select"]
                self.assertEqual(len(selects), 1)
                self.assertTrue(selects[0].get("aria-label"))
                self.assertIn("onchange", selects[0])
                self.assertEqual(len(page.language_options), 3)
                selected = [o for o in page.language_options if "selected" in o]
                self.assertEqual([o["lang"] for o in selected], [locale])
                for option in page.language_options:
                    self.assertEqual((path.parent / option["value"] / "index.html").resolve(), targets[option["lang"]])
                self.assertEqual(len(page.language_links), 3)
                self.assertEqual([a["hreflang"] for a in page.language_links if a.get("aria-current") == "page"], [locale])
                for a in page.language_links:
                    self.assertEqual(a["lang"], a["hreflang"])
                    self.assertEqual((path.parent / a["href"] / "index.html").resolve(), targets[a["hreflang"]])

    def test_localized_metadata(self):
        alternatives = {"zh-CN": ORIGIN + "/", "en": ORIGIN + "/en/", "ja": ORIGIN + "/ja/", "x-default": ORIGIN + "/"}
        titles = []
        for locale, (_, page) in self.pages.items():
            with self.subTest(locale=locale):
                a_by_tag = lambda tag: [a for t, a in page.elements if t == tag]
                self.assertEqual(a_by_tag("html")[0]["lang"], locale)
                links = a_by_tag("link")
                self.assertEqual({a["hreflang"]: a["href"] for a in links if a.get("rel") == "alternate"}, alternatives)
                self.assertEqual([a["href"] for a in links if a.get("rel") == "canonical"], [alternatives[locale]])
                meta = {a.get("property", a.get("name")): a.get("content") for a in a_by_tag("meta")}
                self.assertEqual(meta["og:url"], alternatives[locale])
                self.assertEqual(meta["og:locale"], {"zh-CN": "zh_CN", **LOCALES}[locale])
                self.assertTrue(meta["description"])
                titles.append(meta["og:title"])
                schema = json.loads(page.schema_text)
                self.assertEqual(schema["name"], "PHI")
                self.assertEqual(schema["inLanguage"], locale)
                self.assertEqual(schema["url"], alternatives[locale])
        self.assertEqual(len(set(titles)), 3)

    def test_english_has_no_chinese_fallback(self):
        page = self.pages["en"][1]
        self.assertIsNone(CJK.search("".join(page.text)))
        for _, a in page.elements:
            for key in ("alt", "aria-label", "content"):
                self.assertIsNone(CJK.search(a.get(key, "")), a.get(key))
        self.assertIsNone(CJK.search(page.schema_text))

    def test_external_destinations_are_preserved(self):
        def destinations(page):
            return [a["href"] for tag, a in page.elements if tag == "a" and a.get("href", "").startswith("https://")]
        source = destinations(self.pages["zh-CN"][1])
        for locale in LOCALES:
            self.assertEqual(destinations(self.pages[locale][1]), source)


if __name__ == "__main__":
    unittest.main()
