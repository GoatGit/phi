import { useTranslation } from "react-i18next";
import { Pin, PinOff, RefreshCw } from "lucide-react";
import { AppPageHeader } from "@/components/shell/AppPageHeader";
import { PageHeaderBackButton } from "@/components/shell/PageHeaderBackButton";
import { Badge } from "@/components/ui/badge";
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
      <div className="px-6 pb-10">
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

const STATUS_LABEL_KEYS: Record<
  Exclude<PluginCenterEntry["status"], "unknown">,
  string
> = {
  enabled: "pluginCenter.home.enabled",
  disabled: "pluginCenter.home.disabled",
  "always-on": "pluginCenter.home.alwaysOn",
};

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

  return (
    <div className="space-y-5 px-6 pb-10">
      <section className="space-y-1">
        <p className="text-body text-fg-2">{t("pluginCenter.home.intro")}</p>
        {root && (
          <p className="text-caption text-fg-3">
            {t("pluginCenter.home.dir")}：{root}
          </p>
        )}
      </section>

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

      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {entries.map((entry) => (
          <li key={entry.id}>
            <PluginCard
              entry={entry}
              pinned={pinnedPluginIds.includes(entry.id)}
              onOpen={() => onOpen(entry.id)}
            />
          </li>
        ))}
      </ul>

      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="compact"
          onClick={() => void refetch()}
          disabled={isLoading || isFetching}
        >
          <RefreshCw
            className={cn(
              "me-1.5 h-3.5 w-3.5",
              (isLoading || isFetching) && "animate-spin",
            )}
          />
          {t("pluginCenter.refresh")}
        </Button>
      </div>
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
  const statusLabel =
    entry.status === "unknown" ? null : t(STATUS_LABEL_KEYS[entry.status]);

  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex h-full w-full flex-col gap-3 rounded-panel border border-border bg-surface p-4 text-start transition-[border-color,background-color] duration-150 hover:border-border-strong hover:bg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-control bg-subtle text-fg-1 ring-1 ring-border">
          <Icon className="h-[18px] w-[18px]" />
        </span>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-strong font-medium text-fg-1">
              {entry.title}
            </span>
            {pinned && (
              <Pin
                className="h-3 w-3 shrink-0 text-fg-3"
                aria-label={t("pluginCenter.home.pinned")}
              />
            )}
          </div>
          {entry.description && (
            <p className="line-clamp-2 text-caption text-fg-2">
              {entry.description}
            </p>
          )}
        </div>
      </div>
      {statusLabel && (
        <div className="mt-auto flex items-center gap-1.5 text-caption text-fg-3">
          <span
            aria-hidden="true"
            className={cn(
              "h-1.5 w-1.5 rounded-full",
              entry.status === "disabled" ? "bg-fg-3" : "bg-success",
            )}
          />
          <span>{statusLabel}</span>
          {entry.kind === "config" && (
            <Badge variant="outline" className="ms-1 text-fg-3">
              {t("pluginCenter.home.builtin")}
            </Badge>
          )}
        </div>
      )}
    </button>
  );
}
