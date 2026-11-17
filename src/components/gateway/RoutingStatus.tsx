import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { gatewayApi } from "@/lib/api";
import { accessApi } from "@/lib/api/access";
import {
  type GatewayCatalog,
  type GatewayRoutingSummary,
  type GatewayTraceQuery,
} from "@/lib/api/gateway";
import { getAppLabel } from "@/config/appConfig";
import { ChevronRight, RefreshCw, SlidersHorizontal } from "lucide-react";
import { TraceSection } from "./TraceSection";
import { RoutingFlow } from "./RoutingFlow";
import type { RouteAppRequest } from "./routingFlowModel";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Notice } from "@/components/ui/notice";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useGlobalProxyConfig } from "@/lib/query/proxy";
import { proxyOrigin } from "@/lib/gatewayAddress";
import { GatewaySelect } from "./GatewaySelect";
import { GATEWAY_APPS, useGatewayErrorMessage } from "./useGatewayCatalog";

export interface RoutingFilters {
  hours: number;
  appId: string;
  groupId: string;
  policyId: string;
  outcome: string;
}
export const defaultRoutingFilters: RoutingFilters = {
  hours: 24,
  appId: "all",
  groupId: "all",
  policyId: "all",
  outcome: "all",
};
export function useRoutingData(filters: RoutingFilters, offset = 0) {
  return useQuery({
    queryKey: ["gateway", "routing-data", filters, offset],
    queryFn: () => {
      const query: GatewayTraceQuery = {
        since: Date.now() - filters.hours * 3_600_000,
        offset,
      };
      if (filters.appId !== "all") query.appId = filters.appId;
      if (filters.groupId !== "all") query.groupId = filters.groupId;
      if (filters.outcome !== "all") query.outcome = filters.outcome;
      if (filters.policyId !== "all") query.policyId = filters.policyId;
      return gatewayApi.getTracePage(query);
    },
    refetchInterval: 5_000,
  });
}
function countActiveFilters(filters: RoutingFilters): number {
  return (
    Object.keys(defaultRoutingFilters) as (keyof RoutingFilters)[]
  ).filter((key) => filters[key] !== defaultRoutingFilters[key]).length;
}

/** 筛选收进单个紧凑入口，弹层内按需调整，避免四个下拉常驻占一行。 */
export function RoutingFilterBar({
  filters,
  onChange,
  catalog,
}: {
  filters: RoutingFilters;
  onChange: (filters: RoutingFilters) => void;
  catalog?: GatewayCatalog;
}) {
  const { t } = useTranslation();
  const active = countActiveFilters(filters);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="toolbar" size="sm" data-active={active > 0}>
          <SlidersHorizontal data-icon="inline-start" aria-hidden />
          {t("gateway.routingStatus.filter")}
          {active > 0 && (
            <Badge
              variant="secondary"
              className="ms-0.5 h-4 min-w-4 px-1 text-badge tabular-nums"
            >
              {active}
            </Badge>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-4">
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <span className="text-xs text-fg-2">
              {t("gateway.routingStatus.window")}
            </span>
            <GatewaySelect
              label={t("gateway.routingStatus.window")}
              value={String(filters.hours)}
              onChange={(hours) =>
                onChange({ ...filters, hours: Number(hours) })
              }
              options={[1, 24, 168, 720].map((hours) => ({
                value: String(hours),
                label: t("gateway.routingStatus.hours", { hours }),
              }))}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs text-fg-2">{t("gateway.agent")}</span>
            <GatewaySelect
              label={t("gateway.agent")}
              value={filters.appId}
              onChange={(appId) => onChange({ ...filters, appId })}
              options={[
                { value: "all", label: t("gateway.routingStatus.allApps") },
                ...GATEWAY_APPS.map((value) => ({
                  value,
                  label: getAppLabel(value),
                })),
              ]}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs text-fg-2">
              {t("gateway.groups.group")}
            </span>
            <GatewaySelect
              label={t("gateway.groups.group")}
              value={filters.groupId}
              onChange={(groupId) => onChange({ ...filters, groupId })}
              options={[
                { value: "all", label: t("gateway.routingStatus.allGroups") },
                ...(catalog?.groups ?? []).map((g) => ({
                  value: g.id,
                  label: g.name,
                })),
                ...(!catalog?.groups?.some((g) => g.id === filters.groupId) &&
                filters.groupId !== "all"
                  ? [{ value: filters.groupId, label: filters.groupId }]
                  : []),
              ]}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs text-fg-2">
              {t("gateway.trace.outcome")}
            </span>
            <GatewaySelect
              label={t("gateway.trace.outcome")}
              value={filters.outcome}
              onChange={(outcome) => onChange({ ...filters, outcome })}
              options={[
                { value: "all", label: t("gateway.routingStatus.allOutcomes") },
                ...[
                  "completed",
                  "interrupted",
                  "response_error",
                  "authentication",
                  "rate_limit",
                  "upstream_unavailable",
                  "request_rejected",
                  "timeout",
                  "circuit_open",
                  "configuration",
                  "transport",
                  "pending",
                  "upstream_accepted",
                ].map((value) => ({
                  value,
                  label: t(`gateway.trace.outcomes.${value}`),
                })),
              ]}
            />
          </div>
          {active > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onChange(defaultRoutingFilters)}
            >
              {t("gateway.trace.clearFilter")}
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
export function RoutingSummary({
  summary: s,
}: {
  summary: GatewayRoutingSummary;
}) {
  const { t } = useTranslation();
  const costHints = [
    Number(s.classifierCost) > 0 &&
      t("gateway.routingStatus.costWithClassifier", {
        cost: s.classifierCost,
      }),
    s.classifierCalls > 0 &&
      t("gateway.routingStatus.classifierUsage", {
        count: s.classifierCalls,
      }),
    s.unknownCost > 0 &&
      t("gateway.routingStatus.unknown", { count: s.unknownCost }),
  ].filter(Boolean) as string[];
  // 单行摘要：去掉卡片边框与分栏，压缩统计区纵向占用；标签保持独立
  // 文本节点，便于屏幕阅读器与测试定位。
  const metrics: { label: string; value: string; hint: string | null }[] = [
    {
      label: t("gateway.routingStatus.requests"),
      value: String(s.requests),
      hint:
        s.requests > 0
          ? t("gateway.routingStatus.completedFailed", {
              completed: s.completed,
              failed: s.failed,
              interrupted: s.interrupted,
            })
          : null,
    },
    {
      label: t("gateway.routingStatus.successRate"),
      value: s.requests
        ? `${((s.completed / s.requests) * 100).toFixed(1)}%`
        : "—",
      hint:
        s.failovers > 0
          ? t("gateway.routingStatus.failovers", { count: s.failovers })
          : null,
    },
    {
      label: t("gateway.routingStatus.latency"),
      value: s.requests ? `${s.p50LatencyMs} / ${s.p95LatencyMs} ms` : "—",
      hint: null,
    },
    {
      label: t("gateway.trace.tokens"),
      value: `${s.inputTokens.toLocaleString()} / ${s.outputTokens.toLocaleString()}`,
      hint:
        s.unknownUsage > 0
          ? t("gateway.routingStatus.unknown", { count: s.unknownUsage })
          : null,
    },
    {
      label: t("gateway.trace.cost"),
      value: formatCost(s.estimatedCost),
      hint: costHints.join(" · ") || null,
    },
  ];
  // 指标按列排：标签在上、数值在下，最多 5 列；窄窗自动落到 3 / 2 列。
  // 以前是一行 flex-wrap，长提示会把行拆得七零八落。
  // 数值提到 strong（14/500）而不是正文：这些数字是首页第二眼要读的东西，
  // 与旁边表格的正文同级会让整屏变成一片灰字。
  return (
    <dl className="grid grid-cols-2 gap-x-3 gap-y-3 sm:grid-cols-3 xl:grid-cols-5">
      {metrics.map((metric) => (
        <div
          key={metric.label}
          className="flex min-w-0 flex-col gap-0.5 rounded-panel border bg-surface px-3 py-2"
        >
          <dt className="truncate text-caption text-fg-3">{metric.label}</dt>
          <dd
            className="truncate text-strong tabular-nums text-fg-1"
            title={
              metric.label === t("gateway.trace.cost")
                ? `${t("gateway.routingStatus.costNote")} · $${s.estimatedCost}`
                : metric.value
            }
          >
            {metric.value}
          </dd>
          {metric.hint && (
            <span
              className="truncate text-caption text-fg-3"
              title={metric.hint}
            >
              {metric.hint}
            </span>
          )}
        </div>
      ))}
    </dl>
  );
}

/** 费用按 4 位小数读；8 位小数在指标卡里既读不出量级、又把整行撑满。
 *  下限写成 `<$0.0001` 而不是 `$<0.0001`：符号和小数点的顺序一错，读起来像笔误。 */
function formatCost(value: string): string {
  const number = Number(value);
  if (!Number.isFinite(number)) return `$${value}`;
  if (number === 0) return "$0.00";
  return number < 0.0001 ? "<$0.0001" : `$${number.toFixed(4)}`;
}

export function RoutingStatus({
  catalog,
  policyId,
  groupId,
  onOpenPolicy,
  routeAppRequest,
  onRouteAppRequestHandled,
}: {
  catalog: GatewayCatalog;
  policyId?: string | null;
  groupId?: string | null;
  onOpenPolicy?: (id: string) => void;
  /** 侧栏发来的“打开应用路由设置”请求 */
  routeAppRequest?: RouteAppRequest | null;
  onRouteAppRequestHandled?: () => void;
}) {
  const { t } = useTranslation();
  const describeError = useGatewayErrorMessage();
  const [filters, setFilters] = useState({
    ...defaultRoutingFilters,
    groupId: groupId ?? "all",
    policyId: policyId ?? "all",
  });
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    setFilters((previous) => ({
      ...previous,
      groupId: groupId ?? "all",
      policyId: policyId ?? "all",
    }));
    setOffset(0);
  }, [groupId, policyId]);
  const query = useRoutingData(filters, offset);
  const config = useGlobalProxyConfig();
  const bindings = useQuery({
    queryKey: ["access-bindings"],
    queryFn: accessApi.bindings,
  });
  // 流转图给的是「照着填进客户端」的地址：带协议头和 /v1，和后端
  // `proxy_origin` 一致；0.0.0.0 / :: 监听所有网卡，客户端连不上，改用回环。
  const gatewayAddress = config.data
    ? proxyOrigin(config.data.listenAddress, config.data.listenPort)
    : undefined;
  // 请求记录默认完全收起：首页第一眼只应该看到图。展开后还保留一条页头，
  // 计数与展开按钮就在那里，不必滚回顶部再收起。
  const [historyOpen, setHistoryOpen] = useState(false);
  // Retention can shrink the last page while polling.
  useEffect(() => {
    if (query.data && offset > 0 && offset >= query.data.total) {
      setOffset(Math.max(0, Math.ceil(query.data.total / 50) - 1) * 50);
    }
  }, [query.data, offset]);
  const historyId = "gateway-request-history";
  // 筛了谁、筛成什么样必须写在脸上：只给按钮一个数字角标，用户看到图变空
  // 会以为是数据没了，而不是「我正在筛 Codex」。
  const filterSummary = [
    filters.appId !== "all" ? getAppLabel(filters.appId) : null,
    filters.groupId !== "all"
      ? (catalog?.groups?.find((group) => group.id === filters.groupId)?.name ??
        filters.groupId)
      : null,
    filters.outcome !== "all"
      ? t(`gateway.trace.outcomes.${filters.outcome}`, {
          defaultValue: filters.outcome,
        })
      : null,
  ].filter(Boolean) as string[];
  return (
    <section
      className="flex flex-col gap-4"
      aria-label={t("gateway.routingStatus.title")}
    >
      {/* 一行工具栏：左边是刷新状态与时间窗，右边是筛选与手动刷新。
          它和下方卡片的页头各司其职，中间不留一层空行。 */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex min-w-0 items-center gap-2 text-caption text-fg-3">
          <span className="relative flex h-1.5 w-1.5 shrink-0" aria-hidden>
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-action opacity-60 motion-reduce:hidden" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-action" />
          </span>
          <span className="truncate">
            {t("gateway.routingStatus.description")} ·{" "}
            {t("gateway.routingStatus.hours", { hours: filters.hours })}
          </span>
          {filterSummary.length > 0 && (
            <span
              className="shrink-0 rounded-full bg-subtle px-1.5 py-0.5 text-fg-2"
              title={filterSummary.join(" · ")}
            >
              {t("gateway.routingStatus.filtered", {
                summary: filterSummary.join(" · "),
              })}
            </span>
          )}
        </p>
        <div className="flex items-center gap-2">
          <RoutingFilterBar
            filters={filters}
            onChange={(next) => {
              setFilters(next);
              setOffset(0);
            }}
            catalog={catalog}
          />
          <Button
            variant="toolbar"
            size="sm"
            aria-busy={query.isFetching}
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            <RefreshCw
              data-icon="inline-start"
              aria-hidden
              className={cn(query.isFetching && "motion-safe:animate-spin")}
            />
            {t("gateway.trace.refresh")}
          </Button>
        </div>
      </div>
      {config.data?.enableLogging === false && (
        <Notice tone="warning" title={t("gateway.routingStatus.loggingOff")} />
      )}
      {query.isError ? (
        <Notice tone="danger" title={describeError(query.error)} />
      ) : query.isPending ? (
        <p role="status">{t("gateway.loading")}</p>
      ) : (
        <>
          <RoutingFlow
            key={JSON.stringify([filters, offset])}
            data={query.data}
            catalog={catalog}
            bindings={bindings.data}
            gatewayAddress={gatewayAddress}
            routeAppRequest={routeAppRequest}
            onRouteAppRequestHandled={onRouteAppRequestHandled}
          />
          <RoutingSummary summary={query.data.summary} />
          {!!query.data.active.length && (
            <div className="flex flex-col gap-3">
              <h3 className="text-strong text-fg-1">
                {t("gateway.routingStatus.active")}
              </h3>
              {query.data.active.map((trace) => {
                const event = trace.events.at(-1);
                return (
                  <div
                    key={trace.id}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-panel border bg-surface px-3 py-2 text-body break-words"
                  >
                    <span className="font-medium">
                      {getAppLabel(trace.appId)}
                    </span>
                    <span className="text-fg-3" aria-hidden>
                      →
                    </span>
                    <span>
                      {event?.groupPath
                        ?.map(
                          (id) =>
                            trace.decision?.groups.find((g) => g.id === id)
                              ?.name ?? id,
                        )
                        .join(" → ") || trace.policy.name}
                    </span>
                    <span className="text-fg-3" aria-hidden>
                      →
                    </span>
                    <span className="font-mono text-caption">
                      {event
                        ? `${event.supplierName || event.supplierId} · ${event.model}`
                        : t("gateway.trace.outcomes.pending")}
                    </span>
                    <span className="ms-auto text-caption tabular-nums text-fg-3">
                      {Math.max(
                        0,
                        Math.round((Date.now() - trace.createdAt) / 1000),
                      )}{" "}
                      s
                    </span>
                  </div>
                );
              })}
            </div>
          )}
          {/* 请求记录默认收起：首页的落点是图，表格是查证时才要的工具。 */}
          <section className="flex flex-col gap-3 rounded-panel border">
            <button
              type="button"
              className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-start"
              aria-expanded={historyOpen}
              aria-controls={historyId}
              onClick={() => setHistoryOpen((value) => !value)}
            >
              <ChevronRight
                aria-hidden
                className={cn(
                  "size-4 shrink-0 text-fg-3 transition-transform motion-reduce:transition-none",
                  historyOpen && "rotate-90",
                )}
              />
              <span className="text-strong text-fg-1">
                {t("gateway.trace.title")}
              </span>
              <span className="text-caption text-fg-3">
                {t("gateway.trace.toggleHint", { count: query.data.total })}
              </span>
            </button>
            {historyOpen && (
              <div id={historyId} className="px-4 pb-4">
                <TraceSection
                  catalog={catalog}
                  data={query.data}
                  offset={offset}
                  onOffsetChange={setOffset}
                  onOpenPolicy={onOpenPolicy}
                />
              </div>
            )}
          </section>
        </>
      )}
    </section>
  );
}
