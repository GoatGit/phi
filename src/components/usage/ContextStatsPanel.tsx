import { useMemo } from "react";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { sessionStatsApi } from "@/lib/api/sessionStats";
import {
  compactAdvice,
  observe,
  seriesBySession,
  tuneParamsFor,
  type CompactAdvice,
} from "@/lib/usage/contextTune";
import { AppFilterChips } from "./AppFilterChips";
import { KNOWN_APP_TYPES } from "@/types/usage";
import { Loader2 } from "lucide-react";
import { fmtInt } from "./format";

function fmtTokens(value: number): string {
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return fmtInt(value);
}

interface SessionCurve {
  key: string;
  appType: string;
  sessionId: string;
  series: number[];
  outs: number[];
  model: string;
  lastAt: number;
}

/** 上下文统计面板：压缩识别 + 增长事实 + 压缩阈值重放调优 */
export function ContextStatsPanel() {
  const { t } = useTranslation();
  const [appFilter, setAppFilter] = useState("all");
  const stats = useQuery({
    queryKey: ["session-stats", 30],
    queryFn: () => sessionStatsApi.get(30),
  });

  const model = useMemo(() => {
    const allPoints = stats.data?.contextPoints ?? [];
    const points =
      appFilter === "all"
        ? allPoints
        : allPoints.filter((p) => p.appType === appFilter);
    const allEntries = stats.data?.sessions ?? [];
    const entries =
      appFilter === "all"
        ? allEntries
        : allEntries.filter((s) => s.appType === appFilter);
    const seriesMap = seriesBySession(points);
    const sessionsById = new Map<string, (typeof entries)[number]>(
      entries.map((s) => [`${s.appType}\0${s.sessionId}`, s]),
    );

    // 会话曲线（有 ≥3 个采样点的会话）
    const curves: SessionCurve[] = [];
    for (const [key, series] of seriesMap) {
      const [appType, sessionId] = key.split("\0") as [string, string];
      const entry = sessionsById.get(key);
      if (!entry) continue;
      const ordered = [...points]
        .filter((p) => p.appType === appType && p.sessionId === sessionId)
        .sort((a, b) => a.createdAt - b.createdAt);
      curves.push({
        key,
        appType,
        sessionId,
        series,
        outs: ordered.map((p) => p.outputTokens),
        model: ordered.at(-1)?.model ?? "",
        lastAt: entry.lastAt,
      });
    }

    // 按应用聚合
    const apps = new Map<
      string,
      {
        appType: string;
        calls: number;
        sessions: number;
        compacts: number;
        growths: number[];
        peaks: number[];
        advice: CompactAdvice | null;
      }
    >();
    for (const curve of curves) {
      const facts = observe(curve.series);
      if (!facts) continue;
      const entry = apps.get(curve.appType) ?? {
        appType: curve.appType,
        calls: 0,
        sessions: 0,
        compacts: 0,
        growths: [] as number[],
        peaks: [] as number[],
        advice: null,
      };
      entry.calls += facts.calls;
      entry.sessions += 1;
      entry.compacts += facts.compacts;
      if (facts.growth > 0) entry.growths.push(facts.growth);
      if (facts.maxLevel > 0) entry.peaks.push(facts.maxLevel);
      apps.set(curve.appType, entry);
    }
    const sorted = [...apps.values()].sort((a, b) => b.calls - a.calls);
    for (const app of sorted) {
      const appSeries = curves.filter((c) => c.appType === app.appType);
      // 重放调优用聚合序列：取该应用所有会话点按时间排序的水位
      const merged: number[] = [];
      const mergedOuts: number[] = [];
      for (const curve of appSeries) {
        merged.push(...curve.series);
        mergedOuts.push(...curve.outs);
      }
      if (merged.length) {
        app.advice = compactAdvice(app.appType, merged, mergedOuts);
      }
    }

    const sessionList = [...curves]
      .sort((a, b) => Math.max(...b.series, 0) - Math.max(...a.series, 0))
      .slice(0, 8)
      .map((curve) => ({
        curve,
        entry: sessionsById.get(curve.key),
        facts: observe(curve.series),
      }));

    return { apps: sorted, sessionList };
  }, [stats.data, appFilter]);

  if (stats.isPending) {
    return (
      <div className="flex h-40 items-center justify-center" role="status">
        <Loader2 className="h-6 w-6 animate-spin text-fg-3" />
      </div>
    );
  }
  if (stats.isError) {
    return <p className="text-sm text-destructive">{String(stats.error)}</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <AppFilterChips
          aria-label={t("usage.appFilter.label")}
          appTypes={KNOWN_APP_TYPES}
          value={appFilter}
          onChange={setAppFilter}
        />
        <p className="text-xs text-fg-3">{t("contextStats.source")}</p>
      </div>

      {!model.apps.length && (
        <p className="text-sm text-fg-3">{t("contextStats.empty")}</p>
      )}

      {model.apps.map((app) => {
        const advice = app.advice;
        const growthMedian =
          app.growths.length > 0
            ? [...app.growths].sort((a, b) => a - b)[app.growths.length >> 1]
            : 0;
        return (
          <div key={app.appType} className="rounded-lg border p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="font-medium">{app.appType}</h3>
                <p className="text-xs text-fg-3">
                  {t("contextStats.appMeta", {
                    calls: fmtInt(app.calls),
                    sessions: app.sessions,
                  })}
                </p>
              </div>
              {app.compacts > 0 && (
                <span className="rounded-full bg-subtle px-2 py-0.5 text-xs text-fg-2">
                  {t("contextStats.compacts", { count: app.compacts })}
                </span>
              )}
            </div>

            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div>
                <p className="text-xs text-fg-3">{t("contextStats.calls")}</p>
                <p className="text-lg font-medium tabular-nums">
                  {fmtInt(app.calls)}
                </p>
              </div>
              <div>
                <p className="text-xs text-fg-3">{t("contextStats.growth")}</p>
                <p className="text-lg font-medium tabular-nums">
                  {fmtTokens(growthMedian)}
                </p>
              </div>
              <div>
                <p className="text-xs text-fg-3">
                  {t("contextStats.peakMedian")}
                </p>
                <p className="text-lg font-medium tabular-nums">
                  {app.peaks.length
                    ? fmtTokens(
                        [...app.peaks].sort((a, b) => a - b)[
                          app.peaks.length >> 1
                        ],
                      )
                    : "—"}
                </p>
              </div>
              <div>
                <p className="text-xs text-fg-3">
                  {t("contextStats.sessionsUnit")}
                </p>
                <p className="text-lg font-medium tabular-nums">
                  {app.sessions}
                </p>
              </div>
            </div>

            {advice && (
              <div className="mt-3 rounded-md border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h4 className="text-sm font-medium">
                    {t("contextStats.tune.title")}
                  </h4>
                  {advice.best !== advice.current ? (
                    <span className="rounded-full bg-subtle px-2 py-0.5 text-xs text-fg-2">
                      {t("contextStats.tune.save", {
                        percent: Math.round(
                          (1 - advice.cost / Math.max(advice.currentCost, 1)) *
                            100,
                        ),
                      })}
                    </span>
                  ) : (
                    <span className="rounded-full bg-subtle px-2 py-0.5 text-xs text-fg-3">
                      {t("contextStats.tune.optimal")}
                    </span>
                  )}
                </div>
                <p className="mt-2 text-sm">
                  {advice.current} →{" "}
                  <span className="font-medium text-action">{advice.best}</span>
                </p>
                <p className="mt-1 text-xs text-fg-3">
                  {t("contextStats.tune.facts", {
                    calls: fmtInt(advice.facts.calls),
                    compacts: advice.facts.compacts,
                    peak: fmtTokens(advice.facts.peak),
                    after: fmtTokens(advice.facts.after),
                    growth: fmtTokens(advice.facts.growth),
                    rework: fmtTokens(advice.facts.rework),
                  })}
                </p>
                <div className="mt-2 h-24">
                  <TuneCurveChart advice={advice} />
                </div>
              </div>
            )}
          </div>
        );
      })}

      <div className="rounded-lg border p-4">
        <h3 className="font-medium">{t("contextStats.sessions")}</h3>
        <ol className="mt-3 flex flex-col divide-y">
          {model.sessionList.map(({ curve, entry, facts }) => {
            const window =
              tuneParamsFor(curve.appType, Math.max(...curve.series, 0))
                ?.window ?? 200_000;
            const peak = Math.max(...curve.series, 0);
            return (
              <li
                key={curve.key}
                className="flex items-center gap-3 py-2 text-sm"
              >
                <svg
                  viewBox={`0 0 100 28`}
                  className="h-7 w-24 shrink-0"
                  preserveAspectRatio="none"
                  aria-hidden
                >
                  <polyline
                    fill="none"
                    stroke="var(--action-bg)"
                    strokeWidth="2"
                    points={curve.series
                      .map(
                        (level, index) =>
                          `${(index / Math.max(1, curve.series.length - 1)) * 100},${
                            26 - (level / Math.max(peak, 1)) * 24
                          }`,
                      )
                      .join(" ")}
                  />
                </svg>
                <span className="min-w-0 flex-1">
                  <span className="block truncate">
                    {entry
                      ? entry.sessionId.slice(-8)
                      : curve.sessionId.slice(-8)}
                  </span>
                  <span className="block truncate text-xs text-fg-3">
                    {curve.appType} · {curve.model} ·{" "}
                    {t("contextStats.peakFill", {
                      percent: Math.round((peak / window) * 100),
                    })}
                  </span>
                </span>
                <span className="shrink-0 text-xs text-fg-3">
                  {facts?.compacts
                    ? t("contextStats.compacts", { count: facts.compacts })
                    : "—"}
                </span>
                <span className="w-16 shrink-0 text-end tabular-nums text-fg-2">
                  {fmtTokens(peak)}
                </span>
              </li>
            );
          })}
          {!model.sessionList.length && (
            <li className="py-2 text-sm text-fg-3">
              {t("contextStats.empty")}
            </li>
          )}
        </ol>
      </div>
    </div>
  );
}

function replayCostAt(advice: CompactAdvice, threshold: number): number {
  return (
    advice.curve.find((p) => p.threshold === threshold)?.cost ??
    advice.currentCost
  );
}

function TuneCurveChart({ advice }: { advice: CompactAdvice }) {
  const max = Math.max(...advice.curve.map((p) => p.cost), 1);
  const min = Math.min(...advice.curve.map((p) => p.cost), 0);
  const range = Math.max(1, max - min);
  const toX = (threshold: number): number =>
    ((threshold - advice.curve[0].threshold) /
      Math.max(
        1,
        advice.curve[advice.curve.length - 1].threshold -
          advice.curve[0].threshold,
      )) *
    100;
  const toY = (cost: number): number => 26 - ((cost - min) / range) * 24;
  const points = advice.curve
    .map((p) => `${toX(p.threshold)},${toY(p.cost)}`)
    .join(" ");
  const bestX = toX(advice.best);
  return (
    <svg
      viewBox="0 0 100 28"
      className="h-full w-full"
      preserveAspectRatio="none"
      aria-hidden
    >
      <line
        x1={toX(advice.current)}
        y1="0"
        x2={toX(advice.current)}
        y2="28"
        stroke="var(--border-strong)"
        strokeWidth="0.5"
        strokeDasharray="2 2"
      />
      <polyline
        fill="none"
        stroke="var(--action-bg)"
        strokeWidth="1.5"
        points={points}
      />
      <circle
        cx={bestX}
        cy={toY(replayCostAt(advice, advice.best))}
        r="1.8"
        fill="var(--action-bg)"
      />
      <text
        x={bestX}
        y="6"
        fontSize="4"
        textAnchor="middle"
        fill="var(--text-2)"
      >
        {fmtInt(advice.best)}
      </text>
    </svg>
  );
}
