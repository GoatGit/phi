import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
import {
  APP_IDS,
  type ProxyAppId,
  getAppLabel,
  isProxyAppId,
  isStackAppId,
} from "@/config/appConfig";
import {
  gatewayApi,
  providersApi,
  type AppId,
  type GatewayCatalog,
} from "@/lib/api";
import { proxyApi } from "@/lib/api/proxy";
import { useProxyStack, useProxyStatusQuery } from "@/lib/query/proxy";
import { useAutoFailoverEnabled, useFailoverQueue } from "@/lib/query/failover";
import { AppPageHeader } from "@/components/shell/AppPageHeader";
import { PageHeaderBackButton } from "@/components/shell/PageHeaderBackButton";
import { AppGlyph } from "@/components/shell/AppGlyph";
import { Button } from "@/components/ui/button";
import { PageTabs } from "@/components/ui/page-tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ResourcePoolSection } from "@/components/gateway/ResourcePoolSection";
import { NativeAppConnectionRow } from "@/components/gateway/NativeAppConnectionRow";
import { RoutingStatus } from "@/components/gateway/RoutingStatus";
import { appConnectionId, appRouteGroup } from "@/lib/api/gateway";
import { GroupSection } from "@/components/gateway/GroupSection";
import { supplierDirectCompatible } from "@/components/gateway/useGatewayCatalog";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useGatewayCatalog,
  useGatewayErrorMessage,
} from "@/components/gateway/useGatewayCatalog";

interface GatewayPageProps {
  onOpenApp: (app: AppId) => void;
}

// Unlike the legacy picker, a failed read must not look like an empty catalog.
// Keep the key under providers/app so existing mutations invalidate this view.
/** 后端 materialize_supplier_provider 落行的固定 id 前缀。 */
const SUPPLIER_PROVIDER_PREFIX = "gateway-supplier:";

function useCatalog(app: AppId) {
  return useQuery({
    queryKey: ["providers", app, "catalog"] as const,
    queryFn: () => providersApi.getAll(app),
  });
}

/** 目录加载门控：pending/错误态统一处理，成功后才能进入需要整份目录的区块。 */
function GatewayCatalogGate({
  children,
}: {
  children: (
    catalog: NonNullable<ReturnType<typeof useGatewayCatalog>["data"]>,
  ) => ReactNode;
}) {
  const { t } = useTranslation();
  const describeError = useGatewayErrorMessage();
  const query = useGatewayCatalog();
  if (query.isPending) {
    return (
      <p role="status" className="text-sm text-fg-2">
        {t("gateway.loading")}
      </p>
    );
  }
  if (query.isError || !query.data) {
    return (
      <div role="alert" className="flex items-center gap-3 text-sm text-fg-2">
        {describeError(query.error)}
        <Button
          variant="ghost"
          size="sm"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          {t("gateway.retry")}
        </Button>
      </div>
    );
  }
  return <>{children(query.data)}</>;
}

/**
 * 供应商页即统一资源池：所有供应商在这里集中管理（新建/编辑/删除），
 * 不再按应用分别罗列；各应用的原生配置仍留在各自页面。
 */
export function ProviderCatalogPage({
  onOpenPolicy,
  onBack,
}: {
  onOpenPolicy?: (id: string) => void;
  /** 从其他页面下钻进来时的返回（与用量 / 会话页同一 drill-in 约定） */
  onBack?: () => void;
}) {
  const { t } = useTranslation();
  const [createOpen, setCreateOpen] = useState(false);
  return (
    <>
      <AppPageHeader
        leading={onBack && <PageHeaderBackButton onClick={onBack} />}
        title={t("gateway.providers")}
        actions={
          <Button
            variant="solid"
            size="regular"
            onClick={() => setCreateOpen(true)}
          >
            <Plus className="h-4 w-4" aria-hidden />
            {t("gateway.pool.create")}
          </Button>
        }
      />
      <div
        id="main-content"
        className="min-h-0 flex-1 overflow-y-auto scroll-stable px-6 py-5"
      >
        <div className="mx-auto flex max-w-5xl flex-col gap-6">
          <GatewayCatalogGate>
            {(catalog) => (
              <ResourcePoolSection
                catalog={catalog}
                onOpenPolicy={onOpenPolicy}
                createOpen={createOpen}
                onCreateOpenChange={setCreateOpen}
              />
            )}
          </GatewayCatalogGate>
        </div>
      </div>
    </>
  );
}

function RouteRow({
  app,
  running,
  gatewayCatalog,
}: {
  app: ProxyAppId;
  running: boolean | undefined;
  gatewayCatalog: GatewayCatalog;
}) {
  const { t } = useTranslation();
  const catalog = useCatalog(app);
  const qc = useQueryClient();
  const describeError = useGatewayErrorMessage();
  const mode = useQuery({
    queryKey: ["providers", app, "mode"] as const,
    queryFn: () => proxyApi.getAppMode(app),
    refetchInterval: 5000,
  });
  const state = mode.data;
  const failed = mode.isError || catalog.isError;
  const pending = mode.isPending || catalog.isPending;
  const isProxy = !!state && state.mode !== "direct";
  const isPool = !!state?.routeProviderId?.startsWith("gateway-entry:");
  const storedConnection = gatewayCatalog.policies.find(
    (p) => p.id === appConnectionId(app),
  );
  const groupId = isPool ? appRouteGroup(gatewayCatalog, app) : null;
  const group = gatewayCatalog.groups?.find((g) => g.id === groupId);
  const availableGroups = (gatewayCatalog.groups ?? []).filter(
    (g) => g.enabled && g.appIds.includes(app),
  );
  const groupAvailable = availableGroups.some((g) => g.id === groupId);
  const detachedGroup =
    isProxy && !!groupId && groupAvailable && !state?.attached;
  const hasDirectConfig = state?.directConfigured ?? !!state?.directProviderId;
  // 池内供应商直连由后端落成固定 id 的应用供应商行，能映射回 supplier 选项；
  // 其它直连目标（如官方登录）保持 provider/ 值并以下拉外禁用项展示。
  const directSupplierId =
    !isProxy && state?.directProviderId?.startsWith(SUPPLIER_PROVIDER_PREFIX)
      ? state.directProviderId.slice(SUPPLIER_PROVIDER_PREFIX.length)
      : null;
  const connection = isProxy
    ? isPool && storedConnection && (!storedConnection.enabled || !groupId)
      ? "unconfigured"
      : groupId
        ? `${detachedGroup ? "detached" : "group"}/${groupId}`
        : "legacy"
    : hasDirectConfig
      ? directSupplierId
        ? `supplier/${directSupplierId}`
        : state?.directProviderId
          ? `provider/${state.directProviderId}`
          : "direct"
      : "unconfigured";
  const targetId = isProxy ? state?.routeProviderId : state?.directProviderId;
  // 旧连接仍由应用页那套路由概念驱动（默认路由 + 故障转移队列 + 聚合模型）；
  // 这里把它们读出来展示，避免路由页只剩一句「旧连接」。
  const isLegacy = connection === "legacy";
  const { data: failoverOn } = useAutoFailoverEnabled(app, isLegacy);
  const { data: failoverQueue } = useFailoverQueue(app, isLegacy);
  const { data: stack } = useProxyStack(app, isLegacy && isStackAppId(app));
  const queueCount = isLegacy && failoverOn ? (failoverQueue ?? []).length : 0;
  const stackModels = (stack?.members ?? []).reduce(
    (sum, member) => sum + member.modelIds.length,
    0,
  );
  const target = targetId
    ? targetId.startsWith("gateway-entry:")
      ? group
        ? [
            ...new Set(
              group.members
                .filter((m) => m.enabled)
                .map((m) =>
                  m.supplierId
                    ? (gatewayCatalog.suppliers.find(
                        (s) => s.id === m.supplierId,
                      )?.name ?? m.supplierId)
                    : (gatewayCatalog.groups?.find((g) => g.id === m.groupId)
                        ?.name ?? m.groupId),
                ),
            ),
          ].join(" · ") || "—"
        : t("gateway.connections.poolTarget")
      : (catalog.data?.[targetId]?.name ?? targetId)
    : hasDirectConfig && !isProxy
      ? t("gateway.connections.nativeTarget")
      : "—";
  const connectionMutation = useMutation({
    mutationFn: async (connection: string) => {
      if (connection.startsWith("supplier/")) {
        // 池内供应商 = 直连：先落成该应用的供应商行，再走常规直连切换。
        const providerId = await gatewayApi.materializeSupplierProvider(
          app,
          connection.slice("supplier/".length),
        );
        if (isProxy) await proxyApi.setProxyTakeoverForApp(app, false);
        await providersApi.switch(providerId, app);
        return;
      }
      if (connection.startsWith("provider/")) {
        // A provider selection means direct access even when currently routing.
        // Refresh on settlement also exposes the actual mode if switching fails
        // after the existing direct configuration has been restored.
        if (isProxy) await proxyApi.setProxyTakeoverForApp(app, false);
        await providersApi.switch(connection.slice("provider/".length), app);
        return;
      }
      if (connection === "direct") {
        return proxyApi.setProxyTakeoverForApp(app, false);
      }
      return gatewayApi.connectApp(
        app,
        connection.slice("group/".length),
        gatewayCatalog.revision,
      );
    },
    onSettled: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["providers", app] }),
        qc.invalidateQueries({ queryKey: ["proxyStatus"] }),
        qc.invalidateQueries({ queryKey: ["proxyTakeoverStatus"] }),
        qc.invalidateQueries({ queryKey: ["gateway"] }),
      ]);
    },
  });
  return (
    <TableRow>
      <TableCell className="whitespace-nowrap">
        <span className="flex items-center gap-2">
          <AppGlyph app={app} size={16} badgeClassName="bg-surface" />
          {getAppLabel(app)}
        </span>
      </TableCell>
      {failed || pending ? (
        <TableCell>
          {failed ? (
            <div role="alert" className="flex items-center gap-2">
              {t("gateway.loadError")}
              <Button
                variant="ghost"
                size="sm"
                disabled={mode.isFetching || catalog.isFetching}
                onClick={() => {
                  void mode.refetch();
                  void catalog.refetch();
                }}
              >
                {t("gateway.retry")}
              </Button>
            </div>
          ) : (
            <span role="status">{t("gateway.loading")}</span>
          )}
        </TableCell>
      ) : (
        <TableCell className="max-w-64 break-words">
          {target}
          {isLegacy && (queueCount > 0 || stackModels > 0) && (
            <div className="mt-0.5 text-caption text-fg-2">
              {[
                queueCount > 0
                  ? t("gateway.connections.legacyQueue", { count: queueCount })
                  : null,
                stackModels > 0
                  ? t("gateway.connections.legacyStack", { count: stackModels })
                  : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </div>
          )}
        </TableCell>
      )}
      <TableCell className="w-64">
        {!failed && !pending && (
          <Select
            value={connection}
            disabled={connectionMutation.isPending}
            onValueChange={(value) => connectionMutation.mutate(value)}
          >
            <SelectTrigger
              aria-label={t("gateway.connections.methodForApp", {
                app: getAppLabel(app),
              })}
              className="min-w-0"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectLabel>
                  {t("gateway.providers")} · {t("gateway.connections.direct")}
                </SelectLabel>
                {gatewayCatalog.suppliers.map((supplier) => {
                  const direct = supplierDirectCompatible(
                    app,
                    supplier.endpoint.protocol,
                  );
                  return (
                    <SelectItem
                      key={supplier.id}
                      value={`supplier/${supplier.id}`}
                      disabled={!direct}
                      title={
                        direct
                          ? undefined
                          : t("gateway.connections.supplierNeedsRoute")
                      }
                    >
                      {supplier.name}
                    </SelectItem>
                  );
                })}
                {connection.startsWith("provider/") && (
                  <SelectItem value={connection} disabled>
                    {target}
                  </SelectItem>
                )}
                {hasDirectConfig && !state?.directProviderId && (
                  <SelectItem value="direct">
                    {t("gateway.connections.nativeTarget")}
                  </SelectItem>
                )}
              </SelectGroup>
              <SelectSeparator />
              <SelectGroup>
                <SelectLabel>{t("gateway.groups.title")}</SelectLabel>
                {availableGroups.map((g) => (
                  <SelectItem key={g.id} value={`group/${g.id}`}>
                    {g.name}
                  </SelectItem>
                ))}
                {[
                  ...(detachedGroup
                    ? [
                        {
                          value: connection,
                          label: t("gateway.connections.detachedGroup", {
                            name: group?.name ?? groupId,
                          }),
                          disabled: true,
                        },
                      ]
                    : []),
                  ...(isProxy && groupId && !groupAvailable
                    ? [
                        {
                          value: connection,
                          label: t("gateway.connections.unavailableGroup", {
                            name: group?.name ?? groupId,
                          }),
                          disabled: true,
                        },
                      ]
                    : []),
                  ...(connection === "legacy"
                    ? [
                        {
                          value: "legacy",
                          label: t("gateway.connections.legacy"),
                          disabled: true,
                        },
                      ]
                    : []),
                  ...(connection === "unconfigured"
                    ? [
                        {
                          value: "unconfigured",
                          label: t("gateway.connections.unconfigured"),
                          disabled: true,
                        },
                      ]
                    : []),
                ].map((option) => (
                  <SelectItem key={option.value} value={option.value} disabled>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        )}
        {!failed &&
          !pending &&
          isProxy &&
          running === true &&
          !state?.attached && (
            <p role="status" className="mt-2 text-xs text-fg-2">
              {t(
                detachedGroup
                  ? "gateway.connections.reconnectGroup"
                  : "gateway.connections.needsReconnect",
              )}
            </p>
          )}
        {connectionMutation.isError && (
          <p role="alert" className="mt-2 text-sm text-destructive">
            {describeError(connectionMutation.error)}
          </p>
        )}
      </TableCell>
    </TableRow>
  );
}

export function RoutingOverviewPage({
  onOpenApp,
  initialPolicyId,
  initialTab,
  onBack,
}: GatewayPageProps & {
  initialPolicyId?: string | null;
  /** 进入路由页时默认停留的标签（缺省：带策略跳转→路由） */
  initialTab?: "connections" | "policies" | "status";
  /** 从其他页面下钻进来时的返回 */
  onBack?: () => void;
}) {
  const { t } = useTranslation();
  const status = useProxyStatusQuery();
  const [tab, setTab] = useState<"connections" | "policies" | "status">(
    initialTab ?? (initialPolicyId ? "status" : "connections"),
  );
  const [traceGroupId, setTraceGroupId] = useState<string | null>(null);
  const [tracePolicyId, setTracePolicyId] = useState<string | null>(
    initialPolicyId ?? null,
  );
  const running = status.isError ? undefined : status.data?.running;
  return (
    <>
      <AppPageHeader
        leading={onBack && <PageHeaderBackButton onClick={onBack} />}
        title={null}
        tabs={
          <PageTabs
            size="lg"
            /* 底边对齐页头并下压 1px：页签下划线压在页头分割线上（同用量页） */
            className="self-end -mb-px"
            aria-label={t("gateway.routing")}
            value={tab}
            onValueChange={(value) =>
              setTab(value as "connections" | "policies" | "status")
            }
            items={[
              {
                value: "connections",
                label: t("gateway.tabs.connections"),
              },
              { value: "policies", label: t("gateway.tabs.policies") },
              { value: "status", label: t("gateway.routingStatus.title") },
            ]}
          />
        }
      />
      <div
        id="main-content"
        className="min-h-0 flex-1 overflow-y-auto scroll-stable px-6 py-5"
      >
        <div
          className={
            tab === "connections"
              ? "mx-auto flex max-w-5xl flex-col gap-6"
              : "hidden"
          }
        >
          {status.isError && (
            <div role="alert" className="flex items-center gap-3 text-sm">
              {t("gateway.statusError")}
              <Button
                variant="outline"
                size="sm"
                disabled={status.isFetching}
                onClick={() => void status.refetch()}
              >
                {t("gateway.retry")}
              </Button>
            </div>
          )}
          <GatewayCatalogGate>
            {(gatewayCatalog) => (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("gateway.agent")}</TableHead>
                    <TableHead>{t("gateway.target")}</TableHead>
                    <TableHead>{t("gateway.connections.method")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {APP_IDS.map((app) =>
                    isProxyAppId(app) ? (
                      <RouteRow
                        key={app}
                        app={app}
                        running={running}
                        gatewayCatalog={gatewayCatalog}
                      />
                    ) : (
                      <NativeAppConnectionRow
                        key={app}
                        app={app}
                        onOpenApp={onOpenApp}
                      />
                    ),
                  )}
                </TableBody>
              </Table>
            )}
          </GatewayCatalogGate>
        </div>
        {tab === "policies" && (
          <GatewayCatalogGate>
            {(catalog) => (
              <div className="mx-auto flex max-w-5xl flex-col gap-6">
                <GroupSection
                  catalog={catalog}
                  onOpenTraces={(id) => {
                    setTraceGroupId(id);
                    setTracePolicyId(null);
                    setTab("status");
                  }}
                />
              </div>
            )}
          </GatewayCatalogGate>
        )}
        {tab === "status" && (
          <GatewayCatalogGate>
            {(catalog) => (
              <RoutingStatus
                catalog={catalog}
                policyId={tracePolicyId}
                groupId={traceGroupId}
              />
            )}
          </GatewayCatalogGate>
        )}
      </div>
    </>
  );
}
