import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import {
  Blocks,
  BookOpenCheck,
  ClipboardList,
  HandHeart,
  Network,
  ShieldCheck,
} from "lucide-react";
import type { ComponentType } from "react";
import { pluginsApi, type PluginSummary } from "@/lib/api/plugins";

/**
 * 插件中心的卡片目录。
 *
 * 这里描述「界面上有哪几个插件」，与后端清单是两件事：
 * - `panel` / `plugin` 卡片背后有插件清单条目（成绩单是宿主内置，接棒来自插件目录），
 *   启停状态直接读清单；
 * - `config` 卡片是宿主自带能力（隐私脱敏、MCP 路由、教训库），没有插件清单，
 *   也不需要启停——它们各自的面板里才有关闭开关。
 *
 * 磁盘上其他插件（规则 / 脚本）不在固定清单里，按清单自动补成卡片。
 */

export const pluginKeys = {
  list: ["plugins", "list"] as const,
};

export type PluginEntryKind = "panel" | "plugin" | "config";

/** 卡片状态：`unknown` 表示插件列表还没读到，先不下结论。 */
export type PluginEntryStatus =
  | "enabled"
  | "disabled"
  | "always-on"
  | "unknown";

export interface PluginCenterEntry {
  id: string;
  /** 展示名；固定卡片走文案，磁盘插件用清单里的 name */
  title: string;
  description: string | null;
  icon: ComponentType<{ className?: string }>;
  order: number;
  kind: PluginEntryKind;
  /** 对应的插件清单条目；`config` 卡片与未加载到的插件为 null */
  summary: PluginSummary | null;
  /** 能不能在详情页启停 */
  toggleable: boolean;
  status: PluginEntryStatus;
}

interface CardDefinition {
  id: string;
  titleKey: string;
  descriptionKey: string;
  icon: ComponentType<{ className?: string }>;
  order: number;
  kind: PluginEntryKind;
}

const CARD_DEFINITIONS: CardDefinition[] = [
  {
    id: "report-card",
    titleKey: "pluginCenter.cards.reportCard.title",
    descriptionKey: "pluginCenter.cards.reportCard.description",
    icon: ClipboardList,
    order: 10,
    kind: "panel",
  },
  {
    id: "session-baton",
    titleKey: "pluginCenter.cards.sessionBaton.title",
    descriptionKey: "pluginCenter.cards.sessionBaton.description",
    icon: HandHeart,
    order: 20,
    kind: "plugin",
  },
  {
    id: "privacy",
    titleKey: "pluginCenter.cards.privacy.title",
    descriptionKey: "pluginCenter.cards.privacy.description",
    icon: ShieldCheck,
    order: 30,
    kind: "config",
  },
  {
    id: "mcp-router",
    titleKey: "pluginCenter.cards.mcpRouter.title",
    descriptionKey: "pluginCenter.cards.mcpRouter.description",
    icon: Network,
    order: 40,
    kind: "config",
  },
  {
    id: "lessons",
    titleKey: "pluginCenter.cards.lessons.title",
    descriptionKey: "pluginCenter.cards.lessons.description",
    icon: BookOpenCheck,
    order: 50,
    kind: "config",
  },
];

/** 磁盘插件的卡片排在固定卡片之后，按名字稳定排序。 */
const DISCOVERED_ORDER_BASE = 1000;

function statusOf(
  kind: PluginEntryKind,
  summary: PluginSummary | null,
): PluginEntryStatus {
  // 面板类与配置类都是宿主页面：启停状态不决定它能不能打开，
  // 后端也没有运行期消费方（原来只用来挂侧栏入口）。
  if (kind === "config" || kind === "panel") return "always-on";
  if (!summary) return "unknown";
  return summary.enabled ? "enabled" : "disabled";
}

/** 合并固定卡片与磁盘插件，得到插件中心主页要展示的全部卡片。 */
export function pluginCenterEntries(
  plugins: PluginSummary[],
  t: TFunction,
): PluginCenterEntry[] {
  const remaining = new Map(plugins.map((plugin) => [plugin.id, plugin]));

  const cards: PluginCenterEntry[] = CARD_DEFINITIONS.map((definition) => {
    const summary = remaining.get(definition.id) ?? null;
    if (summary) remaining.delete(definition.id);
    return {
      id: definition.id,
      title: t(definition.titleKey),
      description: t(definition.descriptionKey),
      icon: definition.icon,
      order: definition.order,
      kind: definition.kind,
      summary,
      toggleable: definition.kind === "plugin" && summary !== null,
      status: statusOf(definition.kind, summary),
    };
  });

  const discovered = [...remaining.values()]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((summary, index) => ({
      id: summary.id,
      title: summary.name,
      description: summary.description,
      icon: Blocks,
      order: DISCOVERED_ORDER_BASE + index,
      kind: "plugin" as const,
      summary,
      toggleable: true,
      status: statusOf("plugin", summary),
    }));

  return [...cards, ...discovered];
}

/** 按 id 取一张卡片；id 不在目录里（插件已卸载）时返回 null。 */
export function pluginEntryFor(
  pluginId: string,
  plugins: PluginSummary[],
  t: TFunction,
): PluginCenterEntry | null {
  return (
    pluginCenterEntries(plugins, t).find((entry) => entry.id === pluginId) ??
    null
  );
}

export function usePluginSummaries() {
  return useQuery({
    queryKey: pluginKeys.list,
    queryFn: pluginsApi.list,
    staleTime: 30_000,
  });
}

/** 插件中心的全部卡片（含启停状态）。 */
export function usePluginCenterEntries(): PluginCenterEntry[] {
  const { t } = useTranslation();
  const { data } = usePluginSummaries();
  return useMemo(
    () => pluginCenterEntries(data?.plugins ?? [], t),
    [data?.plugins, t],
  );
}
