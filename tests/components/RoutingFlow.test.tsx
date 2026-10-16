import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { RoutingFlow } from "@/components/gateway/RoutingFlow";
import { buildRoutingFlow } from "@/components/gateway/routingFlowModel";
import type { GatewayRequestTrace, GatewayTracePage } from "@/lib/api/gateway";

const trace: GatewayRequestTrace = {
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
      groupPath: ["root", "nested"],
      latencyMs: 100,
    },
    {
      supplierId: "b",
      supplierName: "Historical B",
      model: "model-b",
      outcome: "upstream_accepted",
      groupPath: ["root"],
      latencyMs: 250,
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
    intents: [],
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
    candidates: ["a", "b", "c"].map((supplierId) => ({
      supplierId,
      supplierName: `Historical ${supplierId.toUpperCase()}`,
      model: `model-${supplierId}`,
      groupPath: supplierId === "a" ? ["root", "nested"] : ["root"],
      memberPath: [],
      reason: supplierId === "c" ? "cooldown" : "ordered",
      available: supplierId !== "c",
      recentTokens: 0,
      active: 0,
      cooldownUntil: supplierId === "c" ? 5000 : null,
    })),
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

describe("recorded routing flow", () => {
  it("keeps failed attempts, nested snapshot paths and the final stream outcome", () => {
    const { nodes } = buildRoutingFlow(trace, false);
    expect(nodes.map((node) => node.state)).toEqual([
      "failed",
      "completed",
      "cooldown",
    ]);
    expect(nodes[0].groups).toEqual(["Snapshot root", "Snapshot nested"]);
    expect(nodes[1].latestOutcome).toBe("completed");
    // Header acceptance must not turn an interrupted response into a success.
    expect(
      buildRoutingFlow({ ...trace, outcome: "interrupted" }, false).nodes[1]
        .state,
    ).toBe("failed");
    // Historical cooldown is evaluated at request time, not against today's clock.
    expect(nodes[2].state).toBe("cooldown");
  });

  it("only animates in-flight attempts present in the active request list", () => {
    const live = { ...trace, outcome: "upstream_accepted" };
    expect(buildRoutingFlow(live, true).nodes[1].state).toBe("active");
    expect(buildRoutingFlow(live, false).nodes[1].state).toBe("unknown");
    const { container, rerender } = render(
      <RoutingFlow data={page([live], [live])} />,
    );
    expect(
      container.querySelector('path[data-state="active"]'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "gateway.flow.replay" }),
    ).toBeDisabled();
    rerender(<RoutingFlow data={page([trace])} />);
    expect(
      container.querySelector('path[data-state="active"]'),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "gateway.flow.replay" }),
    ).toBeEnabled();
  });

  it("replays actual attempts in order and restores the full result", () => {
    vi.useFakeTimers();
    const { container } = render(<RoutingFlow data={page([trace])} />);
    fireEvent.click(
      screen.getByRole("button", { name: "gateway.flow.replay" }),
    );
    expect(
      container.querySelectorAll('.phi-routing-outlet[data-state="failed"]'),
    ).toHaveLength(0);
    act(() => vi.advanceTimersByTime(900));
    expect(
      container.querySelector('.phi-routing-outlet[data-state="failed"]'),
    ).toHaveTextContent("Historical A");
    expect(
      container.querySelectorAll('.phi-routing-outlet[data-state="completed"]'),
    ).toHaveLength(0);
    act(() => vi.advanceTimersByTime(900));
    expect(
      container.querySelector('.phi-routing-outlet[data-state="completed"]'),
    ).toHaveTextContent("Historical B");
    const attempts = screen.getByRole("list", {
      name: "gateway.flow.attempts",
    });
    fireEvent.click(within(attempts).getAllByRole("button")[0]);
    expect(
      container.querySelectorAll('.phi-routing-outlet[data-state="completed"]'),
    ).toHaveLength(0);
    fireEvent.click(
      screen.getByRole("button", { name: "gateway.flow.showAll" }),
    );
    expect(
      container.querySelector('.phi-routing-outlet[data-state="completed"]'),
    ).toHaveTextContent("Historical B");
  });

  it("handles legacy traces and repeated attempts without consulting today's catalog", () => {
    const legacy = {
      ...trace,
      decision: undefined,
      policy: { ...trace.policy, candidates: [] },
      events: [trace.events[0], { ...trace.events[0], outcome: "timeout" }],
    };
    const { nodes, eventNodes } = buildRoutingFlow(legacy, false);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].name).toBe("Historical A");
    expect(nodes[0].groups).toEqual(["root", "nested"]);
    expect(nodes[0].attempts).toEqual([1, 2]);
    expect(eventNodes[0]).toBe(eventNodes[1]);
  });

  it("shows an empty state without inventing traffic", () => {
    const { container } = render(<RoutingFlow data={page([])} />);
    expect(screen.getByRole("status")).toHaveTextContent("gateway.flow.empty");
    expect(
      container.querySelector(".phi-routing-wires"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "gateway.flow.replay" }),
    ).not.toBeInTheDocument();
  });

  it("selects a historical request while live data refreshes", async () => {
    HTMLElement.prototype.scrollIntoView = vi.fn();
    const user = userEvent.setup();
    const historical = {
      ...trace,
      id: "codex-request",
      appId: "codex",
      createdAt: 500,
    };
    const live = { ...trace, outcome: "upstream_accepted" };
    const { container, rerender } = render(
      <RoutingFlow data={page([historical, live], [live])} />,
    );
    expect(container.querySelector(".phi-routing-source")).toHaveTextContent(
      "Claude",
    );
    await user.click(
      screen.getByRole("combobox", { name: "gateway.flow.request" }),
    );
    await user.click(screen.getByRole("option", { name: /Codex/ }));
    expect(container.querySelector(".phi-routing-source")).toHaveTextContent(
      "Codex",
    );
    expect(
      container.querySelector('path[data-state="active"]'),
    ).not.toBeInTheDocument();
    rerender(
      <RoutingFlow
        data={page([historical, { ...live, latencyMs: 500 }], [live])}
      />,
    );
    expect(container.querySelector(".phi-routing-source")).toHaveTextContent(
      "Codex",
    );
  });
});
