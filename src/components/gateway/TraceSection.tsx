import { useState } from "react";
import { useTranslation } from "react-i18next";
import { getAppLabel } from "@/config/appConfig";
import type { GatewayRequestTrace, GatewayCatalog } from "@/lib/api";
import type { GatewayTracePage, GatewayMemberStatus } from "@/lib/api/gateway";
import { ChevronDown, ChevronRight } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { DecisionDetails } from "./DecisionDetails";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/** 后端只写入固定类别，不会出现任意上游文本。 */
const KNOWN_OUTCOMES = new Set([
  "upstream_accepted",
  "pending",
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
]);

/** Request history consumes the status page's shared query and filters.
 *  Each row expands inline into the routing process (attempts / failover)
 *  and the current runtime status of the involved outlets. */
export function TraceSection({
  catalog,
  data,
  offset,
  onOffsetChange,
  onOpenPolicy,
}: {
  catalog: GatewayCatalog;
  data: GatewayTracePage;
  offset: number;
  onOffsetChange: (offset: number) => void;
  onOpenPolicy?: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<GatewayRequestTrace | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const statuses = new Map(
    data.members.map((m) => [`${m.supplierId}\0${m.model}`, m]),
  );
  const visibleTraces = data.traces;
  return (
    <section
      className="flex flex-col gap-3"
      aria-label={t("gateway.trace.title")}
    >
      <h2 className="text-base font-medium">{t("gateway.trace.title")}</h2>
      {visibleTraces.length === 0 ? (
        <p className="text-sm text-fg-3">{t("gateway.trace.empty")}</p>
      ) : (
        <Table className="[&_td]:px-3 [&_td]:py-3 [&_th]:px-3 [&_th]:h-10">
          <TableHeader>
            <TableRow>
              <TableHead className="w-8" />
              <TableHead>{t("gateway.trace.time")}</TableHead>
              <TableHead>{t("gateway.agent")}</TableHead>
              <TableHead>{t("gateway.trace.policy")}</TableHead>
              <TableHead className="whitespace-nowrap">
                {t("gateway.trace.latestOutlet")}
              </TableHead>
              <TableHead>{t("gateway.trace.outcome")}</TableHead>
              <TableHead>{t("gateway.trace.latency")}</TableHead>
              <TableHead>{t("gateway.trace.usageCost")}</TableHead>
              <TableHead>{t("gateway.decisions.details")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visibleTraces.map((trace) => {
              const isExpanded = expandedId === trace.id;
              return (
                <TraceRows
                  key={trace.id}
                  trace={trace}
                  catalog={catalog}
                  statuses={statuses}
                  isExpanded={isExpanded}
                  onToggle={() => setExpandedId(isExpanded ? null : trace.id)}
                  onOpenPolicy={onOpenPolicy}
                  onOpenDetails={setSelected}
                />
              );
            })}
          </TableBody>
        </Table>
      )}
      {data.total > 50 && (
        <div className="flex items-center justify-end gap-3">
          <Button
            variant="outline"
            disabled={offset === 0}
            onClick={() => onOffsetChange(Math.max(0, offset - 50))}
          >
            {t("gateway.decisions.previous")}
          </Button>
          <span className="text-xs">
            {t("gateway.decisions.page", {
              start: offset + 1,
              end: Math.min(offset + 50, data.total),
              total: data.total,
            })}
          </span>
          <Button
            variant="outline"
            disabled={offset + 50 >= data.total}
            onClick={() => onOffsetChange(offset + 50)}
          >
            {t("gateway.decisions.next")}
          </Button>
        </div>
      )}
      {selected && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setSelected(null);
          }}
        >
          <DialogContent className="max-h-[85vh] max-w-4xl overflow-y-auto">
            <DialogHeader>
              <DialogTitle>{t("gateway.decisions.details")}</DialogTitle>
              <DialogDescription>
                {getAppLabel(selected.appId)} · {selected.requestModel} ·{" "}
                {selected.policy.name} ·{" "}
                {t("gateway.preview.revision", {
                  revision: selected.catalogRevision,
                })}
              </DialogDescription>
            </DialogHeader>
            <div className="px-6 pb-6 flex flex-col gap-4">
              <p className="text-xs font-mono break-all">{selected.id}</p>
              <p className="text-xs text-fg-2">
                {t(
                  selected.policy.id.startsWith("group/") ||
                    selected.policy.id.startsWith("connection/")
                    ? "gateway.preview.group"
                    : selected.policy.matchModel
                      ? "gateway.preview.model_match"
                      : "gateway.preview.catch_all",
                )}
                {!selected.policy.groupId && (
                  <>
                    {" "}
                    · {t("gateway.policy.priority")} {selected.policy.priority}
                  </>
                )}
              </p>
              <OutcomeBadge outcome={selected.outcome} />
              {selected.events.map((event, i) => (
                <div
                  key={i}
                  className="flex flex-wrap gap-2 items-center text-sm"
                >
                  <span>
                    {i + 1}. {event.supplierName || event.supplierId} →{" "}
                    {event.model}
                  </span>
                  <OutcomeBadge outcome={event.outcome} />
                  <span>{event.latencyMs ?? "—"} ms</span>
                </div>
              ))}
              {selected.decision ? (
                <DecisionDetails decision={selected.decision} />
              ) : (
                <p>{t("gateway.decisions.legacy")}</p>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setSelected(null)}>
                {t("common.close")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </section>
  );
}

/** Main record row plus an inline expandable routing-process panel. */
function TraceRows({
  trace,
  catalog,
  statuses,
  isExpanded,
  onToggle,
  onOpenPolicy,
  onOpenDetails,
}: {
  trace: GatewayRequestTrace;
  catalog: GatewayCatalog;
  statuses: Map<string, GatewayMemberStatus>;
  isExpanded: boolean;
  onToggle: () => void;
  onOpenPolicy?: (id: string) => void;
  onOpenDetails: (trace: GatewayRequestTrace) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <TableRow>
        <TableCell className="w-8">
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            aria-expanded={isExpanded}
            aria-label={t("gateway.trace.routingProcess")}
            onClick={onToggle}
          >
            {isExpanded ? (
              <ChevronDown aria-hidden />
            ) : (
              <ChevronRight aria-hidden />
            )}
          </Button>
        </TableCell>
        <TableCell className="whitespace-nowrap text-xs text-fg-2">
          {formatTime(trace.createdAt)}
        </TableCell>
        <TableCell>{getAppLabel(trace.appId)}</TableCell>
        <TableCell className="max-w-40 break-words">
          {onOpenPolicy ? (
            <Button
              variant="link"
              size="sm"
              disabled={
                !catalog.policies.some(
                  (policy) => policy.id === trace.policy.id,
                )
              }
              onClick={() => onOpenPolicy?.(trace.policy.id)}
            >
              {trace.policy.name || trace.policy.id}
            </Button>
          ) : (
            <span className="text-sm">
              {trace.policy.name || trace.policy.id}
            </span>
          )}
          {!trace.policy.groupId &&
            !catalog.policies.some(
              (policy) => policy.id === trace.policy.id,
            ) && (
              <span className="text-xs text-muted-foreground">
                {t("gateway.trace.policyDeleted")}
              </span>
            )}
          <span className="block font-mono text-[11px] text-fg-3">
            {trace.requestModel || "—"}
          </span>
        </TableCell>
        <TableCell>
          <div className="flex max-w-80 flex-col gap-0.5">
            {trace.events.slice(-1).map((event) => (
              <span
                key={event.supplierId}
                className="flex flex-col gap-0.5 text-xs"
              >
                <span className="text-fg-2">
                  {event.supplierName || event.supplierId}
                </span>
                <span className="whitespace-nowrap font-mono text-fg-3">
                  {event.model}
                </span>
              </span>
            ))}
            {!trace.events.length && "—"}
            {trace.events.length > 1 && (
              <span className="text-xs text-fg-3">
                {t("gateway.trace.attempts", {
                  count: trace.events.length,
                })}
              </span>
            )}
          </div>
        </TableCell>
        <TableCell>
          <OutcomeBadge outcome={trace.outcome} />
        </TableCell>
        <TableCell className="whitespace-nowrap text-fg-2">
          {t("gateway.trace.latencyValue", { ms: trace.latencyMs })}
        </TableCell>
        <TableCell className="whitespace-nowrap text-fg-2">
          <span className="block">
            {formatTokens(trace.inputTokens, trace.outputTokens) ||
              t("gateway.trace.unknownUsage")}
          </span>
          <span className="block text-xs text-fg-3">
            {trace.estimatedCost == null
              ? t("gateway.trace.unknownUsage")
              : `$${trace.estimatedCost}`}
          </span>
        </TableCell>
        <TableCell>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onOpenDetails(trace)}
          >
            {t("gateway.decisions.details")}
          </Button>
        </TableCell>
      </TableRow>
      {isExpanded && (
        <TableRow className="bg-subtle hover:bg-subtle">
          <TableCell colSpan={9}>
            <TraceDetail trace={trace} statuses={statuses} />
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

function TraceDetail({
  trace,
  statuses,
}: {
  trace: GatewayRequestTrace;
  statuses: Map<string, GatewayMemberStatus>;
}) {
  const { t } = useTranslation();
  const outcome = (value: string) =>
    t(`gateway.trace.outcomes.${value}`, { defaultValue: value });
  const groupName = (id?: string | null) =>
    id ? (trace.decision?.groups.find((g) => g.id === id)?.name ?? id) : null;
  const rootGroup = trace.decision?.groups.find(
    (g) => g.id === trace.decision?.groupId,
  );
  const involved = [
    ...new Map(
      trace.events.map((e) => [`${e.supplierId}\0${e.model}`, e] as const),
    ).values(),
  ];
  return (
    <div className="flex flex-col gap-3 py-1 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-fg-3">{t("gateway.trace.routingProcess")}</span>
        {trace.decision ? (
          <>
            <span className="font-medium">
              {rootGroup?.name || trace.policy.name || trace.policy.id}
            </span>
            <Badge variant="outline">
              {t(
                `gateway.groups.strategies.${rootGroup?.strategy ?? "ordered"}`,
              )}
            </Badge>
            {trace.decision.intents.map((intent, i) => (
              <span key={i} className="text-fg-2">
                {t("gateway.groups.intent")} · {intent.ruleName} ·{" "}
                {t(`gateway.decisions.intentOutcomes.${intent.outcome}`, {
                  defaultValue: intent.outcome,
                })}
              </span>
            ))}
          </>
        ) : (
          <span className="text-fg-3">{t("gateway.decisions.legacy")}</span>
        )}
      </div>
      <ol className="flex flex-col gap-1.5">
        {trace.events.map((event, index) => (
          <li key={index} className="flex flex-wrap items-center gap-2">
            <span className="tabular-nums text-fg-3">{index + 1}.</span>
            <span>
              {event.supplierName || event.supplierId}{" "}
              <span className="font-mono text-fg-2">→ {event.model}</span>
            </span>
            <OutcomeBadge outcome={event.outcome} />
            {event.latencyMs != null && (
              <span className="text-fg-3">{event.latencyMs} ms</span>
            )}
            {!!event.groupPath?.length && (
              <span className="text-fg-3">
                {event.groupPath.map(groupName).join(" → ")}
              </span>
            )}
          </li>
        ))}
        {!trace.events.length && (
          <li className="text-fg-3">{outcome(trace.outcome)}</li>
        )}
      </ol>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        <span className="text-fg-3">{t("gateway.trace.outletStatus")}</span>
        {involved.map((event) => {
          const status = statuses.get(`${event.supplierId}\0${event.model}`);
          return (
            <span
              key={`${event.supplierId}\0${event.model}`}
              className="flex flex-wrap items-center gap-1.5"
            >
              <span>
                {event.supplierName || event.supplierId} ·{" "}
                <span className="font-mono text-fg-2">{event.model}</span>
              </span>
              <OutletStatusBadge status={status} />
            </span>
          );
        })}
        {!involved.length && <span className="text-fg-3">—</span>}
      </div>
    </div>
  );
}

function OutletStatusBadge({ status }: { status?: GatewayMemberStatus }) {
  const { t } = useTranslation();
  const cooling =
    status?.cooldownUntil != null && status.cooldownUntil > Date.now();
  const title = status
    ? t("gateway.routingStatus.memberCounts", {
        active: status.active,
        requests: status.requests,
        successes: status.successes,
        failures: status.failures,
      }) +
      " · " +
      t("gateway.routingStatus.load", {
        tokens: Math.round(status.recentTokens),
        unknown: status.unknownUsage,
      })
    : undefined;
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <span title={title}>
        <Badge variant={cooling ? "destructive" : "secondary"}>
          {t(
            !status
              ? "gateway.routingStatus.ready"
              : cooling
                ? "gateway.routingStatus.cooldown"
                : status.active
                  ? "gateway.routingStatus.busy"
                  : "gateway.routingStatus.ready",
          )}
        </Badge>
      </span>
      {cooling && (
        <span className="text-fg-3">
          {new Date(status!.cooldownUntil!).toLocaleTimeString()}
        </span>
      )}
      {status?.lastError && (
        <span className="text-destructive">
          {t(`gateway.trace.outcomes.${status.lastError}`, {
            defaultValue: status.lastError,
          })}
        </span>
      )}
    </span>
  );
}

function OutcomeBadge({ outcome }: { outcome: string }) {
  const { t } = useTranslation();
  const key = KNOWN_OUTCOMES.has(outcome)
    ? `gateway.trace.outcomes.${outcome}`
    : null;
  return (
    <Badge
      className="self-start shrink-0 whitespace-nowrap"
      variant={
        ["upstream_accepted", "completed", "pending"].includes(outcome)
          ? "secondary"
          : "destructive"
      }
    >
      {key ? t(key) : outcome}
    </Badge>
  );
}

function formatTime(ms: number): string {
  // 后端写入的是 epoch 毫秒；防御性处理秒级值。
  const date = new Date(ms < 1e12 ? ms * 1000 : ms);
  return Number.isNaN(date.getTime()) ? String(ms) : date.toLocaleString();
}

function formatTokens(input: number | null, output: number | null): string {
  if (input == null && output == null) return "";
  return `${input ?? "?"} / ${output ?? "?"}`;
}
