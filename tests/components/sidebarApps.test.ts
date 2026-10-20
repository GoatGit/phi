import { describe, expect, it } from "vitest";
import {
  buildSidebarApps,
  collapseSidebarApps,
  compareSidebarApps,
  isSidebarAppId,
  sidebarAppRank,
  SIDEBAR_CANDIDATE_APP_IDS,
  SIDEBAR_VISIBLE_APP_LIMIT,
} from "@/components/shell/sidebarApps";
import type {
  GatewayCatalog,
  GatewayRequestTrace,
  GatewayRouteGroup,
  GatewayRoutePolicy,
} from "@/lib/api/gateway";

/** 全部可添加的应用（默认一个都不在侧栏里）。 */
const everyApp = SIDEBAR_CANDIDATE_APP_IDS;

const group = (
  id: string,
  appIds: string[],
  enabled = true,
): GatewayRouteGroup => ({
  id,
  name: id,
  enabled,
  appIds,
  strategy: "ordered",
  members: [],
  sessionAffinity: false,
  affinityTtlSeconds: 0,
  failover: true,
  maxAttempts: 2,
  streamingFirstByteTimeout: 60,
  streamingIdleTimeout: 180,
  nonStreamingTimeout: 600,
  rules: [],
});

const connection = (
  appId: string,
  groupId: string,
  enabled = true,
): GatewayRoutePolicy => ({
  id: `connection/${appId}`,
  name: `${appId} connection`,
  appId,
  enabled,
  matchModel: "",
  priority: 1,
  failover: true,
  candidates: [],
  groupId,
});

const catalog = (policies: GatewayRoutePolicy[]): GatewayCatalog => ({
  revision: 1,
  suppliers: [],
  policies,
  groups: [group("g-core", ["claude"]), group("g-pi", ["pi"])],
});

const trace = (
  appId: string,
  outcome: string,
  createdAt: number,
): GatewayRequestTrace => ({
  id: `${appId}-${createdAt}`,
  createdAt,
  appId,
  catalogRevision: 1,
  policy: connection(appId, "g-core"),
  events: [],
  outcome,
  latencyMs: 0,
  inputTokens: null,
  outputTokens: null,
  estimatedCost: null,
});

describe("sidebar app priority", () => {
  it("starts empty until the user adds an app", () => {
    expect(buildSidebarApps({ appIds: [], traces: [] })).toEqual([]);
  });

  it("lists only the apps the user added, in the order they were added", () => {
    const apps = buildSidebarApps({
      appIds: ["zcode", "codex", "crush"],
      traces: [],
    });

    expect(apps.map((entry) => entry.appId)).toEqual([
      "zcode",
      "codex",
      "crush",
    ]);
    expect(apps.find((entry) => entry.appId === "crush")?.local).toBe(true);
  });

  it("ignores unknown ids and duplicates from the saved list", () => {
    const apps = buildSidebarApps({
      appIds: ["codex", "codex", "nope", "omO"],
      traces: [],
    });

    expect(apps.map((entry) => entry.appId)).toEqual(["codex"]);
    expect(isSidebarAppId("omo")).toBe(true);
    expect(isSidebarAppId("typesafe")).toBe(false);
  });

  it("orders live traffic, then recent traffic, then connected groups, then the rest", () => {
    const apps = buildSidebarApps({
      appIds: everyApp,
      catalog: catalog([
        connection("claude", "g-core"),
        connection("pi", "g-pi"),
      ]),
      traces: [
        trace("codex", "pending", 300),
        trace("gemini", "completed", 200),
      ],
      now: 1_000,
    });

    expect(apps.slice(0, 6).map((entry) => entry.appId)).toEqual([
      "codex",
      "gemini",
      "claude",
      "pi",
      "claude-desktop",
      "grokbuild",
    ]);
    expect(sidebarAppRank(apps[0])).toBe(0);
    expect(sidebarAppRank(apps[2])).toBe(2);
    expect(sidebarAppRank(apps[4])).toBe(3);
  });

  it("ignores traffic older than the 24-hour window", () => {
    const day = 24 * 60 * 60 * 1000;
    const apps = buildSidebarApps({
      appIds: everyApp,
      traces: [trace("zcode", "completed", 1)],
      now: 2 * day,
    });
    expect(apps[0].appId).toBe("claude");
    expect(
      apps.find((entry) => entry.appId === "zcode")?.lastSeenAt,
    ).toBeNull();
  });

  it("keeps the add order as a stable tie-breaker", () => {
    const apps = buildSidebarApps({ appIds: everyApp, traces: [] });
    expect(apps.slice(0, 5).map((entry) => entry.appId)).toEqual([
      "claude",
      "claude-desktop",
      "codex",
      "gemini",
      "grokbuild",
    ]);
    // 同一份输入重复构图不会改变顺序
    const again = buildSidebarApps({ appIds: everyApp, traces: [] });
    expect(again.map((entry) => entry.appId)).toEqual(
      apps.map((entry) => entry.appId),
    );
    expect([...apps].sort(compareSidebarApps)).toEqual(apps);

    // 用户自己先加 Pi 再加 Claude，就按这个顺序
    const custom = buildSidebarApps({
      appIds: ["pi", "claude"],
      traces: [],
    });
    expect(custom.map((entry) => entry.appId)).toEqual(["pi", "claude"]);
  });
});

describe("sidebar app collapse", () => {
  const apps = buildSidebarApps({ appIds: everyApp, traces: [] });

  it("shows the first N and collapses the tail by default", () => {
    const { shown, hiddenCount } = collapseSidebarApps(apps, {
      expanded: false,
    });
    expect(shown).toHaveLength(SIDEBAR_VISIBLE_APP_LIMIT);
    expect(hiddenCount).toBe(apps.length - SIDEBAR_VISIBLE_APP_LIMIT);
  });

  it("keeps a pinned app visible even when it sorts into the tail", () => {
    const { shown, hiddenCount } = collapseSidebarApps(apps, {
      expanded: false,
      pinned: ["omo"],
    });
    expect(shown.map((entry) => entry.appId)).toContain("omo");
    // 固定项只是优先占位，总数仍是硬上限。
    expect(shown).toHaveLength(SIDEBAR_VISIBLE_APP_LIMIT);
    expect(hiddenCount).toBe(apps.length - SIDEBAR_VISIBLE_APP_LIMIT);
  });

  it("keeps the cap when every app belongs to a route group", () => {
    // 一个路由组挂了很多应用：已配置不能让侧栏整体展开。
    const shared = apps.map((entry) => ({
      ...entry,
      groupId: "root",
      groupName: "Root",
    }));
    const { shown, hiddenCount } = collapseSidebarApps(shared, {
      expanded: false,
    });
    expect(shown).toHaveLength(SIDEBAR_VISIBLE_APP_LIMIT);
    expect(hiddenCount).toBe(shared.length - SIDEBAR_VISIBLE_APP_LIMIT);
  });

  it("shows everything when expanded and reports no hidden rows", () => {
    const { shown, hiddenCount } = collapseSidebarApps(apps, {
      expanded: true,
    });
    expect(shown).toEqual(apps);
    expect(hiddenCount).toBe(0);
  });
});
