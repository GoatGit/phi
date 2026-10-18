import type { ReactNode } from "react";
import type { AppId } from "@/lib/api";
import { getAppLabel } from "@/config/appConfig";
import { AppGlyph } from "@/components/shell/AppGlyph";
import { cn } from "@/lib/utils";

interface AppRouteRowProps {
  app: AppId;
  /** 副行：这个应用当前实际使用的供应商 / 路由组；没有就写未配置 */
  children: ReactNode;
  /** 右侧唯一的可操作控件：接入方式下拉，或打开应用 */
  control?: ReactNode;
  className?: string;
}

/**
 * 路由页的一行应用：左边是应用名和当前目标，右边是接入方式。
 * 不做成表格：少了三列标题和贯穿整行的数字网格，读起来更像供应商列表。
 */
export function AppRouteRow({
  app,
  children,
  control,
  className,
}: AppRouteRowProps) {
  return (
    <li className={cn("flex items-center gap-4 px-5 py-2.5", className)}>
      <AppGlyph app={app} size={20} badgeClassName="bg-surface" />
      <div className="min-w-0 flex-1">
        <span className="block truncate text-strong text-fg-1">
          {getAppLabel(app)}
        </span>
        <div className="mt-0.5 min-w-0 text-caption text-fg-2">{children}</div>
      </div>
      {control ? (
        <div className="flex w-56 shrink-0 items-center justify-end">
          {control}
        </div>
      ) : null}
    </li>
  );
}
