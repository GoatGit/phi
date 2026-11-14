import type { ComponentType } from "react";
import {
  Blocks,
  BookOpenCheck,
  ClipboardList,
  Columns3,
  HandHeart,
  Network,
  ShieldCheck,
} from "lucide-react";

/**
 * 插件的身份语汇：每个插件一种颜色 + 一个图标。
 *
 * 卡片与插件页页头共用这一处，所以从卡片点进页面时，图标底色不会变。
 * 颜色只做「认得出是谁」，不表示状态——状态靠徽标与开关。
 * 取值都取现有 token（模式色、语义色、图表的青/粉），不新增散装色号。
 */
export interface PluginIdentity {
  icon: ComponentType<{ className?: string }>;
  /** 图标底色（--*-soft），深色模式下是半透明叠加 */
  tint: string;
  /** 图标本身的颜色（--*-text） */
  ink: string;
}

const IDENTITY: Record<string, PluginIdentity> = {
  "report-card": {
    icon: ClipboardList,
    tint: "bg-route-soft",
    ink: "text-route-text",
  },
  "session-baton": {
    icon: HandHeart,
    tint: "bg-stack-soft",
    ink: "text-stack-text",
  },
  privacy: {
    icon: ShieldCheck,
    tint: "bg-success-soft",
    ink: "text-success-text",
  },
  "mcp-router": {
    icon: Network,
    tint: "bg-action-soft",
    ink: "text-action-text",
  },
  lessons: {
    icon: BookOpenCheck,
    tint: "bg-warning-soft",
    ink: "text-warning-text",
  },
  "task-board": {
    icon: Columns3,
    tint: "bg-direct-soft",
    ink: "text-direct-text",
  },
};

/** 磁盘上的插件没有固定语汇，统一用一个中性方块，避免看起来像内置功能。 */
const DISCOVERED: PluginIdentity = {
  icon: Blocks,
  tint: "bg-subtle",
  ink: "text-fg-2",
};

export function pluginIdentity(pluginId: string): PluginIdentity {
  return IDENTITY[pluginId] ?? DISCOVERED;
}
