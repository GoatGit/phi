import type { AppId } from "@/lib/api";

/**
 * 主窗口的导航模型（v8）：侧栏点应用进它的首页（九宫格），首页宫格跳到各功能；
 * 设置单独占一屏，高级分区由「专家模式」唤出。
 *
 * - 应用页：首页（home）、供应商页；OpenClaw 还有工作区页，Hermes 有记忆页。
 * - 全局页：供应商目录、路由总览、用量统计、MCP、Skills、提示词、会话。
 * - 设置：侧栏换成设置目录，包含授权中心和应用管理。
 */

export type AppPage =
  | "home"
  | "providers"
  | "workspace"
  | "hermesMemory";

export type GlobalPage =
  | "providerCatalog"
  | "routingOverview"
  | "usage"
  | "mcp"
  | "skills"
  | "skillsDiscovery"
  | "prompts"
  | "sessions";

export type View = AppPage | GlobalPage | "settings";

export type SettingsSection =
  | "general"
  | "auth"
  | "apps"
  | "routing"
  | "network"
  | "data"
  | "about";

export const SETTINGS_SECTIONS: SettingsSection[] = [
  "general",
  "auth",
  "apps",
  "routing",
  "network",
  "data",
  "about",
];

/**
 * 非专家模式下设置目录显示的分区。apps（应用管理）、network（全局代理）
 * 属于高级功能，由「专家模式」开关唤出（见 GeneralSection）。
 * 原「配置目录」分区已并入各应用首页的配置弹窗，不再是独立分区。
 */
const DEFAULT_SETTINGS_SECTIONS: SettingsSection[] = [
  "general",
  "auth",
  "routing",
  "data",
  "about",
];

export function visibleSettingsSections(
  expertMode: boolean,
): SettingsSection[] {
  return expertMode ? SETTINGS_SECTIONS : DEFAULT_SETTINGS_SECTIONS;
}

const APP_PAGES: AppPage[] = [
  "home",
  "providers",
  "workspace",
  "hermesMemory",
];

const GLOBAL_PAGES: GlobalPage[] = [
  "providerCatalog",
  "routingOverview",
  "usage",
  "mcp",
  "skills",
  "skillsDiscovery",
  "prompts",
  "sessions",
];

export const VIEW_STORAGE_KEY = "phi-last-view";
export const APP_STORAGE_KEY = "phi-last-app";

/** 旧版视图名 → 新视图（OpenClaw 的三个配置页合成了一个；配置改为弹窗）。 */
const LEGACY_VIEWS: Record<string, View> = {
  auth: "settings",
  apps: "settings",
  openclawEnv: "workspace",
  openclawTools: "workspace",
  openclawAgents: "workspace",
  openclawConfig: "providers",
  appConfig: "settings",
};

export function isAppPage(view: View): view is AppPage {
  return (APP_PAGES as string[]).includes(view);
}

export function isGlobalPage(view: View): view is GlobalPage {
  return (GLOBAL_PAGES as string[]).includes(view);
}

export function parseView(value: string | null | undefined): View | null {
  if (!value) return null;
  if (value in LEGACY_VIEWS) return LEGACY_VIEWS[value];
  if (value === "settings") return "settings";
  if ((APP_PAGES as string[]).includes(value)) return value as AppPage;
  if ((GLOBAL_PAGES as string[]).includes(value)) return value as GlobalPage;
  return null;
}

/** 应用专属页只对它所属的应用成立；换了应用就回到首页。 */
export function appPageBelongsTo(page: AppPage, app: AppId): boolean {
  switch (page) {
    case "home":
    case "providers":
      return true;
    case "workspace":
      return app === "openclaw";
    case "hermesMemory":
      return app === "hermes";
  }
}

export function readStoredView(): View {
  try {
    return parseView(localStorage.getItem(VIEW_STORAGE_KEY)) ?? "providers";
  } catch {
    return "providers";
  }
}

/** 兼容旧版记住的一级管理页，启动后定位到对应设置分组。 */
export function readStoredSettingsSection(): SettingsSection {
  try {
    return normalizeSettingsSection(localStorage.getItem(VIEW_STORAGE_KEY));
  } catch {
    return "general";
  }
}

export function storeView(view: View) {
  try {
    localStorage.setItem(VIEW_STORAGE_KEY, view);
  } catch {
    // 存不了就算了：下次启动回到供应商页
  }
}

/**
 * 旧的设置页签名 → 新的设置分组。
 */
export function normalizeSettingsSection(
  tab: string | null | undefined,
): SettingsSection {
  switch (tab) {
    case "proxy":
    case "routing":
      return "routing";
    case "advanced":
    case "data":
      return "data";
    case "auth":
    case "apps":
    case "network":
    case "about":
    case "general":
      return tab;
    default:
      return "general";
  }
}

/** 提示词、会话页在 Claude Desktop 上看的是 Claude Code 的内容（两者共用）。 */
export function sharedFeatureAppOf(app: AppId): AppId {
  return app === "claude-desktop" ? "claude" : app;
}
