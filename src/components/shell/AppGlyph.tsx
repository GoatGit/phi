import { Monitor, Terminal } from "lucide-react";
import type { AppId } from "@/lib/api";
import { ProviderIcon } from "@/components/ProviderIcon";
import {
  LOCAL_ROUTABLE_APP_ICONS,
  LOCAL_ROUTABLE_APP_LABELS,
  isLocalRoutableAppId,
} from "@/config/appConfig";
import { cn } from "@/lib/utils";

/** 应用名：品牌名不翻译，四种语言都写原文。 */
export const APP_DISPLAY_NAME: Record<AppId, string> = {
  claude: "Claude Code",
  "claude-desktop": "Claude Desktop",
  codex: "Codex",
  gemini: "Gemini CLI",
  grokbuild: "Grok Build",
  opencode: "OpenCode",
  openclaw: "OpenClaw",
  hermes: "Hermes",
  pi: "Pi",
  mcode: "MiniMax Code",
  zcode: "ZCode",
};

const APP_ICON_NAME: Record<AppId, string> = {
  claude: "claude",
  "claude-desktop": "claude",
  codex: "openai",
  gemini: "gemini",
  grokbuild: "grok",
  opencode: "opencode",
  openclaw: "openclaw",
  hermes: "hermes",
  pi: "pi",
  mcode: "minimax",
  zcode: "zcode",
};

// Claude Code 和 Claude Desktop 用同一个图标，靠右下角的小角标区分终端与桌面
const APP_BADGE_ICON: Partial<Record<AppId, typeof Terminal>> = {
  claude: Terminal,
  "claude-desktop": Monitor,
};

/** 应用显示名：AppId 用固定表，路由专用应用用它们自己的品牌名。 */
export function getAppDisplayName(appId: string): string {
  return (
    (APP_DISPLAY_NAME as Record<string, string>)[appId] ??
    LOCAL_ROUTABLE_APP_LABELS[appId] ??
    appId
  );
}

/** 应用图标名：没有图标的 id 返回 undefined，由调用方决定是否用首字母兜底。 */
export function getAppIconName(appId: string): string | undefined {
  if (isLocalRoutableAppId(appId)) return LOCAL_ROUTABLE_APP_ICONS[appId];
  return (APP_ICON_NAME as Record<string, string>)[appId];
}

interface AppGlyphProps {
  app: string;
  /** 图标边长：侧栏 16，页头 20 */
  size?: number;
  /** 角标底色要和所在的行一致，否则看起来像缺了一块 */
  badgeClassName?: string;
  className?: string;
}

/** 应用图标 + 角标（装饰性，名称由旁边的文字或按钮的 aria-label 提供）。 */
export function AppGlyph({
  app,
  size = 16,
  badgeClassName,
  className,
}: AppGlyphProps) {
  const BadgeIcon = APP_BADGE_ICON[app as AppId];
  const iconName = getAppIconName(app);
  return (
    <span
      aria-hidden="true"
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center",
        className,
      )}
      style={{ width: size + 2, height: size + 2 }}
    >
      <ProviderIcon icon={iconName} name="" size={size} showFallback={false} />
      {BadgeIcon && (
        <span
          className={cn(
            "absolute -bottom-1 -right-1 flex h-[11px] w-[11px] items-center justify-center rounded-[3px] bg-sidebar text-fg-2",
            badgeClassName,
          )}
        >
          <BadgeIcon className="h-[9px] w-[9px]" strokeWidth={3} />
        </span>
      )}
    </span>
  );
}
