import { useTranslation } from "react-i18next";
import type { ModelScoreboardRow } from "@/lib/api/reportCard";
import { failureTone, TONE_TEXT } from "./reliability";

/**
 * 可靠性分布：每个模型一条横向双色条，左边失败、右边中断。
 *
 * 这样做的理由很简单——表格里 9 列数字要一行行比，条子一眼就能看出
 * 「谁明显更长」。条长按当前窗口内的最大值归一，即使全员都很稳也能看出差异；
 * 刻度线标出「注意」阈值，让人知道多长算高。
 */
export function ReliabilityChart({
  rows,
  maxRate,
}: {
  rows: ModelScoreboardRow[];
  /** 归一化上限（三个比率里的最大值，已经取过整） */
  maxRate: number;
}) {
  const { t } = useTranslation();
  const scored = rows.filter((row) => row.sufficient);
  if (scored.length === 0) return null;

  const scale = (rate: number) => {
    const ratio = scaleOnly(rate, maxRate);
    return `${Math.max(ratio * 100, 0.5)}%`;
  };

  return (
    <figure className="space-y-2.5">
      <figcaption className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-section text-fg-1">
          {t("reportCard.chart.title")}
        </span>
        <span className="flex items-center gap-3 text-badge text-fg-3">
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-chart-1" />
            {t("reportCard.columns.failureRate")}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-chart-2" />
            {t("reportCard.columns.interruptRate")}
          </span>
        </span>
      </figcaption>

      <ul className="space-y-2">
        {scored.map((row) => {
          const failure = row.toolFailureRate ?? 0;
          const interruption = row.interruptionRate ?? 0;
          return (
            <li
              key={`${row.providerId}:${row.model}`}
              className="grid grid-cols-[minmax(0,150px)_minmax(0,1fr)_60px] items-center gap-3"
            >
              <span
                className="truncate text-body text-fg-1"
                title={`${row.model} · ${row.providerId}`}
              >
                {row.model || t("reportCard.unlabeledModel")}
              </span>
              <span
                className="flex h-2.5 overflow-hidden rounded-full bg-subtle"
                role="img"
                aria-label={t("reportCard.chart.aria", {
                  model: row.model || t("reportCard.unlabeledModel"),
                  failure: percent(failure),
                  interruption: percent(interruption),
                })}
              >
                <span
                  className="h-full bg-chart-1"
                  style={{ width: scale(failure) }}
                />
                <span
                  className="h-full bg-chart-2"
                  style={{ width: scale(interruption) }}
                />
              </span>
              <span
                className={`text-end text-body tabular-nums ${TONE_TEXT[failureTone(failure)]}`}
              >
                {percent(failure)}
              </span>
            </li>
          );
        })}
      </ul>

      <p className="text-badge text-fg-3">
        {t("reportCard.chart.scale", { max: percent(maxRate) })}
      </p>
    </figure>
  );
}

/** 相邻两条之间的失败率色带：给「谁明显更长」一个颜色上的答案。 */
export function ReliabilityLegend() {
  const { t } = useTranslation();
  const items: { tone: ReturnType<typeof failureTone>; label: string }[] = [
    { tone: "calm", label: t("reportCard.legend.calm") },
    { tone: "watch", label: t("reportCard.legend.watch") },
    { tone: "bad", label: t("reportCard.legend.bad") },
  ];
  return (
    <span className="flex items-center gap-3 text-badge text-fg-3">
      {items.map((item) => (
        <span key={item.label} className="flex items-center gap-1.5">
          <span
            className={`h-2 w-2 rounded-sm ${TONE_TEXT[item.tone].replace("text-", "bg-")}`}
          />
          {item.label}
        </span>
      ))}
    </span>
  );
}

/** 归一化：把任意比率换算成条长比例，上限至少 1%，避免全员极稳时条子被放大成误导。 */
export function scaleOnly(rate: number, maxRate: number): number {
  const base = Math.max(maxRate, 0.01);
  return Math.min(1, Math.max(0, rate / base));
}

/**
 * 归一化上限：所有可见比率的整倍数，取 1% / 2% / 5% / 10% … 这种不用心算的数。
 * 只用中断率时同一条上的比例仍然统一，不会出现「两个条子不可比」。
 */
export function scaleCeiling(rates: number[]): number {
  const peak = Math.max(...rates.filter((rate) => Number.isFinite(rate)), 0);
  if (peak <= 0.01) return 0.01;
  const steps = [
    0.01, 0.02, 0.03, 0.05, 0.075, 0.1, 0.15, 0.2, 0.3, 0.5, 0.75, 1,
  ];
  return steps.find((step) => peak <= step) ?? 1;
}

function percent(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

/** 中断率单独取色，导出给表格复用。 */
