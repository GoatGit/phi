import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Check } from "lucide-react";
import {
  getAppLabel,
  isLocalRoutableAppId,
  isProxyAppId,
  type LocalRoutableAppId,
  type ProxyAppId,
  type RoutableAppId,
} from "@/config/appConfig";

/**
 * 有 PHI 供应商表的可路由应用。路由专用应用与 System One 不在其中：
 * 前者只写原生配置，后者是决策协议的虚拟应用身份，路由目标完全由组决定。
 */
type ProviderRoutableAppId = Exclude<
  RoutableAppId,
  LocalRoutableAppId | "typesafe"
>;
import {
  appConnectionId,
  appRouteGroup,
  type GatewayCatalog,
} from "@/lib/api/gateway";
import { gatewayApi, providersApi } from "@/lib/api";
import { proxyApi } from "@/lib/api/proxy";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Notice } from "@/components/ui/notice";
import {
  supplierDirectCompatible,
  useGatewayErrorMessage,
} from "./useGatewayCatalog";

/** 后端 materialize_supplier_provider 落行的固定 id 前缀。 */
const SUPPLIER_PROVIDER_PREFIX = "gateway-supplier:";
/** 累加式应用不接受冒号，供应商行改用连字符前缀。 */
const SUPPLIER_PROVIDER_SAFE_PREFIX = "gateway-supplier-";

function supplierIdOf(providerId: string | null | undefined): string | null {
  if (!providerId) return null;
  if (providerId.startsWith(SUPPLIER_PROVIDER_PREFIX)) {
    return providerId.slice(SUPPLIER_PROVIDER_PREFIX.length);
  }
  if (providerId.startsWith(SUPPLIER_PROVIDER_SAFE_PREFIX)) {
    return providerId.slice(SUPPLIER_PROVIDER_SAFE_PREFIX.length);
  }
  return null;
}

type RouteOption = {
  value: string;
  label: string;
  note?: string;
  disabled?: boolean;
};

/** 应用路由的候选值：第一段是供应商直连，第二段是路由组。
 *  判定逻辑与旧路由页的连接下拉一致，避免同一状态在两处读法不同。 */
function useAppRouteOptions(app: ProxyAppId, catalog: GatewayCatalog) {
  const { t } = useTranslation();
  const mode = useQuery({
    queryKey: ["providers", app, "mode"] as const,
    queryFn: () => proxyApi.getAppMode(app),
    refetchInterval: 5000,
  });
  const providers = useQuery({
    queryKey: ["providers", app, "catalog"] as const,
    queryFn: () => providersApi.getAll(app),
  });
  const state = mode.data;
  const failed = mode.isError || providers.isError;
  const pending = mode.isPending || providers.isPending;
  const isProxy = !!state && state.mode !== "direct";
  const isPool = !!state?.routeProviderId?.startsWith("gateway-entry:");
  const storedConnection = catalog.policies.find(
    (p) => p.id === appConnectionId(app),
  );
  const groupId = isPool ? appRouteGroup(catalog, app) : null;
  const group = catalog.groups?.find((g) => g.id === groupId);
  const availableGroups = (catalog.groups ?? []).filter(
    (g) => g.enabled && g.appIds.includes(app),
  );
  const groupAvailable = availableGroups.some((g) => g.id === groupId);
  const detachedGroup =
    isProxy && !!groupId && groupAvailable && !state?.attached;
  const hasDirectConfig = state?.directConfigured ?? !!state?.directProviderId;
  // 池内供应商直连由后端落成固定 id 的应用供应商行，能映射回 supplier 选项；
  // 其它直连目标（如官方登录）保持 provider/ 值并以禁用项展示。
  const directSupplierId = !isProxy
    ? supplierIdOf(state?.directProviderId)
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
  const target = targetId
    ? targetId.startsWith("gateway-entry:")
      ? group
        ? [
            ...new Set(
              group.members
                .filter((m) => m.enabled)
                .map((m) =>
                  m.supplierId
                    ? (catalog.suppliers.find((s) => s.id === m.supplierId)
                        ?.name ?? m.supplierId)
                    : (catalog.groups?.find((g) => g.id === m.groupId)?.name ??
                      m.groupId),
                ),
            ),
          ].join(" · ") || t("gateway.connections.unconfigured")
        : t("gateway.connections.poolTarget")
      : (providers.data?.[targetId]?.name ?? targetId)
    : hasDirectConfig && !isProxy
      ? t("gateway.connections.nativeTarget")
      : t("gateway.connections.unconfigured");

  const directOptions: RouteOption[] = catalog.suppliers.map((supplier) => {
    const direct = supplierDirectCompatible(
      app,
      supplier.endpoint.protocol,
      supplier.endpoint.baseUrl,
    );
    return {
      value: `supplier/${supplier.id}`,
      label: supplier.name,
      note: direct
        ? supplier.endpoint.protocol
        : t("gateway.connections.supplierNeedsRoute"),
      disabled: !direct,
    };
  });
  if (connection.startsWith("provider/")) {
    directOptions.push({
      value: connection,
      label: target,
      note: t("gateway.groups.current"),
      disabled: true,
    });
  }
  if (hasDirectConfig && !state?.directProviderId) {
    directOptions.push({
      value: "direct",
      label: t("gateway.connections.nativeTarget"),
      note: t("gateway.connections.direct"),
    });
  }

  const groupOptions: RouteOption[] = availableGroups.map((g) => ({
    value: `group/${g.id}`,
    label: g.name,
    note:
      detachedGroup && g.id === groupId
        ? t("gateway.connections.reconnectGroup")
        : t(`gateway.groups.strategies.${g.strategy}`, {
            defaultValue: g.strategy,
          }),
  }));
  if (isProxy && groupId && !groupAvailable) {
    groupOptions.push({
      value: `unavailable/${groupId}`,
      label: t("gateway.connections.unavailableGroup", {
        name: group?.name ?? groupId,
      }),
      disabled: true,
    });
  }
  if (connection === "legacy") {
    groupOptions.push({
      value: "legacy",
      label: t("gateway.connections.legacy"),
      disabled: true,
    });
  }
  if (connection === "unconfigured") {
    groupOptions.push({
      value: "unconfigured",
      label: t("gateway.connections.unconfigured"),
      disabled: true,
    });
  }

  // detached 的 value 是状态而不是候选值：可选组按 groupId 高亮。
  const selectedValue = connection.startsWith("detached/")
    ? `group/${connection.slice("detached/".length)}`
    : connection;
  const current =
    [...directOptions, ...groupOptions].find(
      (option) => option.value === selectedValue,
    )?.label ?? target;

  return {
    mode,
    providers,
    state,
    failed,
    pending,
    isProxy,
    detachedGroup,
    connection,
    selectedValue,
    current,
    directOptions,
    groupOptions,
  };
}

function RouteChoice({
  option,
  selected,
  pending,
  onSelect,
}: {
  option: RouteOption;
  selected: boolean;
  pending: boolean;
  onSelect: (value: string) => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={option.label}
      disabled={option.disabled || pending}
      title={option.note}
      onClick={() => onSelect(option.value)}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-control border border-transparent px-2.5 py-2 text-start transition-colors",
        "hover:bg-subtle",
        "disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent",
        selected && "bg-subtle",
      )}
    >
      <span className="flex size-4 shrink-0 items-center justify-center text-action-text">
        {selected && <Check className="h-3.5 w-3.5" aria-hidden />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-body font-medium text-fg-1">
          {option.label}
        </span>
        {option.note && (
          <span className="block truncate text-caption text-fg-3">
            {option.note}
          </span>
        )}
      </span>
    </button>
  );
}

/** 代理模式应用的路由设置：按模式状态读当前连接。 */
function ProxyAppRouteDialog({
  app,
  catalog,
  open,
  onOpenChange,
}: {
  app: ProxyAppId;
  catalog: GatewayCatalog;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const describeError = useGatewayErrorMessage();
  const route = useAppRouteOptions(app, catalog);
  const mutation = useMutation({
    mutationFn: async (connection: string) => {
      if (connection.startsWith("supplier/")) {
        // 池内供应商 = 直连：先落成该应用的供应商行，再走常规直连切换。
        const providerId = await gatewayApi.materializeSupplierProvider(
          app,
          connection.slice("supplier/".length),
        );
        if (route.isProxy) await proxyApi.setProxyTakeoverForApp(app, false);
        await providersApi.switch(providerId, app);
        return;
      }
      if (connection.startsWith("provider/")) {
        // A provider selection means direct access even when currently routing.
        // Refresh on settlement also exposes the actual mode if switching fails
        // after the existing direct configuration has been restored.
        if (route.isProxy) await proxyApi.setProxyTakeoverForApp(app, false);
        await providersApi.switch(connection.slice("provider/".length), app);
        return;
      }
      if (connection === "direct") {
        await proxyApi.setProxyTakeoverForApp(app, false);
        return;
      }
      await gatewayApi.connectApp(
        app,
        connection.slice("group/".length),
        catalog.revision,
      );
    },
    onSuccess: () => onOpenChange(false),
    onSettled: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["providers", app] }),
        qc.invalidateQueries({ queryKey: ["proxyStatus"] }),
        qc.invalidateQueries({ queryKey: ["proxyTakeoverStatus"] }),
        qc.invalidateQueries({ queryKey: ["gateway"] }),
      ]);
    },
  });
  const options = [...route.directOptions, ...route.groupOptions];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[86vh] max-w-md overflow-hidden">
        <DialogHeader>
          <DialogTitle>{t("gateway.flow.routeSettings")}</DialogTitle>
          <DialogDescription>
            {getAppLabel(app)} · {t("gateway.flow.routeSettingsHint")}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3">
          {route.failed ? (
            <div
              role="alert"
              className="flex flex-col items-start gap-2 text-sm text-fg-2"
            >
              {t("gateway.loadError")}
              <Button
                variant="ghost"
                size="sm"
                disabled={route.mode.isFetching || route.providers.isFetching}
                onClick={() => {
                  void route.mode.refetch();
                  void route.providers.refetch();
                }}
              >
                {t("gateway.retry")}
              </Button>
            </div>
          ) : route.pending ? (
            <p role="status" className="text-sm text-fg-2">
              {t("gateway.loading")}
            </p>
          ) : (
            <>
              <p className="text-sm text-fg-2">
                {t("gateway.flow.currentRoute")}
                <span className="ms-1.5 font-medium text-fg-1">
                  {route.current}
                </span>
              </p>
              {route.detachedGroup && (
                <Notice
                  tone="warning"
                  title={t("gateway.connections.reconnectGroup")}
                />
              )}
              {mutation.isError && (
                <div role="alert">
                  <Notice tone="danger" title={describeError(mutation.error)} />
                </div>
              )}
              <div
                role="radiogroup"
                aria-label={t("gateway.flow.routeSettings")}
                className="flex flex-col gap-0.5"
              >
                <p className="px-2.5 pb-1 pt-1.5 text-xs font-medium text-fg-3">
                  {t("gateway.providers")} · {t("gateway.connections.direct")}
                </p>
                {route.directOptions.map((option) => (
                  <RouteChoice
                    key={option.value}
                    option={option}
                    selected={option.value === route.selectedValue}
                    pending={mutation.isPending}
                    onSelect={(value) => mutation.mutate(value)}
                  />
                ))}
                <p className="border-t border-border px-2.5 pb-1 pt-3 text-xs font-medium text-fg-3">
                  {t("gateway.groups.title")}
                </p>
                {route.groupOptions.map((option) => (
                  <RouteChoice
                    key={option.value}
                    option={option}
                    selected={option.value === route.selectedValue}
                    pending={mutation.isPending}
                    onSelect={(value) => mutation.mutate(value)}
                  />
                ))}
              </div>
              {!options.length && (
                <p className="text-sm text-fg-3">{t("gateway.pool.empty")}</p>
              )}
              {mutation.isPending && (
                <p role="status" className="text-xs text-fg-3">
                  {t("gateway.saving")}
                </p>
              )}
            </>
          )}
        </DialogBody>
        <DialogFooter className="border-t border-border">
          <Button
            variant="ghost"
            disabled={mutation.isPending}
            onClick={() => onOpenChange(false)}
          >
            {t("common.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * 累加式应用的路由设置：路由以一行「PHI」供应商写进原生配置，没有代理模式，
 * 所以读接入状态而不是模式状态。
 */
function useProviderAppRouteOptions(
  app: ProviderRoutableAppId,
  catalog: GatewayCatalog,
) {
  const { t } = useTranslation();
  const status = useQuery({
    queryKey: ["gateway", app, "attachment"] as const,
    queryFn: () => gatewayApi.getAppStatus(app),
    refetchInterval: 5000,
  });
  const providers = useQuery({
    queryKey: ["providers", app, "catalog"] as const,
    queryFn: () => providersApi.getAll(app),
  });
  const state = status.data;
  const attached = !!state?.attached;
  const group = catalog.groups?.find((g) => g.id === state?.groupId);
  const availableGroups = (catalog.groups ?? []).filter(
    (g) => g.enabled && g.appIds.includes(app),
  );
  const current = attached
    ? (group?.name ??
      t("gateway.connections.unavailableGroup", {
        name: state?.groupId ?? "",
      }))
    : t("gateway.connections.nativeTarget");

  const directOptions: RouteOption[] = catalog.suppliers.map((supplier) => {
    const direct = supplierDirectCompatible(
      app,
      supplier.endpoint.protocol,
      supplier.endpoint.baseUrl,
    );
    return {
      value: `supplier/${supplier.id}`,
      label: supplier.name,
      note: direct
        ? supplier.endpoint.protocol
        : t("gateway.connections.supplierNeedsRoute"),
      disabled: !direct,
    };
  });
  directOptions.push({
    value: "native",
    label: t("gateway.connections.nativeTarget"),
    note: attached
      ? t("gateway.connections.disconnect")
      : t("gateway.connections.direct"),
  });

  const groupOptions: RouteOption[] = availableGroups.map((g) => ({
    value: `group/${g.id}`,
    label: g.name,
    note: t(`gateway.groups.strategies.${g.strategy}`, {
      defaultValue: g.strategy,
    }),
  }));
  if (attached && state?.groupId && !group) {
    groupOptions.push({
      value: `unavailable/${state.groupId}`,
      label: t("gateway.connections.unavailableGroup", {
        name: state.groupId,
      }),
      disabled: true,
    });
  }

  const selectedValue = attached
    ? group
      ? `group/${group.id}`
      : state?.groupId
        ? `unavailable/${state.groupId}`
        : "native"
    : "native";

  return {
    status,
    providers,
    failed: status.isError || providers.isError,
    pending: status.isPending || providers.isPending,
    attached,
    selectedValue,
    current,
    directOptions,
    groupOptions,
  };
}

function ProviderAppRouteDialog({
  app,
  catalog,
  open,
  onOpenChange,
}: {
  app: ProviderRoutableAppId;
  catalog: GatewayCatalog;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const describeError = useGatewayErrorMessage();
  const route = useProviderAppRouteOptions(app, catalog);
  const mutation = useMutation({
    mutationFn: async (connection: string) => {
      if (connection.startsWith("supplier/")) {
        // 供应商直连前先退出路由，避免本地组连接继续接管请求。
        if (route.attached) await gatewayApi.disconnectApp(app);
        const providerId = await gatewayApi.materializeSupplierProvider(
          app,
          connection.slice("supplier/".length),
        );
        await providersApi.switch(providerId, app);
        return;
      }
      if (connection === "native") {
        if (route.attached) await gatewayApi.disconnectApp(app);
        return;
      }
      await gatewayApi.connectApp(
        app,
        connection.slice("group/".length),
        catalog.revision,
      );
    },
    onSuccess: () => onOpenChange(false),
    onSettled: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["providers", app] }),
        qc.invalidateQueries({ queryKey: ["gateway"] }),
        qc.invalidateQueries({ queryKey: ["proxyStatus"] }),
      ]);
    },
  });
  const options = [...route.directOptions, ...route.groupOptions];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[86vh] max-w-md overflow-hidden">
        <DialogHeader>
          <DialogTitle>{t("gateway.flow.routeSettings")}</DialogTitle>
          <DialogDescription>
            {getAppLabel(app)} · {t("gateway.flow.routeSettingsHint")}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3">
          {route.failed ? (
            <div
              role="alert"
              className="flex flex-col items-start gap-2 text-sm text-fg-2"
            >
              {t("gateway.loadError")}
              <Button
                variant="ghost"
                size="sm"
                disabled={route.status.isFetching || route.providers.isFetching}
                onClick={() => {
                  void route.status.refetch();
                  void route.providers.refetch();
                }}
              >
                {t("gateway.retry")}
              </Button>
            </div>
          ) : route.pending ? (
            <p role="status" className="text-sm text-fg-2">
              {t("gateway.loading")}
            </p>
          ) : (
            <>
              <p className="text-sm text-fg-2">
                {t("gateway.flow.currentRoute")}
                <span className="ms-1.5 font-medium text-fg-1">
                  {route.current}
                </span>
              </p>
              {mutation.isError && (
                <div role="alert">
                  <Notice tone="danger" title={describeError(mutation.error)} />
                </div>
              )}
              <div
                role="radiogroup"
                aria-label={t("gateway.flow.routeSettings")}
                className="flex flex-col gap-0.5"
              >
                <p className="px-2.5 pb-1 pt-1.5 text-xs font-medium text-fg-3">
                  {t("gateway.providers")} · {t("gateway.connections.direct")}
                </p>
                {route.directOptions.map((option) => (
                  <RouteChoice
                    key={option.value}
                    option={option}
                    selected={option.value === route.selectedValue}
                    pending={mutation.isPending}
                    onSelect={(value) => mutation.mutate(value)}
                  />
                ))}
                <p className="border-t border-border px-2.5 pb-1 pt-3 text-xs font-medium text-fg-3">
                  {t("gateway.groups.title")}
                </p>
                {route.groupOptions.map((option) => (
                  <RouteChoice
                    key={option.value}
                    option={option}
                    selected={option.value === route.selectedValue}
                    pending={mutation.isPending}
                    onSelect={(value) => mutation.mutate(value)}
                  />
                ))}
              </div>
              {!options.length && (
                <p className="text-sm text-fg-3">{t("gateway.pool.empty")}</p>
              )}
              {mutation.isPending && (
                <p role="status" className="text-xs text-fg-3">
                  {t("gateway.saving")}
                </p>
              )}
            </>
          )}
        </DialogBody>
        <DialogFooter className="border-t border-border">
          <Button
            variant="ghost"
            disabled={mutation.isPending}
            onClick={() => onOpenChange(false)}
          >
            {t("common.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * 路由专用应用：没有供应商直连，也没有 PHI 侧的供应商表；
 * 只能选「原生配置」或一个已启用的路由组。
 */
function LocalAppRouteDialog({
  app,
  catalog,
  open,
  onOpenChange,
}: {
  app: RoutableAppId;
  catalog: GatewayCatalog;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const describeError = useGatewayErrorMessage();
  const status = useQuery({
    queryKey: ["gateway", app, "attachment"] as const,
    queryFn: () => gatewayApi.getAppStatus(app),
    refetchInterval: 5000,
  });
  const state = status.data;
  const attached = !!state?.attached;
  const group = catalog.groups?.find((g) => g.id === state?.groupId);
  const availableGroups = (catalog.groups ?? []).filter(
    (g) => g.enabled && g.appIds.includes(app),
  );
  const current = attached
    ? (group?.name ??
      t("gateway.connections.unavailableGroup", {
        name: state?.groupId ?? "",
      }))
    : t("gateway.connections.nativeTarget");
  const selectedValue =
    attached && state?.groupId ? `group/${state.groupId}` : "native";

  const mutation = useMutation({
    mutationFn: async (connection: string) => {
      if (connection === "native") {
        if (attached) await gatewayApi.disconnectApp(app);
        return;
      }
      await gatewayApi.connectApp(
        app,
        connection.slice("group/".length),
        catalog.revision,
      );
    },
    onSuccess: () => onOpenChange(false),
    onSettled: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["gateway"] }),
        qc.invalidateQueries({ queryKey: ["proxyStatus"] }),
      ]);
    },
  });

  const options: RouteOption[] = [
    {
      value: "native",
      label: t("gateway.connections.nativeTarget"),
      note: attached
        ? t("gateway.connections.disconnect")
        : t("gateway.connections.direct"),
    },
    ...availableGroups.map((g) => ({
      value: `group/${g.id}`,
      label: g.name,
      note: t(`gateway.groups.strategies.${g.strategy}`, {
        defaultValue: g.strategy,
      }),
    })),
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[86vh] max-w-md overflow-hidden">
        <DialogHeader>
          <DialogTitle>{t("gateway.flow.routeSettings")}</DialogTitle>
          <DialogDescription>
            {getAppLabel(app)} · {t("gateway.flow.routeSettingsHint")}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3">
          {status.isError ? (
            <div
              role="alert"
              className="flex flex-col items-start gap-2 text-sm text-fg-2"
            >
              {t("gateway.loadError")}
              <Button
                variant="ghost"
                size="sm"
                disabled={status.isFetching}
                onClick={() => void status.refetch()}
              >
                {t("gateway.retry")}
              </Button>
            </div>
          ) : status.isPending ? (
            <p role="status" className="text-sm text-fg-2">
              {t("gateway.loading")}
            </p>
          ) : (
            <>
              <p className="text-sm text-fg-2">
                {t("gateway.flow.currentRoute")}
                <span className="ms-1.5 font-medium text-fg-1">{current}</span>
              </p>
              {mutation.isError && (
                <div role="alert">
                  <Notice tone="danger" title={describeError(mutation.error)} />
                </div>
              )}
              <div
                role="radiogroup"
                aria-label={t("gateway.flow.routeSettings")}
                className="flex flex-col gap-0.5"
              >
                {options.map((option) => (
                  <RouteChoice
                    key={option.value}
                    option={option}
                    selected={option.value === selectedValue}
                    pending={mutation.isPending}
                    onSelect={(value) => mutation.mutate(value)}
                  />
                ))}
              </div>
            </>
          )}
        </DialogBody>
        <DialogFooter className="border-t border-border">
          <Button
            variant="ghost"
            disabled={mutation.isPending}
            onClick={() => onOpenChange(false)}
          >
            {t("common.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * 「设置应用路由」能打开的应用：有 PHI 供应商表的可路由应用，以及只写原生
 * 配置的路由专用应用。System One 是决策协议的虚拟应用身份，路由目标完全由组
 * 推导，没有可写的应用配置，所以不在其中。
 */
export type AppRouteDialogAppId = Exclude<RoutableAppId, "typesafe">;

/** 流程图应用节点的「设置应用路由」：选中即生效，不额外加一层保存按钮。 */
export function AppRouteSettingsDialog({
  app,
  catalog,
  open,
  onOpenChange,
}: {
  app: AppRouteDialogAppId;
  catalog: GatewayCatalog;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  if (isLocalRoutableAppId(app)) {
    return (
      <LocalAppRouteDialog
        app={app}
        catalog={catalog}
        open={open}
        onOpenChange={onOpenChange}
      />
    );
  }
  if (isProxyAppId(app)) {
    return (
      <ProxyAppRouteDialog
        app={app}
        catalog={catalog}
        open={open}
        onOpenChange={onOpenChange}
      />
    );
  }
  return (
    <ProviderAppRouteDialog
      app={app}
      catalog={catalog}
      open={open}
      onOpenChange={onOpenChange}
    />
  );
}
