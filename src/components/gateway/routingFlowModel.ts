import type { GatewayRequestTrace, GatewayTraceEvent } from "@/lib/api/gateway";

export type FlowState =
  | "available"
  | "skipped"
  | "cooldown"
  | "active"
  | "completed"
  | "failed"
  | "unknown";
export interface RoutingFlowNode {
  id: string;
  supplierId: string;
  name: string;
  model: string;
  groupPath: string[];
  groups: string[];
  state: FlowState;
  reason?: string;
  attempts: number[];
  latestOutcome?: string;
}

const waiting = (outcome: string) =>
  outcome === "pending" || outcome === "upstream_accepted";

/** Accepted upstream headers are not a completed response. The request's
 * terminal outcome determines the final accepted attempt's actual result. */
export function flowEventOutcome(trace: GatewayRequestTrace, index: number) {
  const outcome = trace.events[index].outcome;
  return waiting(outcome) &&
    index === trace.events.length - 1 &&
    !waiting(trace.outcome)
    ? trace.outcome
    : outcome;
}

export function buildRoutingFlow(
  trace: GatewayRequestTrace,
  isLive: boolean,
  count = trace.events.length,
) {
  const names = new Map(
    trace.decision?.groups.map((group) => [group.id, group.name]),
  );
  const candidates =
    trace.decision?.candidates ??
    trace.policy.candidates.map((candidate) => ({
      ...candidate,
      supplierName: candidate.supplierId,
      groupPath: [],
      available: true,
      reason: "",
      cooldownUntil: null,
    }));
  const nodes: RoutingFlowNode[] = candidates.map((candidate, index) => ({
    id: `candidate-${index}`,
    supplierId: candidate.supplierId,
    name: candidate.supplierName || candidate.supplierId,
    model: candidate.model,
    groupPath: candidate.groupPath,
    groups: candidate.groupPath.map((id) => names.get(id) ?? id),
    state: candidate.available
      ? "available"
      : candidate.cooldownUntil != null &&
          candidate.cooldownUntil > trace.createdAt
        ? "cooldown"
        : "skipped",
    reason: candidate.reason,
    attempts: [],
  }));
  const eventNodes: string[] = [];
  trace.events.slice(0, count).forEach((event: GatewayTraceEvent, index) => {
    const matching = nodes.filter(
      (node) =>
        node.supplierId === event.supplierId && node.model === event.model,
    );
    let node = event.groupPath?.length
      ? matching.find(
          (candidate) =>
            JSON.stringify(candidate.groupPath) ===
            JSON.stringify(event.groupPath),
        )
      : matching.length === 1
        ? matching[0]
        : undefined;
    if (!node) {
      node = {
        id: `attempt-${index}`,
        supplierId: event.supplierId,
        name: event.supplierName || event.supplierId,
        model: event.model,
        groupPath: event.groupPath ?? [],
        groups: (event.groupPath ?? []).map((id) => names.get(id) ?? id),
        state: "unknown",
        attempts: [],
      };
      nodes.push(node);
    }
    if (event.supplierName) node.name = event.supplierName;
    const outcome = flowEventOutcome(trace, index);
    node.latestOutcome = outcome;
    node.state = waiting(outcome)
      ? isLive && index === trace.events.length - 1
        ? "active"
        : "unknown"
      : outcome === "completed"
        ? "completed"
        : "failed";
    node.attempts.push(index + 1);
    eventNodes.push(node.id);
  });
  return { nodes, eventNodes };
}
