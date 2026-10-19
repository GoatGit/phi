import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
import { AppPageHeader } from "@/components/shell/AppPageHeader";
import { PageHeaderBackButton } from "@/components/shell/PageHeaderBackButton";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useProxyStatus } from "@/hooks/useProxyStatus";
import { ResourcePoolSection } from "@/components/gateway/ResourcePoolSection";
import { RoutingStatus } from "@/components/gateway/RoutingStatus";
import type { RouteAppRequest } from "@/components/gateway/routingFlowModel";
import {
  useGatewayCatalog,
  useGatewayErrorMessage,
} from "@/components/gateway/useGatewayCatalog";

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

/**
 * 路由页就是一张运行中的流转图：应用节点直接设置路由，路由组列直接
 * 新建/编辑组，不再需要独立的「路由」与「路由组」页签。
 */
export function RoutingOverviewPage({
  initialPolicyId,
  onBack,
  routeAppRequest,
  onRouteAppRequestHandled,
}: {
  initialPolicyId?: string | null;
  /** 从其他页面下钻进来时的返回 */
  onBack?: () => void;
  /** 侧栏点了路由专用应用：进页后打开它的「设置应用路由」 */
  routeAppRequest?: RouteAppRequest | null;
  onRouteAppRequestHandled?: () => void;
}) {
  const { t } = useTranslation();
  const { stopWithRestore, isPending } = useProxyStatus();
  const [confirmExitAll, setConfirmExitAll] = useState(false);
  return (
    <>
      <AppPageHeader
        leading={onBack && <PageHeaderBackButton onClick={onBack} />}
        title={t("gateway.routing")}
        actions={
          <Button
            variant="neutral"
            size="compact"
            disabled={isPending}
            onClick={() => setConfirmExitAll(true)}
          >
            {t("routingSettings.exitAll")}
          </Button>
        }
      />
      <div
        id="main-content"
        className="min-h-0 flex-1 overflow-y-auto scroll-stable px-6 py-5"
      >
        <GatewayCatalogGate>
          {(catalog) => (
            <RoutingStatus
              catalog={catalog}
              policyId={initialPolicyId}
              routeAppRequest={routeAppRequest}
              onRouteAppRequestHandled={onRouteAppRequestHandled}
            />
          )}
        </GatewayCatalogGate>
      </div>
      {/* 可恢复的操作（路由目标、队列、聚合名单都保留），不用红色 */}
      <ConfirmDialog
        isOpen={confirmExitAll}
        variant="info"
        title={t("routingSettings.exitAllTitle")}
        message={t("routingSettings.exitAllMessage")}
        confirmText={t("routingSettings.exitAllConfirm")}
        onConfirm={() => {
          setConfirmExitAll(false);
          void stopWithRestore().catch(() => undefined);
        }}
        onCancel={() => setConfirmExitAll(false)}
      />
    </>
  );
}
