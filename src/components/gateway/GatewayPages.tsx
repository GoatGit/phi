import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
import {
  APP_IDS,
  type ProxyAppId,
  getAppLabel,
  isProxyAppId,
} from "@/config/appConfig";
import {
  gatewayApi,
  providersApi,
  type AppId,
  type GatewayCatalog,
} from "@/lib/api";
import { proxyApi } from "@/lib/api/proxy";
import { useProxyStatusQuery } from "@/lib/query/proxy";
import { AppPageHeader } from "@/components/shell/AppPageHeader";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
import { RoutePreview } from "@/components/gateway/RoutePreview";
import { appConnectionId, appRouteGroup } from "@/lib/api/gateway";
import { GatewaySelect, GroupSection } from "@/components/gateway/GroupSection";
import {
  useGatewayCatalog,
  useGatewayErrorMessage,
} from "@/components/gateway/useGatewayCatalog";

interface GatewayPageProps {
  onOpenApp: (app: AppId) => void;
}

// Unlike the legacy picker, a failed read must not look like an empty catalog.
// Keep the key under providers/app so existing mutations invalidate this view.
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
}: {
  onOpenPolicy?: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [createOpen, setCreateOpen] = useState(false);
  return (
    <>
      <AppPageHeader
        title={t("gateway.providers")}
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => setCreateOpen(true)}
          >
            <Plus data-icon="inline-start" aria-hidden />
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
  onOpenApp,
  running,
  gatewayCatalog,
}: GatewayPageProps & {
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
  const connection = isProxy
    ? isPool && storedConnection && (!storedConnection.enabled || !groupId)
      ? "unconfigured"
      : groupId
        ? `${detachedGroup ? "detached" : "group"}/${groupId}`
        : "legacy"
    : hasDirectConfig
      ? "direct"
      : "unconfigured";
  const targetId = isProxy ? state?.routeProviderId : state?.directProviderId;
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
    mutationFn: (connection: string) => {
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
      <TableCell className="whitespace-nowrap">{getAppLabel(app)}</TableCell>
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
        <TableCell className="max-w-64 break-words">{target}</TableCell>
      )}
      <TableCell className="w-64">
        <div className="flex items-center gap-2">
          {!failed && !pending && (
            <div className="min-w-0 flex-1">
              <GatewaySelect
                label={t("gateway.connections.methodForApp", {
                  app: getAppLabel(app),
                })}
                value={connection}
                disabled={connectionMutation.isPending}
                onChange={(value) => connectionMutation.mutate(value)}
                options={[
                  {
                    value: "direct",
                    label: t("gateway.connections.direct"),
                    disabled: !hasDirectConfig && !isProxy,
                  },
                  ...availableGroups.map((g) => ({
                    value: `group/${g.id}`,
                    label: g.name,
                  })),
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
                ]}
              />
            </div>
          )}
          <Button
            variant={
              connection === "unconfigured" && !failed && !pending
                ? "outline"
                : "ghost"
            }
            size="sm"
            disabled={connectionMutation.isPending}
            onClick={() => onOpenApp(app)}
          >
            {t("gateway.configure")}
          </Button>
        </div>
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
}: GatewayPageProps & {
  initialPolicyId?: string | null;
}) {
  const { t } = useTranslation();
  const status = useProxyStatusQuery();
  const [tab, setTab] = useState(initialPolicyId ? "status" : "connections");
  const [traceGroupId, setTraceGroupId] = useState<string | null>(null);
  const [tracePolicyId, setTracePolicyId] = useState<string | null>(
    initialPolicyId ?? null,
  );
  const running = status.isError ? undefined : status.data?.running;
  return (
    <>
      <AppPageHeader
        title={t("gateway.routing")}
        titleExtra={
          <Badge variant="outline">
            {t(
              running === undefined
                ? "gateway.unknown"
                : running
                  ? "gateway.running"
                  : "gateway.stopped",
            )}
          </Badge>
        }
      />
      <div
        id="main-content"
        className="min-h-0 flex-1 overflow-y-auto scroll-stable px-6 py-5"
      >
        <Tabs
          value={tab}
          onValueChange={setTab}
          className="mx-auto flex max-w-5xl flex-col gap-6"
        >
          <TabsList aria-label={t("gateway.routing")}>
            <TabsTrigger value="connections">
              {t("gateway.tabs.connections")}
            </TabsTrigger>
            <TabsTrigger value="policies">
              {t("gateway.tabs.policies")}
            </TabsTrigger>
            <TabsTrigger value="status">
              {t("gateway.routingStatus.title")}
            </TabsTrigger>
          </TabsList>
          <TabsContent
            value="connections"
            className="data-[state=active]:flex data-[state=active]:flex-col data-[state=active]:gap-6"
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
                          onOpenApp={onOpenApp}
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
          </TabsContent>
          <TabsContent value="policies">
            <GatewayCatalogGate>
              {(catalog) => (
                <div className="flex flex-col gap-6">
                  <GroupSection
                    catalog={catalog}
                    onOpenTraces={(id) => {
                      setTraceGroupId(id);
                      setTracePolicyId(null);
                      setTab("status");
                    }}
                  />
                  <RoutePreview catalog={catalog} />
                </div>
              )}
            </GatewayCatalogGate>
          </TabsContent>
          <TabsContent value="status">
            <GatewayCatalogGate>
              {(catalog) => (
                <RoutingStatus
                  catalog={catalog}
                  policyId={tracePolicyId}
                  groupId={traceGroupId}
                />
              )}
            </GatewayCatalogGate>
          </TabsContent>
        </Tabs>
      </div>
    </>
  );
}
