import type { ComponentType, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

export interface AppHomeTile {
  key: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  /** 不可用的宫格置灰（如终端在当前应用上不可用） */
  disabled?: boolean;
  /** 一句话说明点进去会看到什么；主宫格才显示 */
  hint?: string;
  /**
   * 主宫格：一屏只放一个，用来承载「现在最该做的事」。
   * 有主宫格时它占一大块，其余宫格后退成一行行的小卡片。
   */
  primary?: boolean;
  onSelect: () => void;
}

interface AppHomePageProps {
  tiles: AppHomeTile[];
  /** 宫格下方的一行说明性内容（如 OpenClaw 健康横幅） */
  children?: ReactNode;
}

/**
 * 应用首页。
 *
 * 原来八格等大的描边框，让人分不清「安装」和「配置目录」哪个更该点。
 * 现在分两层：主宫格（一块带图标、说明的实心卡片）承担最高频的动作，
 * 其余宫格收成两列的小卡片，仍然一点即达，但不再抢同一份注意力。
 */
export function AppHomePage({ tiles, children }: AppHomePageProps) {
  const { t } = useTranslation();
  const primary = tiles.find((tile) => tile.primary && !tile.disabled) ?? null;
  const rest = tiles.filter((tile) => tile !== primary);

  return (
    <div
      id="main-content"
      className="min-h-0 flex-1 overflow-y-auto scroll-stable px-6 pb-10 pt-5"
    >
      <div className="mx-auto w-full max-w-3xl space-y-4">
        {primary && <PrimaryTile tile={primary} />}

        <section aria-label={t("appPage.moreActions", { name: "" })}>
          <ul className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
            {rest.map((tile) => (
              <li key={tile.key}>
                <SmallTile tile={tile} />
              </li>
            ))}
          </ul>
        </section>
      </div>
      {children}
    </div>
  );
}

function PrimaryTile({ tile }: { tile: AppHomeTile }) {
  const Icon = tile.icon;
  return (
    <button
      type="button"
      onClick={tile.onSelect}
      className="group flex w-full items-center gap-4 rounded-panel border border-border bg-surface p-4 text-start transition-[border-color,box-shadow] duration-150 hover:border-action hover:shadow-v7-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-control bg-action-soft text-action-text">
        <Icon className="h-5 w-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-section text-fg-1">
          {tile.label}
        </span>
        {tile.hint && (
          <span className="mt-0.5 block truncate text-caption text-fg-3">
            {tile.hint}
          </span>
        )}
      </span>
      <ChevronRight
        aria-hidden="true"
        className="h-4 w-4 shrink-0 text-fg-3 transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-fg-2"
      />
    </button>
  );
}

function SmallTile({ tile }: { tile: AppHomeTile }) {
  const Icon = tile.icon;
  return (
    <button
      type="button"
      disabled={tile.disabled}
      onClick={tile.onSelect}
      className={cn(
        "flex h-full w-full items-center gap-2.5 rounded-panel border border-border bg-surface px-3 py-2.5 text-start",
        "transition-[border-color,background-color] duration-150",
        "hover:border-border-strong hover:bg-subtle",
        "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-border disabled:hover:bg-surface",
      )}
    >
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-control bg-subtle text-fg-2">
        <Icon className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1 truncate text-body text-fg-1">
        {tile.label}
      </span>
    </button>
  );
}
