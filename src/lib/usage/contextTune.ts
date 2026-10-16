import type { SessionContextPoint } from "@/lib/api/sessionStats";

/**
 * 上下文压缩调优：移植自 magpie（MIT License，© 2026 yetone，
 * https://github.com/yetone/magpie，internal/tune/tune.go）的重放思路。
 *
 * 输入是逐请求的上下文水位序列（会话内累计的 fresh input + cache read + cache creation），
 * 对每个候选「自动压缩阈值」重放同样的调用序列，算出加权 token 成本，取最便宜点推荐。
 * Token 权重按厂商计费方式：一次缓存读取 ≈ 十分之一个普通输入 token。
 */

/** 相对权重（以普通输入 token 为 1） */
export interface TuneWeights {
  read: number;
  write: number;
  write1h: number;
  out: number;
}

export function weightsFor(appType: string): TuneWeights {
  if (appType === "claude") {
    return { read: 0.1, write: 1.25, write1h: 2, out: 5 };
  }
  return { read: 0.1, write: 1, write1h: 1, out: 8 };
}

export interface TuneObservation {
  /** 调用次数 */
  calls: number;
  /** 自动压缩次数（前值 ≥ 20K 且后值 < 60%） */
  compacts: number;
  /** 压缩前水位中位数 */
  peak: number;
  /** 压缩后水位中位数 */
  after: number;
  /** 相邻调用增长中位数 */
  growth: number;
  /** 压缩后重读成本中位数 */
  rework: number;
  /** 会话流首条水位中位数（系统提示+工具等保留部分） */
  base: number;
  /** 观察到的水位峰值 */
  maxLevel: number;
}

const COMPACTION_MIN_PREV = 20_000;

/** 有序水位序列 → 事实观察。series 必须按时间升序。 */
export function observe(series: number[]): TuneObservation | null {
  if (series.length < 3) return null;
  const median = (values: number[]): number => {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2
      ? sorted[mid]
      : (sorted[mid - 1] + sorted[mid]) / 2;
  };

  const peaks: number[] = [];
  const afters: number[] = [];
  const growths: number[] = [];
  const reworks: number[] = [];
  const firsts: number[] = [];
  let compacts = 0;

  // 会话流分段：水位骤降视为压缩/新流边界
  let streamStart = 0;
  for (let i = 0; i < series.length; i += 1) {
    const level = series[i];
    if (i > 0) {
      const prev = series[i - 1];
      const delta = level - prev;
      if (delta > 0) growths.push(delta);
      const isCompaction = prev >= COMPACTION_MIN_PREV && level < prev * 0.6;
      if (isCompaction) {
        compacts += 1;
        peaks.push(prev);
        afters.push(level);
        // 重读成本：压缩点后第 10 次调用的水位 − 压缩点水位 − 10×增长
        const probe = Math.min(i + 10, series.length - 1);
        if (probe > i) {
          const rework = series[probe] - level - (probe - i) * median(growths);
          if (rework > 0) reworks.push(rework);
        }
        firsts.push(series[streamStart]);
        streamStart = i;
      }
    }
  }
  firsts.push(series[streamStart]);
  if (series.length <= streamStart + 1) return null;

  const growth = median(growths);
  const base = median(firsts);
  const after = compacts > 0 ? median(afters) : base + 10_000;
  const rework =
    compacts >= 5 ? median(reworks) : Math.max(median(reworks), 10_000);
  return {
    calls: series.length,
    compacts,
    peak: median(peaks),
    after,
    growth: Math.max(1, growth),
    rework,
    base,
    maxLevel: Math.max(...series),
  };
}

export interface ReplayPoint {
  threshold: number;
  cost: number;
}

/**
 * 对单个候选阈值重放调用序列。
 * 每次调用付「读全量上下文 + 写增量 + 输出」三笔；水位超过阈值且高于压缩后
 * 剩余水位时触发一次模拟压缩（付一次读 + 写摘要 + 下一轮写缓存，水位落到 after + rework）。
 */
export function replayCompact(
  series: number[],
  outs: number[],
  threshold: number,
  facts: TuneObservation,
  weights: TuneWeights,
  use1h: boolean,
): number {
  const write = use1h ? weights.write1h : weights.write;
  const summary = Math.max(0, facts.after - facts.base);
  let ctx = series[0];
  let cost = ctx * write + (outs[0] ?? 0) * weights.out;
  for (let i = 1; i < series.length; i += 1) {
    const delta = Math.max(0, series[i] - ctx);
    if (ctx + delta > threshold && ctx > facts.after) {
      cost +=
        ctx * weights.read +
        summary * weights.out +
        (summary + facts.rework) * write;
      ctx = facts.after + facts.rework;
    }
    cost += ctx * weights.read + delta * write + (outs[i] ?? 0) * weights.out;
    ctx += delta;
  }
  return cost;
}

export interface CompactAdvice {
  /** 当前生效的压缩阈值（Agent 默认） */
  current: number;
  /** 推荐阈值；节省不足 3% 时等于 current */
  best: number;
  /** 推荐点的重放成本 */
  cost: number;
  /** 当前阈值下的重放成本 */
  currentCost: number;
  /** 曲线下限 */
  low: number;
  window: number;
  facts: TuneObservation;
  curve: ReplayPoint[];
}

/** Agent 的窗口与扫描参数（magpie gui/tune.go:81） */
export function tuneParamsFor(
  appType: string,
  maxLevel: number,
): {
  min: number;
  max: number;
  step: number;
  reserve: number;
  window: number;
  current: number;
} | null {
  if (appType === "claude") {
    const window = maxLevel > 200_000 ? 1_000_000 : 200_000;
    const current = window - 33_000; // Claude Code 在 window − 33K 处压缩
    return {
      min: 100_000,
      max: window,
      step: 10_000,
      reserve: 33_000,
      window,
      current,
    };
  }
  if (appType === "codex") {
    return {
      min: 50_000,
      max: 272_000,
      step: 10_000,
      reserve: 0,
      window: 272_000,
      current: 272_000,
    };
  }
  return null;
}

/** 计算压缩阈值建议。calls < 50 时返回 null（数据不足）。 */
export function compactAdvice(
  appType: string,
  series: number[],
  outs: number[],
): CompactAdvice | null {
  const params = tuneParamsFor(appType, Math.max(...series, 0));
  const facts = observe(series);
  if (!params || !facts || facts.calls < 50) return null;

  const weights = weightsFor(appType);
  const use1h = false; // 1h 缓存占比无法从水位序列推出，v1 统一按 5m 写价
  const floor = Math.max(
    params.min,
    facts.after + Math.max(facts.after / 2, 20 * facts.growth) + params.reserve,
  );
  const top = Math.min(params.max, Math.max(params.window, facts.maxLevel));

  const curve: ReplayPoint[] = [];
  for (let t = floor; t <= top; t += params.step) {
    curve.push({
      threshold: t,
      cost: replayCompact(series, outs, t, facts, weights, use1h),
    });
  }
  if (curve.length < 2) return null;

  const minCost = Math.min(...curve.map((p) => p.cost));
  // 1% 成本内取最大的阈值（少压缩少丢上下文）
  const candidates = curve.filter((p) => p.cost <= minCost * 1.01);
  const cheapest = candidates[candidates.length - 1];
  const currentCost = replayCompact(
    series,
    outs,
    params.current,
    facts,
    weights,
    use1h,
  );
  const best =
    currentCost - cheapest.cost >= currentCost * 0.03
      ? cheapest.threshold
      : params.current;
  const bestCost =
    best === cheapest.threshold
      ? cheapest.cost
      : replayCompact(series, outs, best, facts, weights, use1h);
  return {
    current: params.current,
    best,
    cost: bestCost,
    currentCost,
    low: Math.min(...curve.map((p) => p.cost)),
    window: params.window,
    facts,
    curve,
  };
}

/** 从上下文采样点构建每会话的有序水位序列（时间升序） */
export function seriesBySession(
  points: SessionContextPoint[],
): Map<string, number[]> {
  const grouped = new Map<string, SessionContextPoint[]>();
  for (const point of points) {
    const key = `${point.appType}\0${point.sessionId}`;
    const list = grouped.get(key);
    if (list) list.push(point);
    else grouped.set(key, [point]);
  }
  const result = new Map<string, number[]>();
  for (const [key, list] of grouped) {
    list.sort((a, b) => a.createdAt - b.createdAt);
    result.set(
      key,
      list.map((p) => p.contextTokens),
    );
  }
  return result;
}
