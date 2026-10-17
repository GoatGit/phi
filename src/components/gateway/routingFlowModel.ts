import { appRouteGroup, type GatewayCatalog } from "@/lib/api/gateway";
import type {
  GatewayRequestTrace,
  GatewayTraceEvent,
  GatewayTracePage,
} from "@/lib/api/gateway";
import { PROXY_APP_IDS } from "@/config/appConfig";

export type FlowState = "active" | "completed" | "failed" | "unknown";

/** One deduplicated upstream attempt inside a request's flow line. */
export interface FlowAttempt {
  key: string;
  supplierId: string;
  supplierName: string;
  model: string;
  groupPath: string[];
  state: FlowState;
  attempts: number[];
  latestOutcome: string;
}

/** A single app's flow line, built from that app's latest request. */
export interface FlowLane {
  appId: string;
  trace: GatewayRequestTrace;
  live: boolean;
  groupKey: string;
  groupName: string;
  groupStrategy: string | null;
  attempts: FlowAttempt[];
}

export interface FlowGroupNode {
  key: string;
  name: string;
  strategy: string | null;
}

export interface FlowOutletNode {
  key: string;
  supplierName: string;
  model: string;
  /** null = 只存在于当前配置中，尚无请求经过。 */
  state: FlowState | null;
}

/** One app row: its configured connection (always drawn) plus the latest
 * request lane (colored overlay, absent when the app has no traffic). */
export interface FlowAppEntry {
  appId: string;
  lane: FlowLane | null;
  /** True when the row comes from the catalog roster (gray base layer). */
  configured: boolean;
  staticGroupKey: string | null;
  staticOutletKeys: string[];
}

export interface FlowTimelineStep {
  laneKey: string;
  attemptKey: string;
  at: number;
}

/** Lane colors distinguish apps; assigned by sorted appId for stability. */
export const FLOW_LANE_COLORS = [
  "#3b82f6",
  "#f97316",
  "#10b981",
  "#a855f7",
  "#ec4899",
  "#14b8a6",
  "#eab308",
  "#6366f1",
];

export function laneColor(appId: string, apps: { appId: string }[]): string {
  const index = apps.findIndex((app) => app.appId === appId);
  return FLOW_LANE_COLORS[(index < 0 ? 0 : index) % FLOW_LANE_COLORS.length];
}

const waiting = (outcome: string) =>
  outcome === "pending" || outcome === "upstream_accepted";

/** Accepted upstream headers are not a completed response. The request's
 * terminal outcome determines the final accepted attempt's actual result. */
export function flowEventOutcome(
  trace: GatewayRequestTrace,
  index: number,
): string {
  const outcome = trace.events[index]?.outcome;
  if (outcome == null) return trace.outcome;
  return waiting(outcome) &&
    index === trace.events.length - 1 &&
    !waiting(trace.outcome)
    ? trace.outcome
    : outcome;
}

/** Active requests win over history for the same app because they are the
 * newest routing decisions still in flight. */
export function latestTracePerApp(
  page: GatewayTracePage,
): GatewayRequestTrace[] {
  const merged = [
    ...new Map(
      [...page.traces, ...page.active].map((trace) => [trace.id, trace]),
    ).values(),
  ].sort((a, b) => a.createdAt - b.createdAt);
  const latest = new Map<string, GatewayRequestTrace>();
  for (const trace of merged) latest.set(trace.appId, trace);
  for (const trace of page.active) latest.set(trace.appId, trace);
  return [...latest.values()].sort((a, b) => (a.appId < b.appId ? -1 : 1));
}

/** Collapse repeated events onto the same attempt so one flow line may carry
 * several attempt numbers instead of duplicating outlet nodes. */
export function laneAttempts(
  trace: GatewayRequestTrace,
  live: boolean,
): FlowAttempt[] {
  const byKey = new Map<string, FlowAttempt>();
  trace.events.forEach((event: GatewayTraceEvent, index: number) => {
    const key = attemptKey(event);
    const outcome = flowEventOutcome(trace, index);
    let attempt = byKey.get(key);
    if (!attempt) {
      attempt = {
        key,
        supplierId: event.supplierId,
        supplierName: event.supplierName || event.supplierId,
        model: event.model,
        groupPath: event.groupPath ?? [],
        state: "unknown",
        attempts: [],
        latestOutcome: outcome,
      };
      byKey.set(key, attempt);
    }
    if (event.supplierName) attempt.supplierName = event.supplierName;
    attempt.latestOutcome = outcome;
    attempt.attempts.push(index + 1);
    attempt.state = waiting(outcome)
      ? live && index === trace.events.length - 1
        ? "active"
        : "unknown"
      : outcome === "completed"
        ? "completed"
        : "failed";
  });
  return [...byKey.values()];
}

function attemptKey(event: GatewayTraceEvent): string {
  return [event.supplierId, event.model, ...(event.groupPath ?? [])].join("|");
}

function outletKey(attempt: FlowAttempt): string {
  return `${attempt.supplierId}|${attempt.model}`;
}

/** Flatten a group's enabled members into supplier+model outlets, recursing
 * into nested groups with a cycle guard. */
export function flattenGroupMembers(
  catalog: GatewayCatalog,
  groupId: string,
  seen = new Set<string>(),
): { key: string; supplierName: string; model: string }[] {
  if (seen.has(groupId)) return [];
  seen.add(groupId);
  const group = catalog.groups?.find((item) => item.id === groupId);
  if (!group) return [];
  const outlets: { key: string; supplierName: string; model: string }[] = [];
  for (const member of group.members) {
    if (!member.enabled) continue;
    if (member.groupId) {
      outlets.push(...flattenGroupMembers(catalog, member.groupId, seen));
      continue;
    }
    if (!member.supplierId) continue;
    const supplier = catalog.suppliers.find((s) => s.id === member.supplierId);
    outlets.push({
      key: `${member.supplierId}|${member.model}`,
      supplierName: supplier?.name || member.supplierId,
      model: member.model,
    });
  }
  return outlets;
}

/** Build the four-column graph. The configured topology (every gateway app,
 * its connected route group and the group's member models from today's
 * catalog) is always drawn as the base layer; the latest request per app
 * overlays it as that app's colored lane. Traffic-only groups and models
 * keep their historical snapshot names. */
export function buildRoutingFlow(
  page: GatewayTracePage,
  catalog?: GatewayCatalog,
): {
  apps: FlowAppEntry[];
  lanes: FlowLane[];
  groups: FlowGroupNode[];
  outlets: FlowOutletNode[];
  liveCount: number;
} {
  const activeIds = new Set(page.active.map((trace) => trace.id));
  const lanes: FlowLane[] = latestTracePerApp(page).map((trace) => {
    const rootGroup = trace.decision?.groups.find(
      (group) => group.id === trace.decision?.groupId,
    );
    const groupName = rootGroup?.name || trace.policy.name || trace.policy.id;
    return {
      appId: trace.appId,
      trace,
      live: activeIds.has(trace.id),
      groupKey: rootGroup
        ? `group:${rootGroup.id}`
        : `policy:${trace.appId}:${trace.policy.id}`,
      groupName,
      groupStrategy: rootGroup?.strategy ?? null,
      attempts: laneAttempts(trace, activeIds.has(trace.id)),
    };
  });
  const traceGroups = new Map<string, FlowGroupNode>();
  const traceOutlets = new Map<string, FlowOutletNode>();
  for (const lane of lanes) {
    if (!traceGroups.has(lane.groupKey)) {
      traceGroups.set(lane.groupKey, {
        key: lane.groupKey,
        name: lane.groupName,
        strategy: lane.groupStrategy,
      });
    }
    for (const attempt of lane.attempts) {
      const key = outletKey(attempt);
      const existing = traceOutlets.get(key);
      if (!existing) {
        traceOutlets.set(key, {
          key,
          supplierName: attempt.supplierName,
          model: attempt.model,
          state: attempt.state,
        });
      } else if (attempt.state !== "unknown") {
        existing.state = attempt.state;
      }
    }
  }
  // Configured base layer: every app, its connected group and the group's
  // enabled member models — present even when no request ever ran.
  const staticGroups = new Map<string, FlowGroupNode>();
  const staticOutlets = new Map<string, FlowOutletNode>();
  const staticByApp = new Map<
    string,
    { groupKey: string | null; outletKeys: string[] }
  >();
  if (catalog) {
    for (const appId of PROXY_APP_IDS) {
      const groupId = appRouteGroup(catalog, appId);
      const group = groupId
        ? catalog.groups?.find((item) => item.id === groupId)
        : undefined;
      if (!group) {
        staticByApp.set(appId, { groupKey: null, outletKeys: [] });
        continue;
      }
      const groupKey = `group:${group.id}`;
      if (!staticGroups.has(groupKey)) {
        staticGroups.set(groupKey, {
          key: groupKey,
          name: group.name,
          strategy: group.strategy,
        });
      }
      const members = flattenGroupMembers(catalog, group.id);
      for (const member of members) {
        if (!staticOutlets.has(member.key)) {
          staticOutlets.set(member.key, { ...member, state: null });
        }
      }
      staticByApp.set(appId, {
        groupKey,
        outletKeys: members.map((member) => member.key),
      });
    }
  }
  // Union: configured nodes come first, traffic-only nodes are appended;
  // shared nodes keep today's catalog naming over historical snapshots.
  const groups = new Map(traceGroups);
  for (const [key, node] of staticGroups) {
    const legacy = groups.get(key);
    groups.delete(key);
    groups.set(key, {
      key,
      name: node.name,
      strategy: node.strategy ?? legacy?.strategy ?? null,
    });
  }
  const outlets = new Map(staticOutlets);
  for (const [key, node] of traceOutlets) {
    const existing = outlets.get(key);
    if (existing) existing.state = node.state;
    else outlets.set(key, node);
  }
  const laneByApp = new Map(lanes.map((lane) => [lane.appId, lane]));
  const apps: FlowAppEntry[] = [
    ...new Set([
      ...(catalog ? PROXY_APP_IDS : []),
      ...lanes.map((lane) => lane.appId),
    ]),
  ]
    .sort((a, b) => (a < b ? -1 : 1))
    .map((appId) => {
      const configured = staticByApp.get(appId);
      return {
        appId,
        lane: laneByApp.get(appId) ?? null,
        configured: Boolean(configured),
        staticGroupKey: configured?.groupKey ?? null,
        staticOutletKeys: configured?.outletKeys ?? [],
      };
    });
  return {
    apps,
    lanes,
    groups: [...groups.values()],
    outlets: [...outlets.values()],
    liveCount: lanes.filter((lane) => lane.live).length,
  };
}

/** Cross-app replay timeline: one step per recorded attempt event, ordered
 * by the event timestamps captured at request time. */
export function buildTimeline(lanes: FlowLane[]): FlowTimelineStep[] {
  const steps: FlowTimelineStep[] = [];
  for (const lane of lanes) {
    for (const attempt of lane.attempts) {
      for (const n of attempt.attempts) {
        const event = lane.trace.events[n - 1];
        steps.push({
          laneKey: lane.appId,
          attemptKey: attempt.key,
          at: event?.startedAt ?? lane.trace.createdAt + n * 1000,
        });
      }
    }
  }
  return steps.sort((a, b) => a.at - b.at);
}

/** Resolve which pieces of a lane are visible at a replay step. `step`
 * indexes into the timeline; `null` shows the final full state. */
export function lanePlayback(
  lane: FlowLane,
  timeline: FlowTimelineStep[],
  step: number | null,
): {
  visible: boolean;
  done: boolean;
  headAttempt: string | null;
  attemptVisible: (attempt: FlowAttempt) => boolean;
} {
  const indexes = timeline
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.laneKey === lane.appId);
  if (step === null) {
    return {
      visible: true,
      done: true,
      headAttempt: null,
      attemptVisible: () => true,
    };
  }
  const played = indexes.filter(({ index }) => index <= step);
  const visible = played.length > 0;
  const done = visible && played.length === indexes.length;
  const head = played.at(-1)?.item.attemptKey ?? null;
  return {
    visible,
    done,
    headAttempt: visible && !done ? head : null,
    attemptVisible: (attempt) =>
      visible && played.some(({ item }) => item.attemptKey === attempt.key),
  };
}

/** Final line style for a lane once every replay step has passed. */
export function laneFinalState(lane: FlowLane): FlowState {
  if (lane.live) return "active";
  return lane.trace.outcome === "completed" ? "completed" : "failed";
}
