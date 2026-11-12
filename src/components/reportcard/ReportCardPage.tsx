import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ClipboardList, RefreshCw } from "lucide-react";
import { AppPageHeader } from "@/components/shell/AppPageHeader";
import { PageHeaderBackButton } from "@/components/shell/PageHeaderBackButton";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  fmtInt,
  fmtUsd,
  getLocaleFromLanguage,
  getResolvedLang,
} from "@/components/usage/format";
import { usageTable } from "@/components/usage/usageTable";
import {
  reportCardApi,
  type ModelScoreboardRow,
  type ReportCard,
} from "@/lib/api/reportCard";
import { cn } from "@/lib/utils";
import { extractErrorMessage } from "@/utils/errorUtils";

/** 与后端 `extract::MIN_SAMPLES` 对齐：样本不够就不报百分比 */
const MIN_SAMPLES = 5;

const WINDOWS = [7, 30, 90] as const;

interface ReportCardPageProps {
  /** 从别处下钻进来时的返回入口 */
  onBack?: () => void;
}

/**
 * 侧栏一级页「成绩单」。
 *
 * 给人看的是一个模型在**这个人自己的仓库上**表现如何，而不是 benchmark 排名。
 * 只有可靠性：工具调用失败率、被中断率、空交付率、单步耗时、单任务成本。
 * 验收命令与返工观察还没接上，所以这一页明确写着「未证实」，不给质量排序。
 */
export function ReportCardPage({ onBack }: ReportCardPageProps = {}) {
  const { t, i18n } = useTranslation();
  const locale = getLocaleFromLanguage(getResolvedLang(i18n));
  const [days, setDays] = useState<number>(30);
  const [card, setCard] = useState<ReportCard | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (refresh: boolean) => {
      if (refresh) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }
      setError(null);
      try {
        setCard(await reportCardApi.page(days, refresh));
      } catch (cause) {
        setError(extractErrorMessage(cause));
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [days],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  const rows = card?.rows ?? [];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <AppPageHeader
        leading={onBack && <PageHeaderBackButton onClick={onBack} />}
        icon={
          onBack ? undefined : (
            <ClipboardList className="h-4 w-4" strokeWidth={1.75} />
          )
        }
        title={t("reportCard.title")}
        actions={
          <>
            <SegmentedControl
              size="sm"
              aria-label={t("reportCard.windowLabel")}
              value={String(days)}
              onValueChange={(value) => setDays(Number(value))}
              items={WINDOWS.map((value) => ({
                value: String(value),
                label: t("reportCard.windowDays", { days: value }),
              }))}
            />
            <Button
              type="button"
              variant="quiet"
              size="icon-compact"
              onClick={() => void load(true)}
              disabled={refreshing}
              aria-label={t("reportCard.refresh")}
            >
              <RefreshCw
                className={cn("h-4 w-4", refreshing && "animate-spin")}
                strokeWidth={1.75}
              />
            </Button>
          </>
        }
      />

      <div
        id="main-content"
        className="min-h-0 flex-1 space-y-4 overflow-y-auto scroll-stable px-6 pt-3 pb-10"
      >
        <Notice tone="warning" title={t("reportCard.unprovenTitle")}>
          {t("reportCard.unprovenBody")}
        </Notice>

        {error && (
          <Notice
            tone="danger"
            title={t("reportCard.loadFailed")}
            actions={
              <Button
                type="button"
                variant="quiet"
                size="compact"
                onClick={() => void load(true)}
              >
                {t("reportCard.retry")}
              </Button>
            }
          >
            {error}
          </Notice>
        )}

        <Summary
          card={card}
          locale={locale}
          loading={loading && !card}
          refreshing={refreshing}
        />

        {loading && !card ? (
          <div className={usageTable.skeleton} />
        ) : rows.length === 0 ? (
          <Notice tone="neutral" title={t("reportCard.emptyTitle")}>
            {t("reportCard.emptyBody")}
          </Notice>
        ) : (
          <div className={usageTable.scroller}>
            <table
              className={cn(usageTable.table, "min-w-[880px]")}
              aria-label={t("reportCard.title")}
            >
              <thead>
                <tr className={usageTable.headRow}>
                  <th className={usageTable.th}>
                    {t("reportCard.columns.model")}
                  </th>
                  <th className={usageTable.thEnd}>
                    {t("reportCard.columns.tasks")}
                  </th>
                  <th className={usageTable.thEnd}>
                    {t("reportCard.columns.calls")}
                  </th>
                  <th className={usageTable.thEnd}>
                    {t("reportCard.columns.failureRate")}
                  </th>
                  <th className={usageTable.thEnd}>
                    {t("reportCard.columns.interruptRate")}
                  </th>
                  <th className={usageTable.thEnd}>
                    {t("reportCard.columns.emptyDelivery")}
                  </th>
                  <th className={usageTable.thEnd}>
                    {t("reportCard.columns.stepDuration")}
                  </th>
                  <th className={usageTable.thEnd}>
                    {t("reportCard.columns.costPerTask")}
                  </th>
                  <th className={usageTable.thEnd}>
                    {t("reportCard.columns.lastSeen")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <ScoreboardRow
                    key={`${row.providerId}:${row.model}`}
                    row={row}
                    locale={locale}
                    now={card?.generatedAt ?? Date.now()}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="text-caption text-fg-3">{t("reportCard.footnote")}</p>
      </div>
    </div>
  );
}

function Summary({
  card,
  locale,
  loading,
  refreshing,
}: {
  card: ReportCard | null;
  locale: string;
  loading: boolean;
  refreshing: boolean;
}) {
  const { t } = useTranslation();
  if (loading) {
    return <div className={usageTable.skeleton} />;
  }

  const items = [
    {
      label: t("reportCard.summary.tasks"),
      value: fmtInt(card?.totalTasks ?? 0, locale),
    },
    {
      label: t("reportCard.summary.models"),
      value: fmtInt(card?.rows.length ?? 0, locale),
    },
    {
      label: t("reportCard.summary.projects"),
      value: fmtInt(card?.projects ?? 0, locale),
    },
    {
      label: t("reportCard.summary.sources"),
      value: fmtInt(card?.scannedSources ?? 0, locale),
    },
  ];

  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="flex flex-wrap gap-6">
        {items.map((item) => (
          <div key={item.label} className="flex flex-col gap-0.5">
            <span className="text-caption text-fg-2">{item.label}</span>
            <span className="text-title tabular-nums">{item.value}</span>
          </div>
        ))}
      </div>
      <span className="text-caption text-fg-3">
        {refreshing
          ? t("reportCard.summary.syncing")
          : card?.sync.skipped
            ? t("reportCard.summary.syncedRecently")
            : t("reportCard.summary.synced", {
                count: card?.sync.parsedSessions ?? 0,
              })}
      </span>
    </div>
  );
}

function ScoreboardRow({
  row,
  locale,
  now,
}: {
  row: ModelScoreboardRow;
  locale: string;
  now: number;
}) {
  const { t } = useTranslation();
  return (
    <tr className={usageTable.row}>
      <td className={usageTable.td}>
        <div className="flex flex-col">
          <span className="truncate">
            {row.model || t("reportCard.unlabeledModel")}
          </span>
          <span className="text-caption text-fg-3">{row.providerId}</span>
        </div>
      </td>
      <td className={usageTable.tdEnd}>{fmtInt(row.tasks, locale)}</td>
      <td className={usageTable.tdEnd}>{fmtInt(row.toolCalls, locale)}</td>
      <td className={usageTable.tdEnd}>
        {row.sufficient
          ? percent(row.toolFailureRate)
          : t("reportCard.insufficient", { samples: row.sampleSize })}
      </td>
      <td className={usageTable.tdEnd}>
        {row.sufficient
          ? percent(row.interruptionRate)
          : t("reportCard.insufficient", { samples: row.sampleSize })}
      </td>
      <td className={usageTable.tdEnd}>
        {row.deliveryTasks >= MIN_SAMPLES
          ? percent(row.emptyDeliveryRate)
          : t("reportCard.insufficient", { samples: row.deliveryTasks })}
      </td>
      <td className={usageTable.tdEnd}>
        {row.avgStepMs == null ? "—" : duration(row.avgStepMs)}
      </td>
      <td className={usageTable.tdEnd}>
        {row.costPerTask == null ? "—" : fmtUsd(row.costPerTask, 3)}
      </td>
      <td className={usageTable.tdEnd}>{recency(row.lastSeenAt, now, t)}</td>
    </tr>
  );
}

function percent(rate: number | null): string {
  if (rate == null) return "—";
  return `${(rate * 100).toFixed(1)}%`;
}

function duration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)} s`;
  return `${(ms / 60_000).toFixed(1)} min`;
}

function recency(
  at: number,
  now: number,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  if (!at) return "—";
  const days = Math.max(0, Math.floor((now - at) / 86_400_000));
  if (days === 0) return t("reportCard.today");
  return t("reportCard.daysAgo", { days });
}
