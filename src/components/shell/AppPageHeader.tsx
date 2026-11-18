import { createContext, useContext, type ReactNode } from "react";
import { DRAG_REGION_ATTR, DRAG_REGION_STYLE } from "@/lib/platform";
import { cn } from "@/lib/utils";

/** 由外壳提供：Linux 自绘窗口按钮要接在每一屏页头的最右端。 */
export const WindowControlsContext = createContext<ReactNode>(null);

const NO_DRAG = { WebkitAppRegion: "no-drag" } as React.CSSProperties;

interface AppPageHeaderProps {
  /** 标题前的可操作元素（二级页的返回按钮）；和 icon 二选一 */
  leading?: ReactNode;
  icon?: ReactNode;
  title: ReactNode;
  /** 应用页用 16px 的名字 + 13px 的页面名；全局页和设置用 18px 的页面标题 */
  variant?: "app" | "page";
  /** 应用页的页面名（如「供应商」），灰字跟在应用名后面 */
  subtitle?: ReactNode;
  /** 标题后面的「?」、Beta 徽标、计数等 */
  titleExtra?: ReactNode;
  /** 右侧操作区：主按钮放最后一个、⋯ 放它后面 */
  actions?: ReactNode;
  tabs?: ReactNode;
  /** 标题可能很长（如会话阅读页的会话名）：标题占满剩余宽度，放不下就截断 */
  truncateTitle?: boolean;
  className?: string;
}

/**
 * 内容区页头：高 52，整条可拖动窗口，左边是图标 + 标题，右边是操作。
 */
export function AppPageHeader({
  leading,
  icon,
  title,
  variant = "page",
  subtitle,
  titleExtra,
  actions,
  tabs,
  truncateTitle = false,
  className,
}: AppPageHeaderProps) {
  const windowControls = useContext(WindowControlsContext);
  // 页签占标题位时（用量、设置、插件中心、工具箱）不画空标题，
  // 标题后的附加内容（帮助、计数）改跟在页签后面。
  const hasTitle = title !== null && title !== undefined && title !== "";
  return (
    <header
      className={cn(
        // w-full：页头本身不能按内容宽度收缩，否则「页签占满剩余宽度」时
        // 弹性分配没有确定的可用宽度，页签栏会缩到标签内容上
        "flex h-[52px] w-full shrink-0 items-center gap-5 border-b border-border pe-4 ps-6",
        // 收起后只避让原生红绿灯：52px 图标轨 + 44px 留白。
        "[[data-sidebar-collapsed=true]~#content-area_&]:ps-[44px]",
        className,
      )}
      {...DRAG_REGION_ATTR}
      style={DRAG_REGION_STYLE as React.CSSProperties}
    >
      {/* Tauri 只认按下的元素自身带拖动属性：标题区、标题、占位条都要带，整条才能拖窗口 */}
      {/* 标题位固定保留（即使标题为空）：页签行与其它页面左边缘对齐 */}
      <div
        {...DRAG_REGION_ATTR}
        className={cn(
          "flex min-w-0 items-center gap-2.5",
          truncateTitle ? "flex-1" : "shrink-0",
        )}
      >
        {leading && (
          <span className="-ms-2 flex shrink-0 items-center" style={NO_DRAG}>
            {leading}
          </span>
        )}
        {icon && (
          <span
            aria-hidden="true"
            className="flex h-[22px] w-[22px] shrink-0 items-center justify-center text-fg-1"
          >
            {icon}
          </span>
        )}
        {hasTitle && (
          <h1
            {...DRAG_REGION_ATTR}
            className={cn(
              "m-0 whitespace-nowrap",
              variant === "app" ? "text-title" : "text-page",
              truncateTitle && "min-w-0 truncate",
            )}
          >
            {title}
          </h1>
        )}
        {subtitle && (
          <span className="whitespace-nowrap text-body text-fg-3">
            {subtitle}
          </span>
        )}
        {hasTitle && titleExtra && (
          <div className="flex items-center gap-1" style={NO_DRAG}>
            {titleExtra}
          </div>
        )}
      </div>
      {tabs}
      {/* 页签占了标题位时，帮助与计数这类标题附属信息跟在页签后面 */}
      {!hasTitle && titleExtra && (
        <div className="flex shrink-0 items-center gap-1" style={NO_DRAG}>
          {titleExtra}
        </div>
      )}
      {/*
        页签后面那条占位必须能撑开：操作区永远贴页头最右端。
        只给了固定宽度时，操作按钮会紧挨着页签停在左侧（钉住按钮就是这么跑偏的）；
        只有「有页签、没有操作」时留一条窄缝，不把页签行拉满。
      */}
      {!truncateTitle && (
        <div
          {...DRAG_REGION_ATTR}
          className={tabs && !actions ? "w-5 shrink-0" : "flex-1"}
        />
      )}
      {actions && (
        <div
          className="flex min-w-0 shrink items-center justify-end gap-2"
          style={NO_DRAG}
        >
          {actions}
        </div>
      )}
      {windowControls && (
        <div className="flex shrink-0 items-center gap-1" style={NO_DRAG}>
          {windowControls}
        </div>
      )}
    </header>
  );
}
