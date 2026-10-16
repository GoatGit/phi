import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { GatewayRequestTrace, GatewayTracePage } from "@/lib/api/gateway";
import { getAppLabel } from "@/config/appConfig";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { GatewaySelect } from "./GroupSection";
import { buildRoutingFlow, flowEventOutcome } from "./routingFlowModel";

/** Shares the status page's filtered query; no additional polling or live
 * catalog lookups. Historical names and group paths come from the trace. */
export function RoutingFlow({ data }: { data: GatewayTracePage }) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState("auto");
  const requests = [
    ...new Map(
      [...data.traces, ...data.active].map((trace) => [trace.id, trace]),
    ).values(),
  ].sort((a, b) => b.createdAt - a.createdAt);
  const activeIds = new Set(data.active.map((trace) => trace.id));
  const chosen = requests.find((trace) => trace.id === selected);
  const trace =
    chosen ?? requests.find((item) => activeIds.has(item.id)) ?? requests[0];
  const live = !!trace && activeIds.has(trace.id);
  return (
    <Card role="region" aria-label={t("gateway.flow.title")}>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle>{t("gateway.flow.title")}</CardTitle>
          {trace && (
            <Badge variant="outline">
              {t(live ? "gateway.flow.live" : "gateway.flow.snapshot")}
            </Badge>
          )}
        </div>
        {!!requests.length && (
          <GatewaySelect
            label={t("gateway.flow.request")}
            value={chosen ? selected : "auto"}
            onChange={setSelected}
            options={[
              {
                value: "auto",
                label: t("gateway.flow.follow", { count: data.active.length }),
              },
              ...requests.map((item) => ({
                value: item.id,
                label: `${new Date(item.createdAt).toLocaleTimeString()} · ${getAppLabel(item.appId)} · ${item.requestModel || "—"}`,
              })),
            ]}
          />
        )}
      </CardHeader>
      <CardContent>
        {trace ? (
          <RequestFlow key={trace.id} trace={trace} isLive={live} />
        ) : (
          <div className="flex flex-col gap-4 py-5">
            <div
              className="flex items-center justify-center gap-4 text-sm text-fg-2"
              aria-hidden
            >
              <span>{t("gateway.agent")}</span>
              <span>→</span>
              <strong>PHI</strong>
              <span>→</span>
              <span>{t("gateway.flow.outlets")}</span>
            </div>
            <p role="status" className="text-center text-sm text-fg-3">
              {t("gateway.flow.empty")}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function RequestFlow({
  trace,
  isLive = false,
}: {
  trace: GatewayRequestTrace;
  isLive?: boolean;
}) {
  const { t } = useTranslation();
  const titleId = useId();
  const [step, setStep] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const count = step ?? trace.events.length;
  const { nodes, eventNodes } = buildRoutingFlow(
    trace,
    isLive && step === null,
    count,
  );
  const focused = eventNodes.at(-1);
  const rootGroup = trace.decision?.groups.find(
    (group) => group.id === trace.decision?.groupId,
  );
  const strategy = rootGroup
    ? t(`gateway.groups.strategies.${rootGroup.strategy}`)
    : t("gateway.groups.strategies.ordered");
  const height = Math.max(
    240,
    nodes.length * 96 + Math.max(0, nodes.length - 1) * 12,
  );
  const top =
    (height - (nodes.length * 96 + Math.max(0, nodes.length - 1) * 12)) / 2;
  const moving = (isLive && step === null) || playing;
  const outcome = (value: string) =>
    t(`gateway.trace.outcomes.${value}`, { defaultValue: value });

  useEffect(() => {
    if (!playing) return;
    if (count >= trace.events.length) {
      setPlaying(false);
      return;
    }
    const timer = window.setTimeout(() => setStep(count + 1), 900);
    return () => window.clearTimeout(timer);
  }, [playing, count, trace.events.length]);

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 text-sm">
          <p className="break-words font-medium">
            {rootGroup?.name || trace.policy.name || trace.policy.id}
          </p>
          <p className="text-xs text-fg-3">
            {t("gateway.preview.revision", { revision: trace.catalogRevision })}{" "}
            · {strategy}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={isLive || !trace.events.length}
            onClick={() => {
              if (playing) setPlaying(false);
              else {
                setStep(0);
                setPlaying(true);
              }
            }}
          >
            {t(playing ? "gateway.flow.pause" : "gateway.flow.replay")}
          </Button>
          {step !== null && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setStep(null);
                setPlaying(false);
              }}
            >
              {t("gateway.flow.showAll")}
            </Button>
          )}
        </div>
      </div>
      <div
        className="overflow-x-auto"
        tabIndex={0}
        role="group"
        aria-labelledby={titleId}
      >
        <span className="sr-only" id={titleId}>
          {t("gateway.flow.diagram")}
        </span>
        <div className="phi-routing-stage" style={{ height: height + 24 }}>
          <div className="phi-routing-node phi-routing-source">
            <span className="phi-routing-mark">
              {getAppLabel(trace.appId).slice(0, 1)}
            </span>
            <strong>{getAppLabel(trace.appId)}</strong>
            <span
              className="truncate text-xs text-fg-3"
              title={trace.requestModel}
            >
              {trace.requestModel || "—"}
            </span>
          </div>
          <svg
            className="phi-routing-wires"
            viewBox={`0 0 40 ${height}`}
            preserveAspectRatio="none"
            aria-hidden
          >
            <path
              d={`M 0 ${height / 2} H 40`}
              data-state={moving ? "active" : "available"}
            />
          </svg>
          <div className="phi-routing-node phi-routing-hub">
            <span className="phi-routing-mark">φ</span>
            <strong>PHI</strong>
            <span className="text-xs text-fg-2">{strategy}</span>
            <Badge variant="outline">
              {step !== null
                ? t("gateway.flow.step", {
                    current: count,
                    total: trace.events.length,
                  })
                : outcome(trace.outcome)}
            </Badge>
          </div>
          <svg
            className="phi-routing-wires"
            viewBox={`0 0 56 ${height}`}
            preserveAspectRatio="none"
            aria-hidden
          >
            {nodes.map((node, index) => (
              <path
                key={node.id}
                d={`M 0 ${height / 2} C 28 ${height / 2}, 28 ${top + index * 108 + 48}, 56 ${top + index * 108 + 48}`}
                data-state={node.state}
                data-moving={moving && node.id === focused ? "true" : undefined}
              />
            ))}
          </svg>
          <ol
            className="flex flex-col gap-3"
            aria-label={t("gateway.flow.outlets")}
          >
            {nodes.map((node) => (
              <li
                key={node.id}
                className="phi-routing-outlet"
                data-state={node.state}
                data-focused={node.id === focused ? "true" : undefined}
              >
                <span className="phi-routing-dot" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium" title={node.name}>
                    {node.name}
                  </p>
                  <p
                    className="truncate font-mono text-xs text-fg-2"
                    title={node.model}
                  >
                    {node.model}
                  </p>
                  {!!node.groups.length && (
                    <p
                      className="truncate text-xs text-fg-3"
                      title={node.groups.join(" → ")}
                    >
                      {node.groups.join(" → ")}
                    </p>
                  )}
                </div>
                <div className="flex max-w-[44%] flex-col items-end gap-1 text-end text-xs">
                  <span className="phi-routing-state">
                    {t(`gateway.flow.states.${node.state}`)}
                  </span>
                  {node.latestOutcome && node.latestOutcome !== "completed" && (
                    <span className="text-fg-3">
                      {outcome(node.latestOutcome)}
                    </span>
                  )}
                  {!!node.attempts.length && (
                    <span className="text-fg-3">
                      {node.attempts.map((n) => `#${n}`).join(" · ")}
                    </span>
                  )}
                </div>
              </li>
            ))}
            {!nodes.length && (
              <li className="text-sm text-fg-3">
                {t("gateway.decisions.noCandidates")}
              </li>
            )}
          </ol>
        </div>
      </div>
      <div
        className="flex flex-wrap gap-x-4 gap-y-2 text-xs text-fg-2"
        aria-label={t("gateway.flow.legend")}
      >
        {(
          ["active", "completed", "failed", "cooldown", "available"] as const
        ).map((state) => (
          <span key={state} className="phi-routing-key" data-state={state}>
            <span className="phi-routing-dot" aria-hidden />
            {t(`gateway.flow.states.${state}`)}
          </span>
        ))}
      </div>
      <div className="flex flex-col gap-2 border-t pt-3">
        <p role="status" className="text-sm text-fg-2">
          {step !== null
            ? t("gateway.flow.step", {
                current: count,
                total: trace.events.length,
              })
            : t(isLive ? "gateway.flow.liveHint" : "gateway.flow.historyHint")}
        </p>
        {!!trace.decision?.intents.length && (
          <p className="text-xs text-fg-2">
            {t("gateway.groups.intent")} ·{" "}
            {trace.decision.intents
              .map((intent) =>
                [
                  intent.ruleName,
                  t(`gateway.decisions.intentOutcomes.${intent.outcome}`, {
                    defaultValue: intent.outcome,
                  }),
                ]
                  .filter(Boolean)
                  .join(" · "),
              )
              .join(" / ")}
          </p>
        )}
        {trace.decision && (
          <p className="text-xs text-fg-3">
            {t("gateway.decisions.affinity")} ·{" "}
            {t(`gateway.decisions.affinityStates.${trace.decision.affinity}`, {
              defaultValue: trace.decision.affinity,
            })}
          </p>
        )}
        <ol
          className="flex flex-col gap-1"
          aria-label={t("gateway.flow.attempts")}
        >
          {trace.events.map((event, index) => (
            <li key={index}>
              <Button
                variant="ghost"
                size="sm"
                className="h-auto w-full justify-start whitespace-normal py-2 text-start"
                aria-pressed={step === index + 1}
                onClick={() => {
                  setStep(index + 1);
                  setPlaying(false);
                }}
              >
                <span className="shrink-0 tabular-nums">{index + 1}.</span>
                <span className="min-w-0 break-words">
                  {event.supplierName || event.supplierId} → {event.model} ·{" "}
                  {outcome(flowEventOutcome(trace, index))} ·{" "}
                  {event.latencyMs ?? "—"} ms
                </span>
              </Button>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
