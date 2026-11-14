import { beforeEach, describe, expect, it } from "vitest";
import {
  MAX_PINNED_PLUGINS,
  PINNED_PLUGINS_STORAGE_KEY,
  readPinnedPlugins,
  storePinnedPlugins,
  togglePinnedPlugin,
} from "@/lib/pluginPins";

describe("pluginPins", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("reads an empty list when nothing is stored", () => {
    expect(readPinnedPlugins()).toEqual([]);
  });

  it("roundtrips pinned plugin ids", () => {
    storePinnedPlugins(["report-card", "session-baton"]);
    expect(readPinnedPlugins()).toEqual(["report-card", "session-baton"]);
    expect(localStorage.getItem(PINNED_PLUGINS_STORAGE_KEY)).toBe(
      '["report-card","session-baton"]',
    );
  });

  it("falls back to an empty list on broken storage", () => {
    localStorage.setItem(PINNED_PLUGINS_STORAGE_KEY, "{not json");
    expect(readPinnedPlugins()).toEqual([]);
  });

  it("drops invalid and duplicate ids instead of failing", () => {
    localStorage.setItem(
      PINNED_PLUGINS_STORAGE_KEY,
      JSON.stringify([
        "report-card",
        "../escape",
        42,
        "report-card",
        "lessons",
      ]),
    );
    expect(readPinnedPlugins()).toEqual(["report-card", "lessons"]);
  });

  it("caps the list at the sidebar limit", () => {
    const ids = Array.from(
      { length: MAX_PINNED_PLUGINS + 3 },
      (_, index) => `plugin-${index}`,
    );
    localStorage.setItem(PINNED_PLUGINS_STORAGE_KEY, JSON.stringify(ids));
    expect(readPinnedPlugins()).toHaveLength(MAX_PINNED_PLUGINS);
  });

  it("toggles add and remove, and refuses to grow past the cap", () => {
    expect(togglePinnedPlugin([], "report-card")).toEqual(["report-card"]);
    expect(togglePinnedPlugin(["report-card"], "report-card")).toEqual([]);

    const full = Array.from(
      { length: MAX_PINNED_PLUGINS },
      (_, index) => `plugin-${index}`,
    );
    expect(togglePinnedPlugin(full, "one-more")).toBe(full);
  });
});
