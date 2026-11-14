import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { fmtInt } from "@/components/usage/format";
import type { ModelScoreboardRow } from "@/lib/api/reportCard";
import {
  compositionRows,
  compositionTotals,
  formatPercent,
  segmentPercent,
} from "./chartData";

interface ReliabilityChartProps {
  rows: ModelScoreboardRow[];
  locale: string;
}

/**
 * 成绩单的图：每个模型的工具调用构成（成功 / 失败 / 中断）。
 *
 * 为什么画构成而不画「失败率折线」：
 * - 数据是每个模型一段时间的汇总，没有可靠的逐日序列，画时间轴等于编曲线；
 * - 构成条同时带着样本量——332 次里 12% 和 5 次里 20% 长得不一样，不会被误读；
 * - 失败率本身已经出现在右侧和表格里，图负责的是「谁在翻车、翻得多不多」。
 *
 * 样本不足的行不画百分比，只写「样本不足」，与表格口径一致。
 */
export function ReliabilityChart({ rows, locale }: ReliabilityChartProps) {
  const { t } = useTranslation();
  const chart = useMemo(() => compositionRows(rows), [rows]);
  const totals = useMemo(() => compositionTotals(rows), [rows]);
  const omitted = rows.length - chart.length;

  const legend = [
    {
      key: "ok",
      label: t("reportCard.chart.ok"),
      value: totals.ok,
      dot: "bg-chart-1",
    },
    {
      key: "failed",
      label: t("reportCard.chart.failed"),
      value: totals.failed,
      dot: "bg-danger",
    },
    {
      key: "interrupted",
      label: t("reportCard.chart.interrupted"),
      value: totals.interrupted,
      dot: "bg-warning",
    },
  ];

  return (
    <section
      aria-labelledby="report-card-chart-title"
      className="rounded-panel border border-border bg-surface px-4 py-3"
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <h2
          id="report-card-chart-title"
          className="m-0 whitespace-nowrap text-caption font-semibold text-fg-2"
        >
          {t("reportCard.chart.title")}
        </h2>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          {legend.map((item) => (
            <span
              key={item.key}
              className="inline-flex items-center gap-1.5 whitespace-nowrap text-caption text-fg-2"
            >
              <span
                aria-hidden="true"
                className={`h-2 w-2 rounded-[2px] ${item.dot}`}
              />
              {item.label}
              <span className="tabular-nums text-fg-3">
                {fmtInt(item.value, locale)}
              </span>
            </span>
          ))}
        </div>
      </div>

      {chart.length === 0 ? (
        <p className="mt-3 text-caption text-fg-3">
          {t("reportCard.chart.empty")}
        </p>
      ) : (
        <>
          <div
            aria-hidden="true"
            className="mt-3 grid grid-cols-[minmax(0,1fr)_64px_84px] items-end gap-3 border-b border-border pb-1 text-caption text-fg-3"
          >
            <span>{t("reportCard.columns.model")}</span>
            <span className="text-end">{t("reportCard.chart.calls")}</span>
            <span className="text-end">
              {t("reportCard.columns.failureRate")}
            </span>
          </div>
          <ul className="m-0 list-none p-0">
            {chart.map((row) => (
              <li
                key={row.key}
                className="grid grid-cols-[minmax(0,1fr)_64px_84px] items-center gap-3 py-2"
              >
                <div className="min-w-0">
                  <div className="flex min-w-0 items-baseline gap-2">
                    <span className="truncate text-body">
                      {row.model || t("reportCard.unlabeledModel")}
                    </span>
                    <span className="shrink-0 text-caption text-fg-3">
                      {row.providerId}
                    </span>
                  </div>
                  <div
                    aria-hidden="true"
                    className="mt-1 flex h-2 w-full overflow-hidden rounded-full bg-subtle"
                  >
                    <span
                      className="h-full bg-chart-1"
                      style={{ width: `${segmentPercent(row.ok, row.calls)}%` }}
                    />
                    <span
                      className="h-full bg-danger"
                      style={{
                        width: `${segmentPercent(row.failed, row.calls)}%`,
                      }}
                    />
                    <span
                      className="h-full bg-warning"
                      style={{
                        width: `${segmentPercent(row.interrupted, row.calls)}%`,
                      }}
                    />
                  </div>
                </div>
                <span className="text-end text-caption tabular-nums text-fg-2">
                  {fmtInt(row.calls, locale)}
                </span>
                <span className="text-end text-caption tabular-nums">
                  {row.sufficient
                    ? formatPercent(row.failureRate)
                    : t("reportCard.chart.tooFewSamples")}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      {/* 一条都没有样本时上面那句已经说明白了，不再重复一遍「另有 N 个」 */}
      {omitted > 0 && chart.length > 0 && (
        <p className="mt-2 text-caption text-fg-3">
          {t("reportCard.chart.omitted", { count: omitted })}
        </p>
      )}
    </section>
  );
}
