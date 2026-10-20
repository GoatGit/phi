import { describe, expect, it } from "vitest";
import {
  SETTINGS_SECTIONS,
  normalizeSettingsSection,
  visibleSettingsSections,
} from "@/lib/navigation";

describe("visibleSettingsSections", () => {
  it("shows apps unconditionally by default: 应用管理/目录定位/全局代理 are expert-only", () => {
    expect(visibleSettingsSections(false)).toEqual([
      "general",
      "apps",
      "routing",
      "data",
      "about",
    ]);
  });

  it("drops the auth section: 授权中心已取消，订阅类账号统一在供应商-订阅里登录", () => {
    for (const expertMode of [false, true]) {
      expect(visibleSettingsSections(expertMode)).not.toContain("auth");
    }
    // 旧链接 / 旧存储值落到通用
    expect(normalizeSettingsSection("auth")).toBe("general");
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
