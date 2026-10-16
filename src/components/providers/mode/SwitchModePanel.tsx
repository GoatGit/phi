import { useEffect, useMemo, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "@/lib/toast";
import type { Provider } from "@/types";
import type { AppMode, StartupAttachFailure } from "@/types/proxy";
import type { ProxyAppId } from "@/config/appConfig";
import { providersApi } from "@/lib/api/providers";
import { proxyApi } from "@/lib/api/proxy";
import {
  appRouteGroup,
  gatewayApi,
  type GatewayRouteGroup,
} from "@/lib/api/gateway";
import { proxyKeys, useAppMode, useProxyStatusQuery } from "@/lib/query/proxy";
import { useModeActions } from "@/hooks/useModeActions";
import { getRoutingReason } from "@/utils/routingReason";
import { extractErrorMessage } from "@/utils/errorUtils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Notice } from "@/components/ui/notice";
import { ProviderList } from "@/components/providers/ProviderList";
import {
  useGatewayCatalog,
  useGatewayErrorMessage,
} from "@/components/gateway/useGatewayCatalog";
import { APP_DISPLAY_NAME } from "@/components/shell/AppGlyph";
import { ModeTabs } from "./ModeTabs";
import { ModeDialog, type ModeDialogState } from "./ModeDialog";
import { RouteSettingsSheet } from "./RouteSettingsSheet";

type ListCallbacks = Pick<
  React.ComponentProps<typeof ProviderList>,
  | "onEdit"
  | "onDelete"
  | "onDuplicate"
  | "onConfigureUsage"
  | "onOpenWebsite"
  | "onOpenTerminal"
  | "onCreate"
  | "searchOpen"
  | "onSearchOpenChange"
>;

interface SwitchModePanelProps extends ListCallbacks {
  app: ProxyAppId;
  providers: Record<string, Provider>;
  currentProviderId: string;
  isLoading: boolean;
  scrollRef?: RefObject<HTMLDivElement>;
  onSwitch: (
    provider: Provider,
    options?: { acknowledgedRouting?: boolean },
  ) => unknown;
  /** 无可用路由组时的「去路由页创建」：跳到路由策略标签 */
  onOpenRoutingPage: () => void;
  startupFailure?: StartupAttachFailure;
  onDismissStartupFailure?: () => void;
  /** 托盘里点了直连下需要路由的那家：到这页后弹同一个「需要路由」对话框 */
  needsRouteRequest?: { providerId: string; nonce: number };
  onNeedsRouteHandled?: () => void;
  /** 正在看的那格变了：新增 / 编辑供应商按它选表单布局。需要是稳定的回调 */
  onViewChange?: (app: ProxyAppId, view: AppMode) => void;
}

/** 聚合模式已废弃：代理一律走路由组，确认框里选的就是组。 */
const CONNECTION_MODES: AppMode[] = ["direct", "route"];

/**
 * 切换式应用的供应商页（v7 S1–S3）：模式行 → 通知槽 → 直连列表 / 路由组列表。
 * tab 只负责查看；启用代理必须选一个路由组并确认（改写客户端文件的后果写在确认框里），
 * 回到直连一步完成、可撤销。
 */
export function SwitchModePanel({
  app,
  providers,
  currentProviderId,
  isLoading,
  scrollRef,
  onSwitch,
  onOpenRoutingPage,
  startupFailure,
  onDismissStartupFailure,
  needsRouteRequest,
  onNeedsRouteHandled,
  onViewChange,
  ...listCallbacks
}: SwitchModePanelProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const appName = APP_DISPLAY_NAME[app];
  const modes = CONNECTION_MODES;

  const { data: modeView } = useAppMode(app);
  // 兼容旧后端 / 缓存返回的 stack，连接方式统一显示为代理。
  const active: AppMode =
    modeView && modeView.mode !== "direct" ? "route" : "direct";
  const directId = modeView?.directProviderId ?? null;
  const routeId = modeView?.routeProviderId ?? null;

  // 离开页面再回来、或生效的模式变了，一律落在生效的那格（「查看中」不持久化）
  const [view, setView] = useState<AppMode>(active);
  useEffect(() => {
    setView(active);
  }, [app, active]);
  useEffect(() => {
    onViewChange?.(app, view);
  }, [app, view, onViewChange]);

  const { data: proxyStatus } = useProxyStatusQuery();
  const serviceRunning = proxyStatus?.running ?? false;
  const { data: catalog } = useGatewayCatalog();
  const describeGatewayError = useGatewayErrorMessage();
  const modeActions = useModeActions(app);

  const [dialog, setDialog] = useState<ModeDialogState | null>(null);
  const [activating, setActivating] = useState(false);
  const [routeSettingsOpen, setRouteSettingsOpen] = useState(false);

  // ─── 路由组连接状态 ───────────────────────────────────────────────────────
  const isProxy = active !== "direct";
  const routeIdIsEntry = routeId?.startsWith("gateway-entry:") ?? false;
  // appRouteGroup 有兜底（策略/第一个组），只在确实是组连接时才采信
  const boundGroupId =
    isProxy && routeIdIsEntry && catalog ? appRouteGroup(catalog, app) : null;
  const boundGroup =
    catalog?.groups?.find((g) => g.id === boundGroupId) ?? null;
  const isLegacyRoute = isProxy && !routeIdIsEntry;
  const availableGroups = useMemo(
    () =>
      (catalog?.groups ?? []).filter(
        (g) => g.enabled && g.appIds.includes(app),
      ),
    [catalog, app],
  );

  const memberSummary = (group: GatewayRouteGroup) =>
    [
      ...new Set(
        group.members
          .filter((m) => m.enabled)
          .map((m) =>
            m.supplierId
              ? (catalog?.suppliers.find((s) => s.id === m.supplierId)?.name ??
                m.supplierId)
              : (catalog?.groups?.find((g) => g.id === m.groupId)?.name ??
                m.groupId),
          ),
      ),
    ].join(" · ");

  const dialogGroups = useMemo(
    () =>
      availableGroups.map((group) => ({
        id: group.id,
        name: group.name,
        summary: memberSummary(group),
      })),
    // memberSummary 只依赖 catalog，随 availableGroups 一起变化
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [availableGroups, catalog],
  );

  // ─── 动作 ─────────────────────────────────────────────────────────────────
  const refreshAfterActivation = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: proxyKeys.status }),
      queryClient.invalidateQueries({ queryKey: proxyKeys.takeoverStatus }),
      queryClient.invalidateQueries({ queryKey: ["providers", app] }),
      queryClient.invalidateQueries({ queryKey: ["gateway", "catalog"] }),
    ]);
    providersApi.updateTrayMenu().catch(() => undefined);
  };

  /** 启用代理并绑定路由组；groupId 为空时由后端按策略解析默认组。失败时抛出给调用方展示。 */
  const activateGroup = async (groupId?: string) => {
    setActivating(true);
    try {
      await gatewayApi.connectApp(app, groupId, catalog?.revision);
      const group = catalog?.groups?.find((g) => g.id === groupId) ?? undefined;
      toast.success(
        t("mode.toast.enteredGroup", {
          app: appName,
          group: group?.name ?? t("gateway.groups.group"),
        }),
        { closeButton: true },
      );
      await refreshAfterActivation();
    } finally {
      setActivating(false);
    }
  };

  const previous = { mode: active, routeProviderId: routeId };

  const exitAndUse = (provider: Provider) =>
    void modeActions.exitToDirect({
      previous,
      directProviderId: directId,
      useProviderId: provider.id,
      providerName: provider.name,
    });

  const exitToDirect = () =>
    void modeActions.exitToDirect({
      previous,
      directProviderId: directId,
      providerName:
        (directId && providers[directId]?.name) || t("mode.noProvider"),
    });

  const nameOf = (id: string | null) =>
    (id && providers[id]?.name) || t("mode.noProvider");

  // 状态行：只在看生效的那格时显示；代理写组名（旧连接写目标供应商），不写本机地址和端口
  const routeTarget = isProxy
    ? routeIdIsEntry
      ? (boundGroup?.name ?? t("gateway.groups.group"))
      : nameOf(routeId)
    : nameOf(directId);
  const status =
    view !== active
      ? undefined
      : active === "direct"
        ? { lead: t("mode.status.directLead"), value: nameOf(directId) }
        : {
            lead: t("mode.status.routeLead"),
            value: `→ ${routeTarget}`,
          };

  // 托盘「需要路由」与启动重试都走默认路由组（后端按策略解析）；没有确认框，错误只 toast
  const activateDefaultGroup = async () => {
    try {
      await activateGroup();
    } catch (error) {
      toast.error(
        t("mode.toast.failed", {
          detail: describeGatewayError(error),
        }),
        { closeButton: true },
      );
    }
  };

  useEffect(() => {
    if (!needsRouteRequest) return;
    const provider = providers[needsRouteRequest.providerId];
    if (!provider) return;
    setDialog({
      kind: "needsRoute",
      providerId: provider.id,
      name: provider.name,
      reason: getRoutingReason(app, provider, t) ?? "",
    });
    onNeedsRouteHandled?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsRouteRequest?.nonce, providers]);

  const startService = async () => {
    try {
      await proxyApi.startProxyServer();
      await queryClient.invalidateQueries({ queryKey: proxyKeys.status });
    } catch (error) {
      toast.error(
        t("proxy.server.startFailed", {
          detail: extractErrorMessage(error) || t("common.unknown"),
        }),
      );
    }
  };

  const notices: React.ReactNode[] = [];
  if (isProxy && proxyStatus !== undefined && !serviceRunning) {
    notices.push(
      <Notice
        key="broken"
        tone="warning"
        title={t("mode.notice.serviceDown", {
          app: appName,
          mode: t("mode.names.route"),
        })}
        actions={
          <>
            <Button
              variant="neutral"
              size="compact"
              onClick={() => void startService()}
            >
              {t("mode.notice.startService")}
            </Button>
            <Button variant="neutral" size="compact" onClick={exitToDirect}>
              {t("mode.notice.backToDirect")}
            </Button>
          </>
        }
      />,
    );
  }
  if (startupFailure) {
    notices.push(
      <Notice
        key="startup"
        tone="warning"
        title={t("mode.notice.attachFailed", {
          app: appName,
          mode: t("mode.names.route"),
        })}
        onDismiss={onDismissStartupFailure}
        dismissLabel={t("common.close")}
        actions={
          <Button
            variant="neutral"
            size="compact"
            onClick={() =>
              void activateDefaultGroup()
                .then(() => onDismissStartupFailure?.())
                .catch(() => undefined)
            }
          >
            {t("common.retry")}
          </Button>
        }
      >
        {startupFailure.error}
      </Notice>,
    );
  }
  if (isLegacyRoute && view === "route") {
    notices.push(
      <Notice
        key="legacy"
        tone="warning"
        title={t("gateway.connections.legacy")}
      >
        {t("mode.legacyRouteTarget", { name: nameOf(routeId) })}
      </Notice>,
    );
  }
  if (view !== active) {
    const cta =
      view === "route" ? t("mode.activate.route") : t("mode.activate.direct");
    notices.push(
      <Notice
        key="activate"
        tone="neutral"
        title={t("mode.activate.viewing", {
          view: t("mode.names.route"),
          app: appName,
          active: t("mode.names.direct"),
        })}
        actions={
          <Button
            variant={view}
            size="regular"
            disabled={activating || modeActions.pending}
            onClick={() =>
              view === "direct"
                ? exitToDirect()
                : setDialog({
                    kind: "enter",
                    preselect: boundGroupId ?? availableGroups[0]?.id ?? null,
                  })
            }
          >
            {cta}
          </Button>
        }
      />,
    );
  }

  // ─── 直连列表 ─────────────────────────────────────────────────────────────
  const directList = (
    <ProviderList
      {...listCallbacks}
      providers={providers}
      currentProviderId={currentProviderId}
      appId={app}
      isLoading={isLoading}
      onSwitch={(provider) => void onSwitch(provider)}
      switchMode={{
        active,
        view: "direct",
        directId,
        routeId,
        failoverOn: false,
        queue: [],
        stackMembers: new Map(),
        serviceRunning,
        routingReason: (provider: Provider) =>
          getRoutingReason(app, provider, t) ?? "",
        actions: {
          switchDirect: (provider: Provider) => void onSwitch(provider),
          needsRouteDialog: (provider: Provider) =>
            setDialog({
              kind: "needsRoute",
              providerId: provider.id,
              name: provider.name,
              reason: getRoutingReason(app, provider, t) ?? "",
            }),
          exitAndUse,
          routeTo: (provider: Provider) => void onSwitch(provider),
          queueAdd: () => undefined,
          queueRemove: () => undefined,
          queueMove: () => undefined,
          stackAdd: () => undefined,
          stackRemove: () => undefined,
          stackSetDefault: () => undefined,
        },
      }}
    />
  );

  // ─── 代理视图：路由组 ─────────────────────────────────────────────────────
  const groupList = (
    <div className="flex flex-col gap-3" data-testid="route-group-list">
      {availableGroups.map((group) => {
        const isBound = group.id === boundGroupId;
        const summary = memberSummary(group);
        return (
          <div
            key={group.id}
            data-testid={`group-${group.id}`}
            className="flex items-center justify-between gap-3 rounded-panel border border-border bg-surface px-4 py-3"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="truncate text-body font-medium text-fg-1">
                  {group.name}
                </span>
                {isBound && (
                  <Badge variant="secondary">
                    {t("gateway.groups.current")}
                  </Badge>
                )}
              </div>
              <p className="mt-0.5 truncate text-caption text-fg-2">
                {summary || t("gateway.groups.empty")}
              </p>
            </div>
            {isBound ? (
              <Button variant="outline" size="compact" onClick={exitToDirect}>
                {t("mode.notice.backToDirect")}
              </Button>
            ) : (
              <Button
                variant="solid"
                size="compact"
                disabled={activating || modeActions.pending}
                onClick={() =>
                  setDialog({ kind: "enter", preselect: group.id })
                }
              >
                {t("mode.activate.route")}
              </Button>
            )}
          </div>
        );
      })}
      {availableGroups.length === 0 && (
        <div className="rounded-panel border border-dashed border-border px-4 py-6 text-center text-caption text-fg-2">
          {t("gateway.groups.empty")}
          <div className="mt-2">
            <Button
              variant="outline"
              size="compact"
              onClick={onOpenRoutingPage}
            >
              {t("gateway.groups.goCreate")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );

  return (
    <>
      <ModeTabs
        modes={modes}
        active={active}
        view={view}
        onView={setView}
        status={status}
        onOpenRouteSettings={
          view === "route" && active === "route"
            ? () => setRouteSettingsOpen(true)
            : undefined
        }
      />
      <div
        ref={scrollRef}
        id="main-content"
        className="min-h-0 flex-1 overflow-y-auto scroll-stable overflow-x-hidden px-6 pb-12 pt-3"
      >
        {notices.length > 0 && (
          <div role="status" className="mb-3 flex flex-col gap-2">
            {notices}
          </div>
        )}
        {view !== "direct" ? groupList : directList}
      </div>

      <ModeDialog
        app={app}
        state={dialog}
        active={active}
        groups={dialogGroups}
        defaultPick={boundGroupId ?? availableGroups[0]?.id ?? null}
        activating={activating}
        onClose={() => setDialog(null)}
        onEnter={async (groupId) => {
          await activateGroup(groupId);
          setDialog(null);
        }}
        onRouteDefault={activateDefaultGroup}
        onSwitchDirect={(providerId) => {
          const provider = providers[providerId];
          if (provider) void onSwitch(provider, { acknowledgedRouting: true });
        }}
      />

      <RouteSettingsSheet
        app={app}
        open={routeSettingsOpen}
        onOpenChange={setRouteSettingsOpen}
        onOpenSettings={onOpenRoutingPage}
      />
    </>
  );
}
