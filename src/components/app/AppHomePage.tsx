import type { ComponentType, ReactNode } from "react";

export interface AppHomeTile {
  key: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  /** 不可用的宫格置灰（如终端在当前应用上不可用） */
  disabled?: boolean;
  onSelect: () => void;
}

interface AppHomePageProps {
  tiles: AppHomeTile[];
  /** 宫格下方的一行说明性内容（如 OpenClaw 健康横幅） */
  children?: ReactNode;
}

/**
 * 应用首页：九宫格。点侧栏应用进来落在这里，每个宫格跳一个功能
 * （供应商、路由、终端、用量、会话、MCP、Skills、提示词、配置……）。
 * 宫格按应用能力取舍，三列排布。
 */
export function AppHomePage({ tiles, children }: AppHomePageProps) {
  return (
    <div
      id="main-content"
      className="min-h-0 flex-1 overflow-y-auto scroll-stable px-6 pb-12 pt-4"
    >
      <div className="mx-auto grid w-full max-w-3xl grid-cols-2 gap-3 sm:grid-cols-3">
        {tiles.map((tile) => {
          const Icon = tile.icon;
          return (
            <button
              key={tile.key}
              type="button"
              disabled={tile.disabled}
              onClick={tile.onSelect}
              className="flex flex-col items-center gap-3 rounded-panel border border-border bg-surface px-4 py-7 text-body text-fg-1 transition-colors hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Icon className="h-6 w-6 text-fg-2 stroke-[1.5]" />
              <span className="truncate">{tile.label}</span>
            </button>
          );
        })}
      </div>
      {children}
    </div>
  );
}
