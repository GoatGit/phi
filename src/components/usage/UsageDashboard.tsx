import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/lib/toast";
import {
  ChartColumn,
  Check,
  ChevronDown,
  KeyRound,
  Loader2,
} from "lucide-react";
import { AppGlyph, APP_DISPLAY_NAME } from "@/components/shell/AppGlyph";
import { PageTabs } from "@/components/ui/page-tabs";
import { Button } from "@/components/ui/button";
import { HoverTip } from "@/components/ui/hover-tip";
import {
  SegmentThumb,
  useSlidingIndicator,
} from "@/components/ui/sliding-indicator";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  KNOWN_APP_TYPES,
  type AppType,
  type AppTypeFilter,
  type UsageRangeSelection,
} from "@/types/usage";
import { usageKeys, useModelStats, useProviderStats } from "@/lib/query/usage";
import { useUsageEventBridge } from "@/hooks/useUsageEventBridge";
import { usageApi } from "@/lib/api/usage";
import { accessApi } from "@/lib/api/access";
import { getUsageRangePresetLabel, resolveUsageRange } from "@/lib/usageRange";
import { cn } from "@/lib/utils";
import { UsageHero } from "./UsageHero";
import { UsageTrendChart } from "./UsageTrendChart";
import { RequestLogTable } from "./RequestLogTable";
import { ProviderStatsTable } from "./ProviderStatsTable";
import { ModelStatsTable } from "./ModelStatsTable";
import { PricingConfigPanel } from "./PricingConfigPanel";
import { RequestDetailPanel } from "./RequestDetailPanel";
import { UsageDateRangePicker } from "./UsageDateRangePicker";
import { UsageHeatmap } from "./UsageHeatmap";
import { fmtInt, getLocaleFromLanguage } from "./format";
import { getUsageProviderLabel, usageProviderTitle } from "./providerLabel";

interface UsageDashboardProps {
  /** 从应用页「查看此应用的用量」进入时带上的应用筛选 */
  initialAppType?: AppTypeFilter;
}

type UsageTab = "logs" | "providers" | "models" | "pricing";

/**
 * 用量范围是单选：要么全部、要么一个应用、要么一把外部密钥。
 * 外部密钥本身就是接入 PHI 的一个独立第三方应用，不能和应用再叠加。
 */
type UsageScope =
  | { kind: "all" }
  | { kind: "app"; app: AppType }
  | { kind: "key"; keyId: string };

function toUsageScope(appType: AppTypeFilter): UsageScope {
  return appType === "all" ? { kind: "all" } : { kind: "app", app: appType };
}

const TABS = ["logs", "providers", "models", "pricing"] as const;

function MenuMeta({ children }: { children: ReactNode }) {
  return (
    <span className="ms-auto shrink-0 tabular-nums text-xs text-fg-3">
      {children}
    </span>
  );
}

const STATUS_CODE_OPTIONS = [
  200, 400, 401, 403, 404, 429, 500, 502, 503,
] as const;

const menuContentClass =
  "rounded-panel border border-border bg-surface p-1 shadow-md";
const menuItemClass =
  "flex cursor-pointer items-center gap-2 rounded-control px-2 py-1.5 text-body text-fg-2 transition-colors hover:bg-subtle hover:text-fg-1";

function MenuCheck({ checked }: { checked: boolean }) {
  return (
    <Check
      aria-hidden
      className={cn(
        "h-3.5 w-3.5 shrink-0",
        checked ? "opacity-100" : "opacity-0",
      )}
    />
  );
}

function useContainerWidth<T extends HTMLElement>(): [
  (node: T | null) => void,
  number,
] {
  const [width, setWidth] = useState(0);
  const observerRef = useRef(
    new ResizeObserver((entries) => {
      for (const entry of entries) setWidth(entry.contentRect.width);
    }),
  );
  const ref = (element: T | null) => {
    observerRef.current.disconnect();
    if (element) observerRef.current.observe(element);
  };
  return [ref, width] as const;
}

export function UsageDashboard({
  initialAppType = "all",
}: UsageDashboardProps = {}) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const [range, setRange] = useState<UsageRangeSelection>({
    preset: "today",
  });
  const [scope, setScope] = useState<UsageScope>(() =>
    toUsageScope(initialAppType),
  );
  // 下游只认 appType / bindingId；两者由同一个 scope 推导，天然互斥。
  const appType: AppTypeFilter = scope.kind === "app" ? scope.app : "all";
  const bindingId = scope.kind === "key" ? scope.keyId : undefined;
  const [providerName, setProviderName] = useState<string | undefined>(
    undefined,
  );
  const [model, setModel] = useState<string | undefined>(undefined);
  const [statusCode, setStatusCode] = useState<number | undefined>(undefined);
  const [tab, setTab] = useState<UsageTab>("logs");
  // 没有用量时也能进定价页：新装的人往往先配好 models.dev 同步再开始用
  const [pricingWhileEmpty, setPricingWhileEmpty] = useState(false);
  // 系统固定 10 秒自动刷新（交互简化：不再暴露刷新间隔设置）
  const refreshIntervalMs = 10_000;
  const [detailRequestId, setDetailRequestId] = useState<string | null>(null);
  const [syncingSession, setSyncingSession] = useState(false);
  const [containerRef, measuredWidth] = useContainerWidth<HTMLDivElement>();

  // 测量不到（测试环境）按宽窗口排
  const width = measuredWidth || 1000;
  const compact = width < 720;

  useEffect(() => {
    setScope(toUsageScope(initialAppType));
    setProviderName(undefined);
    setModel(undefined);
  }, [initialAppType]);

  // 切应用时清掉下游筛选，避免留下一个在新范围内查无数据的"幽灵"组合；
  // 切供应商同理清掉模型（模型选项随供应商级联）。
  // 选应用会同时退出密钥筛选：密钥是一个独立应用，两者只能选一个。
  const changeAppType = (next: AppTypeFilter) => {
    const scopeChanged = scope.kind === "key" || next !== appType;
    setScope(toUsageScope(next));
    if (scopeChanged) {
      setProviderName(undefined);
      setModel(undefined);
    }
  };

  const changeProviderName = (next: string | undefined) => {
    setProviderName(next);
    if (next !== providerName) {
      setModel(undefined);
    }
  };

  // 选密钥即切到"外部应用"这一独立范围，并退出应用筛选；
  // 清掉下游筛选，避免旧供应商/模型把新范围过滤成空。
  const changeBindingId = (next: string | undefined) => {
    // 没有密钥筛选时点「全部密钥」不应把当前应用也一并清掉
    if (!next && scope.kind !== "key") return;
    const scopeChanged = next !== bindingId;
    setScope(next ? { kind: "key", keyId: next } : { kind: "all" });
    if (scopeChanged) {
      setProviderName(undefined);
      setModel(undefined);
    }
  };

  // 后端写入新日志时 emit `usage-log-recorded`，立刻 invalidate 所有 usage 查询
  useUsageEventBridge();

  const runManualSessionSync = async () => {
    setSyncingSession(true);
    try {
      const result = await usageApi.syncSessionUsage();
      await queryClient.invalidateQueries({ queryKey: usageKeys.all });
      const message = t("usage.sessionSync.syncCompleted", {
        imported: result.imported,
        files: result.filesScanned,
        errors: result.errors.length,
      });
      if (result.errors.length > 0) {
        toast.warning(message);
      } else {
        toast.success(message);
      }
    } catch (error) {
      toast.error(t("usage.sessionSync.syncFailed", { error: String(error) }));
    } finally {
      setSyncingSession(false);
    }
  };

  const language = i18n.resolvedLanguage || i18n.language || "en";
  const locale = getLocaleFromLanguage(language);
  const resolvedRange = useMemo(() => resolveUsageRange(range), [range]);
  const rangeLabel = useMemo(() => {
    if (range.preset !== "custom") {
      return getUsageRangePresetLabel(range.preset, t);
    }
    const startStr = new Date(resolvedRange.startDate * 1000).toLocaleString(
      locale,
    );
    if (range.liveEndTime) {
      return `${startStr} → ${t("usage.liveEndTimeNow", "现在")}`;
    }
    const endStr = new Date(resolvedRange.endDate * 1000).toLocaleString(
      locale,
    );
    return `${startStr} - ${endStr}`;
  }, [locale, range, resolvedRange.endDate, resolvedRange.startDate, t]);

  // 筛选下拉的选项池：供应商列表只跟应用/时间范围走（不受自身选中值影响），
  // 模型列表随所选供应商级联。refetchInterval 跟随面板的刷新设置——未筛选时
  // 这两个查询与统计表共享 query key，落下的话会按默认 30s 拖着同 key 查询轮询。
  const refetch = {
    refetchInterval:
      refreshIntervalMs > 0 ? refreshIntervalMs : (false as const),
  };
  const { data: providerOptionsData } = useProviderStats(
    range,
    { appType, bindingId },
    refetch,
  );
  const { data: modelOptionsData } = useModelStats(
    range,
    { appType, providerName, bindingId },
    refetch,
  );
  // 有没有任何用量（不分时间范围）：一条都没有时显示空状态
  const { data: allTimeSummary } = useQuery({
    queryKey: [...usageKeys.all, "all-time-summary"],
    queryFn: () => usageApi.getUsageSummary(),
    refetchInterval: refetch.refetchInterval,
  });
  const isEmpty = allTimeSummary != null && allTimeSummary.totalRequests === 0;

  const providerOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const stat of providerOptionsData ?? []) {
      counts.set(
        stat.providerName,
        (counts.get(stat.providerName) ?? 0) + stat.requestCount,
      );
    }
    // 数据刷新后选中项可能掉出列表（如改了时间范围）；补回去保证用户看得见、能清除
    if (providerName && !counts.has(providerName)) counts.set(providerName, 0);
    return Array.from(counts, ([name, count]) => ({ name, count })).sort(
      (a, b) => b.count - a.count,
    );
  }, [providerOptionsData, providerName]);

  const modelOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const stat of modelOptionsData ?? []) {
      counts.set(stat.model, (counts.get(stat.model) ?? 0) + stat.requestCount);
    }
    if (model && !counts.has(model)) counts.set(model, 0);
    return Array.from(counts, ([name, count]) => ({ name, count })).sort(
      (a, b) => b.count - a.count,
    );
  }, [modelOptionsData, model]);

  const providerTotal = providerOptions.reduce((sum, p) => sum + p.count, 0);
  const modelTotal = modelOptions.reduce((sum, m) => sum + m.count, 0);

  // 外部接入密钥：只有存在密钥时才显示筛选项。应用自己的接入没有密钥。
  const bindings = useQuery({
    queryKey: ["access-bindings"],
    queryFn: accessApi.bindings,
  });
  const externalKeys = useMemo(
    () =>
      (bindings.data ?? [])
        .filter((b) => b.tool === "external")
        .sort((a, b) => a.name.localeCompare(b.name)),
    [bindings.data],
  );
  const selectedKey = externalKeys.find((key) => key.id === bindingId);

  // 密钥被删除后，不留一个查不到任何数据的筛选范围。
  useEffect(() => {
    if (!bindings.isSuccess || scope.kind !== "key") return;
    if (!externalKeys.some((key) => key.id === scope.keyId)) {
      setScope({ kind: "all" });
      setProviderName(undefined);
      setModel(undefined);
    }
  }, [bindings.isSuccess, externalKeys, scope]);

  // ── 筛选行 ───────────────────────────────────────────────────────────
  // 选中块是单独的滑块（SegmentThumb），在应用与密钥之间切换时滑过去。
  // 密钥触发器和应用芯片同属一个单选组，value 用当前范围区分，选中密钥时也要重量。
  const appFilterIndicator = useSlidingIndicator<HTMLDivElement>(
    '[aria-pressed="true"]',
    bindingId ? `key:${bindingId}` : appType,
  );
  const chipClass = (pressed: boolean) =>
    cn(
      "relative inline-flex h-[26px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[5px] px-2 text-body transition-colors duration-150",
      pressed
        ? "font-semibold text-fg-1"
        : "font-medium text-fg-2 hover:text-fg-1",
    );
  const keyPressed = scope.kind === "key";

  const filterRow = (
    <div className="flex min-h-12 shrink-0 flex-wrap items-center gap-1.5 px-6 py-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <div
          ref={appFilterIndicator.ref}
          role="group"
          aria-label={t("usage.keyFilter.groupLabel")}
          className="relative flex h-8 shrink-0 items-center gap-0.5 rounded-[8px] bg-subtle p-[3px]"
        >
          <SegmentThumb
            rect={appFilterIndicator.rect}
            animate={appFilterIndicator.animate}
            className="rounded-[5px]"
          />
          <button
            type="button"
            aria-pressed={scope.kind === "all"}
            className={chipClass(scope.kind === "all")}
            onClick={() => changeAppType("all")}
          >
            {t("usage.appFilter.all")}
          </button>
          {/* 应用只露图标，名字放悬停提示和 aria-label */}
          {KNOWN_APP_TYPES.map((app) => {
            const pressed = scope.kind === "app" && scope.app === app;
            return (
              <HoverTip key={app} content={APP_DISPLAY_NAME[app]}>
                <button
                  type="button"
                  aria-pressed={pressed}
                  aria-label={APP_DISPLAY_NAME[app]}
                  className={cn(
                    chipClass(pressed),
                    "w-[30px] justify-center px-0",
                  )}
                  onClick={() => changeAppType(app)}
                >
                  <AppGlyph
                    app={app}
                    size={16}
                    badgeClassName={pressed ? "bg-surface" : "bg-subtle"}
                  />
                </button>
              </HoverTip>
            );
          })}
          {/* 每个外部密钥就是一个独立应用：放在同一个单选组里，选中密钥即退出应用筛选 */}
          {externalKeys.length > 0 && (
            <>
              <span
                aria-hidden="true"
                className="mx-0.5 h-4 w-px shrink-0 bg-border"
              />
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-pressed={keyPressed}
                    aria-label={
                      selectedKey
                        ? `${t("usage.keyFilter.label")}: ${selectedKey.name}`
                        : t("usage.keyFilter.label")
                    }
                    title={selectedKey?.name ?? t("usage.keyFilter.title")}
                    className={cn(
                      chipClass(keyPressed),
                      "max-w-[172px] gap-1 pe-1 ps-1.5",
                    )}
                  >
                    <KeyRound
                      className="h-3.5 w-3.5 shrink-0"
                      aria-hidden="true"
                    />
                    <span className="min-w-0 truncate">
                      {selectedKey?.name ?? t("usage.keyFilter.label")}
                    </span>
                    <ChevronDown
                      className="h-3.5 w-3.5 shrink-0 opacity-70"
                      aria-hidden="true"
                    />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="start"
                  aria-label={t("usage.keyFilter.title")}
                  className={cn(
                    menuContentClass,
                    "max-h-[360px] overflow-y-auto",
                  )}
                >
                  <DropdownMenuLabel className="max-w-[280px] whitespace-normal text-caption font-normal leading-relaxed text-fg-3">
                    {t("usage.keyFilter.hint")}
                  </DropdownMenuLabel>
                  <DropdownMenuItem
                    className={menuItemClass}
                    onSelect={() => changeBindingId(undefined)}
                  >
                    <MenuCheck checked={bindingId == null} />
                    {t("usage.keyFilter.all")}
                  </DropdownMenuItem>
                  {externalKeys.map((key) => {
                    // agent 与名称相同时不重复展示（新建密钥时记账标识默认等于名称）
                    const meta = !key.enabled
                      ? t("usage.keyFilter.disabled")
                      : key.agent && key.agent !== key.name
                        ? key.agent
                        : null;
                    return (
                      <DropdownMenuItem
                        key={key.id}
                        className={menuItemClass}
                        onSelect={() => changeBindingId(key.id)}
                      >
                        <MenuCheck checked={bindingId === key.id} />
                        <span className="min-w-0 truncate">{key.name}</span>
                        {meta && <MenuMeta>{meta}</MenuMeta>}
                      </DropdownMenuItem>
                    );
                  })}
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          )}
        </div>
      </div>
      <div className="min-w-2 flex-1" />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="neutral"
            size="regular"
            className="min-w-[78px] max-w-[156px] shrink gap-1 pe-2 ps-3"
            title={
              providerName
                ? usageProviderTitle(getUsageProviderLabel(providerName, t))
                : t("usage.providerFilter.title")
            }
          >
            <span className="min-w-0 truncate">
              {providerName
                ? getUsageProviderLabel(providerName, t).label
                : t("usage.providerFilter.label")}
            </span>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-fg-2" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          aria-label={t("usage.providerFilter.title")}
          className={cn(menuContentClass, "max-h-[360px] overflow-y-auto")}
        >
          <DropdownMenuItem
            className={menuItemClass}
            onSelect={() => changeProviderName(undefined)}
          >
            <MenuCheck checked={providerName == null} />
            {t("usage.providerFilter.all")}
            <MenuMeta>{fmtInt(providerTotal, locale)}</MenuMeta>
          </DropdownMenuItem>
          {providerOptions.map((option) => {
            const label = getUsageProviderLabel(option.name, t);
            return (
              <DropdownMenuItem
                key={option.name}
                className={menuItemClass}
                title={usageProviderTitle(label)}
                onSelect={() => changeProviderName(option.name)}
              >
                <MenuCheck checked={providerName === option.name} />
                <span className="min-w-0 truncate">{label.label}</span>
                <MenuMeta>{fmtInt(option.count, locale)}</MenuMeta>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="neutral"
            size="regular"
            className="min-w-[66px] max-w-[156px] shrink gap-1 pe-2 ps-3"
            title={model ?? t("usage.modelFilter.title")}
          >
            <span className="min-w-0 truncate">
              {model ?? t("usage.modelFilter.label")}
            </span>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-fg-2" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          aria-label={t("usage.modelFilter.title")}
          className={cn(menuContentClass, "max-h-[360px] overflow-y-auto")}
        >
          <DropdownMenuItem
            className={menuItemClass}
            onSelect={() => setModel(undefined)}
          >
            <MenuCheck checked={model == null} />
            {t("usage.allModels")}
            <MenuMeta>{fmtInt(modelTotal, locale)}</MenuMeta>
          </DropdownMenuItem>
          {modelOptions.map((option) => (
            <DropdownMenuItem
              key={option.name}
              className={menuItemClass}
              title={option.name}
              onSelect={() => setModel(option.name)}
            >
              <MenuCheck checked={model === option.name} />
              <span className="min-w-0 truncate font-mono text-caption">
                {option.name}
              </span>
              <MenuMeta>{fmtInt(option.count, locale)}</MenuMeta>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <UsageDateRangePicker
        selection={range}
        triggerLabel={rangeLabel}
        onApply={(nextRange) => setRange(nextRange)}
      />
    </div>
  );

  // ── 子页签 ───────────────────────────────────────────────────────────
  const tabLabel: Record<UsageTab, string> = {
    logs: t("usage.requestLogs"),
    providers: t("usage.tabs.providers"),
    models: t("usage.tabs.models"),
    pricing: t("usage.tabs.pricing"),
  };
  const statusLabel =
    statusCode == null
      ? t("usage.statusFilter.all")
      : `${t("usage.statusCode")} ${statusCode}`;

  const tabTrailing =
    tab === "logs" ? (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="quiet"
            size="compact"
            className="gap-1 pe-1.5 ps-2 text-caption text-fg-2"
            aria-label={`${t("usage.statusCode")}: ${statusLabel}`}
          >
            {statusLabel}
            <ChevronDown className="h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className={cn(menuContentClass, "min-w-[160px]")}
        >
          <DropdownMenuItem
            className={menuItemClass}
            onSelect={() => setStatusCode(undefined)}
          >
            <MenuCheck checked={statusCode == null} />
            {t("usage.statusFilter.all")}
          </DropdownMenuItem>
          {STATUS_CODE_OPTIONS.map((code) => (
            <DropdownMenuItem
              key={code}
              className={menuItemClass}
              onSelect={() => setStatusCode(code)}
            >
              <MenuCheck checked={statusCode === code} />
              <span className="tabular-nums">{code}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    ) : tab === "providers" || tab === "models" ? (
      <span className="text-caption text-fg-3">
        {t("usage.sortedByRequests")}
      </span>
    ) : null;

  const scopedAppType = appType === "all" ? undefined : appType;

  const tabsSection = (
    <section aria-label={t("usage.tabs.label")} className="flex flex-col">
      <PageTabs<UsageTab>
        aria-label={t("usage.tabs.label")}
        items={TABS.map((id) => ({ value: id, label: tabLabel[id] }))}
        value={tab}
        onValueChange={setTab}
        idPrefix="usage-tab"
        controls="usage-tabpanel"
        trailing={tabTrailing}
      />

      <div
        role="tabpanel"
        id="usage-tabpanel"
        aria-labelledby={`usage-tab-${tab}`}
      >
        {tab === "logs" && (
          <RequestLogTable
            range={range}
            appType={appType}
            providerName={providerName}
            model={model}
            bindingId={bindingId}
            statusCode={statusCode}
            refreshIntervalMs={refreshIntervalMs}
            onOpenDetail={setDetailRequestId}
          />
        )}
        {tab === "providers" && (
          <ProviderStatsTable
            range={range}
            appType={appType}
            providerName={providerName}
            model={model}
            bindingId={bindingId}
            refreshIntervalMs={refreshIntervalMs}
          />
        )}
        {tab === "models" && (
          <ModelStatsTable
            range={range}
            appType={appType}
            providerName={providerName}
            model={model}
            bindingId={bindingId}
            refreshIntervalMs={refreshIntervalMs}
          />
        )}
        {tab === "pricing" && <PricingConfigPanel />}
      </div>
    </section>
  );

  const body =
    isEmpty && pricingWhileEmpty ? (
      // 空库里只有定价可配：不画全是 0 的概览和趋势，直接给页签
      <div
        id="main-content"
        className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto scroll-stable px-6 pb-10 pt-1"
      >
        {tabsSection}
      </div>
    ) : isEmpty ? (
      <div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto scroll-stable px-6 pb-10">
        <div className="mt-16 flex max-w-[440px] flex-col items-center gap-3 text-center">
          <span
            aria-hidden="true"
            className="flex h-11 w-11 items-center justify-center rounded-full bg-subtle text-fg-2"
          >
            <ChartColumn className="h-5 w-5" strokeWidth={1.5} />
          </span>
          <div className="flex flex-col gap-1">
            <p className="m-0 text-section text-fg-1">
              {t("usage.empty.title")}
            </p>
            <p className="m-0 text-body text-fg-2">{t("usage.empty.body")}</p>
          </div>
          <Button
            type="button"
            variant="neutral"
            size="regular"
            disabled={syncingSession}
            onClick={() => void runManualSessionSync()}
          >
            {syncingSession && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {t("usage.sessionSync.syncNow")}
          </Button>
          <Button
            type="button"
            variant="quiet"
            size="regular"
            onClick={() => {
              setTab("pricing");
              setPricingWhileEmpty(true);
            }}
          >
            {t("usage.empty.configurePricing")}
          </Button>
        </div>
      </div>
    ) : (
      <div
        id="main-content"
        className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto scroll-stable px-6 pb-10 pt-1"
      >
        <UsageHero
          range={range}
          appType={scopedAppType}
          providerName={providerName}
          model={model}
          bindingId={bindingId}
          refreshIntervalMs={refreshIntervalMs}
          compact={compact}
        />

        {/* 「全部」看长期分布用热力图；24 小时到 30 天这类短范围用柱状图 */}
        {range.preset === "all" ? (
          <UsageHeatmap
            appType={appType}
            providerName={providerName}
            model={model}
            bindingId={bindingId}
            refreshIntervalMs={refreshIntervalMs}
          />
        ) : (
          <UsageTrendChart
            range={range}
            rangeLabel={rangeLabel}
            appType={appType}
            providerName={providerName}
            model={model}
            bindingId={bindingId}
            refreshIntervalMs={refreshIntervalMs}
          />
        )}

        {tabsSection}
      </div>
    );

  return (
    <div ref={containerRef} className="flex min-h-0 min-w-0 flex-1 flex-col">
      {filterRow}
      {body}

      <RequestDetailPanel
        requestId={detailRequestId}
        onClose={() => setDetailRequestId(null)}
      />
    </div>
  );
}
