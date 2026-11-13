import { useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { AppPageHeader } from "@/components/shell/AppPageHeader";
import { PageHeaderBackButton } from "@/components/shell/PageHeaderBackButton";
import { Button } from "@/components/ui/button";
import { PageTabs } from "@/components/ui/page-tabs";
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

export type GatewayTab = "routing" | "suppliers";

export interface GatewayPageProps {
  /** 进页时落在哪个页签：侧栏「路由」默认落在路由页签 */
  initialTab?: GatewayTab;
  /** 路由页签按某个应用的策略筛选（供应商页签点引用跳过来时用） */
  initialPolicyId?: string | null;
  /** 从其他页面下钻进来时的返回（与用量 / 会话页同一 drill-in 约定） */
  onBack?: () => void;
  /** 供应商页签点了某条策略引用：切到路由页签并按该策略筛选 */
  onOpenPolicy?: (id: string) => void;
  /** 侧栏点了路由专用应用：进页后打开它的「设置应用路由」 */
  routeAppRequest?: RouteAppRequest | null;
  onRouteAppRequestHandled?: () => void;
}

/**
 * 「路由」页：合并了原来的供应商页与路由页，两者是同一条链路的两个视角——
 * 供应商是链路入口（统一资源池，所有供应商在这里集中新建/编辑/删除），
 * 路由是链路本身（应用节点 + 路由组 + 请求轨迹）。
 *
 * 两页共用一份网关目录（`useGatewayCatalog`），所以目录的加载与错误态
 * 收在页签外层，切页签不重新拉取，也不会各自渲染一套加载提示。
 */
export function GatewayPage({
  initialTab = "routing",
  initialPolicyId,
  onBack,
  onOpenPolicy,
  routeAppRequest,
  onRouteAppRequestHandled,
}: GatewayPageProps = {}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<GatewayTab>(initialTab);
  const [createOpen, setCreateOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const selectTab = (next: GatewayTab) => {
    if (next === tab) return;
    setTab(next);
    // 两个页签共用一条滚动容器：切页签回到顶部，别停在上一页的滚动位置
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  };

  const openPolicy = (id: string) => {
    selectTab("routing");
    onOpenPolicy?.(id);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <AppPageHeader
        leading={onBack && <PageHeaderBackButton onClick={onBack} />}
        title={null}
        tabs={
          <PageTabs
            size="lg"
            // 与用量 / 插件中心一致：页签底线压在页头分割线上
            className="self-end -mb-px"
            aria-label={t("gateway.routing")}
            idPrefix="gateway-tab"
            controls="gateway-tabpanel"
            value={tab}
            onValueChange={(value) => selectTab(value as GatewayTab)}
            items={[
              { value: "routing", label: t("gateway.routing") },
              { value: "suppliers", label: t("gateway.providers") },
            ]}
          />
        }
      />
      <div
        ref={scrollRef}
        id="main-content"
        className="min-h-0 flex-1 overflow-y-auto scroll-stable px-6 pb-10 pt-4"
      >
        <div
          id="gateway-tabpanel"
          role="tabpanel"
          aria-labelledby={`gateway-tab-${tab}`}
          className="mx-auto flex max-w-5xl flex-col gap-6"
        >
          <GatewayCatalogGate>
            {(catalog) =>
              tab === "routing" ? (
                <RoutingStatus
                  catalog={catalog}
                  policyId={initialPolicyId}
                  routeAppRequest={routeAppRequest}
                  onRouteAppRequestHandled={onRouteAppRequestHandled}
                />
              ) : (
                <ResourcePoolSection
                  catalog={catalog}
                  onOpenPolicy={openPolicy}
                  createOpen={createOpen}
                  onCreateOpenChange={setCreateOpen}
                />
              )
            }
          </GatewayCatalogGate>
        </div>
      </div>
    </div>
  );
}
