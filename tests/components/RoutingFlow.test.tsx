import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RoutingFlow, wirePath } from "@/components/gateway/RoutingFlow";
import { ROUTABLE_APP_IDS } from "@/config/appConfig";
import {
  buildRoutingFlow,
  buildTimeline,
  flattenGroupMembers,
  laneAttempts,
  laneFinalState,
  lanePlayback,
  latestTracePerApp,
  readableRequestModel,
} from "@/components/gateway/routingFlowModel";
import { renderWithQueryClient } from "../utils/testQueryClient";
import type {
  GatewayCatalog,
  GatewayRequestTrace,
  GatewayTracePage,
} from "@/lib/api/gateway";
import type { AccessBinding } from "@/lib/api/access";

const baseTrace: GatewayRequestTrace = {
  id: "request-1",
  createdAt: 1000,
  appId: "claude",
  requestModel: "client-model",
  catalogRevision: 7,
  policy: {
    id: "policy",
    name: "Historical policy",
    appId: "claude",
    enabled: true,
    matchModel: "",
    priority: 1,
    failover: true,
    candidates: [],
    groupId: "root",
  },
  events: [
    {
      supplierId: "a",
      supplierName: "Historical A",
      model: "model-a",
      outcome: "rate_limit",
      groupPath: ["root"],
      latencyMs: 100,
      startedAt: 1010,
    },
    {
      supplierId: "b",
      supplierName: "Historical B",
      model: "model-b",
      outcome: "upstream_accepted",
      groupPath: ["root"],
      latencyMs: 250,
      startedAt: 1300,
    },
  ],
  outcome: "completed",
  latencyMs: 350,
  inputTokens: 10,
  outputTokens: 20,
  estimatedCost: "0.01",
  decision: {
    reason: "group",
    groupId: "root",
    affinity: "hit",
    groups: ["root", "nested"].map((id) => ({
      id,
      name: `Snapshot ${id}`,
      enabled: true,
      appIds: ["claude"],
      strategy: "ordered",
      members: [],
      sessionAffinity: true,
      affinityTtlSeconds: 30,
      failover: true,
      maxAttempts: 3,
      streamingFirstByteTimeout: 60,
      streamingIdleTimeout: 180,
      nonStreamingTimeout: 600,
      rules: [],
    })),
    candidates: [],
    intents: [],
  },
};

function page(
  traces: GatewayRequestTrace[],
  active: GatewayRequestTrace[] = [],
): GatewayTracePage {
  return {
    traces,
    active,
    members: [],
    total: traces.length,
    retainedSince: 1000,
    summary: {
      requests: traces.length,
      completed: 1,
      failed: 0,
      interrupted: 0,
      failovers: 1,
      inputTokens: 10,
      outputTokens: 20,
      unknownUsage: 0,
      unknownCost: 0,
      estimatedCost: "0.01",
      classifierCalls: 0,
      classifierCost: "0",
      classifierUnknownCost: 0,
      p50LatencyMs: 350,
      p95LatencyMs: 350,
    },
  };
}

afterEach(() => vi.useRealTimers());

const supplier = (
  id: string,
  name: string,
  model: string,
): GatewayCatalog["suppliers"][number] => ({
  id,
  name,
  endpoint: { protocol: "anthropic", baseUrl: `https://${id}.test` },
  models: [model],
});
type CatalogGroup = NonNullable<GatewayCatalog["groups"]>[number];
const group = (
  overrides: Partial<CatalogGroup> & { id: string },
): CatalogGroup => ({
  name: `Group ${overrides.id}`,
  enabled: true,
  appIds: [],
  strategy: "ordered",
  members: [],
  sessionAffinity: false,
  affinityTtlSeconds: 0,
  failover: true,
  maxAttempts: 3,
  streamingFirstByteTimeout: 60,
  streamingIdleTimeout: 180,
  nonStreamingTimeout: 600,
  rules: [],
  ...overrides,
});
const catalog: GatewayCatalog = {
  revision: 7,
  suppliers: [
    supplier("a", "Pool A", "model-a"),
    supplier("b", "Pool B", "model-b"),
  ],
  policies: [
    {
      id: "connection/claude",
      name: "Claude connection",
      appId: "claude",
      enabled: true,
      matchModel: "",
      priority: 0,
      failover: false,
      candidates: [],
      groupId: "root",
    },
  ],
  groups: [
    group({
      id: "root",
      name: "Root group",
      appIds: ["claude"],
      members: [
        {
          id: "m1",
          supplierId: "a",
          model: "model-a",
          enabled: true,
          weight: 1,
        },
        {
          id: "m2",
          supplierId: "b",
          model: "model-b",
          enabled: true,
          weight: 1,
        },
        { id: "m3", groupId: "nested", model: "", enabled: true, weight: 1 },
      ],
    }),
    group({
      id: "nested",
      name: "Nested group",
      strategy: "manual",
      manualMemberId: "n1",
      members: [
        {
          id: "n1",
          supplierId: "b",
          model: "model-nested",
          enabled: true,
          weight: 1,
        },
      ],
    }),
  ],
};

describe("routing flow model", () => {
  it("rewrites a legacy group/<uuid> request model to the group name", () => {
    // 早期版本用 UUID 当组别名，历史轨迹里存的就是它。用户看到一串 UUID
    // 无法对应到任何组，这里按今天的目录换回组名；其他模型名原样透传。
    const withGroup: GatewayCatalog = {
      ...catalog,
      groups: [
        group({ id: "group-917a468c", name: "路由组1", appIds: ["codex"] }),
      ],
    };
    expect(readableRequestModel("group/group-917a468c", withGroup)).toBe(
      "group/路由组1",
    );
    expect(readableRequestModel("group/group-917a468c/gpt-5", withGroup)).toBe(
      "group/路由组1/gpt-5",
    );
    expect(readableRequestModel("group/路由组1", withGroup)).toBe(
      "group/路由组1",
    );
    expect(readableRequestModel("gpt-5", withGroup)).toBe("gpt-5");
    // 目录里已经没有这个组时，保持原样而不是造一个名字出来。
    expect(readableRequestModel("group/gone", withGroup)).toBe("group/gone");
    expect(readableRequestModel(undefined, withGroup)).toBe("");
  });

  it("keeps one lane per app using its latest request, active wins", () => {
    const older = { ...baseTrace, id: "older", createdAt: 500 };
    const newer = {
      ...baseTrace,
      id: "newer",
      appId: "codex",
      createdAt: 900,
    };
    const live = { ...baseTrace, id: "live", createdAt: 400 };
    expect(
      latestTracePerApp(page([older, newer], [live])).map((t) => t.id),
    ).toEqual(["live", "newer"]);
    // claude lane resolves to the active request despite the older history.
    const { lanes } = buildRoutingFlow(page([older], [live]));
    expect(lanes.map((lane) => lane.trace.id)).toEqual(["live"]);
    expect(lanes[0].live).toBe(true);
  });

  it("collapses repeated attempts and keeps the final stream outcome", () => {
    const retry = {
      ...baseTrace,
      events: [
        baseTrace.events[0],
        { ...baseTrace.events[0], outcome: "timeout", startedAt: 1200 },
      ],
    };
    const attempts = laneAttempts(retry, false);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].attempts).toEqual([1, 2]);
    expect(attempts[0].state).toBe("failed");
    // Header acceptance must not turn an interrupted response into a success.
    expect(
      laneAttempts({ ...baseTrace, outcome: "interrupted" }, false)[1].state,
    ).toBe("failed");
    expect(laneAttempts(baseTrace, false)[1].state).toBe("completed");
  });

  it("marks the last event of a live lane as active only in the active list", () => {
    const live = { ...baseTrace, outcome: "upstream_accepted" };
    expect(laneAttempts(live, true)[1].state).toBe("active");
    expect(laneAttempts(live, false)[1].state).toBe("unknown");
    expect(laneFinalState({ ...laneOf(live), live: true })).toBe("active");
  });

  it("derives group and model columns from the trace without today's catalog", () => {
    const { lanes, groups, outlets } = buildRoutingFlow(page([baseTrace]));
    expect(lanes[0].groupName).toBe("Snapshot root");
    expect(groups).toHaveLength(1);
    expect(outlets.map((o) => o.model)).toEqual(["model-a", "model-b"]);
    expect(outlets[0].state).toBe("failed");
    expect(outlets[1].state).toBe("completed");
    const legacy = {
      ...baseTrace,
      decision: undefined,
      policy: { ...baseTrace.policy, groupId: null },
    };
    const legacyFlow = buildRoutingFlow(page([legacy]));
    expect(legacyFlow.lanes[0].groupName).toBe("Historical policy");
    expect(legacyFlow.groups[0].key).toBe("policy:claude:policy");
  });

  it("draws the configured topology even without any traffic", () => {
    const { apps, lanes, groups, outlets, liveCount } = buildRoutingFlow(
      page([]),
      catalog,
    );
    expect(lanes).toEqual([]);
    expect(liveCount).toBe(0);
    expect(apps.map((app) => app.appId)).toEqual([
      "claude",
      "claude-desktop",
      "codex",
      "gemini",
      "grokbuild",
      "opencode",
      "openclaw",
      "hermes",
      "pi",
      "mcode",
      "typesafe",
      "commandcode",
      "crush",
      "droid",
      "kimi",
      "atomcode",
      "omo",
    ]);
    expect(apps[0]).toMatchObject({
      lane: null,
      staticRoutes: [
        {
          groupKey: "group:root",
          outletKeys: ["a|model-a", "b|model-b", "b|model-nested"],
        },
      ],
    });
    // 其余应用没有连接：只有 app→PHI 一条边。
    expect(apps[1].staticRoutes).toEqual([]);
    // The group column lists every catalog group (including nested ones),
    // while the nested group's members are flattened into the model list.
    expect(groups.map((g) => g.name)).toEqual(["Root group", "Nested group"]);
    expect(outlets).toMatchObject([
      { supplierName: "Pool A", state: null },
      { supplierName: "Pool B", state: null },
      { supplierName: "Pool B", state: null },
    ]);
  });

  it("merges traffic onto the configured topology, catalog names win", () => {
    const { apps, groups, outlets } = buildRoutingFlow(
      page([baseTrace]),
      catalog,
    );
    const claude = apps.find((app) => app.appId === "claude")!;
    expect(claude.lane).not.toBeNull();
    expect(claude.staticRoutes.map((route) => route.groupKey)).toEqual([
      "group:root",
    ]);
    expect(groups[0]).toMatchObject({ key: "group:root", name: "Root group" });
    // Shared outlets take the traffic state; configured-only ones stay idle.
    expect(outlets.find((o) => o.key === "a|model-a")!.state).toBe("failed");
    expect(outlets.find((o) => o.key === "b|model-b")!.state).toBe("completed");
    expect(outlets.find((o) => o.key === "b|model-nested")!.state).toBeNull();
  });

  it("orders apps by priority: live traffic, recent traffic, routed, then the rest", () => {
    const routed: GatewayCatalog = {
      ...catalog,
      policies: [
        ...catalog.policies,
        {
          ...catalog.policies[0],
          id: "connection/pi",
          appId: "pi",
          groupId: "nested",
        },
      ],
    };
    const codex = {
      ...baseTrace,
      id: "codex-1",
      appId: "codex",
      createdAt: 1200,
    };
    const live = {
      ...baseTrace,
      id: "grok-1",
      appId: "grokbuild",
      createdAt: 1500,
    };
    const { apps } = buildRoutingFlow(page([baseTrace, codex], [live]), routed);
    expect(apps.map((app) => app.appId)).toEqual([
      "grokbuild", // 进行中
      "codex", // 最近一次流量
      "claude", // 更早的流量
      "pi", // 已接入路由组但没有流量
      "claude-desktop", // 其余按配置清单顺序
      "gemini",
      "opencode",
      "openclaw",
      "hermes",
      "mcode",
      "typesafe",
      "commandcode",
      "crush",
      "droid",
      "kimi",
      "atomcode",
      "omo",
    ]);
  });

  it("flattens nested groups with a cycle guard", () => {
    const cyclic: GatewayCatalog = {
      ...catalog,
      groups: [
        group({
          id: "root",
          name: "Root group",
          members: [
            {
              id: "m3",
              groupId: "nested",
              model: "",
              enabled: true,
              weight: 1,
            },
          ],
        }),
        group({
          id: "nested",
          name: "Nested group",
          members: [
            { id: "n1", groupId: "root", model: "", enabled: true, weight: 1 },
          ],
        }),
      ],
    };
    expect(flattenGroupMembers(cyclic, "root")).toEqual([]);
    expect(flattenGroupMembers(catalog, "root").map((o) => o.key)).toEqual([
      "a|model-a",
      "b|model-b",
      "b|model-nested",
    ]);
  });

  it("orders the replay timeline across apps by event time", () => {
    const claude = baseTrace;
    const codex = {
      ...baseTrace,
      id: "codex-1",
      appId: "codex",
      events: [
        {
          supplierId: "c",
          supplierName: "Codex C",
          model: "model-c",
          outcome: "completed",
          groupPath: ["root"],
          startedAt: 1100,
        },
      ],
    };
    const { lanes } = buildRoutingFlow(page([claude, codex]));
    const timeline = buildTimeline(lanes);
    expect(
      timeline.map((s) => `${s.laneKey}:${s.attemptKey.split("|")[1]}`),
    ).toEqual(["claude:model-a", "codex:model-c", "claude:model-b"]);
    const lane = lanes.find((l) => l.appId === "codex")!;
    const playback = lanePlayback(lane, timeline, 0);
    expect(playback.visible).toBe(false);
    const after = lanePlayback(lane, timeline, 1);
    expect(after.visible && after.done).toBe(true);
  });
});

function laneOf(trace: GatewayRequestTrace) {
  return {
    appId: trace.appId,
    trace,
    live: false,
    groupKey: "group:root",
    groupName: "Snapshot root",
    groupStrategy: "ordered",
    groupId: "root",
    groupEnabled: true,
    attempts: [],
  };
}

/** 连线按区域分组：app / group / model 三段，分别对应三条连线轨道。 */
const regionOf = (container: HTMLElement, region: string) =>
  container.querySelector(`.phi-flow-wires g[data-region="${region}"]`)!;

describe("routing flow diagram", () => {
  it("renders four columns with per-app colored flow lines", () => {
    const codex = {
      ...baseTrace,
      id: "codex-1",
      appId: "codex",
      createdAt: 1200,
      events: [
        {
          supplierId: "a",
          supplierName: "Historical A",
          model: "model-a",
          outcome: "completed",
          groupPath: ["root"],
          startedAt: 1210,
        },
      ],
    };
    const { container } = render(
      <RoutingFlow data={page([baseTrace, codex])} />,
    );
    expect(
      screen.getByRole("list", { name: "gateway.flow.apps" }).children,
    ).toHaveLength(2);
    expect(
      screen.getByRole("list", { name: "gateway.flow.groups" }).children,
    ).toHaveLength(1);
    expect(
      screen.getByRole("list", { name: "gateway.flow.models" }).children,
    ).toHaveLength(2);
    expect(container.querySelector(".phi-flow-hub")).toContainElement(
      screen.getByRole("img", { name: "phi" }),
    );
    const colors = new Set(
      [
        ...container.querySelectorAll<SVGPathElement>(".phi-flow-wires path"),
      ].map((p) => p.style.stroke),
    );
    expect(colors.size).toBe(2);
    expect(
      container.querySelector('path[data-state="active"]'),
    ).not.toBeInTheDocument();
  });

  it("shows the live lane as an animated flow line", () => {
    const live = { ...baseTrace, outcome: "upstream_accepted" };
    const { container, rerender } = render(
      <RoutingFlow data={page([live], [live])} />,
    );
    expect(
      container.querySelector('path[data-state="active"]'),
    ).toBeInTheDocument();
    rerender(<RoutingFlow data={page([baseTrace])} />);
    expect(
      container.querySelector('path[data-state="active"]'),
    ).not.toBeInTheDocument();
  });

  it("replays the cross-app timeline step by step", () => {
    vi.useFakeTimers();
    const { container } = render(<RoutingFlow data={page([baseTrace])} />);
    // Final state: app→PHI, PHI→group and two group→model attempts.
    expect(container.querySelectorAll(".phi-flow-wires path")).toHaveLength(4);
    fireEvent.click(
      screen.getByRole("button", { name: "gateway.flow.replay" }),
    );
    // Step 0: lane wires are lit but only the first attempt is visible.
    expect(container.querySelectorAll(".phi-flow-wires path")).toHaveLength(3);
    act(() => vi.advanceTimersByTime(900));
    // Step 1 already covers both events: the lane settles on its final
    // completed state with the failed attempt still on the chart.
    expect(container.querySelectorAll(".phi-flow-wires path")).toHaveLength(4);
    expect(
      container.querySelector('.phi-flow-wires path[data-state="active"]'),
    ).not.toBeInTheDocument();
    expect(
      container.querySelector(
        '.phi-flow-node[data-kind="model"][data-state="failed"]',
      ),
    ).toHaveTextContent("Historical A");
    act(() => vi.advanceTimersByTime(900));
    expect(
      container.querySelector(
        '.phi-flow-node[data-kind="model"][data-state="completed"]',
      ),
    ).toHaveTextContent("Historical B");
    expect(
      screen.getByRole("button", { name: "gateway.flow.showAll" }),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "gateway.flow.showAll" }),
    );
    expect(
      container.querySelector(
        '.phi-flow-node[data-kind="model"][data-state="completed"]',
      ),
    ).toHaveTextContent("Historical B");
  });

  it("dims other lanes when an app node is focused", () => {
    const codex = {
      ...baseTrace,
      id: "codex-1",
      appId: "codex",
      createdAt: 1200,
      events: [
        {
          supplierId: "c",
          supplierName: "Codex C",
          model: "model-c",
          outcome: "completed",
          groupPath: ["root"],
          startedAt: 1210,
        },
      ],
    };
    const { container } = render(
      <RoutingFlow data={page([baseTrace, codex])} />,
    );
    fireEvent.click(
      screen.getAllByRole("button", { name: /gateway.flow.focusApp/ })[1],
    );
    const dimmed = container.querySelectorAll<SVGPathElement>(
      '.phi-flow-wires path[data-dimmed="true"]',
    );
    expect(dimmed.length).toBeGreaterThan(0);
    expect([...dimmed].every((p) => p.style.stroke !== "")).toBe(true);
  });

  it("collapses the lower-priority apps by default and expands them on demand", () => {
    render(<RoutingFlow data={page([])} catalog={catalog} />);
    const list = screen.getByRole("list", { name: "gateway.flow.apps" });
    // 默认只留五个位置：已配置/活跃的应用只优先占位，不额外占名额。
    expect(list.children).toHaveLength(5);
    expect(document.querySelector('[data-flow-key="claude"]')).not.toBeNull();
    // 没有任何配置的应用（排在最后、没流量）默认被收起来。
    expect(document.querySelector('[data-flow-key="openclaw"]')).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "gateway.flow.moreApps" }),
    );
    expect(list.children).toHaveLength(17);
    fireEvent.click(
      screen.getByRole("button", { name: "gateway.flow.fewerApps" }),
    );
    expect(list.children).toHaveLength(5);
  });

  it("shows the gateway address with its protocol and copies it as shown", () => {
    // 流转图上的地址是让用户照抄进客户端的，缺协议头就会被客户端判成
    // URL 解析失败（表现为「连不上」）。这里锁住「显示即可用」。
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    render(
      <RoutingFlow
        data={page([])}
        catalog={catalog}
        gatewayAddress="http://127.0.0.1:15821/v1"
      />,
    );
    const address =
      document.querySelector<HTMLButtonElement>(".phi-flow-address")!;
    expect(address).toHaveTextContent("http://127.0.0.1:15821/v1");
    fireEvent.click(address);
    expect(writeText).toHaveBeenCalledWith("http://127.0.0.1:15821/v1");
  });

  it("keeps the visible count capped when one group holds many apps", () => {
    // 现实场景：一个路由组一次性挂了八个应用，于是几乎每个应用都被判定为
    // 已配置。已配置只能用来「优先占位」，不能让默认列表突破上限。
    const shared: GatewayCatalog = {
      ...catalog,
      policies: [],
      groups: [
        {
          ...catalog.groups![0],
          appIds: [
            "claude",
            "claude-desktop",
            "codex",
            "gemini",
            "grokbuild",
            "opencode",
            "openclaw",
            "hermes",
          ],
        },
      ],
    };
    render(<RoutingFlow data={page([])} catalog={shared} />);
    const list = screen.getByRole("list", { name: "gateway.flow.apps" });
    expect(list.children).toHaveLength(5);
    expect(
      screen.getByRole("button", { name: "gateway.flow.moreApps" }),
    ).toBeInTheDocument();
  });

  it("lets a manual pick show more apps than the collapse limit", async () => {
    const user = userEvent.setup();
    render(<RoutingFlow data={page([])} catalog={catalog} />);
    const list = screen.getByRole("list", { name: "gateway.flow.apps" });
    expect(list.children).toHaveLength(5);
    await user.click(
      screen.getByRole("button", { name: "gateway.flow.pickApps" }),
    );
    const menu = screen.getByRole("dialog");
    // 挑七个：用户自定义的筛选不受第 1 条的折叠上限约束。
    for (const box of within(menu).getAllByRole("checkbox").slice(0, 7)) {
      fireEvent.click(box);
    }
    await waitFor(() => expect(list.children).toHaveLength(7));
    expect(
      screen.queryByRole("button", { name: /gateway.flow.moreApps/ }),
    ).not.toBeInTheDocument();
  });

  it("keeps in-flight apps prioritized but still capped", () => {
    const live = [
      "claude",
      "codex",
      "gemini",
      "grokbuild",
      "opencode",
      "openclaw",
      "hermes",
      "pi",
    ].map((appId, index) => ({
      ...baseTrace,
      id: `live-${appId}`,
      appId,
      createdAt: 1000 + index,
    }));
    render(<RoutingFlow data={page([], live)} />);
    // 进行中只用来优先占位：八条都在跑，默认仍只露五个，其余折叠。
    expect(
      screen.getByRole("list", { name: "gateway.flow.apps" }).children,
    ).toHaveLength(5);
    expect(
      screen.getByRole("button", { name: "gateway.flow.moreApps" }),
    ).toBeInTheDocument();
  });

  it("draws configured apps, groups and models as gray dashed base lines", () => {
    const { container } = render(
      <RoutingFlow data={page([])} catalog={catalog} />,
    );
    // 默认只列优先级最高的五个应用（硬上限），其余折叠在展开按钮后面。
    const appList = screen.getByRole("list", { name: "gateway.flow.apps" });
    expect(appList.children).toHaveLength(5);
    expect(
      screen.getByRole("list", { name: "gateway.flow.groups" }).children,
    ).toHaveLength(2);
    expect(
      screen.getByRole("list", { name: "gateway.flow.models" }).children,
    ).toHaveLength(3);
    // Configured-only models carry no traffic status text.
    expect(
      screen.queryByText("gateway.flow.states.unknown"),
    ).not.toBeInTheDocument();
    // 折叠后的应用不画 app→PHI 灰线；可见的 claude 走 group 区那条灰线，
    // 组与模型各自保留配置层连线。
    expect(
      regionOf(container, "app").querySelectorAll('[data-state="static"]'),
    ).toHaveLength(1);
    expect(
      regionOf(container, "group").querySelectorAll('[data-state="static"]'),
    ).toHaveLength(1);
    fireEvent.click(
      screen.getByRole("button", { name: "gateway.flow.moreApps" }),
    );
    // 展开后补齐剩下的应用与连线。
    expect(appList.children).toHaveLength(17);
    expect(
      regionOf(container, "app").querySelectorAll('[data-state="static"]'),
    ).toHaveLength(1);
    expect(
      screen.queryByRole("button", { name: "gateway.flow.replay" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("replaces matching gray edges with traffic and retains unused branches", () => {
    const { container } = render(
      <RoutingFlow data={page([baseTrace])} catalog={catalog} />,
    );
    const colored = [
      ...container.querySelectorAll<SVGPathElement>(".phi-flow-wires path"),
    ].filter((path) => path.getAttribute("data-state") !== "static");
    // app→PHI + PHI→group + two group→model attempt wires.
    expect(colored).toHaveLength(4);
    expect(colored.every((path) => path.style.stroke !== "")).toBe(true);
    // 有流量的应用不再画灰线；其余列出来的应用都没有配置，所以 app 区没有灰线。
    expect(
      regionOf(container, "app").querySelectorAll('[data-state="static"]'),
    ).toHaveLength(0);
    expect(
      regionOf(container, "group").querySelectorAll('[data-state="static"]'),
    ).toHaveLength(0);
    expect(
      regionOf(container, "model").querySelectorAll('[data-state="static"]'),
    ).toHaveLength(1);
    // The shared outlet keeps its traffic state while idle members stay on.
    expect(
      container.querySelector(
        '.phi-flow-node[data-kind="model"][data-state="failed"]',
      ),
    ).toHaveTextContent("Pool A");
  });

  it("replaces shared group and model edges even when another app is idle", () => {
    const sharedCatalog: GatewayCatalog = {
      ...catalog,
      policies: [
        ...catalog.policies,
        { ...catalog.policies[0], id: "connection/codex", appId: "codex" },
      ],
    };
    const { container } = render(
      <RoutingFlow data={page([baseTrace])} catalog={sharedCatalog} />,
    );
    // codex 也接入了路由组但没有流量：它的灰线留着。
    expect(
      regionOf(container, "app").querySelectorAll('[data-state="static"]'),
    ).toHaveLength(1);
    expect(
      regionOf(container, "group").querySelectorAll('[data-state="static"]'),
    ).toHaveLength(0);
    // Both configured apps retain only their unused nested-model connection.
    expect(
      regionOf(container, "model").querySelectorAll('[data-state="static"]'),
    ).toHaveLength(2);
  });

  it("keeps configured edges when historical traffic used another group", () => {
    const historical = {
      ...baseTrace,
      decision: { ...baseTrace.decision!, groupId: "old" },
      policy: { ...baseTrace.policy, groupId: "old" },
      events: baseTrace.events.map((event) => ({
        ...event,
        groupPath: ["old"],
      })),
    };
    const { container } = render(
      <RoutingFlow data={page([historical])} catalog={catalog} />,
    );
    expect(
      regionOf(container, "app").querySelectorAll('[data-state="static"]'),
    ).toHaveLength(0);
    expect(
      regionOf(container, "group").querySelectorAll('[data-state="static"]'),
    ).toHaveLength(1);
    expect(
      regionOf(container, "model").querySelectorAll('[data-state="static"]'),
    ).toHaveLength(3);
  });

  it("replaces gray model edges only as their attempts become visible in replay", () => {
    vi.useFakeTimers();
    const { container } = render(
      <RoutingFlow data={page([baseTrace])} catalog={catalog} />,
    );
    const modelWires = regionOf(container, "model");
    fireEvent.click(
      screen.getByRole("button", { name: "gateway.flow.replay" }),
    );
    expect(modelWires.querySelectorAll('[data-state="static"]')).toHaveLength(
      2,
    );
    expect(
      modelWires.querySelectorAll('path:not([data-state="static"])'),
    ).toHaveLength(1);
    act(() => vi.advanceTimersByTime(900));
    expect(modelWires.querySelectorAll('[data-state="static"]')).toHaveLength(
      1,
    );
    expect(
      modelWires.querySelectorAll('path:not([data-state="static"])'),
    ).toHaveLength(2);
  });

  it("explains line styles in the legend and drops node icons", () => {
    const { container } = render(
      <RoutingFlow data={page([baseTrace])} catalog={catalog} />,
    );
    for (const key of [
      "gateway.flow.lineActive",
      "gateway.flow.lineCompleted",
      "gateway.flow.lineFailed",
      "gateway.flow.lineUnknown",
      "gateway.flow.configured",
    ]) {
      expect(screen.getByText(key)).toBeInTheDocument();
    }
    expect(container.querySelector(".phi-flow-mark")).not.toBeInTheDocument();
  });

  it("shows an empty state without inventing traffic", () => {
    const { container } = render(<RoutingFlow data={page([])} />);
    expect(screen.getByRole("status")).toHaveTextContent("gateway.flow.empty");
    expect(container.querySelector(".phi-flow-wires")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "gateway.flow.replay" }),
    ).not.toBeInTheDocument();
  });
});

describe("wirePath geometry", () => {
  it("starts on the source's right edge and lands on the target's left edge", () => {
    const d = wirePath({ right: 100, cy: 40 }, { left: 220, cy: 96 });
    expect(d.startsWith("M 100 40")).toBe(true);
    expect(d.endsWith("220 96")).toBe(true);
  });

  it("applies the fan-out offset at both endpoints", () => {
    const d = wirePath({ right: 10, cy: 50 }, { left: 90, cy: 70 }, -5);
    expect(d.startsWith("M 10 45")).toBe(true);
    expect(d.endsWith("90 65")).toBe(true);
  });

  it("keeps a fanned endpoint inside the node instead of past its corner", () => {
    const node = { right: 100, cy: 40, top: 8, bottom: 72 };
    const target = { left: 220, cy: 40, top: 8, bottom: 72 };
    // ±37.5 曾把落在 64px 高节点上的线推到节点下方 5.5px。
    expect(wirePath(node, target, 37.5).startsWith("M 100 64")).toBe(true);
    expect(wirePath(node, target, -37.5).startsWith("M 100 16")).toBe(true);
  });
});

describe("wire attachment", () => {
  const box = (
    left: number,
    top: number,
    width: number,
    height: number,
  ): DOMRect =>
    ({
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
      x: left,
      y: top,
      toJSON: () => ({}),
    }) as DOMRect;
  const ZERO = box(0, 0, 0, 0);

  /** jsdom 的布局全是 0；这里给每个流程图节点一个固定盒子，让连线真的有坐标。 */
  const stubLayout = () => {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
      function (this: Element) {
        const el = this as HTMLElement;
        if (el.classList?.contains("phi-flow-stage"))
          return box(0, 0, 1200, 900);
        const kind = el.dataset?.flow;
        if (!kind) return ZERO;
        if (kind === "hub") return box(244, 400, 104, 72);
        if (!el.dataset.flowKey) return ZERO;
        const siblings = [
          ...document.querySelectorAll(`[data-flow="${kind}"][data-flow-key]`),
        ];
        const index = Math.max(0, siblings.indexOf(el));
        if (kind === "app") return box(0, 100 + index * 80, 200, 64);
        if (kind === "group") return box(392, 400 + index * 120, 300, 64);
        return box(736, 200 + index * 100, 240, 64);
      },
    );
  };
  afterEach(() => vi.restoreAllMocks());

  const endY = (path: SVGPathElement) => {
    const coords = path.getAttribute("d")!.split(" ");
    return Number(coords[coords.length - 1]);
  };

  it("draws one shared configuration edge on the node's centre, not beside it", () => {
    stubLayout();
    // 真实数据里十几个应用都接到同一个路由组：每条灰线本应完全重叠。
    const shared: GatewayCatalog = {
      ...catalog,
      policies: ROUTABLE_APP_IDS.slice(0, 16).map((appId, index) => ({
        ...catalog.policies[0],
        id: `connection/${appId}`,
        appId,
        priority: index,
      })),
    };
    const { container } = render(
      <RoutingFlow data={page([])} catalog={shared} />,
    );
    const wires = [
      ...regionOf(container, "group").querySelectorAll<SVGPathElement>(
        'path[data-state="static"]',
      ),
    ];
    expect(wires).toHaveLength(16);
    // 组节点 400..464，中心 432：每个应用的灰线都落在同一点。
    for (const path of wires) expect(endY(path)).toBe(432);
    expect(new Set(wires.map((path) => path.getAttribute("d"))).size).toBe(1);
  });

  it("adds another app from the first column by opening the third-party app form", () => {
    // 新建弹窗要读路由目录，所以这里需要 QueryClient（真实页面本来就有）。
    renderWithQueryClient(<RoutingFlow data={page([])} catalog={catalog} />);
    const add = screen.getByRole("button", { name: "gateway.flow.addApp" });
    // 第一次添加时默认叫 PHI：不给用户多一步命名。
    fireEvent.click(add);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByLabelText("access.keyName")).toHaveValue("PHI");
  });

  it("edits a third-party app node instead of its route settings", async () => {
    // 三方应用（接入令牌）没有应用配置可写，节点右上角给的是编辑：
    // 弹窗里只有重新签发与删除。
    const binding: AccessBinding = {
      id: "cursor",
      name: "Cursor",
      agent: "Cursor",
      tool: "external",
      projectId: null,
      allowedGroups: ["root"],
      enabled: true,
    };
    renderWithQueryClient(
      <RoutingFlow data={page([])} catalog={catalog} bindings={[binding]} />,
    );
    const list = screen.getByRole("list", { name: "gateway.flow.apps" });
    const node = list.querySelector<HTMLElement>(
      '[data-flow-key="binding:cursor"]',
    )!;
    expect(node.dataset.appKind).toBe("binding");
    fireEvent.click(
      within(node).getByRole("button", { name: "gateway.flow.editAppFor" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Cursor")).toBeInTheDocument();
    expect(within(dialog).getByText("access.editHint")).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: "access.rotate" }),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: "access.delete" }),
    ).toBeInTheDocument();
    // 编辑弹窗不暴露改名与改路由范围。
    expect(within(dialog).queryByLabelText("access.keyName")).toBeNull();
    expect(within(dialog).queryByRole("checkbox")).toBeNull();
  });

  it("narrows the app column to the picked apps", async () => {
    const user = userEvent.setup();
    render(<RoutingFlow data={page([])} catalog={catalog} />);
    const list = screen.getByRole("list", { name: "gateway.flow.apps" });
    expect(list.children).toHaveLength(5);
    await user.click(
      screen.getByRole("button", { name: "gateway.flow.pickApps" }),
    );
    const menu = screen.getByRole("dialog");
    // 挑选弹层里列出全部应用，不只是折叠后可见的那 6 个。
    expect(within(menu).getAllByRole("checkbox")).toHaveLength(
      ROUTABLE_APP_IDS.length,
    );
    fireEvent.click(within(menu).getAllByRole("checkbox")[16]);
    await waitFor(() => expect(list.children).toHaveLength(1));
    // 挑选生效后折叠按钮让位，避免和「显示哪些应用」互相打架。
    expect(
      screen.queryByRole("button", { name: /gateway.flow.moreApps/ }),
    ).not.toBeInTheDocument();
  });

  it("fans parallel traffic wires out without leaving the group node", () => {
    stubLayout();
    const live = [
      baseTrace,
      { ...baseTrace, id: "live-codex", appId: "codex", createdAt: 1100 },
    ];
    const { container } = render(<RoutingFlow data={page([], live)} />);
    const wires = [
      ...regionOf(container, "group").querySelectorAll<SVGPathElement>(
        'path:not([data-state="static"])',
      ),
    ];
    expect(wires).toHaveLength(2);
    const ends = wires.map(endY);
    // 两条线各有自己的落点，且都还在节点（400..464）的边内。
    expect(new Set(ends).size).toBe(2);
    for (const y of ends) {
      expect(y).toBeGreaterThanOrEqual(408);
      expect(y).toBeLessThanOrEqual(456);
    }
  });
});
