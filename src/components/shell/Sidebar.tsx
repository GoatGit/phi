import { useEffect, useRef, useState, type ComponentType } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { getVersion } from "@tauri-apps/api/app";
import {
  BookOpen,
  ChartColumn,
  ChevronDown,
  Database,
  Globe,
  History,
  Info,
  KeyRound,
  Layers,
  LayoutGrid,
  Route,
  Server,
  Settings,
  SlidersHorizontal,
  ToolCase,
} from "lucide-react";
import type { AppId } from "@/lib/api";
import type { VisibleApps } from "@/types";
import { APP_IDS } from "@/config/appConfig";
import type { GlobalPage, SettingsSection, View } from "@/lib/navigation";
import { isAppPage, visibleSettingsSections } from "@/lib/navigation";
import { SkillsIcon } from "@/components/BrandIcons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useUpdate } from "@/contexts/UpdateContext";
import { sidebarWidth, useSidebarCollapsed } from "@/hooks/useSidebarCollapsed";
import { useSidebarStatus, type AppNavStatus } from "@/hooks/useSidebarStatus";
import { fmtUsd } from "@/components/usage/format";
import { HoverTip } from "@/components/ui/hover-tip";
import { DRAG_REGION_ATTR, DRAG_REGION_STYLE, isMac } from "@/lib/platform";
import { cn } from "@/lib/utils";
// 日间用黑 φ、夜间用白 φ：跟随主题的双版本
import phiLogoLight from "@/assets/icons/phi/phi-logo-light.png";
import phiLogoDark from "@/assets/icons/phi/phi-logo-dark.png";
import { APP_DISPLAY_NAME, AppGlyph } from "./AppGlyph";

const NO_DRAG = { WebkitAppRegion: "no-drag" } as React.CSSProperties;

type IconComponent = ComponentType<{ className?: string }>;

interface SidebarProps {
  activeApp: AppId;
  view: View;
  visibleApps: VisibleApps;
  settingsSection: SettingsSection;
  /** 设置目录显示高级分区（应用管理/目录定位/全局代理），默认关 */
  expertMode?: boolean;
  onSelectApp: (app: AppId) => void;
  onSelectPage: (page: GlobalPage | "settings") => void;
  onSelectSettingsSection: (section: SettingsSection) => void;
  /** 打开了「启动时检查应用更新」并且查到了新版本 */
  appsUpdateAvailable?: boolean;
  terminalCounts?: Partial<Record<AppId, number>>;
}

type DirectoryProps = SidebarProps & { collapsed: boolean };

/**
 * 主导航（v7）：顶条 44 → 供应商/路由/工具箱/用量统计/设置 → 滚动区（应用列表）。
 * 进入设置后整条侧栏换成设置目录。收起时是 52px 的图标轨；
 * 展开 / 收起时宽度一步到位，边缘的滑动由盖板的 transform 动画画出（见 useSidebarCollapsed），文字不换行、被裁掉而不是挤成两行。
 * 收起时各行只剩图标，名字由 HoverTip 从右侧报；展开时文字可见，不再挂提示。
 */
export function Sidebar(props: SidebarProps) {
  const { t } = useTranslation();
  const navRef = useRef<HTMLElement>(null);
  const { collapsed, toggle } = useSidebarCollapsed(navRef);
  const { view } = props;
  const inSettings = view === "settings";

  return (
    <nav
      ref={navRef}
      data-sidebar-collapsed={collapsed && isMac()}
      aria-label={t("nav.mainLabel")}
      className={cn(
        "relative flex h-full shrink-0 flex-col overflow-hidden whitespace-nowrap border-e border-border bg-sidebar text-body text-fg-1",
      )}
      style={{ width: sidebarWidth(collapsed) }}
    >
      <a
        href="#main-content"
        className="absolute -start-[999px] top-2 z-10 rounded-control bg-surface px-2 py-1 text-caption shadow-v7-sm focus:start-2"
      >
        {t("nav.skipToContent")}
      </a>
      <SidebarTopBar collapsed={collapsed} onToggle={toggle} />
      {inSettings ? (
        <SettingsDirectory {...props} collapsed={collapsed} />
      ) : (
        <MainDirectory {...props} collapsed={collapsed} />
      )}
    </nav>
  );
}

function SidebarTopBar({
  collapsed,
  onToggle,
}: {
  collapsed: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const [controlsCenterY, setControlsCenterY] = useState(22);
  // 与顶条拖拽区的 h-11 一致；用于拒绝明显异常的红绿灯几何
  const TOP_BAR_HEIGHT = 44;

  useEffect(() => {
    if (!isMac() || collapsed) return;
    let disposed = false;
    const alignWithWindowControls = () => {
      void invoke<number | null>("get_window_controls_center_y")
        .then((y) => {
          // 红绿灯中心只可能落在 44px 高的顶条内；全屏等异常几何（可能返回
          // 接近内容区高度的值）直接忽略，沿用上一个可信位置。
          if (
            !disposed &&
            y !== null &&
            Number.isFinite(y) &&
            y > 0 &&
            y <= TOP_BAR_HEIGHT
          ) {
            setControlsCenterY(y);
          }
        })
        .catch((error) =>
          console.warn("Failed to align window controls", error),
        );
    };
    alignWithWindowControls();
    window.addEventListener("resize", alignWithWindowControls);
    window.addEventListener("focus", alignWithWindowControls);
    return () => {
      disposed = true;
      window.removeEventListener("resize", alignWithWindowControls);
      window.removeEventListener("focus", alignWithWindowControls);
    };
  }, [collapsed]);

  const label = t(collapsed ? "nav.expandSidebar" : "nav.collapseSidebar");
  const toggleButton = (
    <HoverTip
      content={label}
      side={collapsed ? "right" : "left"}
      disableHoverableContent
    >
      <button
        type="button"
        onClick={onToggle}
        aria-label={label}
        aria-expanded={!collapsed}
        style={NO_DRAG}
        className="flex h-7 w-7 items-center justify-center rounded-control text-fg-2 transition-[background-color,color,scale] hover:bg-subtle hover:text-fg-1 active:scale-[0.96]"
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 256 256"
          className="size-[18px]"
          fill="currentColor"
        >
          <path d="M216 40H40a16 16 0 0 0-16 16v144a16 16 0 0 0 16 16h176a16 16 0 0 0 16-16V56a16 16 0 0 0-16-16M40 56h40v144H40Zm176 144H96V56h120z" />
        </svg>
      </button>
    </HoverTip>
  );

  const brand = (
    <span className="pointer-events-none me-auto flex min-w-0 items-center gap-2">
      <img
        src={phiLogoLight}
        alt=""
        draggable={false}
        className="size-[22px] shrink-0 dark:hidden"
      />
      <img
        src={phiLogoDark}
        alt=""
        draggable={false}
        className="hidden size-[22px] shrink-0 dark:block"
      />
      <span
        className="text-[22px] font-black leading-none tracking-[-0.04em] text-fg-1"
        style={{ fontFamily: '"Arial Black", "Helvetica Neue", sans-serif' }}
      >
        PHI
      </span>
    </span>
  );

  // macOS：展开时按钮对齐红绿灯；收起时移到下一行，在窄侧栏中居中。
  if (isMac()) {
    return (
      <>
        <div
          className="relative h-11 shrink-0"
          {...DRAG_REGION_ATTR}
          style={DRAG_REGION_STYLE as React.CSSProperties}
        >
          {!collapsed && (
            <div
              className="absolute end-2 -translate-y-1/2"
              style={{ ...NO_DRAG, top: controlsCenterY }}
            >
              {toggleButton}
            </div>
          )}
        </div>
        {collapsed ? (
          <div className="mb-2 flex h-9 shrink-0 items-center justify-center">
            {toggleButton}
          </div>
        ) : (
          <div
            className="mb-2 flex h-9 shrink-0 items-center pe-2 ps-4"
            {...DRAG_REGION_ATTR}
            style={DRAG_REGION_STYLE as React.CSSProperties}
          >
            {brand}
          </div>
        )}
      </>
    );
  }

  return (
    <div
      className={cn(
        "flex h-11 shrink-0 items-center gap-0.5 px-2",
        collapsed ? "justify-center" : "justify-end",
      )}
      {...DRAG_REGION_ATTR}
      style={DRAG_REGION_STYLE as React.CSSProperties}
    >
      {!collapsed && brand}
      {toggleButton}
    </div>
  );
}

// ─── 主目录 ────────────────────────────────────────────────────────────────

/** 工具箱二级菜单覆盖的页面（Skills 的发现页也算 Skills）。 */
const TOOLBOX_PAGES: GlobalPage[] = [
  "mcp",
  "skills",
  "skillsDiscovery",
  "prompts",
  "sessions",
];

function MainDirectory({
  collapsed,
  activeApp,
  view,
  visibleApps,
  onSelectApp,
  onSelectPage,
  appsUpdateAvailable = false,
  terminalCounts = {},
}: DirectoryProps) {
  const { t } = useTranslation();
  const { hasUpdate } = useUpdate();
  const { appStatus, todayCost, authNeedsAttention } = useSidebarStatus();
  const apps = APP_IDS.filter((app) => visibleApps[app]);
  const onAppPage = isAppPage(view);

  const todayLabel =
    todayCost > 0
      ? t("nav.todayCost", { cost: fmtUsd(todayCost, 2) })
      : undefined;

  // 工具箱（MCP/Skills/提示词/会话 的二级菜单）：进入其中任一页时自动展开一次
  const toolboxActive = (TOOLBOX_PAGES as string[]).includes(view);
  const [toolboxOpen, setToolboxOpen] = useState(toolboxActive);
  useEffect(() => {
    if (toolboxActive) setToolboxOpen(true);
  }, [toolboxActive]);

  return (
    <>
      <div className="flex shrink-0 flex-col pb-3">
        <NavItem
          collapsed={collapsed}
          selected={view === "providerCatalog"}
          icon={Database}
          label={t("gateway.providers")}
          onClick={() => onSelectPage("providerCatalog")}
        />
        <NavItem
          collapsed={collapsed}
          selected={view === "routingOverview"}
          icon={Route}
          label={t("gateway.routing")}
          onClick={() => onSelectPage("routingOverview")}
        />
        <ToolboxNavItem
          collapsed={collapsed}
          active={toolboxActive}
          open={toolboxOpen}
          onToggleOpen={() => setToolboxOpen((value) => !value)}
          view={view}
          onSelectPage={onSelectPage}
        />
        <NavItem
          collapsed={collapsed}
          selected={view === "usage"}
          icon={ChartColumn}
          label={t("nav.usage")}
          trailing={todayLabel}
          onClick={() => onSelectPage("usage")}
        />
        <NavItem
          collapsed={collapsed}
          selected={false}
          icon={Settings}
          label={t("nav.settings")}
          title={hasUpdate ? t("nav.settingsHasUpdate") : t("nav.settings")}
          alert={authNeedsAttention ? t("nav.authNeedsReauth") : undefined}
          dot={hasUpdate || appsUpdateAvailable}
          dotTone={hasUpdate ? "success" : "neutral"}
          onClick={() => onSelectPage("settings")}
        />
      </div>
      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden pb-2 pt-0.5",
          // 图标轨只有 52px 宽，隐藏滚动条
          collapsed && "no-scrollbar",
        )}
      >
        <div
          role="group"
          aria-label={t("nav.appsGroup")}
          className="flex shrink-0 flex-col"
        >
          {apps.map((app) => (
            <AppNavItem
              key={app}
              app={app}
              collapsed={collapsed}
              selected={onAppPage && activeApp === app}
              status={appStatus(app)}
              terminalCount={terminalCounts[app] ?? 0}
              onSelect={() => onSelectApp(app)}
            />
          ))}
        </div>
      </div>
    </>
  );
}

function modeTag(
  status: AppNavStatus,
  t: (key: string) => string,
): { label: string; className: string } | null {
  if (status.mapping) {
    return {
      label: t("nav.mode.mapping"),
      className: "bg-route-soft text-route-text",
    };
  }
  if (status.mode === "route") {
    return {
      label: t("nav.mode.route"),
      className: "bg-route-soft text-route-text",
    };
  }
  if (status.mode === "stack") {
    return {
      label: t("nav.mode.stack"),
      className: "bg-stack-soft text-stack-text",
    };
  }
  return null;
}

function AppNavItem({
  app,
  collapsed,
  selected,
  status,
  onSelect,
  terminalCount,
}: {
  app: AppId;
  collapsed: boolean;
  selected: boolean;
  status: AppNavStatus;
  onSelect: () => void;
  terminalCount: number;
}) {
  const { t } = useTranslation();
  const name = APP_DISPLAY_NAME[app];
  const tag = modeTag(status, t);
  const modeName = status.mapping
    ? t("nav.mode.mappingFull")
    : status.mode === "route"
      ? t("nav.mode.route")
      : status.mode === "stack"
        ? t("nav.mode.stack")
        : null;
  const tip = status.alert
    ? `${name} · ${t("nav.needsAttention")}`
    : modeName
      ? `${name} · ${modeName}`
      : name;
  const badgeBg = selected ? "bg-selected" : "bg-sidebar";

  if (collapsed) {
    const marker = status.alert
      ? { className: "bg-danger text-action-fg", icon: AlertGlyph }
      : status.mode === "stack"
        ? { className: "bg-stack-solid text-stack-on", icon: Layers }
        : status.mode === "route" || status.mapping
          ? { className: "bg-route-solid text-route-on", icon: Route }
          : null;
    return (
      <HoverTip content={tip} side="right" disableHoverableContent>
        <button
          type="button"
          onClick={onSelect}
          aria-label={tip}
          aria-current={selected ? "page" : undefined}
          className={cn(
            "mx-auto flex h-8 w-10 shrink-0 items-center justify-center rounded-control transition-colors hover:bg-subtle",
            selected && "bg-selected hover:bg-selected",
          )}
        >
          <span className="relative flex">
            <AppGlyph app={app} size={20} badgeClassName={badgeBg} />
            {marker && (
              <span
                aria-hidden="true"
                className={cn(
                  "absolute -end-[7px] -top-1.5 flex h-3.5 w-3.5 items-center justify-center rounded-full border-2",
                  selected ? "border-selected" : "border-sidebar",
                  marker.className,
                )}
              >
                <marker.icon className="h-2 w-2" strokeWidth={3} />
              </span>
            )}
          </span>
        </button>
      </HoverTip>
    );
  }

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? "page" : undefined}
      className={cn(
        "mx-2 flex h-7 w-[184px] shrink-0 items-center gap-2 rounded-control px-2 text-start transition-colors hover:bg-subtle",
        selected && "bg-selected font-medium hover:bg-selected",
      )}
    >
      <AppGlyph app={app} size={16} badgeClassName={badgeBg} />
      <span className="min-w-0 flex-1 truncate">{name}</span>
      {terminalCount > 0 && (
        <span
          className="text-caption text-success-text"
          title={t("terminal.runningCount", { count: terminalCount })}
        >
          {terminalCount}
        </span>
      )}
      {status.alert ? (
        <span
          role="img"
          aria-label={t("nav.needsAttention")}
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-danger"
        />
      ) : (
        // 选中的应用不再显示模式标签：页头下面的模式行已经写明
        tag &&
        !selected && (
          <span
            className={cn(
              "h-[18px] whitespace-nowrap rounded-full px-1.5 text-badge leading-[18px]",
              tag.className,
            )}
          >
            {tag.label}
          </span>
        )
      )}
    </button>
  );
}

function AlertGlyph({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={3.5}
      strokeLinecap="round"
      className={className}
    >
      <path d="M12 4v10" />
      <path d="M12 20h.01" />
    </svg>
  );
}

/**
 * 工具箱：把 MCP / Skills / 提示词 / 会话 合并成「路由」下面的二级菜单。
 * 展开侧栏：点击组行展开/收起，子项导航；收起（图标轨）：点击弹浮层选子项。
 */
function ToolboxNavItem({
  collapsed,
  active,
  open,
  onToggleOpen,
  view,
  onSelectPage,
}: {
  collapsed: boolean;
  /** 当前停在工具箱内任一页（含 Skills 发现页） */
  active: boolean;
  open: boolean;
  onToggleOpen: () => void;
  view: View;
  onSelectPage: (page: GlobalPage | "settings") => void;
}) {
  const { t } = useTranslation();
  const label = t("nav.toolbox");
  const items: { page: GlobalPage; label: string; icon: IconComponent }[] = [
    { page: "mcp", label: "MCP", icon: Server },
    { page: "skills", label: "Skills", icon: SkillsIcon },
    { page: "prompts", label: t("nav.prompts"), icon: BookOpen },
    { page: "sessions", label: t("nav.sessions"), icon: History },
  ];
  const selected = (page: GlobalPage) =>
    view === page || (page === "skills" && view === "skillsDiscovery");

  if (collapsed) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={label}
            aria-current={active ? "page" : undefined}
            className={cn(
              "mx-auto flex h-8 w-10 shrink-0 items-center justify-center rounded-control transition-colors hover:bg-subtle",
              active && "bg-selected hover:bg-selected",
            )}
          >
            <ToolCase aria-hidden className="h-[18px] w-[18px] text-fg-2" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="right" align="start" className="min-w-36">
          {items.map((item) => (
            <DropdownMenuItem
              key={item.page}
              onSelect={() => onSelectPage(item.page)}
            >
              <item.icon className="h-4 w-4" aria-hidden />
              {item.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={onToggleOpen}
        aria-expanded={open}
        className={cn(
          "mx-2 flex h-7 w-[184px] shrink-0 items-center gap-2 rounded-control px-2 text-start transition-colors hover:bg-subtle",
          active && "bg-selected font-medium hover:bg-selected",
        )}
      >
        <span aria-hidden="true" className="flex shrink-0 text-fg-2">
          <ToolCase className="h-[18px] w-[18px]" />
        </span>
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <ChevronDown
          aria-hidden
          className={cn(
            "h-4 w-4 shrink-0 text-fg-3 transition-transform",
            !open && "-rotate-90",
          )}
        />
      </button>
      {open && (
        <div role="group" aria-label={label} className="flex flex-col">
          {items.map((item) => (
            <NavItem
              key={item.page}
              collapsed={false}
              selected={selected(item.page)}
              icon={item.icon}
              label={item.label}
              inset
              onClick={() => onSelectPage(item.page)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function NavItem({
  collapsed,
  selected,
  icon: Icon,
  label,
  title,
  trailing,
  alert,
  dot = false,
  dotTone = "neutral",
  endDot = false,
  inset = false,
  onClick,
}: {
  collapsed: boolean;
  selected: boolean;
  icon: IconComponent;
  label: string;
  title?: string;
  trailing?: string;
  /** 红点：需要处理，内容是给读屏的说明 */
  alert?: string;
  /** 圆点：有更新 */
  dot?: boolean;
  /** 工具更新用中性色（很多人不想追新）；PHI 自己的更新用绿色，和工具更新分开 */
  dotTone?: "neutral" | "success";
  /** 圆点放在行尾（设置目录里的「关于」），而不是图标角上 */
  endDot?: boolean;
  /** 二级菜单子项：缩进对齐一级项的图标列（侧栏 200px 内保持同宽） */
  inset?: boolean;
  onClick: () => void;
}) {
  const ring = selected ? "border-selected" : "border-sidebar";
  const dotFill = dotTone === "success" ? "bg-success" : "bg-fg-1";
  const accessibleName = [label, trailing, alert].filter(Boolean).join(" · ");
  const glyph = (size: number) => (
    <span aria-hidden="true" className="relative flex shrink-0 text-fg-2">
      <Icon className={size === 20 ? "h-5 w-5" : "h-[18px] w-[18px]"} />
      {dot && (collapsed || !endDot) && (
        <span
          className={cn(
            "absolute -end-1 -top-[3px] h-2.5 w-2.5 rounded-full border-2",
            dotFill,
            ring,
          )}
        />
      )}
      {collapsed && alert && (
        <span
          className={cn(
            "absolute -end-[7px] -top-1.5 flex h-3.5 w-3.5 items-center justify-center rounded-full border-2 bg-danger text-action-fg",
            ring,
          )}
        >
          <AlertGlyph className="h-2 w-2" />
        </span>
      )}
    </span>
  );

  if (collapsed) {
    return (
      <HoverTip
        content={title ?? accessibleName}
        side="right"
        disableHoverableContent
      >
        <button
          type="button"
          onClick={onClick}
          aria-label={title ?? accessibleName}
          aria-current={selected ? "page" : undefined}
          className={cn(
            "mx-auto flex h-8 w-10 shrink-0 items-center justify-center rounded-control transition-colors hover:bg-subtle",
            selected && "bg-selected hover:bg-selected",
          )}
        >
          {glyph(20)}
        </button>
      </HoverTip>
    );
  }

  // 展开时名字可见；只有 title 比名字多说了点什么（如「有可用更新」）才挂提示
  return (
    <HoverTip
      content={title !== label ? title : undefined}
      side="right"
      disableHoverableContent
    >
      <button
        type="button"
        onClick={onClick}
        aria-current={selected ? "page" : undefined}
        className={cn(
          "flex h-7 shrink-0 items-center gap-2 rounded-control px-2 text-start transition-colors hover:bg-subtle",
          inset ? "ms-6 me-2 w-[168px]" : "mx-2 w-[184px]",
          selected && "bg-selected font-medium hover:bg-selected",
        )}
      >
        {glyph(18)}
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {trailing && (
          <span className="shrink-0 text-caption tabular-nums text-fg-3">
            {trailing}
          </span>
        )}
        {alert && (
          <span
            role="img"
            aria-label={alert}
            title={alert}
            className="h-1.5 w-1.5 shrink-0 rounded-full bg-danger"
          />
        )}
        {dot && endDot && (
          <span
            aria-hidden="true"
            className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dotFill)}
          />
        )}
      </button>
    </HoverTip>
  );
}

// ─── 设置目录 ──────────────────────────────────────────────────────────────

const SETTINGS_ITEMS: { section: SettingsSection; icon: IconComponent }[] = [
  { section: "general", icon: SlidersHorizontal },
  { section: "auth", icon: KeyRound },
  { section: "apps", icon: LayoutGrid },
  { section: "routing", icon: Route },
  { section: "network", icon: Globe },
  { section: "data", icon: Database },
  { section: "about", icon: Info },
];

function SettingsDirectory({
  collapsed,
  settingsSection,
  expertMode = false,
  onSelectSettingsSection,
  appsUpdateAvailable = false,
}: DirectoryProps) {
  const { t } = useTranslation();
  const { hasUpdate } = useUpdate();
  const { authNeedsAttention } = useSidebarStatus();
  const { data: version } = useQuery({
    queryKey: ["app-version"],
    queryFn: () => getVersion(),
    staleTime: Infinity,
  });
  const visibleSections = new Set(visibleSettingsSections(expertMode));

  return (
    <>
      {!collapsed && (
        <div className="mt-3 px-4 pb-1 text-badge text-fg-3">
          {t("nav.settings")}
        </div>
      )}
      <div
        role="group"
        aria-label={t("nav.settings")}
        className={cn("flex min-h-0 flex-1 flex-col", collapsed && "mt-2")}
      >
        {SETTINGS_ITEMS.filter(({ section }) =>
          visibleSections.has(section),
        ).map(({ section, icon }) => (
          <NavItem
            key={section}
            collapsed={collapsed}
            selected={settingsSection === section}
            icon={icon}
            label={t(
              section === "auth" || section === "apps"
                ? `nav.${section}`
                : `settings.sections.${section}`,
            )}
            alert={
              section === "auth" && authNeedsAttention
                ? t("nav.authNeedsReauth")
                : undefined
            }
            dot={
              (section === "about" && hasUpdate) ||
              (section === "apps" && appsUpdateAvailable)
            }
            dotTone={section === "about" ? "success" : "neutral"}
            endDot
            title={
              section === "about" && hasUpdate
                ? t("nav.settingsHasUpdate")
                : section === "apps" && appsUpdateAvailable
                  ? t("nav.appsHasUpdate")
                  : undefined
            }
            onClick={() => onSelectSettingsSection(section)}
          />
        ))}
      </div>
      {!collapsed && version && (
        <div className="shrink-0 px-4 pb-4 text-caption text-fg-3">
          PHI v{version}
        </div>
      )}
    </>
  );
}

export type { SidebarProps };
