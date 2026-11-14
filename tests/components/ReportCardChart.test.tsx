import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ReliabilityChart } from "@/components/reportcard/ReliabilityChart";
import {
  compositionRows,
  compositionTotals,
  formatPercent,
  segmentPercent,
} from "@/components/reportcard/chartData";
import type { ModelScoreboardRow } from "@/lib/api/reportCard";

function row(overrides: Partial<ModelScoreboardRow> = {}): ModelScoreboardRow {
  return {
    providerId: "codex",
    model: "gpt-5",
    tasks: 3,
    toolCalls: 10,
    toolFailures: 2,
    interruptions: 1,
    effectiveCalls: 9,
    toolFailureRate: 2 / 9,
    interruptionRate: 1 / 10,
    writeAttempts: 2,
    writeSuccesses: 2,
    deliveryTasks: 2,
    emptyTasks: 0,
    emptyDeliveryRate: 0,
    mixedModelTasks: 0,
    costUsd: 0.1,
    costPerTask: 0.03,
    timedCalls: 10,
    avgStepMs: 900,
    exitSamples: 1,
    exitFailures: 0,
    sampleSize: 10,
    sufficient: true,
    lastSeenAt: Date.now(),
    ...overrides,
  };
}

describe("compositionRows", () => {
  it("drops models without tool calls and keeps the rest", () => {
    const rows = [
      row({ model: "busy" }),
      row({ model: "idle", toolCalls: 0, toolFailures: 0, interruptions: 0 }),
    ];
    expect(compositionRows(rows).map((entry) => entry.model)).toEqual(["busy"]);
  });

  it("puts the model that failed most first, then the busier one", () => {
    const rows = [
      row({ model: "few-failures", toolFailures: 1, toolCalls: 50 }),
      row({ model: "many-failures", toolFailures: 9, toolCalls: 12 }),
      row({ model: "quiet", toolFailures: 0, toolCalls: 4 }),
    ];
    expect(compositionRows(rows).map((entry) => entry.model)).toEqual([
      "many-failures",
      "few-failures",
      "quiet",
    ]);
  });

  it("splits calls into ok / failed / interrupted without double counting", () => {
    const [entry] = compositionRows([row({ toolCalls: 10 })]);
    expect(entry.ok).toBe(7);
    expect(entry.failed).toBe(2);
    expect(entry.interrupted).toBe(1);
    expect(entry.ok + entry.failed + entry.interrupted).toBe(entry.calls);
  });
});

describe("compositionTotals", () => {
  it("adds up to the same call count the table shows", () => {
    const rows = [
      row(),
      row({ model: "other", toolCalls: 5, toolFailures: 1, interruptions: 0 }),
    ];
    const totals = compositionTotals(rows);
    expect(totals.calls).toBe(15);
    expect(totals.failed).toBe(3);
    expect(totals.interrupted).toBe(1);
    expect(totals.ok).toBe(11);
  });
});

describe("segmentPercent / formatPercent", () => {
  it("turns a share into a bar width and clamps nonsense", () => {
    expect(segmentPercent(1, 4)).toBe(25);
    expect(segmentPercent(0, 4)).toBe(0);
    expect(segmentPercent(1, 0)).toBe(0);
  });

  it("formats a rate with one decimal, and a dash when there is none", () => {
    expect(formatPercent(0.1234)).toBe("12.3%");
    expect(formatPercent(0)).toBe("0.0%");
    expect(formatPercent(null)).toBe("—");
  });
});

describe("ReliabilityChart", () => {
  it("draws only the sampled models and says how many were left out", () => {
    render(
      <ReliabilityChart
        locale="zh-CN"
        rows={[
          row({ model: "gpt-5" }),
          row({
            model: "idle",
            toolCalls: 0,
            toolFailures: 0,
            interruptions: 0,
          }),
        ]}
      />,
    );

    expect(screen.getByText("reportCard.chart.title")).toBeInTheDocument();
    expect(screen.getByText("gpt-5")).toBeInTheDocument();
    // 没有调用样本的模型不画空条，但要在小字里交代一句
    expect(screen.queryByText("idle")).toBeNull();
    expect(screen.getByText("reportCard.chart.omitted")).toBeInTheDocument();
  });

  it("shows the failure rate only when the sample is big enough", () => {
    render(
      <ReliabilityChart
        locale="zh-CN"
        rows={[
          row({ model: "enough", toolFailureRate: 0.25 }),
          row({
            model: "tiny",
            toolCalls: 3,
            toolFailures: 1,
            interruptions: 0,
            toolFailureRate: 1 / 3,
            sampleSize: 3,
            sufficient: false,
          }),
        ]}
      />,
    );

    expect(screen.getByText("25.0%")).toBeInTheDocument();
    expect(
      screen.getByText("reportCard.chart.tooFewSamples"),
    ).toBeInTheDocument();
  });

  it("says so instead of drawing an empty chart when nothing has samples", () => {
    render(
      <ReliabilityChart
        locale="zh-CN"
        rows={[row({ toolCalls: 0, toolFailures: 0, interruptions: 0 })]}
      />,
    );

    expect(screen.getByText("reportCard.chart.empty")).toBeInTheDocument();
    expect(screen.queryByText("reportCard.chart.omitted")).toBeNull();
  });
});
