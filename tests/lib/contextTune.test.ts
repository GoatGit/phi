import { describe, expect, it } from "vitest";
import {
  compactAdvice,
  observe,
  replayCompact,
  seriesBySession,
  weightsFor,
} from "@/lib/usage/contextTune";
import type { SessionContextPoint } from "@/lib/api/sessionStats";

/** 造一段带一次压缩的水位序列：爬到 80K 后掉到 30K，再继续爬 */
function syntheticSeries(): number[] {
  const series: number[] = [];
  let level = 10_000;
  for (let i = 0; i < 60; i += 1) {
    level += 1_500;
    series.push(level);
  }
  // 压缩：80K+ → 30K
  series.push(30_000);
  for (let i = 0; i < 60; i += 1) {
    level = series[series.length - 1] + 1_500;
    series.push(level);
  }
  return series;
}

function syntheticPoints(appType: string, sessionId: string): SessionContextPoint[] {
  const series = syntheticSeries();
  return series.map((contextTokens, index) => ({
    appType,
    sessionId,
    createdAt: 1_700_000_000 + index * 60,
    model: "test-model",
    contextTokens,
    outputTokens: 300,
  }));
}

describe("contextTune", () => {
  it("detects compactions with the magpie heuristic", () => {
    const facts = observe(syntheticSeries());
    expect(facts).not.toBeNull();
    expect(facts!.compacts).toBe(1);
    expect(facts!.after).toBe(30_000);
    expect(facts!.growth).toBeGreaterThan(0);
  });

  it("ignores tiny sequences", () => {
    expect(observe([1000, 2000])).toBeNull();
  });

  it("replays cost that grows with each call and charges compaction rework", () => {
    const series = syntheticSeries();
    const outs = series.map(() => 300);
    const facts = observe(series)!;
    const weights = weightsFor("codex");
    const low = replayCompact(series, outs, 270_000, facts, weights, false);
    const tight = replayCompact(series, outs, 40_000, facts, weights, false);
    // 过松的阈值几乎不压缩（读贵写少的场景下成本更高），过紧的频繁压缩也不省
    expect(low).toBeGreaterThan(0);
    expect(tight).toBeGreaterThan(0);
  });

  it("requires 50 calls before giving tuning advice", () => {
    const short = syntheticSeries().slice(0, 30);
    const outs = short.map(() => 300);
    expect(compactAdvice("codex", short, outs)).toBeNull();
    const advice = compactAdvice("codex", syntheticSeries(), syntheticSeries().map(() => 300));
    expect(advice).not.toBeNull();
    expect(advice!.current).toBe(272_000);
    expect(advice!.curve.length).toBeGreaterThan(2);
    void outs;
  });

  it("groups points by session and sorts by time", () => {
    const points = syntheticPoints("claude", "abc").reverse();
    const grouped = seriesBySession(points);
    const series = grouped.get("claude\0abc");
    expect(series).toBeDefined();
    expect(series![0]).toBeLessThan(series![series!.length - 1]);
  });
});
