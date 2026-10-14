import { describe, expect, it } from "vitest";
import {
  SETTINGS_SECTIONS,
  visibleSettingsSections,
} from "@/lib/navigation";

describe("visibleSettingsSections", () => {
  it("keeps the directory lean by default: 应用管理/目录定位/全局代理 are expert-only", () => {
    expect(visibleSettingsSections(false)).toEqual([
      "general",
      "auth",
      "routing",
      "data",
      "about",
    ]);
  });

  it("expert mode shows every settings section", () => {
    expect(visibleSettingsSections(true)).toEqual(SETTINGS_SECTIONS);
  });

  it("always contains general first and about last so the directory keeps its anchors", () => {
    for (const expertMode of [false, true]) {
      const sections = visibleSettingsSections(expertMode);
      expect(sections[0]).toBe("general");
      expect(sections[sections.length - 1]).toBe("about");
    }
  });
});
