import type { VisibleApps } from "@/types";
import type { GatewayCatalog, GatewayRequestTrace } from "@/lib/api/gateway";
import { appRouteGroup } from "@/lib/api/gateway";
import { APP_IDS, LOCAL_ROUTABLE_APP_IDS } from "@/config/appConfig";

/**
 * 侧栏应用列表的一行。路由专用应用没有完整的管理页，点进去是路由页的
 * 「设置应用路由」；它们和普通应用共用同一套优先级排序与折叠。
 */
export interface SidebarAppEntry {
  appId: string;
  /** true = 路由专用应用（Command Code / Crush / Droid / Kimi Code / AtomCode / OmO） */
  local: boolean;
  /** 是否有进行中的请求 */
  live: boolean;
  /** 最近一次请求的时间；没有流量为 null */
  lastSeenAt: number | null;
  /** 已接入的路由组；没接入为 null */
  groupId: string | null;
  groupName: string | null;
  /** 目录快照里的启用状态；目录里没有这个组时为 null */
  groupEnabled: boolean | null;
}

/** 与 routingFlowModel / 后端轨迹一致：这两个 outcome 还算“进行中”。 */
const ACTIVE_OUTCOMES = new Set(["pending", "upstream_accepted"]);

/** 和路由页的默认时间窗一致：24 小时以前的轨迹不再算“最近有流量”。 */
const RECENT_TRACE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** 配置清单顺序：同一优先级内的稳定兜底，避免刷新时列表跳动。 */
const APP_ORDER = new Map<string, number>(
  [...APP_IDS, ...LOCAL_ROUTABLE_APP_IDS].map((appId, index) => [appId, index]),
);

const appOrderIndex = (appId: string) =>
  APP_ORDER.get(appId) ?? Number.MAX_SAFE_INTEGER;

/** 默认展开的应用数。应用变多以后，靠后的应用折叠在「展开其余」后面。 */
export const SIDEBAR_VISIBLE_APP_LIMIT = 10;

/**
 * 应用列表的优先级：进行中的请求最该被看到，其次是刚跑过流量的应用，
 * 再次是已接入路由组的应用，最后是没有接入的。与流转图同一口径。
 */
export function sidebarAppRank(entry: SidebarAppEntry): number {
  if (entry.live) return 0;
  if (entry.lastSeenAt != null) return 1;
  return entry.groupId ? 2 : 3;
}

/** 同级按最近请求时间倒序，再按配置清单顺序，最后按 id。 */
export function compareSidebarApps(
  a: SidebarAppEntry,
  b: SidebarAppEntry,
): number {
  const rank = sidebarAppRank(a) - sidebarAppRank(b);
  if (rank !== 0) return rank;
  const recency = (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0);
  if (recency !== 0) return recency;
  const order = appOrderIndex(a.appId) - appOrderIndex(b.appId);
  if (order !== 0) return order;
  return a.appId < b.appId ? -1 : a.appId > b.appId ? 1 : 0;
}

/**
 * 侧栏要列出的应用：用户保留在侧栏的应用 + 全部路由专用应用。
 * 最近轨迹只取每个应用最新的一条，用来判断“进行中/刚有流量”。
 */
export function buildSidebarApps({
  visibleApps,
  catalog,
  traces,
  now = Date.now(),
}: {
  visibleApps: VisibleApps;
  catalog?: GatewayCatalog;
  traces?: GatewayRequestTrace[] | null;
  /** 测试用：判断“最近”的时间基准 */
  now?: number;
}): SidebarAppEntry[] {
  const newest = now - RECENT_TRACE_WINDOW_MS;
  const latest = new Map<string, GatewayRequestTrace>();
  for (const trace of traces ?? []) {
    if (trace.createdAt < newest) continue;
    const previous = latest.get(trace.appId);
    if (!previous || trace.createdAt > previous.createdAt) {
      latest.set(trace.appId, trace);
    }
  }

  const groups = new Map(
    (catalog?.groups ?? []).map((group) => [group.id, group]),
  );
  const appIds = [
    ...APP_IDS.filter((appId) => visibleApps[appId]),
    ...LOCAL_ROUTABLE_APP_IDS,
  ];

  return appIds
    .map((appId): SidebarAppEntry => {
      const trace = latest.get(appId) ?? null;
      const groupId = catalog ? appRouteGroup(catalog, appId) : null;
      const group = groupId ? groups.get(groupId) : undefined;
      return {
        appId,
        local: (LOCAL_ROUTABLE_APP_IDS as string[]).includes(appId),
        live: trace ? ACTIVE_OUTCOMES.has(trace.outcome) : false,
        lastSeenAt: trace?.createdAt ?? null,
        groupId,
        groupName: group?.name ?? null,
        groupEnabled: group ? group.enabled : null,
      };
    })
    .sort(compareSidebarApps);
}

/**
 * 默认只露前若干个；pinned（当前应用、进行中的应用）不会被折叠藏掉。
 * 返回的 hiddenCount 用于「展开其余 N 个应用」的文案。
 */
export function collapseSidebarApps(
  entries: SidebarAppEntry[],
  {
    expanded,
    pinned,
    limit = SIDEBAR_VISIBLE_APP_LIMIT,
  }: { expanded: boolean; pinned?: Iterable<string>; limit?: number },
): { shown: SidebarAppEntry[]; hiddenCount: number } {
  if (expanded || entries.length <= limit) {
    return { shown: entries, hiddenCount: 0 };
  }
  const keep = new Set([
    ...entries.slice(0, limit).map((entry) => entry.appId),
    ...(pinned ?? []),
  ]);
  const shown = entries.filter((entry) => keep.has(entry.appId));
  return { shown, hiddenCount: entries.length - shown.length };
}
