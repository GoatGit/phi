import { useQuery } from "@tanstack/react-query";
import { pluginsApi, type PluginSummary } from "@/lib/api/plugins";
import type { GlobalPage } from "@/lib/navigation";

/**
 * 功能插件的面板入口。
 *
 * 面板组件在宿主里，插件只声明「挂哪个内置面板」。所以这里既是侧栏入口的
 * 数据源，也是插件中心「打开」按钮的依据：插件停用，入口就一起消失。
 */

export const pluginKeys = {
  list: ["plugins", "list"] as const,
};

/** 面板 entry → 宿主内置页面。新增内置面板时，后端 `BUILTIN_PANELS` 与这里一起改。 */
const PANEL_VIEWS: Record<string, GlobalPage> = {
  "report-card": "reportCard",
};

/** 某个 entry 对应的页面；不是内置面板时返回 null（插件清单校验已经挡住了，这里只做兜底）。 */
export function panelViewFor(entry: string): GlobalPage | null {
  return PANEL_VIEWS[entry] ?? null;
}

export interface PluginPanelEntry {
  pluginId: string;
  entry: string;
  view: GlobalPage;
  /** 清单里的自定义标题；为空时由界面按 entry 取文案 */
  title: string | null;
  order: number;
}

function toPanelEntry(plugin: PluginSummary): PluginPanelEntry | null {
  const panel = plugin.panel;
  if (!panel) return null;
  const view = panelViewFor(panel.entry);
  if (!view) return null;
  return {
    pluginId: plugin.id,
    entry: panel.entry,
    view,
    title: panel.title ?? null,
    order: panel.order ?? 100,
  };
}

/** 已启用的功能插件面板，按清单里的 order 排序。 */
export function usePluginPanels(): PluginPanelEntry[] {
  const { data } = useQuery({
    queryKey: pluginKeys.list,
    queryFn: pluginsApi.list,
    staleTime: 30_000,
  });
  return (data?.plugins ?? [])
    .filter((plugin) => plugin.kind === "feature" && plugin.enabled)
    .map(toPanelEntry)
    .filter((panel): panel is PluginPanelEntry => panel !== null)
    .sort((left, right) => left.order - right.order);
}
