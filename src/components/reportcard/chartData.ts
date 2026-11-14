import type { ModelScoreboardRow } from "@/lib/api/reportCard";

/**
 * 图表用的行：只保留真的有工具调用样本的模型。
 *
 * 成绩单里一大半模型往往一次工具调用都没有（纯问答、或会话根本没跑起来），
 * 把它们画进条形图只会得到一排空条，所以图里只画有样本的，
 * 其余的在下方表格里照样列着，不藏。
 */
export interface CompositionRow {
  key: string;
  /** 可能是空串（会话没记模型），渲染时回落到「未标注模型」 */
  model: string;
  providerId: string;
  calls: number;
  ok: number;
  failed: number;
  interrupted: number;
  failureRate: number | null;
  sufficient: boolean;
  sampleSize: number;
}

/** 失败多的排前面，同失败数按调用量排：一眼先看到翻车最多的那个 */
export function compositionRows(rows: ModelScoreboardRow[]): CompositionRow[] {
  return rows
    .filter((row) => row.toolCalls > 0)
    .map((row) => ({
      key: `${row.providerId}:${row.model}`,
      model: row.model,
      providerId: row.providerId,
      calls: row.toolCalls,
      ok: Math.max(0, row.toolCalls - row.toolFailures - row.interruptions),
      failed: row.toolFailures,
      interrupted: row.interruptions,
      failureRate: row.toolFailureRate,
      sufficient: row.sufficient,
      sampleSize: row.sampleSize,
    }))
    .sort((a, b) => {
      if (b.failed !== a.failed) return b.failed - a.failed;
      if (b.calls !== a.calls) return b.calls - a.calls;
      return a.model.localeCompare(b.model);
    });
}

export interface CompositionTotals {
  ok: number;
  failed: number;
  interrupted: number;
  calls: number;
}

/** 图例上的总数：加起来要等于「工具调用」列的总和，否则图例就是错的 */
export function compositionTotals(
  rows: ModelScoreboardRow[],
): CompositionTotals {
  return rows.reduce<CompositionTotals>(
    (sum, row) => ({
      ok:
        sum.ok +
        Math.max(0, row.toolCalls - row.toolFailures - row.interruptions),
      failed: sum.failed + row.toolFailures,
      interrupted: sum.interrupted + row.interruptions,
      calls: sum.calls + row.toolCalls,
    }),
    { ok: 0, failed: 0, interrupted: 0, calls: 0 },
  );
}

/** 一段占整条的比例（0–100），供条形宽度用 */
export function segmentPercent(part: number, total: number): number {
  if (total <= 0 || part <= 0) return 0;
  return Math.min(100, (part / total) * 100);
}

export function formatPercent(rate: number | null): string {
  if (rate == null) return "—";
  return `${(rate * 100).toFixed(1)}%`;
}
