import { describe, expect, it } from "vitest";
import {
  buildSidebarApps,
  collapseSidebarApps,
  compareSidebarApps,
  sidebarAppRank,
  SIDEBAR_VISIBLE_APP_LIMIT,
} from "@/components/shell/sidebarApps";
import type {
  GatewayCatalog,
  GatewayRequestTrace,
  GatewayRouteGroup,
  GatewayRoutePolicy,
} from "@/lib/api/gateway";
import type { VisibleApps } from "@/types";

const visibleApps = (overrides: Partial<VisibleApps> = {}): VisibleApps => ({
  claude: true,
  "claude-desktop": true,
  codex: true,
  gemini: true,
  grokbuild: true,
  opencode: true,
  openclaw: true,
  hermes: true,
  pi: true,
  mcode: true,
  zcode: true,
  ...overrides,
});

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
  it("lists visible apps plus every routing-only app", () => {
    const apps = buildSidebarApps({
      visibleApps: visibleApps({ codex: false }),
      traces: [],
    });
    const ids = apps.map((entry) => entry.appId);

    expect(ids).toContain("claude");
    expect(ids).not.toContain("codex");
    // 路由专用应用即使不在 VisibleApps 里也始终可见
    expect(ids).toEqual(
      expect.arrayContaining([
        "commandcode",
        "crush",
        "droid",
        "kimi",
        "atomcode",
        "omo",
      ]),
    );
    expect(ids).toHaveLength(10 + 6);
  });

  it("orders live traffic, then recent traffic, then connected groups, then the rest", () => {
    const apps = buildSidebarApps({
      visibleApps: visibleApps(),
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
      visibleApps: visibleApps(),
      traces: [trace("zcode", "completed", 1)],
      now: 2 * day,
    });
    expect(apps[0].appId).toBe("claude");
    expect(
      apps.find((entry) => entry.appId === "zcode")?.lastSeenAt,
    ).toBeNull();
  });

  it("keeps the configured order as a stable tie-breaker", () => {
    const apps = buildSidebarApps({ visibleApps: visibleApps(), traces: [] });
    expect(apps.slice(0, 5).map((entry) => entry.appId)).toEqual([
      "claude",
      "claude-desktop",
      "codex",
      "gemini",
      "grokbuild",
    ]);
    // 同一份输入重复构图不会改变顺序
    const again = buildSidebarApps({ visibleApps: visibleApps(), traces: [] });
    expect(again.map((entry) => entry.appId)).toEqual(
      apps.map((entry) => entry.appId),
    );
    expect([...apps].sort(compareSidebarApps)).toEqual(apps);
  });
});

describe("sidebar app collapse", () => {
  const apps = buildSidebarApps({ visibleApps: visibleApps(), traces: [] });

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
    expect(hiddenCount).toBe(apps.length - SIDEBAR_VISIBLE_APP_LIMIT - 1);
  });

  it("shows everything when expanded and reports no hidden rows", () => {
    const { shown, hiddenCount } = collapseSidebarApps(apps, {
      expanded: true,
    });
    expect(shown).toEqual(apps);
    expect(hiddenCount).toBe(0);
  });
});
