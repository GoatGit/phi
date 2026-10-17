import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import type { GatewayCatalog, GatewayTracePage } from "@/lib/api/gateway";
import { getAppLabel } from "@/config/appConfig";
import phiLogoLight from "@/assets/icons/phi/phi-logo-light.png";
import phiLogoDark from "@/assets/icons/phi/phi-logo-dark.png";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardContent } from "@/components/ui/card";
import {
  buildRoutingFlow,
  buildTimeline,
  laneColor,
  laneFinalState,
  lanePlayback,
  type FlowLane,
  type FlowState,
} from "./routingFlowModel";

function PhiFlowLogo() {
  return (
    <span role="img" aria-label="phi" className="inline-flex size-7 shrink-0">
      <img
        src={phiLogoLight}
        alt=""
        draggable={false}
        className="size-full object-contain dark:hidden"
      />
      <img
        src={phiLogoDark}
        alt=""
        draggable={false}
        className="hidden size-full object-contain dark:block"
      />
    </span>
  );
}

/** A node's real on-screen box, relative to the flow stage. Wires are drawn
 *  from these measured values, so they always touch the rendered nodes no
 *  matter how the CSS grid distributes rows or how tall columns grow. */
type NodeBox = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  cy: number;
};

type FlowGeometry = {
  width: number;
  height: number;
  hub: NodeBox | null;
  apps: Map<string, NodeBox>;
  groups: Map<string, NodeBox>;
  models: Map<string, NodeBox>;
};

const round1 = (value: number) => Math.round(value * 10) / 10;

function boxOf(el: Element, stage: DOMRect): NodeBox {
  const rect = el.getBoundingClientRect();
  return {
    left: round1(rect.left - stage.left),
    top: round1(rect.top - stage.top),
    right: round1(rect.right - stage.left),
    bottom: round1(rect.bottom - stage.top),
    cy: round1(rect.top + rect.height / 2 - stage.top),
  };
}

function readGeometry(stage: HTMLElement): FlowGeometry {
  const stageBox = stage.getBoundingClientRect();
  const collect = (kind: string) => {
    const boxes = new Map<string, NodeBox>();
    stage
      .querySelectorAll<HTMLElement>(`[data-flow="${kind}"][data-flow-key]`)
      .forEach((el) => {
        boxes.set(el.dataset.flowKey!, boxOf(el, stageBox));
      });
    return boxes;
  };
  const hub = stage.querySelector<HTMLElement>('[data-flow="hub"]');
  return {
    width: round1(stageBox.width),
    height: round1(stageBox.height),
    hub: hub ? boxOf(hub, stageBox) : null,
    apps: collect("app"),
    groups: collect("group"),
    models: collect("model"),
  };
}

const sameBox = (a?: NodeBox, b?: NodeBox) =>
  a === b ||
  (!!a &&
    !!b &&
    a.left === b.left &&
    a.top === b.top &&
    a.right === b.right &&
    a.bottom === b.bottom &&
    a.cy === b.cy);

function sameGeometry(a: FlowGeometry | null, b: FlowGeometry) {
  if (
    !a ||
    a.width !== b.width ||
    a.height !== b.height ||
    !sameBox(a.hub ?? undefined, b.hub ?? undefined)
  )
    return false;
  const layers = [
    [a.apps, b.apps],
    [a.groups, b.groups],
    [a.models, b.models],
  ] as const;
  for (const [from, to] of layers) {
    if (from.size !== to.size) return false;
    for (const [key, box] of from) {
      if (!sameBox(box, to.get(key))) return false;
    }
  }
  return true;
}

/** Horizontal cubic that leaves the source's right edge and lands exactly
 *  on the target's left edge. Pure function so the shape stays testable. */
export function wirePath(
  from: Pick<NodeBox, "right" | "cy">,
  to: Pick<NodeBox, "left" | "cy">,
  offset = 0,
): string {
  const x1 = round1(from.right);
  const y1 = round1(from.cy + offset);
  const x2 = round1(to.left);
  const y2 = round1(to.cy + offset);
  const bend = round1(Math.max(18, (x2 - x1) * 0.45));
  return `M ${x1} ${y1} C ${round1(x1 + bend)} ${y1}, ${round1(x2 - bend)} ${y2}, ${x2} ${y2}`;
}

/** Shares the status page's filtered query; the catalog only supplies the
 *  configured base topology. Historical names and paths still come from the
 *  traces so past requests render as they happened. */
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

  // The stage grows with its tallest column; every node reports its real
  // box back so wires stay glued to the nodes at any size.
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [geometry, setGeometry] = useState<FlowGeometry | null>(null);
  const measure = useCallback(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const next = readGeometry(stage);
    setGeometry((current) => (sameGeometry(current, next) ? current : next));
  }, []);
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    measure();
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    if (observer) {
      observer.observe(stage);
      stage
        .querySelectorAll("[data-flow]")
        .forEach((node) => observer.observe(node));
    }
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [apps, groups, outlets, measure]);

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

  // Hide configured edges whenever visible traffic connects the same nodes,
  // including shared groups/models reached by another app during replay.
  const visibleApps = new Set<string>();
  const visibleGroups = new Set<string>();
  const visibleOutlets = new Map<string, Set<string>>();
  for (const lane of lanes) {
    const playback = lanePlayback(lane, timeline, step);
    if (playback.visible) {
      visibleApps.add(lane.appId);
      visibleGroups.add(lane.groupKey);
    }
    for (const attempt of lane.attempts) {
      if (!playback.attemptVisible(attempt)) continue;
      const keys = visibleOutlets.get(lane.groupKey) ?? new Set<string>();
      keys.add(`${attempt.supplierId}|${attempt.model}`);
      visibleOutlets.set(lane.groupKey, keys);
    }
  }

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

  const hub = geometry?.hub ?? null;
  const appBox = (appId: string) => geometry?.apps.get(appId);
  const groupBox = (key: string) => geometry?.groups.get(key);
  const modelBox = (key: string) => geometry?.models.get(key);

  return (
    <Card role="region" aria-label={t("gateway.flow.title")}>
      {(liveCount > 0 || total > 0) && (
        <CardHeader className="flex-row flex-wrap items-center justify-end gap-2 space-y-0 p-3 pb-0">
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
        </CardHeader>
      )}
      <CardContent className="p-4 pt-3">
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
            {/* The stage has no fixed height: columns stack naturally and the
                tallest one defines the canvas. An absolutely positioned SVG
                overlays it and draws pixel-exact wires between the measured
                node boxes, so links can never drift off their endpoints. */}
            <div className="phi-flow-stage" ref={stageRef}>
              {/* Column 1 · apps — configured apps are always present; the
                  latest request adds the colored lane overlay on top. */}
              <ol className="phi-flow-col" aria-label={t("gateway.flow.apps")}>
                {apps.map((entry) => {
                  const lane = entry.lane;
                  const playback = lane
                    ? lanePlayback(lane, timeline, step)
                    : null;
                  return (
                    <li
                      key={entry.appId}
                      className="phi-flow-node"
                      data-flow="app"
                      data-flow-key={entry.appId}
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
              {/* Column 2 · PHI */}
              <div className="phi-flow-col phi-flow-hub-wrap">
                <div className="phi-flow-node phi-flow-hub" data-flow="hub">
                  <PhiFlowLogo />
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
              {/* Column 3 · route groups */}
              <ol
                className="phi-flow-col"
                aria-label={t("gateway.flow.groups")}
              >
                {groups.map((group) => (
                  <li
                    key={group.key}
                    className="phi-flow-node"
                    data-flow="group"
                    data-flow-key={group.key}
                    data-kind="group"
                    data-static={
                      trafficGroups.has(group.key) ? undefined : "true"
                    }
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
              {/* Column 4 · models — configured members without traffic keep
                  a neutral idle state. */}
              <ol
                className="phi-flow-col phi-flow-outlets"
                aria-label={t("gateway.flow.models")}
              >
                {outlets.map((outlet) => (
                  <li
                    key={outlet.key}
                    className="phi-flow-node"
                    data-flow="model"
                    data-flow-key={outlet.key}
                    data-kind="model"
                    data-state={outlet.state ?? undefined}
                    data-static={outlet.state == null ? "true" : undefined}
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
              {/* Wires: app → PHI → group → model. Drawn once geometry is
                  measured; every path starts and ends on a node edge. */}
              <svg
                className="phi-flow-wires"
                width={geometry?.width ?? 0}
                height={geometry?.height ?? 0}
                viewBox={`0 0 ${geometry?.width ?? 0} ${geometry?.height ?? 0}`}
                preserveAspectRatio="none"
                aria-hidden
              >
                <g data-region="app">
                  {hub &&
                    apps.map((entry) => {
                      if (!entry.configured || visibleApps.has(entry.appId))
                        return null;
                      const from = appBox(entry.appId);
                      if (!from) return null;
                      return (
                        <path
                          key={`static:${entry.appId}`}
                          d={wirePath(from, hub)}
                          data-state="static"
                          {...dimmed(entry.appId)}
                        />
                      );
                    })}
                  {hub &&
                    lanes.map((lane) => {
                      const playback = lanePlayback(lane, timeline, step);
                      if (!playback.visible) return null;
                      const from = appBox(lane.appId);
                      if (!from) return null;
                      const state = playback.done
                        ? laneFinalState(lane)
                        : "active";
                      return (
                        <path
                          key={lane.appId}
                          d={wirePath(from, hub)}
                          data-dimmed={
                            focus && focus !== lane.appId ? "true" : undefined
                          }
                          {...laneStyle(lane, state)}
                        />
                      );
                    })}
                </g>
                <g data-region="group">
                  {hub &&
                    apps.map((entry) => {
                      if (
                        !entry.staticGroupKey ||
                        visibleGroups.has(entry.staticGroupKey)
                      )
                        return null;
                      const target = groupBox(entry.staticGroupKey);
                      if (!target) return null;
                      const offset =
                        groupWireOffset.get(`g:${entry.staticGroupKey}`) ?? 0;
                      return (
                        <path
                          key={`static:${entry.appId}`}
                          d={wirePath(hub, target, offset)}
                          data-state="static"
                          {...dimmed(entry.appId)}
                        />
                      );
                    })}
                  {hub &&
                    lanes.map((lane) => {
                      const playback = lanePlayback(lane, timeline, step);
                      if (!playback.visible) return null;
                      const target = groupBox(lane.groupKey);
                      if (!target) return null;
                      const state = playback.done
                        ? laneFinalState(lane)
                        : "active";
                      const offset =
                        groupWireOffset.get(`g:${lane.groupKey}`) ?? 0;
                      return (
                        <path
                          key={lane.appId}
                          d={wirePath(hub, target, offset)}
                          data-dimmed={
                            focus && focus !== lane.appId ? "true" : undefined
                          }
                          {...laneStyle(lane, state)}
                        />
                      );
                    })}
                </g>
                <g data-region="model">
                  {apps.flatMap((entry) =>
                    entry.staticOutletKeys.map((key) => {
                      if (visibleOutlets.get(entry.staticGroupKey!)?.has(key))
                        return null;
                      const from = groupBox(entry.staticGroupKey!);
                      const to = modelBox(key);
                      if (!from || !to) return null;
                      const offset =
                        attemptWireOffset.get(
                          `a:${entry.staticGroupKey}:${key}`,
                        ) ?? 0;
                      return (
                        <path
                          key={`static:${entry.appId}:${key}`}
                          d={wirePath(from, to, offset)}
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
                      const from = groupBox(lane.groupKey);
                      const to = modelBox(outletKey);
                      if (!from || !to) return null;
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
                          d={wirePath(from, to, offset)}
                          data-dimmed={
                            focus && focus !== lane.appId ? "true" : undefined
                          }
                          {...laneStyle(lane, state)}
                        />
                      );
                    }),
                  )}
                </g>
              </svg>
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
              <PhiFlowLogo />
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
