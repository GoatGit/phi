import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowUpCircle,
  Copy,
  Download,
  LayoutGrid,
  Loader2,
  MoreHorizontal,
  RefreshCw,
} from "lucide-react";
import { providersApi } from "@/lib/api/providers";
import type { ToolInstallationReport } from "@/lib/api/settings";
import { type LocalRoutableAppId } from "@/config/appConfig";
import { useSettings } from "@/hooks/useSettings";
import { isUpdateAvailable } from "@/lib/version";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { HelpTip } from "@/components/ui/help-tip";
import { HoverTip } from "@/components/ui/hover-tip";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AppPageHeader } from "@/components/shell/AppPageHeader";
import { PageHeaderBackButton } from "@/components/shell/PageHeaderBackButton";
import {
  APP_DISPLAY_NAME,
  AppGlyph,
  getAppDisplayName,
} from "@/components/shell/AppGlyph";
import { ToolUpgradeConfirmDialog } from "@/components/settings/ToolUpgradeConfirmDialog";
import { ToolErrorMessage } from "@/components/settings/ToolErrorMessage";
import {
  ENV_BADGE_CONFIG,
  ONE_CLICK_INSTALL_COMMANDS,
  ROUTE_TOOL_APP_IDS,
  TOOL_APP_IDS,
  TOOL_NAMES,
  toolDisplayName,
  useToolManagement,
  WSL_SHELL_FLAG_OPTIONS,
  WSL_SHELL_OPTIONS,
  type ToolLifecycleAction,
  type ToolName,
} from "./useToolManagement";

/** 安装来源的显示名：只标认得出的，认不出（system）就不标，免得标错。 */
const SOURCE_LABEL: Record<string, string> = {
  homebrew: "Homebrew",
  nvm: "npm",
  volta: "npm",
  fnm: "npm",
  mise: "npm",
  bun: "bun",
  pnpm: "pnpm",
  scoop: "Scoop",
  pip: "pip",
};

type Row =
  | { kind: "tool"; tool: ToolName }
  | { kind: "route-tool"; tool: ToolName; app: LocalRoutableAppId }
  | { kind: "desktop" }
  | { kind: "observability"; app: "zcode" };

/** 路由专用应用：没有完整应用页，但在「应用」页也能装 / 升。 */
const ROUTE_TOOLS = Object.keys(ROUTE_TOOL_APP_IDS) as ToolName[];

const ROWS: Row[] = [
  { kind: "tool", tool: "claude" },
  { kind: "desktop" },
  { kind: "observability", app: "zcode" },
  ...TOOL_NAMES.filter(
    (tool) => tool !== "claude" && !ROUTE_TOOLS.includes(tool),
  ).map((tool): Row => ({ kind: "tool", tool })),
  ...ROUTE_TOOLS.map(
    (tool): Row => ({
      kind: "route-tool",
      tool,
      app: ROUTE_TOOL_APP_IDS[tool]!,
    }),
  ),
];

function formatCheckedAt(timestamp: number, locale: string): string {
  const date = new Date(timestamp);
  const now = new Date();
  const time = date.toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
  });
  return date.toDateString() === now.toDateString()
    ? time
    : `${date.toLocaleDateString(locale, { month: "numeric", day: "numeric" })} ${time}`;
}

/**
 * 「应用」页（v7）：每个应用一行 = 安装状态 / 版本 + 安装 / 升级 + 在侧栏显示的开关。
 * 隐藏一个应用只影响界面（侧栏、MCP / Skills 的列、提示词和会话的下拉），配置照常同步。
 */
export function AppsPage({
  onBack,
  embedded = false,
}: {
  onBack?: () => void;
  /** 设置在页内标签里打开：不画自己的页头，操作按钮放到内容顶部。 */
  embedded?: boolean;
} = {}) {
  const { t, i18n } = useTranslation();
  const tools = useToolManagement();
  const { settings, updateSettings, autoSaveSettings } = useSettings();
  const [showCommands, setShowCommands] = useState(false);
  const { data: desktopStatus } = useQuery({
    queryKey: ["claude-desktop-status"],
    queryFn: () => providersApi.getClaudeDesktopStatus(),
    staleTime: 30_000,
  });

  const sidebarApps = Array.isArray(settings?.sidebarApps)
    ? settings.sidebarApps
    : [];
  const inSidebar = (app: string) => sidebarApps.includes(app);

  // 「显示」开关 = 侧栏里的快捷方式。只改左侧菜单，不影响应用配置与同步。
  const setInSidebar = (app: string, visible: boolean) => {
    if (!settings) return;
    const next = visible
      ? [...sidebarApps.filter((id) => id !== app), app]
      : sidebarApps.filter((id) => id !== app);
    const previous = settings.sidebarApps;
    updateSettings({ sidebarApps: next });
    void autoSaveSettings({ sidebarApps: next }).catch(() =>
      updateSettings({ sidebarApps: previous }),
    );
  };

  const visibilitySwitch = (app: string) => (
    <Switch
      size="sm"
      checked={inSidebar(app)}
      disabled={!settings}
      onCheckedChange={(checked) => setInSidebar(app, checked)}
      aria-label={t("appsPage.showInSidebar", {
        name: getAppDisplayName(app),
      })}
    />
  );

  const lastChecked = tools.lastCheckedAt
    ? t("appsPage.lastChecked", {
        time: formatCheckedAt(tools.lastCheckedAt, i18n.language),
      })
    : t("appsPage.neverChecked");

  const actions = (
    <>
      <span className="whitespace-nowrap text-caption text-fg-3">
        {lastChecked}
      </span>
      {(tools.updatableToolNames.length > 0 || tools.batchAction) && (
        <Button
          variant="neutral"
          size="regular"
          disabled={tools.isLoadingTools || Boolean(tools.batchAction)}
          aria-busy={Boolean(tools.batchAction)}
          onClick={() =>
            void tools.handleRunToolAction(tools.updatableToolNames, "update", {
              fromBatchEntry: true,
            })
          }
        >
          {tools.batchAction === "update" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <ArrowUpCircle className="h-3.5 w-3.5" />
          )}
          {t("settings.updateAllTools", {
            count: tools.updatableToolNames.length,
          })}
        </Button>
      )}
      <Button
        variant="neutral"
        size="regular"
        disabled={tools.isLoadingTools || tools.isAnyBusy}
        onClick={() => void tools.checkForUpdates()}
      >
        <RefreshCw
          className={cn("h-3.5 w-3.5", tools.isLoadingTools && "animate-spin")}
        />
        {tools.isLoadingTools
          ? t("appsPage.checking")
          : t("appsPage.checkUpdates")}
      </Button>
      <DropdownMenu>
        <HoverTip content={t("common.more")}>
          <DropdownMenuTrigger asChild>
            <Button
              variant="quiet"
              size="icon-compact"
              className="h-8 w-8"
              aria-label={t("appsPage.moreActions")}
            >
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
        </HoverTip>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setShowCommands(true)}>
            {t("appsPage.manualCommands")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );

  const content = (
    <>
      <div className="flex h-8 items-center px-4 text-caption font-medium text-fg-2">
        <span className="flex-1">{t("appsPage.columnApp")}</span>
        <span className="w-[168px] text-end">
          {t("appsPage.columnVersion")}
        </span>
        <span className="w-[104px]" />
        <span className="flex w-[64px] items-center justify-end gap-0.5">
          {t("appsPage.columnVisible")}
          <HelpTip title={t("appsPage.columnVisible")} align="end">
            {t("appsPage.visibleHelp")}
          </HelpTip>
        </span>
      </div>

      <div className="divide-y divide-border overflow-hidden rounded-panel border border-border bg-surface">
        {ROWS.map((row) =>
          row.kind === "observability" ? (
            <AppRow
              key={row.app}
              app={row.app}
              name={
                <span className="flex items-center gap-1">
                  {APP_DISPLAY_NAME[row.app]}
                  <HelpTip title={t("appsPage.observabilityHelp")}>
                    {t("appsPage.observabilityHelp")}
                  </HelpTip>
                </span>
              }
              version={
                <span className="text-caption text-fg-2">
                  {t("appsPage.observabilityVersion")}
                </span>
              }
              visibility={visibilitySwitch(row.app)}
            />
          ) : row.kind === "desktop" ? (
            <AppRow
              key="claude-desktop"
              app="claude-desktop"
              name={
                <span className="flex items-center gap-1">
                  {APP_DISPLAY_NAME["claude-desktop"]}
                  <HelpTip title={APP_DISPLAY_NAME["claude-desktop"]}>
                    {t("appsPage.desktopHelp")}
                  </HelpTip>
                </span>
              }
              version={
                <span className="text-caption text-fg-2">
                  {desktopStatus?.supported === false
                    ? t("appsPage.desktopUnsupported")
                    : desktopStatus?.configured
                      ? t("appsPage.desktopConnected")
                      : t("appsPage.desktopNotConnected")}
                </span>
              }
              visibility={visibilitySwitch("claude-desktop")}
            />
          ) : row.kind === "route-tool" ? (
            <ToolRow
              key={row.tool}
              tool={row.tool}
              tools={tools}
              app={row.app}
              label={getAppDisplayName(row.app)}
              routeOnly
              visibility={visibilitySwitch(row.app)}
            />
          ) : (
            <ToolRow
              key={row.tool}
              tool={row.tool}
              tools={tools}
              visibility={visibilitySwitch(TOOL_APP_IDS[row.tool]!)}
            />
          ),
        )}
      </div>
    </>
  );

  return (
    <>
      {embedded ? (
        <div className="mx-auto w-full max-w-[760px] px-6 pb-10 pt-4">
          <div className="mb-2 flex flex-wrap items-center justify-end gap-2">
            {actions}
          </div>
          {content}
        </div>
      ) : (
        <>
          <AppPageHeader
            leading={onBack && <PageHeaderBackButton onClick={onBack} />}
            icon={<LayoutGrid className="h-5 w-5" strokeWidth={1.5} />}
            title={t("nav.apps")}
            titleExtra={
              <HelpTip title={t("appsPage.helpTitle")}>
                {t("appsPage.helpBody")}
              </HelpTip>
            }
            actions={actions}
          />
          <div
            id="main-content"
            className="min-h-0 flex-1 overflow-y-auto scroll-stable"
          >
            <div className="px-6 pb-10 pt-4">{content}</div>
          </div>
        </>
      )}

      <Dialog open={showCommands} onOpenChange={setShowCommands}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("settings.manualInstallCommands")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 px-6">
            <p className="text-body text-fg-2">
              {t("settings.oneClickInstallHint")}
            </p>
            <pre className="max-h-[50vh] overflow-auto rounded-control border border-border bg-subtle px-3 py-2.5 font-mono text-caption">
              {ONE_CLICK_INSTALL_COMMANDS}
            </pre>
          </div>
          <DialogFooter>
            <Button
              variant="neutral"
              size="regular"
              onClick={() => setShowCommands(false)}
            >
              {t("common.close")}
            </Button>
            <Button
              variant="solid"
              size="regular"
              onClick={() => void tools.handleCopyInstallCommands()}
            >
              <Copy className="h-3.5 w-3.5" />
              {t("common.copy")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ToolUpgradeConfirmDialog
        isOpen={tools.pendingUpgrade !== null}
        plans={tools.pendingUpgrade?.plans ?? []}
        displayName={toolDisplayName}
        onConfirm={tools.handleConfirmUpgrade}
        onCancel={tools.handleCancelUpgrade}
      />
    </>
  );
}

function AppRow({
  app,
  name,
  meta,
  version,
  action,
  visibility,
  footer,
}: {
  app: string;
  name: React.ReactNode;
  meta?: React.ReactNode;
  version?: React.ReactNode;
  action?: React.ReactNode;
  visibility: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <div data-tool-row className="px-4 py-3">
      <div className="flex items-center gap-4">
        <AppGlyph app={app} size={20} badgeClassName="bg-surface" />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5 text-strong text-fg-1">
            {name}
          </div>
          {meta && (
            <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-caption text-fg-2">
              {meta}
            </div>
          )}
        </div>
        <div className="w-[168px] shrink-0 text-end">{version}</div>
        <div className="flex w-[104px] shrink-0 justify-end">{action}</div>
        <div className="flex w-[64px] shrink-0 justify-end">{visibility}</div>
      </div>
      {footer && <div className="ms-9 mt-2">{footer}</div>}
    </div>
  );
}

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex h-[18px] shrink-0 items-center rounded-full border border-border-strong px-1.5 text-badge text-fg-2">
      {children}
    </span>
  );
}

function ToolRow({
  tool,
  tools,
  visibility,
  app,
  label,
  routeOnly = false,
}: {
  tool: ToolName;
  tools: ReturnType<typeof useToolManagement>;
  visibility: React.ReactNode;
  /** 行图标的应用 id：核心应用用 TOOL_APP_IDS，路由专用应用用它们的 AppId。 */
  app?: string;
  label?: string;
  /** 路由专用应用：在名称后标注，并解释它始终在侧栏。 */
  routeOnly?: boolean;
}) {
  const { t } = useTranslation();
  const info = tools.toolVersionByName.get(tool);
  const report: ToolInstallationReport | undefined =
    tools.installReports?.[tool];
  const defaultInstall =
    report?.installs.find((install) => install.is_path_default) ??
    report?.installs[0];
  const isVersionLoading =
    Boolean(tools.loadingTools[tool]) ||
    (tools.isLoadingTools && !tools.toolVersionByName.has(tool));
  const isOutdated = isUpdateAvailable(info?.version, info?.latest_version);
  const broken = Boolean(info?.installed_but_broken);
  const isBusy = tools.busyTools.has(tool);
  const action: ToolLifecycleAction | null =
    tools.busyTools.get(tool) ??
    (isVersionLoading || broken
      ? null
      : !info?.version
        ? "install"
        : isOutdated
          ? "update"
          : null);
  const sourceLabel = defaultInstall
    ? SOURCE_LABEL[defaultInstall.source]
    : undefined;
  const envBadge =
    info?.env_type === "wsl" && ENV_BADGE_CONFIG.wsl
      ? `${t(ENV_BADGE_CONFIG.wsl.labelKey)}${info.wsl_distro ? ` · ${info.wsl_distro}` : ""}`
      : null;

  const version = isVersionLoading ? (
    <span
      role="status"
      aria-label={t("common.loading")}
      className="inline-flex justify-end"
    >
      <Loader2 className="h-4 w-4 animate-spin text-fg-3" />
    </span>
  ) : info?.version ? (
    <div>
      <div className="font-mono text-body font-medium tabular-nums text-fg-1">
        {info.version}
      </div>
      {isOutdated && info.latest_version && (
        <div className="text-caption text-fg-2">
          {t("appsPage.newVersion", { version: info.latest_version })}
        </div>
      )}
    </div>
  ) : broken ? (
    <span className="inline-flex items-center gap-1 text-caption font-medium text-warning-text">
      <AlertTriangle className="h-3.5 w-3.5" />
      {t("appsPage.notRunnable")}
    </span>
  ) : (
    <span className="text-caption text-fg-2">{t("common.notInstalled")}</span>
  );

  const actionButton = action ? (
    <Button
      variant="neutral"
      size="compact"
      onClick={() => void tools.handleRunToolAction([tool], action)}
      disabled={isVersionLoading || isBusy}
      aria-busy={isBusy}
    >
      {isBusy ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : action === "install" ? (
        <Download className="h-3.5 w-3.5" />
      ) : (
        <ArrowUpCircle className="h-3.5 w-3.5" />
      )}
      {action === "install"
        ? t("settings.toolInstall")
        : t("settings.toolUpdate")}
    </Button>
  ) : null;

  const meta = defaultInstall ? (
    <>
      <span className="min-w-0 truncate font-mono" title={defaultInstall.path}>
        {defaultInstall.path}
      </span>
    </>
  ) : !info?.version && !isVersionLoading ? (
    <span>{t(`appsPage.installHint.${tool}`, { defaultValue: "" })}</span>
  ) : null;

  const wslControls =
    info?.env_type === "wsl" ? (
      <div className="flex items-center gap-2 text-caption text-fg-2">
        <span>Shell</span>
        <Select
          value={tools.wslShellByTool[tool]?.wslShell || "auto"}
          onValueChange={(value) =>
            void tools.handleToolShellChange(tool, value)
          }
          disabled={isVersionLoading || isBusy}
        >
          <SelectTrigger className="h-7 w-[82px] text-caption">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="auto">{t("common.auto")}</SelectItem>
            {WSL_SHELL_OPTIONS.map((shell) => (
              <SelectItem key={shell} value={shell}>
                {shell}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span>{t("appsPage.wslFlag")}</span>
        <Select
          value={tools.wslShellByTool[tool]?.wslShellFlag || "auto"}
          onValueChange={(value) =>
            void tools.handleToolShellFlagChange(tool, value)
          }
          disabled={isVersionLoading || isBusy}
        >
          <SelectTrigger className="h-7 w-[82px] text-caption">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="auto">{t("common.auto")}</SelectItem>
            {WSL_SHELL_FLAG_OPTIONS.map((flag) => (
              <SelectItem key={flag} value={flag}>
                {flag}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    ) : null;

  const errorLine =
    !isVersionLoading && !info?.version && info?.error ? (
      <ToolErrorMessage message={info.error} />
    ) : null;

  const footer =
    wslControls || errorLine ? (
      <div className="space-y-2">
        {errorLine}
        {wslControls}
      </div>
    ) : undefined;

  return (
    <AppRow
      app={app ?? TOOL_APP_IDS[tool] ?? tool}
      name={
        <>
          <span className="truncate">{label ?? toolDisplayName(tool)}</span>
          {routeOnly && <Pill>{t("appsPage.routeOnly")}</Pill>}
          {sourceLabel && <Pill>{sourceLabel}</Pill>}
          {envBadge && <Pill>{envBadge}</Pill>}
        </>
      }
      meta={meta}
      version={version}
      action={actionButton}
      visibility={visibility}
      footer={footer}
    />
  );
}
