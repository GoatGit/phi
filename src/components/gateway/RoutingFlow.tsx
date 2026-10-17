import { useEffect, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { GatewayCatalog, GatewayTracePage } from "@/lib/api/gateway";
import { getAppLabel } from "@/config/appConfig";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import {
  buildRoutingFlow,
  buildTimeline,
  laneColor,
  laneFinalState,
  lanePlayback,
  type FlowLane,
  type FlowState,
} from "./routingFlowModel";

const NODE_H = 72;
const NODE_GAP = 16;

/** Shares the status page's filtered query; the catalog only supplies the
 * configured base topology. Historical names and paths still come from the
 * traces so past requests render as they happened. */
export function RoutingFlow({
  data,
  catalog,
}: {
  data: GatewayTracePage;
  catalog?: GatewayCatalog;
}) {
  const { t } = useTranslation();
  const titleId = useId();
  const [step, setStep] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [focus, setFocus] = useState<string | null>(null);
  const { apps, lanes, groups, outlets, liveCount } = useMemo(
    () => buildRoutingFlow(data, catalog),
    [data, catalog],
  );
  const timeline = useMemo(() => buildTimeline(lanes), [lanes]);
  const total = timeline.length;

  useEffect(() => {
    setStep((current) =>
      current != null && current > total ? total : current,
    );
  }, [total]);

  useEffect(() => {
    if (!playing) return;
    if (step == null || step >= total) {
      setPlaying(false);
      return;
    }
    const timer = window.setTimeout(() => setStep(step + 1), 900);
    return () => window.clearTimeout(timer);
  }, [playing, step, total]);

  const rows = Math.max(apps.length, groups.length, outlets.length, 1);
  const listHeight = rows * NODE_H + Math.max(0, rows - 1) * NODE_GAP;
  const height = Math.max(236, listHeight);
  const nodeY = (index: number, count: number) =>
    (height - (count * NODE_H + Math.max(0, count - 1) * NODE_GAP)) / 2 +
    index * (NODE_H + NODE_GAP) +
    NODE_H / 2;
  const centerY = height / 2;
  const appIndex = new Map(apps.map((app, index) => [app.appId, index]));
  const groupY = new Map(
    groups.map((group, index) => [group.key, nodeY(index, groups.length)]),
  );
  const outletY = new Map(
    outlets.map((outlet, index) => [outlet.key, nodeY(index, outlets.length)]),
  );
  // Wires sharing both endpoints would overlap exactly; fan parallel wires
  // out symmetrically so every wire keeps its own visible line. The gray
  // configured base layer and the colored traffic lanes share the offset
  // pools so neither sits exactly on top of the other.
  const fanOut = (keys: string[]): Map<string, number> => {
    const counts = new Map<string, number>();
    const offsets = new Map<string, number>();
    for (const key of keys) {
      const index = counts.get(key) ?? 0;
      counts.set(key, index + 1);
      offsets.set(key, index);
    }
    for (const [key, index] of offsets) {
      offsets.set(key, (index - (counts.get(key)! - 1) / 2) * 5);
    }
    return offsets;
  };
  const groupWireOffset = fanOut([
    ...lanes.map((lane) => `g:${lane.groupKey}`),
    ...apps.flatMap((app) =>
      app.staticGroupKey ? [`g:${app.staticGroupKey}`] : [],
    ),
  ]);
  const attemptWireOffset = fanOut([
    ...lanes.flatMap((lane) =>
      lane.attempts.map(
        (attempt) =>
          `a:${lane.groupKey}:${attempt.supplierId}|${attempt.model}`,
      ),
    ),
    ...apps.flatMap((app) =>
      app.staticOutletKeys.map((key) => `a:${app.staticGroupKey}:${key}`),
    ),
  ]);
  const trafficGroups = new Set(lanes.map((lane) => lane.groupKey));

  const laneStyle = (
    lane: FlowLane,
    state: FlowState,
  ): { "data-state": string; style: { stroke: string } } => ({
    "data-state": state,
    style: { stroke: laneColor(lane.appId, apps) },
  });
  const dimmed = (appId: string): { "data-dimmed": "true" } | {} =>
    focus && focus !== appId ? { "data-dimmed": "true" } : {};

  return (
    <Card role="region" aria-label={t("gateway.flow.title")}>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle>{t("gateway.flow.title")}</CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            {liveCount > 0 && (
              <Badge variant="outline">
                {t("gateway.flow.live", { count: liveCount })}
              </Badge>
            )}
            {!!total && (
              <>
                <Button
                  variant="outline"
                  size="sm"
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
                {step != null && (
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
              </>
            )}
          </div>
        </div>
        <p className="text-xs text-fg-3">{t("gateway.flow.latestHint")}</p>
      </CardHeader>
      <CardContent>
        {apps.length ? (
          <div
            className="overflow-x-auto"
            tabIndex={0}
            role="group"
            aria-labelledby={titleId}
          >
            <span className="sr-only" id={titleId}>
              {t("gateway.flow.diagram")}
            </span>
            <div className="phi-flow-stage" style={{ height: height + 24 }}>
              {/* Column 1 · apps — configured apps are always present; the
                  latest request adds the colored lane overlay on top. */}
              <ol
                className="phi-flow-col"
                aria-label={t("gateway.flow.apps")}
                style={{ height }}
              >
                {apps.map((entry) => {
                  const lane = entry.lane;
                  const playback = lane
                    ? lanePlayback(lane, timeline, step)
                    : null;
                  return (
                    <li
                      key={entry.appId}
                      className="phi-flow-node"
                      data-kind="app"
                      data-state={
                        lane
                          ? playback!.visible
                            ? laneFinalState(lane)
                            : "dimmed"
                          : "idle"
                      }
                      data-dimmed={
                        focus && focus !== entry.appId ? "true" : undefined
                      }
                      style={{ height: NODE_H }}
                    >
                      <button
                        type="button"
                        className="phi-flow-hit"
                        aria-label={t("gateway.flow.focusApp", {
                          app: getAppLabel(entry.appId),
                        })}
                        aria-pressed={focus === entry.appId}
                        onClick={() =>
                          setFocus((current) =>
                            current === entry.appId ? null : entry.appId,
                          )
                        }
                      >
                        <strong>{getAppLabel(entry.appId)}</strong>
                        <span
                          className="truncate font-mono text-xs text-fg-3"
                          title={
                            lane
                              ? `${lane.trace.requestModel || "—"} · ${new Date(lane.trace.createdAt).toLocaleTimeString()}`
                              : undefined
                          }
                        >
                          {lane
                            ? `${lane.trace.requestModel || "—"} · ${new Date(lane.trace.createdAt).toLocaleTimeString()}`
                            : entry.staticGroupKey
                              ? t("gateway.flow.idle")
                              : t("gateway.flow.noGroup")}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ol>
              {/* Wire: app → PHI. The configured base line is light gray
                  dashed; each app's traffic lane overlays it in its color. */}
              <svg
                className="phi-flow-wires"
                viewBox={`0 0 44 ${height}`}
                preserveAspectRatio="none"
                aria-hidden
              >
                {apps.map((entry) => {
                  if (!entry.configured) return null;
                  const index = appIndex.get(entry.appId) ?? 0;
                  return (
                    <path
                      key={`static:${entry.appId}`}
                      d={`M 0 ${nodeY(index, apps.length)} C 22 ${nodeY(index, apps.length)}, 22 ${centerY + 3}, 44 ${centerY + 3}`}
                      data-state="static"
                      {...dimmed(entry.appId)}
                    />
                  );
                })}
                {lanes.map((lane) => {
                  const playback = lanePlayback(lane, timeline, step);
                  if (!playback.visible) return null;
                  const state = playback.done ? laneFinalState(lane) : "active";
                  const index = appIndex.get(lane.appId) ?? 0;
                  return (
                    <path
                      key={lane.appId}
                      d={`M 0 ${nodeY(index, apps.length)} C 22 ${nodeY(index, apps.length)}, 22 ${centerY}, 44 ${centerY}`}
                      data-dimmed={
                        focus && focus !== lane.appId ? "true" : undefined
                      }
                      {...laneStyle(lane, state)}
                    />
                  );
                })}
              </svg>
              {/* Column 2 · PHI */}
              <div
                className="phi-flow-col phi-flow-hub-wrap"
                style={{ height }}
              >
                <div
                  className="phi-flow-node phi-flow-hub"
                  style={{ height: NODE_H + 8 }}
                >
                  <strong>PHI</strong>
                  {step != null ? (
                    <Badge variant="outline">
                      {t("gateway.flow.step", { current: step, total })}
                    </Badge>
                  ) : (
                    <span className="text-xs text-fg-3">
                      {t("gateway.flow.appCount", { count: apps.length })}
                    </span>
                  )}
                </div>
              </div>
              {/* Wire: PHI → group. Gray configured connections stay visible
                  under historical traffic lanes into other groups. */}
              <svg
                className="phi-flow-wires"
                viewBox={`0 0 52 ${height}`}
                preserveAspectRatio="none"
                aria-hidden
              >
                {apps.map((entry) => {
                  if (!entry.staticGroupKey) return null;
                  const target = groupY.get(entry.staticGroupKey) ?? 0;
                  const offset =
                    groupWireOffset.get(`g:${entry.staticGroupKey}`) ?? 0;
                  return (
                    <path
                      key={`static:${entry.appId}`}
                      d={`M 0 ${centerY + offset} C 26 ${centerY + offset}, 26 ${target + offset}, 52 ${target + offset}`}
                      data-state="static"
                      {...dimmed(entry.appId)}
                    />
                  );
                })}
                {lanes.map((lane) => {
                  const playback = lanePlayback(lane, timeline, step);
                  if (!playback.visible) return null;
                  const state = playback.done ? laneFinalState(lane) : "active";
                  const target = groupY.get(lane.groupKey) ?? 0;
                  const offset = groupWireOffset.get(`g:${lane.groupKey}`) ?? 0;
                  return (
                    <path
                      key={lane.appId}
                      d={`M 0 ${centerY + offset} C 26 ${centerY + offset}, 26 ${target + offset}, 52 ${target + offset}`}
                      data-dimmed={
                        focus && focus !== lane.appId ? "true" : undefined
                      }
                      {...laneStyle(lane, state)}
                    />
                  );
                })}
              </svg>
              {/* Column 3 · route groups */}
              <ol
                className="phi-flow-col"
                aria-label={t("gateway.flow.groups")}
                style={{ height }}
              >
                {groups.map((group) => (
                  <li
                    key={group.key}
                    className="phi-flow-node"
                    data-kind="group"
                    data-static={
                      trafficGroups.has(group.key) ? undefined : "true"
                    }
                    style={{ height: NODE_H }}
                  >
                    <strong className="w-full truncate" title={group.name}>
                      {group.name}
                    </strong>
                    {group.strategy ? (
                      <span className="text-xs text-fg-3">
                        {t(`gateway.groups.strategies.${group.strategy}`, {
                          defaultValue: group.strategy,
                        })}
                      </span>
                    ) : (
                      <span className="text-xs text-fg-3">
                        {t("gateway.flow.legacyPolicy")}
                      </span>
                    )}
                  </li>
                ))}
              </ol>
              {/* Wire: group → model. Gray wires carry every configured
                  member model; colored wires carry recorded attempts. */}
              <svg
                className="phi-flow-wires"
                viewBox={`0 0 52 ${height}`}
                preserveAspectRatio="none"
                aria-hidden
              >
                {apps.flatMap((entry) =>
                  entry.staticOutletKeys.map((key) => {
                    const from = groupY.get(entry.staticGroupKey!) ?? 0;
                    const to = outletY.get(key) ?? 0;
                    const offset =
                      attemptWireOffset.get(
                        `a:${entry.staticGroupKey}:${key}`,
                      ) ?? 0;
                    return (
                      <path
                        key={`static:${entry.appId}:${key}`}
                        d={`M 0 ${from + offset} C 26 ${from + offset}, 26 ${to + offset}, 52 ${to + offset}`}
                        data-state="static"
                        {...dimmed(entry.appId)}
                      />
                    );
                  }),
                )}
                {lanes.flatMap((lane) =>
                  lane.attempts.map((attempt) => {
                    const playback = lanePlayback(lane, timeline, step);
                    if (!playback.attemptVisible(attempt)) return null;
                    const outletKey = `${attempt.supplierId}|${attempt.model}`;
                    const from = groupY.get(lane.groupKey) ?? 0;
                    const to = outletY.get(outletKey) ?? 0;
                    const offset =
                      attemptWireOffset.get(
                        `a:${lane.groupKey}:${outletKey}`,
                      ) ?? 0;
                    const state: FlowState =
                      playback.headAttempt === attempt.key
                        ? "active"
                        : attempt.state;
                    return (
                      <path
                        key={`${lane.appId}:${attempt.key}`}
                        d={`M 0 ${from + offset} C 26 ${from + offset}, 26 ${to + offset}, 52 ${to + offset}`}
                        data-dimmed={
                          focus && focus !== lane.appId ? "true" : undefined
                        }
                        {...laneStyle(lane, state)}
                      />
                    );
                  }),
                )}
              </svg>
              {/* Column 4 · models — configured members without traffic keep
                  a neutral idle state. */}
              <ol
                className="phi-flow-col phi-flow-outlets"
                aria-label={t("gateway.flow.models")}
                style={{ height }}
              >
                {outlets.map((outlet) => (
                  <li
                    key={outlet.key}
                    className="phi-flow-node"
                    data-kind="model"
                    data-state={outlet.state ?? undefined}
                    data-static={outlet.state == null ? "true" : undefined}
                    style={{ height: NODE_H }}
                  >
                    <span className="phi-flow-dot" aria-hidden />
                    <div className="min-w-0 flex-1 text-start">
                      <p
                        className="truncate text-sm font-medium"
                        title={outlet.supplierName}
                      >
                        {outlet.supplierName}
                      </p>
                      <p
                        className="truncate font-mono text-xs text-fg-2"
                        title={outlet.model}
                      >
                        {outlet.model}
                      </p>
                    </div>
                    {outlet.state && outlet.state !== "completed" && (
                      <span className="text-xs text-fg-3">
                        {t(`gateway.flow.states.${outlet.state}`)}
                      </span>
                    )}
                  </li>
                ))}
              </ol>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-4 py-5">
            <div
              className="flex items-center justify-center gap-4 text-sm text-fg-2"
              aria-hidden
            >
              <span>{t("gateway.flow.apps")}</span>
              <span>→</span>
              <strong>PHI</strong>
              <span>→</span>
              <span>{t("gateway.flow.groups")}</span>
              <span>→</span>
              <span>{t("gateway.flow.models")}</span>
            </div>
            <p role="status" className="text-center text-sm text-fg-3">
              {t("gateway.flow.empty")}
            </p>
          </div>
        )}
        {!!apps.length && (
          <div
            className="flex flex-wrap gap-x-4 gap-y-2 pt-1 text-xs text-fg-2"
            aria-label={t("gateway.flow.legend")}
          >
            <span className="phi-flow-key">
              <span
                className="phi-flow-line phi-flow-line-active"
                aria-hidden
              />
              {t("gateway.flow.lineActive")}
            </span>
            <span className="phi-flow-key">
              <span
                className="phi-flow-line phi-flow-line-completed"
                aria-hidden
              />
              {t("gateway.flow.lineCompleted")}
            </span>
            <span className="phi-flow-key">
              <span
                className="phi-flow-line phi-flow-line-failed"
                aria-hidden
              />
              {t("gateway.flow.lineFailed")}
            </span>
            <span className="phi-flow-key">
              <span
                className="phi-flow-line phi-flow-line-unknown"
                aria-hidden
              />
              {t("gateway.flow.lineUnknown")}
            </span>
            <span className="phi-flow-key">
              <span
                className="phi-flow-line phi-flow-line-static"
                aria-hidden
              />
              {t("gateway.flow.configured")}
            </span>
            {lanes.map((lane) => {
              const color = laneColor(lane.appId, apps);
              return (
                <span
                  key={lane.appId}
                  className="phi-flow-key"
                  data-state={laneFinalState(lane)}
                >
                  <span
                    className="phi-flow-line"
                    style={{ background: color }}
                    aria-hidden
                  />
                  {getAppLabel(lane.appId)}
                  {lane.live && (
                    <span className="text-fg-3">
                      · {t("gateway.flow.liveOne")}
                    </span>
                  )}
                </span>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
