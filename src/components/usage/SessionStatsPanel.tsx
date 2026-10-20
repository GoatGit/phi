import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { sessionStatsApi } from "@/lib/api/sessionStats";
import { KNOWN_APP_TYPES } from "@/types/usage";
import { AppFilterChips } from "./AppFilterChips";
import { sessionsApi } from "@/lib/api/sessions";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Loader2 } from "lucide-react";
import { fmtInt, fmtUsd } from "./format";

type TrendMetric =
  | "tokens"
  | "output"
  | "sessions"
  | "cost"
  | "active"
  | "requests";

const REQUEST_BUCKETS = [1, 6, 16, 31, 61, 121];

function humanDuration(
  seconds: number,
  t: { (key: string, options?: Record<string, unknown>): string },
): string {
  if (seconds <= 0) return "0";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  if (hours <= 0) return t("sessionStats.minutesShort", { count: minutes });
  return t("sessionStats.hoursShort", { hours, minutes });
}

function fmtTokens(value: number): string {
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return fmtInt(value);
}

function projectBasename(projectDir?: string): string | null {
  if (!projectDir) return null;
  const trimmed = projectDir.replace(/\/+$/, "");
  const name = trimmed.split(/[\\/]/).pop();
  return name || trimmed;
}

/** 会话统计面板：汇总卡片 + 每日趋势 + 星期×小时热力图 + Top 会话 + 形态分桶 + 项目排行 */
export function SessionStatsPanel() {
  const { t } = useTranslation();
  const [days, setDays] = useState(30);
  const [metric, setMetric] = useState<TrendMetric>("tokens");
  const [appFilter, setAppFilter] = useState("all");

  const stats = useQuery({
    queryKey: ["session-stats", days],
    queryFn: () => sessionStatsApi.get(days),
  });
  // 项目维度：用量库没有 cwd，用会话管理器的 projectDir 前端联表
  const sessionList = useQuery({
    queryKey: ["sessions"],
    queryFn: () => sessionsApi.list(),
    staleTime: 60_000,
  });

  const projectMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const session of sessionList.data ?? []) {
      const name = projectBasename(session.projectDir ?? undefined);
      if (name) map.set(`${session.providerId}\0${session.sessionId}`, name);
    }
    return map;
  }, [sessionList.data]);

  // 按应用过滤后的视图（all 时原样透传）
  const filtered = useMemo(() => {
    const data = stats.data;
    if (!data) return undefined;
    if (appFilter === "all") return data;
    return {
      ...data,
      sessions: data.sessions.filter((s) => s.appType === appFilter),
      days: data.days.filter((d) => d.appType === appFilter),
      hours: data.hours.filter((h) => h.appType === appFilter),
      contextPoints: data.contextPoints.filter((p) => p.appType === appFilter),
    };
  }, [stats.data, appFilter]);

  const model = useMemo(() => {
    const sessions = filtered?.sessions ?? [];
    const totals = sessions.reduce(
      (acc, s) => {
        acc.input += s.inputTokens;
        acc.output += s.outputTokens;
        acc.cacheRead += s.cacheReadTokens;
        acc.cacheCreation += s.cacheCreationTokens;
        acc.cost += s.costUsd;
        acc.active += s.activeSeconds;
        acc.requests += s.requests;
        return acc;
      },
      {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheCreation: 0,
        cost: 0,
        active: 0,
        requests: 0,
      },
    );
    const spentPerSession = sessions
      .map((s) => s.inputTokens + s.outputTokens)
      .sort((a, b) => a - b);
    const rank = (p: number): number =>
      spentPerSession.length
        ? spentPerSession[
            Math.min(
              spentPerSession.length,
              Math.ceil(p * spentPerSession.length),
            ) - 1
          ]
        : 0;
    const projects = new Map<string, { tokens: number; cost: number }>();
    for (const s of sessions) {
      const name =
        projectMap.get(`${s.appType}\0${s.sessionId}`) ??
        t("sessionStats.unknownProject");
      const entry = projects.get(name) ?? { tokens: 0, cost: 0 };
      entry.tokens += s.inputTokens + s.outputTokens;
      entry.cost += s.costUsd;
      projects.set(name, entry);
    }
    const projectRanking = [...projects.entries()].sort(
      (a, b) => b[1].tokens - a[1].tokens,
    );
    const topSessions = [...sessions]
      .sort(
        (a, b) =>
          b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens),
      )
      .slice(0, 8);
    const buckets = new Array(REQUEST_BUCKETS.length + 1).fill(0) as number[];
    for (const s of sessions) {
      let edgeIndex = -1;
      for (let i = REQUEST_BUCKETS.length - 1; i >= 0; i -= 1) {
        if (s.requests >= REQUEST_BUCKETS[i]) {
          edgeIndex = i;
          break;
        }
      }
      buckets[edgeIndex + 1] += 1;
    }
    const promptTotal = totals.input + totals.cacheRead + totals.cacheCreation;
    return {
      totals,
      count: sessions.length,
      median: rank(0.5),
      p90: rank(0.9),
      cacheHitRate: promptTotal > 0 ? totals.cacheRead / promptTotal : 0,
      projectRanking,
      topSessions,
      buckets,
    };
  }, [filtered, projectMap, t]);

  const trend = useMemo(() => {
    const dayData = filtered?.days ?? [];
    const sessionsByDay = new Map(dayData.map((d) => [d.date, d]));
    const start = new Date();
    start.setDate(start.getDate() - Math.max(days - 1, 0));
    const list: Record<string, number | string>[] = [];
    for (let i = 0; i < days; i += 1) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const day = sessionsByDay.get(date);
      list.push({
        date,
        label: date.slice(5),
        tokens: (day?.inputTokens ?? 0) + (day?.outputTokens ?? 0),
        output: day?.outputTokens ?? 0,
        sessions: day?.sessions ?? 0,
        cost: day?.costUsd ?? 0,
        active: day?.activeSeconds ?? 0,
        requests: day?.requests ?? 0,
      });
    }
    return list;
  }, [filtered, days]);

  const busiest = useMemo(() => {
    const grid = new Map<string, number>();
    for (const h of filtered?.hours ?? []) {
      grid.set(`${h.weekday}-${h.hour}`, h.seconds);
    }
    let best: { key: string; value: number } | null = null;
    for (const [key, value] of grid) {
      if (!best || value > best.value) best = { key, value };
    }
    return { grid, best };
  }, [filtered]);

  const card = (
    label: string,
    value: React.ReactNode,
    hint?: React.ReactNode,
  ) => (
    <div className="min-w-0 rounded-lg border p-3">
      <p className="text-xs text-fg-3">{label}</p>
      <p className="mt-1 text-xl font-medium tabular-nums">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-fg-3">{hint}</p>}
    </div>
  );

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

  const weekdayLabel = (weekday: number): string =>
    t(`sessionStats.weekday.${weekday}`);

  return (
    <div className="flex flex-col gap-4">
      <AppFilterChips
        aria-label={t("usage.appFilter.label")}
        appTypes={KNOWN_APP_TYPES}
        value={appFilter}
        onChange={setAppFilter}
        className="self-start"
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SegmentedControl
          size="sm"
          aria-label={t("sessionStats.range")}
          value={String(days)}
          onValueChange={(value) => setDays(Number(value))}
          items={[
            { value: "1", label: t("sessionStats.today") },
            { value: "7", label: t("sessionStats.days7") },
            { value: "30", label: t("sessionStats.days30") },
            { value: "0", label: t("sessionStats.all") },
          ]}
        />
        <p className="text-xs text-fg-3">{t("sessionStats.source")}</p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {card(
          t("sessionStats.sessions"),
          fmtInt(model.count),
          t("sessionStats.medianP90", {
            median: fmtTokens(model.median),
            p90: fmtTokens(model.p90),
          }),
        )}
        {card(
          t("sessionStats.tokens"),
          fmtTokens(model.totals.input + model.totals.output),
          t("sessionStats.inOut", {
            input: fmtTokens(model.totals.input),
            output: fmtTokens(model.totals.output),
          }),
        )}
        {card(t("sessionStats.cost"), fmtUsd(model.totals.cost, 2))}
        {card(
          t("sessionStats.cacheRead"),
          fmtTokens(model.totals.cacheRead),
          t("sessionStats.hitRate", {
            rate: `${Math.round(model.cacheHitRate * 100)}%`,
          }),
        )}
        {card(
          t("sessionStats.active"),
          humanDuration(model.totals.active, t),
          `${fmtInt(model.totals.requests)} ${t("sessionStats.requestsUnit")}`,
        )}
        {card(
          t("sessionStats.projects"),
          fmtInt(model.projectRanking.length),
          model.projectRanking[0]
            ? t("sessionStats.topShare", {
                name: model.projectRanking[0][0],
                share: `${Math.round(
                  (model.projectRanking[0][1].tokens /
                    Math.max(1, model.totals.input + model.totals.output)) *
                    100,
                )}%`,
              })
            : undefined,
        )}
      </div>

      <div className="rounded-lg border p-4">
        <div className="flex items-center justify-between gap-3">
          <h3 className="font-medium">{t("sessionStats.trend")}</h3>
          <SegmentedControl
            size="sm"
            aria-label={t("sessionStats.metric")}
            value={metric}
            onValueChange={(value) => setMetric(value as TrendMetric)}
            items={[
              { value: "tokens", label: t("sessionStats.metricTokens") },
              { value: "output", label: t("sessionStats.metricOutput") },
              { value: "sessions", label: t("sessionStats.metricSessions") },
              { value: "cost", label: t("sessionStats.metricCost") },
              { value: "active", label: t("sessionStats.metricActive") },
            ]}
          />
        </div>
        <div className="mt-3 h-56">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={trend}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 11 }}
                interval="preserveStartEnd"
              />
              <YAxis tick={{ fontSize: 11 }} width={48} />
              <Tooltip
                formatter={(value) =>
                  metric === "cost" ? fmtUsd(Number(value), 4) : fmtInt(value)
                }
              />
              <Bar
                dataKey={metric}
                fill="var(--action-bg)"
                radius={[3, 3, 0, 0]}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="min-w-0 rounded-lg border p-4">
          <h3 className="font-medium">{t("sessionStats.byHour")}</h3>
          <div className="mt-3 flex flex-col gap-1">
            <div className="grid grid-cols-[auto_repeat(24,minmax(0,1fr))] gap-px text-badge">
              {[0, 1, 2, 3, 4, 5, 6].map((weekday) => (
                <div key={weekday} className="contents">
                  <span className="pe-1 text-fg-3 whitespace-nowrap">
                    {weekdayLabel(weekday)}
                  </span>
                  {Array.from({ length: 24 }, (_, hour) => {
                    const seconds = busiest.grid.get(`${weekday}-${hour}`) ?? 0;
                    const max = busiest.best?.value ?? 0;
                    const level =
                      max > 0 && seconds > 0
                        ? Math.min(4, Math.ceil((seconds / max) * 4))
                        : 0;
                    return (
                      <span
                        key={hour}
                        title={`${weekdayLabel(weekday)} ${hour}:00 · ${humanDuration(seconds, t)}`}
                        className="aspect-square rounded-[2px]"
                        style={{
                          backgroundColor:
                            level === 0
                              ? "var(--bg-subtle)"
                              : `color-mix(in srgb, var(--action-bg) ${level * 20}%, var(--bg-subtle))`,
                        }}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
            {busiest.best && (
              <p className="text-xs text-fg-3">
                {t("sessionStats.busiest", {
                  weekday: weekdayLabel(Number(busiest.best.key.split("-")[0])),
                  hour: busiest.best.key.split("-")[1],
                })}
              </p>
            )}
          </div>
        </div>

        <div className="min-w-0 rounded-lg border p-4">
          <h3 className="font-medium">{t("sessionStats.topSessions")}</h3>
          <ol className="mt-3 flex flex-col divide-y">
            {model.topSessions.map((session) => {
              const name =
                projectMap.get(`${session.appType}\0${session.sessionId}`) ??
                session.sessionId.slice(-8);
              return (
                <li
                  key={`${session.appType}-${session.sessionId}`}
                  className="flex items-center justify-between gap-2 py-2 text-sm"
                >
                  <span className="min-w-0">
                    <span className="block truncate">{name}</span>
                    <span className="block truncate text-xs text-fg-3">
                      {session.appType} · {fmtInt(session.requests)}{" "}
                      {t("sessionStats.requestsUnit")}
                    </span>
                  </span>
                  <span className="shrink-0 tabular-nums text-fg-2">
                    {fmtTokens(session.inputTokens + session.outputTokens)}
                  </span>
                </li>
              );
            })}
            {!model.topSessions.length && (
              <li className="py-2 text-sm text-fg-3">
                {t("sessionStats.empty")}
              </li>
            )}
          </ol>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="min-w-0 rounded-lg border p-4">
          <h3 className="font-medium">{t("sessionStats.shape")}</h3>
          <p className="mt-0.5 text-xs text-fg-3">
            {t("sessionStats.shapeHint")}
          </p>
          <div className="mt-3 flex h-40 items-end gap-2">
            {model.buckets.map((count, index) => {
              const max = Math.max(...model.buckets, 1);
              return (
                <div
                  key={index}
                  className="flex min-w-0 flex-1 flex-col items-center gap-1"
                >
                  <span className="text-xs tabular-nums text-fg-2">
                    {count}
                  </span>
                  <div
                    className="w-full rounded-t"
                    style={{
                      height: `${Math.max(count > 0 ? 8 : 2, (count / max) * 100)}%`,
                      backgroundColor: "var(--action-bg)",
                      opacity: count > 0 ? 1 : 0.3,
                    }}
                  />
                  <span className="text-badge text-fg-3">
                    {index === 0
                      ? `≤${REQUEST_BUCKETS[0]}`
                      : index === REQUEST_BUCKETS.length
                        ? `${REQUEST_BUCKETS[REQUEST_BUCKETS.length - 1]}+`
                        : `${REQUEST_BUCKETS[index - 1]}–${REQUEST_BUCKETS[index] - 1}`}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        <div className="min-w-0 rounded-lg border p-4">
          <h3 className="font-medium">{t("sessionStats.projects")}</h3>
          <ol className="mt-3 flex flex-col gap-2">
            {model.projectRanking.slice(0, 6).map(([name, entry]) => {
              const max = model.projectRanking[0][1].tokens || 1;
              return (
                <li key={name} className="flex items-center gap-2 text-sm">
                  <span className="w-28 min-w-0 truncate" title={name}>
                    {name}
                  </span>
                  <span className="h-1.5 min-w-0 flex-1 rounded-full bg-subtle">
                    <span
                      className="block h-full rounded-full bg-action"
                      style={{ width: `${(entry.tokens / max) * 100}%` }}
                    />
                  </span>
                  <span className="shrink-0 tabular-nums text-xs text-fg-2">
                    {fmtTokens(entry.tokens)} · {fmtUsd(entry.cost, 2)}
                  </span>
                </li>
              );
            })}
            {!model.projectRanking.length && (
              <li className="text-sm text-fg-3">{t("sessionStats.empty")}</li>
            )}
          </ol>
        </div>
      </div>
    </div>
  );
}
