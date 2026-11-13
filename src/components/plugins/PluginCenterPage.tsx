import { useTranslation } from "react-i18next";
import { ArrowUpRight, Pin, PinOff, Plus, RefreshCw } from "lucide-react";
import { AppPageHeader } from "@/components/shell/AppPageHeader";
import { PageHeaderBackButton } from "@/components/shell/PageHeaderBackButton";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { PageTabs } from "@/components/ui/page-tabs";
import { ReportCardPage } from "@/components/reportcard/ReportCardPage";
import {
  usePluginCenterEntries,
  usePluginSummaries,
  type PluginCenterEntry,
} from "@/hooks/usePluginCatalog";
import { commandErrorMessage } from "@/lib/api/plugins";
import { cn } from "@/lib/utils";
import { LessonsPanel } from "./LessonsPanel";
import { McpRouterPanel } from "./McpRouterPanel";
import { PluginDetailPage } from "./PluginDetailPage";
import { pluginPageClass } from "./pluginPage";
import { PrivacyPanel } from "./PrivacyPanel";

// 主页页签用插件 id 不可能出现的字符，避免和某个叫 "home" 的插件撞名。
const HOME_TAB = "@home";

interface PluginCenterPageProps {
  /** 从别处下钻进来时的返回入口 */
  onBack?: () => void;
  /** 当前打开的插件 id；`null` 表示停在插件中心主页 */
  activePluginId: string | null;
  /** 打开某个插件，或回到主页（传 `null`） */
  onSelectPlugin: (pluginId: string | null) => void;
  /** 已钉在侧栏的插件 id */
  pinnedPluginIds: string[];
  /** 插件页右上角的钉住按钮 */
  onTogglePin: (pluginId: string) => void;
}

/**
 * 插件中心：主页是一排插件卡片，点进去才是某个插件的主页。
 *
 * 卡片与后端的插件清单分开建模（见 `usePluginCatalog`）：成绩单、接棒来自清单，
 * 隐私脱敏、MCP 路由、教训库是宿主自带的配置能力，但在界面上是同一层的东西。
 * 插件主页右上角可以把它钉在侧栏一级导航里，钉住状态只存在本地。
 */
export function PluginCenterPage({
  onBack,
  activePluginId,
  onSelectPlugin,
  pinnedPluginIds,
  onTogglePin,
}: PluginCenterPageProps) {
  const { t } = useTranslation();
  const entries = usePluginCenterEntries();
  const activeEntry = activePluginId
    ? (entries.find((entry) => entry.id === activePluginId) ?? null)
    : null;

  const tabs = [
    { value: HOME_TAB, label: t("pluginCenter.title") },
    ...(activePluginId
      ? [
          {
            value: activePluginId,
            label: activeEntry?.title ?? activePluginId,
          },
        ]
      : []),
  ];

  const pinned = activePluginId
    ? pinnedPluginIds.includes(activePluginId)
    : false;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <AppPageHeader
        leading={onBack && <PageHeaderBackButton onClick={onBack} />}
        title={null}
        tabs={
          <PageTabs
            size="lg"
            // 与用量页一致：页签底线压在页头分割线上
            className="self-end -mb-px"
            aria-label={t("pluginCenter.title")}
            idPrefix="plugin-center-tab"
            controls="plugin-center-tabpanel"
            value={activePluginId ?? HOME_TAB}
            onValueChange={(value) =>
              onSelectPlugin(value === HOME_TAB ? null : value)
            }
            items={tabs}
          />
        }
        actions={
          activeEntry && (
            <Button
              type="button"
              variant="quiet"
              size="compact"
              aria-pressed={pinned}
              onClick={() => onTogglePin(activeEntry.id)}
            >
              {pinned ? (
                <PinOff className="me-1.5 h-3.5 w-3.5" />
              ) : (
                <Pin className="me-1.5 h-3.5 w-3.5" />
              )}
              {pinned ? t("pluginCenter.pin.unpin") : t("pluginCenter.pin.pin")}
            </Button>
          )
        }
      />
      <div
        id="main-content"
        className="min-h-0 flex-1 overflow-y-auto scroll-stable pt-3"
      >
        <div
          id="plugin-center-tabpanel"
          role="tabpanel"
          aria-labelledby={`plugin-center-tab-${activePluginId ?? HOME_TAB}`}
        >
          {activePluginId ? (
            <PluginPage entry={activeEntry} />
          ) : (
            <PluginHomePage
              entries={entries}
              pinnedPluginIds={pinnedPluginIds}
              onOpen={onSelectPlugin}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/** 插件主页：按 id 分派到具体面板；未知插件给一句可恢复的提示。 */
function PluginPage({ entry }: { entry: PluginCenterEntry | null }) {
  const { t } = useTranslation();
  if (!entry) {
    return (
      <div className={pluginPageClass}>
        <Notice tone="warning" title={t("pluginCenter.detail.missing")} />
      </div>
    );
  }
  if (entry.kind === "config") {
    if (entry.id === "privacy") return <PrivacyPanel />;
    if (entry.id === "mcp-router") return <McpRouterPanel />;
    if (entry.id === "lessons") return <LessonsPanel />;
  }
  if (entry.kind === "panel" && entry.id === "report-card") {
    return <ReportCardPage embedded />;
  }
  return <PluginDetailPage entry={entry} />;
}

function PluginHomePage({
  entries,
  pinnedPluginIds,
  onOpen,
}: {
  entries: PluginCenterEntry[];
  pinnedPluginIds: string[];
  onOpen: (pluginId: string) => void;
}) {
  const { t } = useTranslation();
  const { data, error, isLoading, isFetching, refetch } = usePluginSummaries();

  const root = data?.root ?? null;
  const errors = data?.errors ?? [];
  const errorMessage = error ? commandErrorMessage(error) : null;
  const busy = isLoading || isFetching;

  return (
    <div className={cn(pluginPageClass, "space-y-4")}>
      {errorMessage && (
        <Notice
          tone="danger"
          title={t("pluginCenter.home.loadFailed")}
          actions={
            <Button size="compact" onClick={() => void refetch()}>
              {t("pluginCenter.refresh")}
            </Button>
          }
        >
          {errorMessage}
        </Notice>
      )}

      {errors.length > 0 && (
        <Notice tone="warning" title={t("pluginCenter.home.loadFailures")}>
          <ul className="space-y-0.5">
            {errors.map((failure) => (
              <li key={`${failure.pluginDir}:${failure.message}`}>
                <span className="font-medium">{failure.pluginDir}</span>：
                {failure.message}
              </li>
            ))}
          </ul>
        </Notice>
      )}

      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {entries.map((entry) => (
          <li key={entry.id}>
            <PluginCard
              entry={entry}
              pinned={pinnedPluginIds.includes(entry.id)}
              onOpen={() => onOpen(entry.id)}
            />
          </li>
        ))}
        <li>
          <AddPluginSlot
            root={root}
            busy={busy}
            onRefresh={() => void refetch()}
          />
        </li>
      </ul>
    </div>
  );
}

function PluginCard({
  entry,
  pinned,
  onOpen,
}: {
  entry: PluginCenterEntry;
  pinned: boolean;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const Icon = entry.icon;
  // 只有「停用」值得单独说一句：其余状态是默认值，写在每张卡片上只是噪音。
  const disabled = entry.status === "disabled";

  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex h-full w-full flex-col gap-2.5 rounded-panel border border-border bg-surface p-4 text-start transition-[border-color,box-shadow] duration-150 hover:border-border-strong hover:shadow-v7-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="flex items-center gap-2.5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-control bg-subtle text-fg-2 ring-1 ring-border transition-colors group-hover:text-fg-1">
          <Icon className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1 truncate text-strong text-fg-1">
          {entry.title}
        </span>
        {pinned && (
          <Pin
            className="h-3 w-3 shrink-0 text-fg-3"
            aria-label={t("pluginCenter.home.pinned")}
          />
        )}
        <ArrowUpRight
          aria-hidden="true"
          className="h-4 w-4 shrink-0 text-fg-3 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100"
        />
      </span>
      {entry.description && (
        <p
          className="line-clamp-2 text-body text-fg-2"
          title={entry.description}
        >
          {entry.description}
        </p>
      )}
      {disabled && (
        <span className="mt-auto pt-0.5 text-caption text-fg-3">
          {t("pluginCenter.home.disabled")}
        </span>
      )}
    </button>
  );
}

/** 卡片末尾的一格空位：告诉人插件从哪来，刷新的入口也在这里。 */
function AddPluginSlot({
  root,
  busy,
  onRefresh,
}: {
  root: string | null;
  busy: boolean;
  onRefresh: () => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="flex h-full flex-col gap-2 rounded-panel border border-dashed border-border p-4">
      <span className="flex items-center gap-2.5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-control text-fg-3">
          <Plus className="h-4 w-4" />
        </span>
        <span className="text-strong text-fg-2">
          {t("pluginCenter.home.addPlugin.title")}
        </span>
      </span>
      <p className="text-caption text-fg-3">
        {t("pluginCenter.home.addPlugin.body")}
      </p>
      {root && (
        <p className="truncate font-mono text-caption text-fg-3" title={root}>
          {root}
        </p>
      )}
      <Button
        variant="ghost"
        size="compact"
        className="mt-auto self-start"
        onClick={onRefresh}
        disabled={busy}
      >
        <RefreshCw
          className={cn("me-1.5 h-3.5 w-3.5", busy && "animate-spin")}
        />
        {t("pluginCenter.refresh")}
      </Button>
    </div>
  );
}
