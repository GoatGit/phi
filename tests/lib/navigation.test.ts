import { describe, expect, it } from "vitest";
import {
  DEFAULT_TOOLBOX_TAB,
  SETTINGS_SECTIONS,
  TOOLBOX_TABS,
  isGlobalPage,
  normalizeSettingsSection,
  parseView,
  pluginIdFromView,
  pluginView,
  readStoredToolboxTab,
  storeToolboxTab,
  toolboxTabFromView,
  toolboxView,
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

  it("maps the retired tasks page onto the task-board plugin tab", () => {
    // 任务看板不再是侧栏一级页；旧的存储值与深链接都要落到插件中心里
    expect(parseView("tasks")).toBe(pluginView("task-board"));
    expect(isGlobalPage(pluginView("task-board"))).toBe(true);
  });

  it("rejects an empty plugin view instead of treating it as the plugin center", () => {
    expect(parseView("plugin:")).toBeNull();
    expect(pluginIdFromView("plugin:")).toBeNull();
  });

  it("encodes the toolbox tab in the view so the sidebar and the page share one state", () => {
    for (const tab of TOOLBOX_TABS) {
      const view = toolboxView(tab);
      expect(view).toBe(`toolbox:${tab}`);
      expect(toolboxTabFromView(view)).toBe(tab);
      expect(isGlobalPage(view)).toBe(true);
      expect(parseView(view)).toBe(view);
    }
    expect(toolboxTabFromView("toolbox:")).toBeNull();
    expect(toolboxTabFromView("toolbox:mcp ")).toBeNull();
    expect(toolboxTabFromView("mcp")).toBeNull();
  });

  it("maps the retired toolbox subpages onto their tabs", () => {
    // 工具箱的四个二级菜单收进了同一个页面，旧的存储值不能把人送进空白页
    for (const tab of TOOLBOX_TABS) {
      expect(parseView(tab)).toBe(toolboxView(tab));
    }
    // 「发现」是 Skills 页签里的二级页签，旧链接只能落到 Skills 页签
    expect(parseView("skillsDiscovery")).toBe(toolboxView("skills"));
  });

  it("remembers the last toolbox tab for the sidebar entry", () => {
    localStorage.removeItem("phi-toolbox-tab");
    expect(readStoredToolboxTab()).toBe(DEFAULT_TOOLBOX_TAB);
    storeToolboxTab("prompts");
    expect(readStoredToolboxTab()).toBe("prompts");
    // 存进去的脏值不认，回落默认页签
    localStorage.setItem("phi-toolbox-tab", "nope");
    expect(readStoredToolboxTab()).toBe(DEFAULT_TOOLBOX_TAB);
  });
});
