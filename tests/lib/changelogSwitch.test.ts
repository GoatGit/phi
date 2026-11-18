import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

const origin = "https://phi.semibot.ai";
const locales = ["", "en/", "ja/"];
const entries = JSON.parse(
  fs.readFileSync(path.resolve("scripts/changelog.json"), "utf8"),
) as { version: string }[];
const versions = ["", ...entries.map(({ version }) => `${version}/`)];
const pages = locales.flatMap((locale) =>
  versions.map((version) => ({ locale, version })),
);

function switcher(locale: string, version: string) {
  const html = fs.readFileSync(
    path.resolve("website", locale, "changelog", version, "index.html"),
    "utf8",
  );
  const doc = new DOMParser().parseFromString(html, "text/html");
  const select = doc.querySelector("select")!;
  const handler = select.getAttribute("onchange")!;
  const location = { href: "unchanged", assign: vi.fn() };
  const run = (value: string) =>
    vm.runInNewContext(
      `(function () { ${handler} }).call(control)`,
      { control: { value }, window: { location } },
      { timeout: 1000 },
    );
  return { select, location, run };
}

describe("更新日志语言切换", () => {
  it.each(pages)(
    "$locale/$version 仍能到同一版本的三种语言",
    ({ locale, version }) => {
      const { select, location, run } = switcher(locale, version);
      const targets = locales.map(
        (prefix) => `${origin}/${prefix}changelog/${version}`,
      );
      expect(Array.from(select.options, (option) => option.value)).toEqual(
        targets,
      );
      for (const target of targets) {
        run(target);
        expect(location.assign).toHaveBeenLastCalledWith(target);
      }
      expect(location.assign).toHaveBeenCalledTimes(3);
    },
  );

  it.each(pages)(
    "$locale/$version 拒绝篡改的 DOM 值",
    ({ locale, version }) => {
      const { location, run } = switcher(locale, version);
      for (const value of [
        "",
        "javascript:alert(1)",
        "data:text/html,<h1>unsafe</h1>",
        "https://example.invalid/",
        "//example.invalid/",
        origin + "/other/",
        origin + "/changelog/?redirect=elsewhere",
      ]) {
        run(value);
      }
      expect(location.assign).not.toHaveBeenCalled();
      expect(location.href).toBe("unchanged");
    },
  );
});
