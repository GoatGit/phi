import { describe, expect, it } from "vitest";
import {
  SETTINGS_SECTIONS,
  isGlobalPage,
  normalizeSettingsSection,
  parseView,
  pluginIdFromView,
  pluginView,
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

  it("encodes the open plugin in the view so tabs and sidebar share one state", () => {
    const view = pluginView("report-card");
    expect(view).toBe("plugin:report-card");
    expect(pluginIdFromView(view)).toBe("report-card");
    expect(pluginIdFromView("plugins")).toBeNull();
    expect(isGlobalPage(view)).toBe(true);
    expect(parseView(view)).toBe(view);
  });

  it("keeps plugin ids that contain dots and dashes", () => {
    const view = pluginView("custom.rules-v2");
    expect(parseView(view)).toBe(view);
    expect(pluginIdFromView(view)).toBe("custom.rules-v2");
  });

  it("maps the retired report-card page onto the plugin tab", () => {
    expect(parseView("reportCard")).toBe(pluginView("report-card"));
  });

  it("rejects an empty plugin view instead of treating it as the plugin center", () => {
    expect(parseView("plugin:")).toBeNull();
    expect(pluginIdFromView("plugin:")).toBeNull();
  });
});
