import { appRouteGroup, type GatewayCatalog } from "@/lib/api/gateway";
import type {
  GatewayRequestTrace,
  GatewayTraceEvent,
  GatewayTracePage,
} from "@/lib/api/gateway";
import { ROUTABLE_APP_IDS } from "@/config/appConfig";

export type FlowState = "active" | "completed" | "failed" | "unknown";

/** 侧栏点了某个路由专用应用：路由页据此打开它的「设置应用路由」。
 *  nonce 让重复点击同一个应用也重新触发。 */
export interface RouteAppRequest {
  appId: string;
  nonce: number;
}

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
  /** 真实目录组 id；旧版策略没有。 */
  groupId: string | null;
  /** 快照里的启用状态；旧版策略没有。 */
  groupEnabled: boolean | null;
  attempts: FlowAttempt[];
}

export interface FlowGroupNode {
  key: string;
  name: string;
  strategy: string | null;
  /** 真实目录组的 id；旧版策略占位节点为 null。 */
  groupId: string | null;
  /** null 表示只存在于历史快照，当前目录里没有。 */
  enabled: boolean | null;
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

/** Lane colors distinguish apps; the palette slot comes from the app itself
 *  (not from its row position) so re-sorting the list — e.g. when an app
 *  starts sending traffic — never repaints lines the user is already reading. */
export const FLOW_LANE_COLORS = [
  "#3b82f6",
  "#f97316",
  "#10b981",
  "#a855f7",
  "#ec4899",
  "#14b8a6",
  "#eab308",
  "#6366f1",
  "#0ea5e9",
  "#a3e635",
];

/** 配置清单顺序：既是排序的稳定兜底，也让已知应用各自拿到固定的颜色槽位。 */
const APP_ORDER = new Map<string, number>(
  ROUTABLE_APP_IDS.map((appId, index) => [appId, index]),
);

const appOrderIndex = (appId: string) =>
  APP_ORDER.get(appId) ?? Number.MAX_SAFE_INTEGER;

export function laneColor(appId: string): string {
  const known = APP_ORDER.get(appId);
  if (known !== undefined) {
    return FLOW_LANE_COLORS[known % FLOW_LANE_COLORS.length];
  }
  // 历史轨迹里可能出现清单外的应用，稳定散列到同一个色板。
  let hash = 0;
  for (let index = 0; index < appId.length; index += 1) {
    hash = (hash * 31 + appId.charCodeAt(index)) >>> 0;
  }
  return FLOW_LANE_COLORS[hash % FLOW_LANE_COLORS.length];
}

/** 应用列表的优先级：进行中的请求最该被看到，其次是刚跑过流量的应用，
 *  再次是已接入路由组的应用，最后是没有接入的。 */
export function flowAppRank(entry: FlowAppEntry): number {
  if (entry.lane?.live) return 0;
  if (entry.lane) return 1;
  return entry.staticGroupKey ? 2 : 3;
}

/** 同级按最近请求时间倒序，再按配置清单顺序（而不是字母序），保证同一份
 *  数据每次都排出同样的顺序，不会在刷新之间跳动。 */
export function compareFlowApps(a: FlowAppEntry, b: FlowAppEntry): number {
  const rank = flowAppRank(a) - flowAppRank(b);
  if (rank !== 0) return rank;
  const recency =
    (b.lane?.trace.createdAt ?? 0) - (a.lane?.trace.createdAt ?? 0);
  if (recency !== 0) return recency;
  const order = appOrderIndex(a.appId) - appOrderIndex(b.appId);
  if (order !== 0) return order;
  return a.appId < b.appId ? -1 : a.appId > b.appId ? 1 : 0;
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
      groupId: rootGroup?.id ?? null,
      groupEnabled: rootGroup?.enabled ?? null,
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
        groupId: lane.groupId,
        enabled: lane.groupEnabled,
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
  const staticOutlets = new Map<string, FlowOutletNode>();
  const staticByApp = new Map<
    string,
    { groupKey: string | null; outletKeys: string[] }
  >();
  if (catalog) {
    for (const appId of ROUTABLE_APP_IDS) {
      const groupId = appRouteGroup(catalog, appId);
      const group = groupId
        ? catalog.groups?.find((item) => item.id === groupId)
        : undefined;
      if (!group) {
        staticByApp.set(appId, { groupKey: null, outletKeys: [] });
        continue;
      }
      const groupKey = `group:${group.id}`;
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
  // Union: 目录里的每个路由组都进入第三列（包括尚未接入应用的组），
  // 只有目录里已经没有的历史组才追加在末尾。
  const groups = new Map<string, FlowGroupNode>();
  for (const group of catalog?.groups ?? []) {
    groups.set(`group:${group.id}`, {
      key: `group:${group.id}`,
      name: group.name,
      strategy: group.strategy,
      groupId: group.id,
      enabled: group.enabled,
    });
  }
  for (const [key, node] of traceGroups) {
    if (!groups.has(key)) groups.set(key, node);
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
      ...(catalog ? ROUTABLE_APP_IDS : []),
      ...lanes.map((lane) => lane.appId),
    ]),
  ]
    .map((appId) => {
      const configured = staticByApp.get(appId);
      return {
        appId,
        lane: laneByApp.get(appId) ?? null,
        configured: Boolean(configured),
        staticGroupKey: configured?.groupKey ?? null,
        staticOutletKeys: configured?.outletKeys ?? [],
      };
    })
    .sort(compareFlowApps);
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
