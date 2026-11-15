import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { getAppDisplayName } from "@/components/shell/AppGlyph";
import {
  gatewayApi,
  groupModelAlias,
  type GatewayRouteGroup,
} from "@/lib/api/gateway";
import type {
  RouterSettings,
  RouterStatus,
  RouterTickReport,
} from "@/lib/api/superAgent";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

interface AutoRouterPanelProps {
  status: RouterStatus | null;
  /** 看板上实际存在的列，用作触发列的可选项 */
  statuses: string[];
  /** 这台机器能开终端会话的应用；空数组表示当前平台不支持 */
  terminalApps: string[];
  /** 读取状态失败时的原因；面板不能停在「正在读取」上让人干等 */
  error?: string | null;
  onSave: (next: RouterSettings) => Promise<void>;
  onRunNow: () => Promise<RouterTickReport>;
}

/** 「按规则」在下拉里的占位值。空字符串是 Radix Select 不接受的选项值。 */
const RULE_ONLY = "__rules__";

function skippedText(t: (key: string) => string, code: string): string {
  switch (code) {
    case "disabled":
      return t("tasks.router.skipped.disabled");
    case "no-tasks":
      return t("tasks.router.skipped.noTasks");
    case "no-candidates":
      return t("tasks.router.skipped.noCandidates");
    case "dispatch-quota-used":
      return t("tasks.router.skipped.quota");
    case "concurrency-full":
      return t("tasks.router.skipped.concurrency");
    default:
      return t("tasks.router.skipped.capacity");
  }
}

/**
 * 自动调度的开关面板。
 *
 * 只在看板头部留一个按钮：看板本身要干净，设置在用到它的地方，不另开一页。
 * 这里的每一项都是「机器要知道的规则」，不是「人每次都要填的字段」——
 * 改一次，之后每 30 秒按它跑。
 */
export function AutoRouterPanel({
  status,
  statuses,
  terminalApps,
  error,
  onSave,
  onRunNow,
}: AutoRouterPanelProps) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const [lastRun, setLastRun] = useState<RouterTickReport | null>(null);
  const [open, setOpen] = useState(false);
  // `null` 表示还没读到；空数组表示读到了但一个可用的组都没有。两种情况的文案不同。
  const [groups, setGroups] = useState<GatewayRouteGroup[] | null>(null);

  // 只有真的要用模型时才需要这份列表，所以打开面板时才去读。
  useEffect(() => {
    if (!open || groups !== null) return;
    let alive = true;
    void gatewayApi
      .getCatalog()
      .then((catalog) => {
        if (!alive) return;
        // 组别名只对「包含 pi 的组」成立：网关按 app 过滤，不在这条链上的组解析不出来。
        setGroups(
          (catalog.groups ?? []).filter(
            (group) => group.enabled && group.appIds.includes("pi"),
          ),
        );
      })
      .catch(() => {
        if (alive) setGroups([]);
      });
    return () => {
      alive = false;
    };
  }, [open, groups]);

  const settings = status?.settings ?? null;
  const enabled = settings?.enabled ?? false;
  const shadow = settings?.shadow ?? true;
  // 保存过的触发列可能已经不在看板上（列被改名或删掉）。这时要把这一项照实
  // 补进下拉里：退回显示第一列会让人以为触发列已经换了，而实际派发一直不发生。
  const columnOptions =
    settings && !statuses.includes(settings.triggerStatus)
      ? [...statuses, settings.triggerStatus]
      : statuses;
  const modeLabel = !enabled
    ? t("tasks.router.modeOff")
    : shadow
      ? t("tasks.router.modeShadow")
      : t("tasks.router.modeOn");

  const patch = async (change: Partial<RouterSettings>) => {
    if (!settings) return;
    setBusy(true);
    try {
      await onSave({ ...settings, ...change });
    } catch (error) {
      toast.error(
        t("tasks.router.saveFailed", {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      setBusy(false);
    }
  };

  const toggleWorker = (appId: string, checked: boolean) => {
    if (!settings) return;
    const next = checked
      ? [...settings.workerApps, appId]
      : settings.workerApps.filter((entry) => entry !== appId);
    // 保持与终端的应用顺序一致，第一个就是默认派发对象。
    const ordered = terminalApps.filter((entry) => next.includes(entry));
    void patch({ workerApps: ordered });
  };

  const runOnce = async () => {
    setRunning(true);
    try {
      setLastRun(await onRunNow());
    } catch (error) {
      toast.error(
        t("tasks.router.actionFailed", {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      setRunning(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t("tasks.router.button")}
          className={cn(
            "flex h-8 items-center gap-1.5 rounded-control border border-border bg-surface px-2.5 text-caption text-fg-1 transition-colors hover:bg-subtle",
            enabled &&
              !shadow &&
              "border-action/40 bg-action-soft text-action-text",
          )}
        >
          <Zap aria-hidden="true" className="h-3.5 w-3.5" strokeWidth={1.5} />
          <span>{t("tasks.router.button")}</span>
          {/* 影子模式开着时，只有「启用」是不会真的派活的。把这件事写在按钮上，
              不让人靠展开面板再琢磨一遍状态标签。 */}
          {enabled && shadow ? (
            <span className="text-warning-text">
              {t("tasks.router.modeShadow")}
            </span>
          ) : null}
          <span
            aria-hidden="true"
            className={cn(
              "size-1.5 rounded-full",
              !enabled
                ? "bg-fg-3/40"
                : shadow
                  ? "bg-warning-text"
                  : "bg-action motion-safe:animate-pulse",
            )}
          />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[320px] p-0">
        <div className="border-b border-border px-4 py-3">
          <div className="flex items-baseline justify-between gap-2">
            <h3 className="m-0 text-body font-medium text-fg-1">
              {t("tasks.router.title")}
            </h3>
            <span className="text-caption text-fg-3">{modeLabel}</span>
          </div>
          <p className="m-0 mt-1 text-caption leading-relaxed text-fg-3">
            {t("tasks.router.quota", {
              dispatches: status?.today.dispatches ?? 0,
              judge: status?.today.judgeCalls ?? 0,
            })}
          </p>
        </div>

        {!settings ? (
          <p className="m-0 px-4 py-4 text-caption leading-relaxed text-fg-3">
            {error
              ? t("tasks.router.loadFailed", { error })
              : t("tasks.router.loading")}
          </p>
        ) : (
          <div className="flex flex-col gap-3 px-4 py-3">
            <label className="flex items-start justify-between gap-3">
              <span className="min-w-0">
                <span className="block text-caption font-medium text-fg-1">
                  {t("tasks.router.enabled")}
                </span>
                <span className="mt-0.5 block text-caption leading-relaxed text-fg-3">
                  {t("tasks.router.enabledHint")}
                </span>
              </span>
              <Switch
                checked={enabled}
                disabled={busy}
                aria-label={t("tasks.router.enabled")}
                onCheckedChange={(value) => void patch({ enabled: value })}
              />
            </label>

            {enabled ? (
              <>
                <label className="flex items-start justify-between gap-3">
                  <span className="min-w-0">
                    <span className="block text-caption font-medium text-fg-1">
                      {t("tasks.router.shadow")}
                    </span>
                    <span className="mt-0.5 block text-caption leading-relaxed text-fg-3">
                      {t("tasks.router.shadowHint")}
                    </span>
                  </span>
                  <Switch
                    checked={shadow}
                    disabled={busy}
                    size="sm"
                    aria-label={t("tasks.router.shadow")}
                    onCheckedChange={(value) => void patch({ shadow: value })}
                  />
                </label>

                <div className="flex items-center justify-between gap-3">
                  <span className="text-caption text-fg-2">
                    {t("tasks.router.triggerStatus")}
                  </span>
                  <Select
                    value={settings.triggerStatus}
                    disabled={busy || columnOptions.length === 0}
                    onValueChange={(value) =>
                      void patch({ triggerStatus: value })
                    }
                  >
                    <SelectTrigger
                      className="h-7 w-[132px] text-caption"
                      aria-label={t("tasks.router.triggerStatus")}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {columnOptions.map((column) => (
                        <SelectItem key={column} value={column}>
                          {column}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex items-center justify-between gap-3">
                  <span className="text-caption text-fg-2">
                    {t("tasks.router.concurrency")}
                  </span>
                  <Select
                    value={String(settings.concurrency)}
                    disabled={busy}
                    onValueChange={(value) =>
                      void patch({ concurrency: Number(value) })
                    }
                  >
                    <SelectTrigger className="h-7 w-[132px] text-caption">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {[1, 2, 3, 4].map((count) => (
                        <SelectItem key={count} value={String(count)}>
                          {t("tasks.router.concurrencyUnit", { count })}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex flex-col gap-1.5">
                  <span className="text-caption text-fg-2">
                    {t("tasks.router.workers")}
                  </span>
                  {terminalApps.length === 0 ? (
                    <p className="m-0 text-caption leading-relaxed text-fg-3">
                      {t("tasks.router.noWorkers")}
                    </p>
                  ) : (
                    <div className="flex flex-col gap-1">
                      {terminalApps.map((appId) => {
                        const checked = settings.workerApps.includes(appId);
                        return (
                          <label
                            key={appId}
                            className="flex cursor-pointer items-center gap-2 text-caption text-fg-1"
                          >
                            <Checkbox
                              checked={checked}
                              disabled={
                                busy ||
                                (checked && settings.workerApps.length === 1)
                              }
                              onCheckedChange={(value) =>
                                toggleWorker(appId, value === true)
                              }
                            />
                            {getAppDisplayName(appId)}
                          </label>
                        );
                      })}
                    </div>
                  )}
                </div>

                <div className="flex flex-col gap-1.5">
                  <span className="text-caption text-fg-2">
                    {t("tasks.router.episodeModel")}
                  </span>
                  <Select
                    value={settings.episodeModel || RULE_ONLY}
                    disabled={busy}
                    onValueChange={(value) =>
                      void patch({
                        episodeModel: value === RULE_ONLY ? "" : value,
                      })
                    }
                  >
                    <SelectTrigger
                      className="h-7 w-full text-caption"
                      aria-label={t("tasks.router.episodeModel")}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={RULE_ONLY}>
                        {t("tasks.router.episodeModelRules")}
                      </SelectItem>
                      {(groups ?? []).map((group) => (
                        <SelectItem
                          key={group.id}
                          value={groupModelAlias(group)}
                        >
                          {group.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="m-0 text-caption leading-relaxed text-fg-3">
                    {groups !== null && groups.length === 0
                      ? t("tasks.router.episodeModelNoGroup")
                      : t("tasks.router.episodeModelHint")}
                  </p>
                </div>
              </>
            ) : null}
          </div>
        )}

        <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-2.5">
          <span className="min-w-0 truncate text-caption text-fg-3">
            {lastRun ? summarize(t, lastRun) : t("tasks.router.runNowHint")}
          </span>
          <Button
            variant="neutral"
            size="compact"
            disabled={running || !settings}
            onClick={() => void runOnce()}
          >
            {running ? (
              <Loader2
                data-icon
                className="h-3.5 w-3.5 animate-spin"
                strokeWidth={1.5}
              />
            ) : (
              <Zap data-icon className="h-3.5 w-3.5" strokeWidth={1.5} />
            )}
            {t("tasks.router.runNow")}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function summarize(
  t: (key: string, options?: Record<string, unknown>) => string,
  report: RouterTickReport,
): string {
  if (report.skipped) return skippedText(t, report.skipped);
  if (report.dispatched.length > 0) {
    return t("tasks.router.resultDispatched", {
      count: report.dispatched.length,
      tasks: report.dispatched.join("、"),
    });
  }
  if (report.needsYou.length > 0) {
    return t("tasks.router.resultNeedsYou", { count: report.needsYou.length });
  }
  return t("tasks.router.resultNone");
}
