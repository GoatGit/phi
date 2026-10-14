import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { gatewayApi } from "@/lib/api";
import {
  type GatewayCatalog,
  type GatewayRoutingSummary,
  type GatewayTraceQuery,
} from "@/lib/api/gateway";
import { getAppLabel } from "@/config/appConfig";
import { RefreshCw } from "lucide-react";
import { TraceSection } from "./TraceSection";
import { RoutingFlow } from "./RoutingFlow";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { useGlobalProxyConfig } from "@/lib/query/proxy";
import { GatewaySelect } from "./GroupSection";
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
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      <GatewaySelect
        label={t("gateway.routingStatus.window")}
        value={String(filters.hours)}
        onChange={(hours) => onChange({ ...filters, hours: Number(hours) })}
        options={[1, 24, 168, 720].map((hours) => ({
          value: String(hours),
          label: t("gateway.routingStatus.hours", { hours }),
        }))}
      />
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
  );
}
export function RoutingSummary({
  summary: s,
  retainedSince,
}: {
  summary: GatewayRoutingSummary;
  retainedSince: number | null;
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
  const metrics = [
    [
      t("gateway.routingStatus.requests"),
      String(s.requests),
      s.requests > 0
        ? t("gateway.routingStatus.completedFailed", {
            completed: s.completed,
            failed: s.failed,
            interrupted: s.interrupted,
          })
        : null,
    ],
    [
      t("gateway.routingStatus.successRate"),
      s.requests ? `${((s.completed / s.requests) * 100).toFixed(1)}%` : "—",
      s.failovers > 0
        ? t("gateway.routingStatus.failovers", { count: s.failovers })
        : null,
    ],
    [
      t("gateway.routingStatus.latency"),
      s.requests ? `${s.p50LatencyMs} / ${s.p95LatencyMs} ms` : "—",
      null,
    ],
    [
      t("gateway.trace.tokens"),
      `${s.inputTokens.toLocaleString()} / ${s.outputTokens.toLocaleString()}`,
      s.unknownUsage > 0
        ? t("gateway.routingStatus.unknown", { count: s.unknownUsage })
        : null,
    ],
    [
      t("gateway.trace.cost"),
      `$${s.estimatedCost}`,
      costHints.join(" · ") || null,
    ],
  ] as const;
  return (
    <>
      <dl className="grid grid-cols-2 gap-4 rounded-lg border p-4 sm:grid-cols-3 lg:grid-cols-5">
        {metrics.map(([label, value, hint]) => (
          <div key={label} className="min-w-0">
            <dt className="text-xs text-fg-2">{label}</dt>
            <dd
              className="mt-1 text-lg font-medium tabular-nums break-words"
              title={
                label === t("gateway.trace.cost")
                  ? t("gateway.routingStatus.costNote")
                  : undefined
              }
            >
              {value}
            </dd>
            {hint && <dd className="mt-1 text-xs text-fg-3">{hint}</dd>}
          </div>
        ))}
      </dl>
      {retainedSince != null && (
        <p className="text-xs text-fg-3">
          {t("gateway.routingStatus.retention", {
            date: new Date(retainedSince).toLocaleString(),
          })}
        </p>
      )}
    </>
  );
}

export function RoutingStatus({
  catalog,
  policyId,
  groupId,
  onOpenPolicy,
}: {
  catalog: GatewayCatalog;
  policyId?: string | null;
  groupId?: string | null;
  onOpenPolicy?: (id: string) => void;
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
  // Retention can shrink the last page while polling.
  useEffect(() => {
    if (query.data && offset > 0 && offset >= query.data.total) {
      setOffset(Math.max(0, Math.ceil(query.data.total / 50) - 1) * 50);
    }
  }, [query.data, offset]);
  const filtered = Object.entries(defaultRoutingFilters).some(
    ([key, value]) => filters[key as keyof RoutingFilters] !== value,
  );
  return (
    <section
      className="flex flex-col gap-4"
      aria-label={t("gateway.routingStatus.title")}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-xs text-fg-3">
          <span className="relative flex h-1.5 w-1.5" aria-hidden>
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-action opacity-60" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-action" />
          </span>
          {t("gateway.routingStatus.description")}
        </p>
        <div className="flex items-center gap-2">
          {filtered && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setFilters(defaultRoutingFilters);
                setOffset(0);
              }}
            >
              {t("gateway.trace.clearFilter")}
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            <RefreshCw data-icon="inline-start" aria-hidden />
            {t("gateway.trace.refresh")}
          </Button>
        </div>
      </div>
      <RoutingFilterBar
        filters={filters}
        onChange={(next) => {
          setFilters(next);
          setOffset(0);
        }}
        catalog={catalog}
      />
      {config.data?.enableLogging === false && (
        <Notice tone="warning" title={t("gateway.routingStatus.loggingOff")} />
      )}
      {query.isError ? (
        <Notice tone="danger" title={describeError(query.error)} />
      ) : query.isPending ? (
        <p role="status">{t("gateway.loading")}</p>
      ) : (
        <>
          <RoutingSummary
            summary={query.data.summary}
            retainedSince={query.data.retainedSince}
          />
          <RoutingFlow
            key={JSON.stringify([filters, offset])}
            data={query.data}
          />
          {!!query.data.active.length && (
            <div className="flex flex-col gap-3">
              <h3 className="font-medium">
                {t("gateway.routingStatus.active")}
              </h3>
              {query.data.active.map((trace) => {
                const event = trace.events.at(-1);
                return (
                  <div
                    key={trace.id}
                    className="rounded-md border p-3 text-sm break-words"
                  >
                    {getAppLabel(trace.appId)} →{" "}
                    {event?.groupPath
                      ?.map(
                        (id) =>
                          trace.decision?.groups.find((g) => g.id === id)
                            ?.name ?? id,
                      )
                      .join(" → ") || trace.policy.name}{" "}
                    →{" "}
                    {event
                      ? `${event.supplierName || event.supplierId} · ${event.model}`
                      : t("gateway.trace.outcomes.pending")}
                    <span className="ms-2 text-fg-3">
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
          <TraceSection
            catalog={catalog}
            data={query.data}
            offset={offset}
            onOffsetChange={setOffset}
            onOpenPolicy={onOpenPolicy}
          />
        </>
      )}
    </section>
  );
}
