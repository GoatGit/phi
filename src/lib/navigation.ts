import type { AppId } from "@/lib/api";

/**
 * 主窗口的导航模型（v8）：侧栏点应用进它的首页（九宫格），首页宫格跳到各功能；
 * 设置是侧栏一级入口，分区是页内标签，高级分区由「专家模式」唤出。
 *
 * - 应用页：首页（home）、供应商页；OpenClaw 还有工作区页，Hermes 有记忆页。
 * - 全局页：路由（供应商与路由总览是它的两个页签）、用量统计、MCP、
 *   Skills、提示词、会话、插件中心。插件中心是主页（卡片列表），
 *   `plugin:<id>` 是某个插件在插件中心里的页签，也可以钉在侧栏一级导航。
 * - 设置：侧栏里的一个一级入口，分区（通用/应用/网关/数据/关于）
 *   是设置页内的标签，不再单独跳转。
 *   授权中心已取消：订阅型账号统一在「供应商 → 订阅」里登录与管理。
 */

export type AppPage = "home" | "providers" | "workspace" | "hermesMemory";

/**
 * 插件中心里的插件页：`plugin:<id>`。
 *
 * 插件中心主页是 `plugins`，打开某张插件卡片后才切到这个视图。把「开了哪个
 * 插件」编码进视图本身，侧栏的钉住入口、重启后的上次位置、页签高亮就能共用
 * 同一份状态，不需要再维护第二份「当前插件」状态。
 */
export const PLUGIN_VIEW_PREFIX = "plugin:";

export type PluginView = `${typeof PLUGIN_VIEW_PREFIX}${string}`;

export type GlobalPage =
  | "routingOverview"
  | "tasks"
  | "plugins"
  | "usage"
  | "mcp"
  | "skills"
  | "skillsDiscovery"
  | "prompts"
  | "sessions"
  | PluginView;

export type View = AppPage | GlobalPage | "settings";

/** 插件 id → 插件页视图。 */
export function pluginView(pluginId: string): PluginView {
  return `${PLUGIN_VIEW_PREFIX}${pluginId}`;
}

/** 插件页视图 → 插件 id；不是插件页时返回 null。 */
export function pluginIdFromView(
  view: string | null | undefined,
): string | null {
  if (!view || !view.startsWith(PLUGIN_VIEW_PREFIX)) return null;
  const pluginId = view.slice(PLUGIN_VIEW_PREFIX.length);
  return pluginId || null;
}

export type SettingsSection =
  | "general"
  | "apps"
  | "routing"
  | "network"
  | "data"
  | "about";

export const SETTINGS_SECTIONS: SettingsSection[] = [
  "general",
  "apps",
  "routing",
  "network",
  "data",
  "about",
];

/**
 * 非专家模式下设置页显示的标签。network（全局代理）
 * 属于高级功能，由「专家模式」开关唤出（见 GeneralSection）。
 * 原「配置目录」分区已并入各应用首页的配置弹窗，不再是独立分区。
 */
const DEFAULT_SETTINGS_SECTIONS: SettingsSection[] = [
  "general",
  "apps",
  "routing",
  "data",
  "about",
];

export function visibleSettingsSections(
  expertMode: boolean,
): SettingsSection[] {
  return expertMode ? SETTINGS_SECTIONS : DEFAULT_SETTINGS_SECTIONS;
}

const APP_PAGES: AppPage[] = ["home", "providers", "workspace", "hermesMemory"];

const GLOBAL_PAGES: Exclude<GlobalPage, PluginView>[] = [
  "routingOverview",
  "tasks",
  "plugins",
  "usage",
  "mcp",
  "skills",
  "skillsDiscovery",
  "prompts",
  "sessions",
];

export const VIEW_STORAGE_KEY = "phi-last-view";
export const APP_STORAGE_KEY = "phi-last-app";

/**
 * 旧版视图名 → 新视图（OpenClaw 的三个配置页合成了一个；配置改为弹窗）。
 * 供应商页并进了路由页的「供应商」页签，旧视图名回落到路由页。
 */
const LEGACY_VIEWS: Record<string, View> = {
  auth: "settings",
  apps: "settings",
  providerCatalog: "routingOverview",
  openclawEnv: "workspace",
  openclawTools: "workspace",
  openclawAgents: "workspace",
  openclawConfig: "providers",
  appConfig: "settings",
  // 成绩单曾经是侧栏一级页，现在是插件中心里的一张卡片。
  reportCard: pluginView("report-card"),
};

export function isAppPage(view: View): view is AppPage {
  return (APP_PAGES as string[]).includes(view);
}

export function isGlobalPage(view: View): view is GlobalPage {
  return (
    pluginIdFromView(view) !== null || (GLOBAL_PAGES as string[]).includes(view)
  );
}

export function parseView(value: string | null | undefined): View | null {
  if (!value) return null;
  if (value in LEGACY_VIEWS) return LEGACY_VIEWS[value];
  if (value === "settings") return "settings";
  if ((APP_PAGES as string[]).includes(value)) return value as AppPage;
  if ((GLOBAL_PAGES as string[]).includes(value)) return value as GlobalPage;
  const pluginId = pluginIdFromView(value);
  if (pluginId) return pluginView(pluginId);
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
    // 已取消的授权中心分区：旧链接 / 旧存储值回落到通用
    case "auth":
      return "general";
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
