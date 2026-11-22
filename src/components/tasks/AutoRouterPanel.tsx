import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Pencil, Plus, Trash2, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
  AgentModelChoices,
  RouterAgent,
  RouterSettings,
  RouterStatus,
  RouterTickReport,
} from "@/lib/api/superAgent";
import { superAgentApi } from "@/lib/api/superAgent";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import {
  AGENT_HARNESS_LIMIT,
  blankAgent,
  harnessPreview,
  linesOf,
  resolveRouterAgents,
  withAgentDeleted,
  withAgentSaved,
} from "./agentSettings";
import { AgentStudioPanel } from "./AgentStudioPanel";
import { AgentArgumentsField } from "./AgentArgumentsField";
import { AgentDraftRail } from "./AgentDraftRail";
import {
  personaFromDraft,
  personaIntoForm,
  personaOf,
  personaOfAgent,
  samePersona,
  type AgentDraftVersion,
  type AgentPersona,
  type PersonaForm,
} from "./agentPersona";

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

/** 巡检节拍的可选值（秒）。比 15 秒更密只是空转磁盘。 */
const MONITOR_INTERVALS = [30, 60, 120, 300];
/** 「等你看」的忍耐时长（秒）。0 表示一直等。 */
const NEEDS_YOU_WINDOWS = [600, 1800, 3600, 14400, 0];

function durationText(
  t: (key: string, options?: Record<string, unknown>) => string,
  seconds: number,
): string {
  if (seconds <= 0) return t("tasks.router.forever");
  if (seconds < 60) return t("tasks.router.seconds", { count: seconds });
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t("tasks.router.minutes", { count: minutes });
  return t("tasks.router.hours", { count: Math.round(minutes / 60) });
}

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

  // 老设置里 workerApps 存的是应用 id：补成「跟随应用」的智能体再展示。
  // 口径与智能体视图、详情页的指派行共用一份（`agentSettings.ts`）。
  const agents = useMemo(() => resolveRouterAgents(settings), [settings]);

  const [editing, setEditing] = useState<{
    agent: RouterAgent;
    isNew: boolean;
  } | null>(null);

  const patch = async (change: Partial<RouterSettings>) => {
    if (!settings) return;
    setBusy(true);
    try {
      await onSave({ ...settings, ...change });
    } catch (error) {
      toast.error(
        t("tasks.router.saveFailed", {
          error: agentErrorText(
            t,
            error instanceof Error ? error.message : String(error),
          ),
        }),
      );
    } finally {
      setBusy(false);
    }
  };

  const toggleAgent = (agentId: string, checked: boolean) => {
    if (!settings) return;
    const next = checked
      ? [...settings.workerApps, agentId]
      : settings.workerApps.filter((entry) => entry !== agentId);
    // 顺序按智能体列表，第一个就是规则调度的默认派发对象。
    const ordered = agents
      .map((agent) => agent.id)
      .filter((id) => next.includes(id));
    void patch({ workerApps: ordered });
  };

  const saveAgent = (agent: RouterAgent, isNew: boolean) => {
    if (!settings) return;
    // 新智能体的 id 由后端按名称派生，允许名单也在后端补：这里不猜 uniqueness。
    void patch(withAgentSaved(settings, agent, isNew));
    setEditing(null);
  };

  const deleteAgent = (agent: RouterAgent) => {
    if (!settings) return;
    void patch(withAgentDeleted(settings, agent.id));
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
    <Popover
      open={open}
      // 编辑器在弹层外的 portal 里：点它会被当成「点了面板外面」。
      // 正在编辑时不跟着关，否则刚输入一个字整个表单就没了。
      onOpenChange={(next) => {
        if (!editing) setOpen(next);
      }}
    >
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

                <div className="flex items-center justify-between gap-3">
                  <span className="text-caption text-fg-2">
                    {t("tasks.router.monitorInterval")}
                  </span>
                  <Select
                    value={String(settings.monitorIntervalSeconds)}
                    disabled={busy}
                    onValueChange={(value) =>
                      void patch({ monitorIntervalSeconds: Number(value) })
                    }
                  >
                    <SelectTrigger
                      className="h-7 w-[132px] text-caption"
                      aria-label={t("tasks.router.monitorInterval")}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {MONITOR_INTERVALS.map((seconds) => (
                        <SelectItem key={seconds} value={String(seconds)}>
                          {durationText(t, seconds)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex items-center justify-between gap-3">
                  <span className="text-caption text-fg-2">
                    {t("tasks.router.needsYou")}
                  </span>
                  <Select
                    value={String(settings.needsYouSeconds)}
                    disabled={busy}
                    onValueChange={(value) =>
                      void patch({ needsYouSeconds: Number(value) })
                    }
                  >
                    <SelectTrigger
                      className="h-7 w-[132px] text-caption"
                      aria-label={t("tasks.router.needsYou")}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {NEEDS_YOU_WINDOWS.map((seconds) => (
                        <SelectItem key={seconds} value={String(seconds)}>
                          {durationText(t, seconds)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-caption text-fg-2">
                      {t("tasks.router.agents")}
                    </span>
                    <Button
                      variant="ghost"
                      size="compact"
                      className="h-6 px-1.5 text-caption text-action-text"
                      disabled={busy || terminalApps.length === 0}
                      onClick={() =>
                        setEditing({
                          agent: blankAgent(terminalApps[0] ?? "claude"),
                          isNew: true,
                        })
                      }
                    >
                      <Plus data-icon className="h-3 w-3" strokeWidth={2} />
                      {t("tasks.router.agentAdd")}
                    </Button>
                  </div>
                  {terminalApps.length === 0 ? (
                    <p className="m-0 text-caption leading-relaxed text-fg-3">
                      {t("tasks.router.noWorkers")}
                    </p>
                  ) : agents.length === 0 ? (
                    <p className="m-0 text-caption leading-relaxed text-fg-3">
                      {t("tasks.router.noAgents")}
                    </p>
                  ) : (
                    <div className="flex flex-col gap-1">
                      {agents.map((agent) => {
                        const allowed = settings.workerApps.includes(agent.id);
                        const isDefault = settings.workerApps[0] === agent.id;
                        return (
                          <div
                            key={agent.id}
                            className="flex items-start gap-1.5 rounded-control px-1 py-0.5 hover:bg-subtle"
                          >
                            <Checkbox
                              className="mt-0.5"
                              checked={allowed}
                              disabled={
                                busy ||
                                (allowed && settings.workerApps.length === 1)
                              }
                              aria-label={t("tasks.router.agentAllowed", {
                                name: agent.name,
                              })}
                              onCheckedChange={(value) =>
                                toggleAgent(agent.id, value === true)
                              }
                            />
                            <div className="min-w-0 flex-1">
                              <span className="flex items-center gap-1 text-caption text-fg-1">
                                <span className="truncate">{agent.name}</span>
                                {isDefault ? (
                                  <span className="shrink-0 rounded-control bg-subtle px-1 text-[10px] text-fg-3">
                                    {t("tasks.router.agentDefault")}
                                  </span>
                                ) : null}
                              </span>
                              <span className="block truncate text-[11px] text-fg-3">
                                {getAppDisplayName(agent.appId)}
                                {" · "}
                                {agent.model
                                  ? agent.model
                                  : t("tasks.router.agentFollowApp")}
                              </span>
                            </div>
                            <Button
                              variant="ghost"
                              size="icon-compact"
                              aria-label={t("tasks.router.agentEdit", {
                                name: agent.name,
                              })}
                              disabled={busy}
                              onClick={() =>
                                setEditing({ agent, isNew: false })
                              }
                            >
                              <Pencil
                                aria-hidden="true"
                                className="h-3.5 w-3.5"
                                strokeWidth={1.5}
                              />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon-compact"
                              aria-label={t("tasks.router.agentDelete", {
                                name: agent.name,
                              })}
                              disabled={busy}
                              onClick={() => deleteAgent(agent)}
                            >
                              <Trash2
                                aria-hidden="true"
                                className="h-3.5 w-3.5"
                                strokeWidth={1.5}
                              />
                            </Button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  <p className="m-0 text-caption leading-relaxed text-fg-3">
                    {t("tasks.router.agentsHint")}
                  </p>
                  {agents.length > 0 && settings.workerApps.length === 0 ? (
                    <p className="m-0 text-caption leading-relaxed text-warning-text">
                      {t("tasks.router.agentsNoneAllowed")}
                    </p>
                  ) : null}
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

        {editing ? (
          <RouterAgentDialog
            draft={editing.agent}
            isNew={editing.isNew}
            terminalApps={terminalApps}
            routerAvatar={settings?.routerAvatar ?? ""}
            onCancel={() => setEditing(null)}
            onSave={(agent) => saveAgent(agent, editing.isNew)}
          />
        ) : null}

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

/** 把后端的错误码翻成人能看懂的一句；认不出来的照原样给。 */
function agentErrorText(
  t: (key: string, options?: Record<string, unknown>) => string,
  message: string,
): string {
  if (message.startsWith("unsupported-agent-argument:")) {
    return t("tasks.router.agentErrorArgument", {
      argument: message.slice("unsupported-agent-argument:".length).trim(),
    });
  }
  if (message.startsWith("agent-model-unpublished:")) {
    return t("tasks.router.agentErrorModel", {
      model: message.slice("agent-model-unpublished:".length).trim(),
    });
  }
  switch (message) {
    case "invalid-agent":
    case "invalid-agent-app":
    case "agent-model-override-unsupported":
      return t("tasks.router.agentErrorInvalid");
    case "invalid-agent-id":
      return t("tasks.router.agentErrorDuplicate");
    case "agent-harness-too-large":
      return t("tasks.router.agentErrorHarness", {
        count: AGENT_HARNESS_LIMIT,
      });
    case "unknown-router-agent":
      return t("tasks.router.agentErrorUnknown");
    default:
      return message;
  }
}

/** 「跟随应用」在下拉里的占位值。空字符串是 Radix Select 不接受的选项值。 */
const FOLLOW_APP = "__follow_app__";

/** 「自己填一个模型」在下拉里的占位值。 */
const CUSTOM_MODEL = "__custom_model__";

/**
 * 表单里的一组字段。
 *
 * 分隔靠「标题 + 一道细线」这一行，而不是另起一条横贯整栏的分割线与标题各占一行：
 * 标题本来就要占一行，把线并进去就少一层留白，也少一个纯装饰的元素。
 */
function AgentSection({
  title,
  children,
}: {
  /** 不传就不画分组标题：首组（名称、用途）本身就是表单的开头，再加一行
   * 「它是谁」只是把「下面是这个人的定义」说两遍。 */
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2.5">
      {title ? (
        <div className="flex items-center gap-2">
          <h4 className="m-0 shrink-0 text-badge text-fg-3">{title}</h4>
          <span aria-hidden="true" className="h-px flex-1 bg-border" />
        </div>
      ) : null}
      {children}
    </section>
  );
}

/**
 * 字段下的一句说明：11px、弱一档，与标签之间只隔 4px。
 *
 * 以前每处手写一遍，字号与行高有一处不同整列就像在抖；带 id 的那几条同时
 * 作为输入的 `aria-describedby`，读屏能把「这个框要填什么」连在一起读。
 */
function FieldHint({
  id,
  className,
  children,
}: {
  id?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <p
      id={id}
      className={cn("m-0 text-[11px] leading-relaxed text-fg-3", className)}
    >
      {children}
    </p>
  );
}

interface RouterAgentDialogProps {
  draft: RouterAgent;
  isNew: boolean;
  terminalApps: string[];
  /** Router 自己的头像键；空 = 按固定 id 派生。工作室的表头与每轮发言都用它。 */
  routerAvatar?: string;
  onCancel: () => void;
  onSave: (agent: RouterAgent) => void;
}

/**
 * 智能体编辑器。
 *
 * 表单按「它是谁 / 怎么启动 / 负责什么 / 怎么做 / 怎样算完成」分五组：
 * 前两组是「判官怎么认人、怎么启动」，后三组是角色定义。五段全空时派发行为
 * 与老智能体一字不差；填了就由 Rust 编译成 harness 拼在前面。
 * 新建时右栏顶部多一条草稿版本条：每轮 Router 写的那一版都留着，可以任意切回去看。
 * 非交互启动参数由 phi 自动附加，不在这里给覆盖入口。
 */
export function RouterAgentDialog({
  draft,
  isNew,
  terminalApps,
  routerAvatar = "",
  onCancel,
  onSave,
}: RouterAgentDialogProps) {
  const { t } = useTranslation();
  const [agent, setAgent] = useState<RouterAgent>(draft);
  // 参数留成一段原文，保存时才切分：直接绑 `arguments.join(" ")` 会让每次
  // 按键后重新拼接，刚打下的空格当场被吃掉，`--effort high` 变成 `--efforthigh`。
  const [argsText, setArgsText] = useState(draft.arguments.join(" "));
  // `null` = 还没读到；名单为空不代表不能填，只表示没有可推荐的。
  const [choices, setChoices] = useState<AgentModelChoices | null>(null);
  const [custom, setCustom] = useState(false);
  // 五段式按「一行一条」编辑：列表字段在界面上就是多行文本，保存时才切分成数组。
  // 直接绑数组会让每次按键都重建元素身份，光标跟着跳。
  const [askText, setAskText] = useState(draft.askUserWhen.join("\n"));
  const [stepsText, setStepsText] = useState(draft.steps.join("\n"));
  const [constraintsText, setConstraintsText] = useState(
    draft.constraints.join("\n"),
  );
  const [evidenceText, setEvidenceText] = useState(
    draft.completion.evidence.join("\n"),
  );
  /**
   * 草稿版本：0 是「开始对话之前」，之后每落一版追加一条。
   *
   * 只存「它是谁」那半边，应用、模型、参数与提示词不进快照——切版本换的是
   * Router 写的那几段，而不是把你刚调好的启动配置也一起翻回去。
   */
  const [versions, setVersions] = useState<AgentDraftVersion[]>([
    { round: null, fields: [], persona: personaOfAgent(draft) },
  ]);
  /** 右栏正在编辑的那一版。 */
  const [cursor, setCursor] = useState(0);
  /** 正在看的历史版本；`null` = 在看右栏实时那一份。 */
  const [preview, setPreview] = useState<number | null>(null);

  const live: PersonaForm = {
    agent,
    askText,
    stepsText,
    constraintsText,
    evidenceText,
  };
  const livePersona = personaOf(live);
  // 预览时右栏只读：能看到、能比，但保存的还是实时那一份，不能两个版本一起改。
  const locked = preview !== null;
  // 手改不另起一版（每敲一个字都存一份没人看得懂），但要说清右栏已不是 Router 那份。
  const edited = !samePersona(livePersona, versions[cursor].persona);
  const shown = preview === null ? livePersona : versions[preview].persona;
  /**
   * 这一轮对话的起点：右栏实时那一份，或者正在看的那一版。
   *
   * 看着旧版开口时，模型和落盘都必须以那一版为基础；拿看不见的实时草稿当基础，
   * 人看到的是第 1 版、改出来的却是第 3 版的衍生。
   */
  const basePersona =
    preview === null ? livePersona : versions[preview].persona;
  const studioAgent =
    preview === null ? agent : personaIntoForm(basePersona, live).agent;
  const versionLabel = (version: number) =>
    version === 0
      ? t("tasks.router.agentVersionInitial")
      : t("tasks.router.agentVersionRound", { count: version });

  const loadPersona = (persona: AgentPersona) => {
    const form = personaIntoForm(persona, live);
    setAgent(form.agent);
    setAskText(form.askText);
    setStepsText(form.stepsText);
    setConstraintsText(form.constraintsText);
    setEvidenceText(form.evidenceText);
  };

  /**
   * 草稿落到右栏，并记成一版。
   *
   * 第一版落下来时顺手把「初始」改成此刻的样子：人可能先手填了名称与用途再开口，
   * 那个才是他真正想退回去的起点。
   */
  const applyDraft = (next: RouterAgent, round: number) => {
    const persona = personaFromDraft(next, basePersona);
    const fields: string[] = [];
    const note = (key: keyof AgentPersona, label: string) => {
      if (persona[key] !== basePersona[key]) fields.push(label);
    };
    note("name", t("tasks.router.agentName"));
    note("description", t("tasks.router.agentPurpose"));
    note("outcome", t("tasks.router.agentOutcome"));
    note("boundary", t("tasks.router.agentBoundary"));
    note("askText", t("tasks.router.agentAskUser"));
    note("stepsText", t("tasks.router.agentSteps"));
    note("constraintsText", t("tasks.router.agentConstraints"));
    note("completionResult", t("tasks.router.agentCompletion"));
    note("evidenceText", t("tasks.router.agentEvidence"));

    const version: AgentDraftVersion = { round, fields, persona };
    const nextVersions =
      versions.length === 1
        ? [{ ...versions[0], persona: livePersona }, version]
        : [...versions, version];
    setVersions(nextVersions);
    setCursor(nextVersions.length - 1);
    setPreview(null);
    loadPersona(persona);
    return { version: nextVersions.length - 1, fields };
  };

  /**
   * 点版本条：切成「看这一版」。
   *
   * 点的是当前这一版、而且没手改过时不算预览——否则白白把右栏锁上，还得多点一次
   * 「以这一版继续」才能接着写。
   */
  const selectVersion = (version: number) => {
    setPreview(version === cursor && !edited ? null : version);
  };

  /** 以某一版继续：右栏换成它，后面的版本仍留在版本条上备查。 */
  const continueFrom = (version: number) => {
    setCursor(version);
    setPreview(null);
    loadPersona(versions[version].persona);
  };

  useEffect(() => {
    let alive = true;
    setChoices(null);
    void superAgentApi
      .agentModels(agent.appId)
      .then((result) => {
        if (alive) setChoices(result);
      })
      .catch(() => {
        if (alive) setChoices({ models: [], overridable: false });
      });
    return () => {
      alive = false;
    };
  }, [agent.appId]);

  const listed = choices?.models ?? [];
  const overridable = choices?.overridable ?? false;
  // 已下架、或手填的模型照样显示出来：悄悄换成「跟随应用」等于改写了配置。
  const missingModel = agent.model !== "" && !listed.includes(agent.model);
  const customModel = custom || missingModel;
  // 角色上下文由 Rust 编译；这里只把「会不会超限」提前告诉人，不自己改内容。
  // 按码点数：Rust 侧算的是 `chars().count()`，用 UTF-16 长度会让带 emoji 的
  // 配置在这里被误判超限，拦住一次其实存得进去的保存。
  // 字数跟屏幕上这一份走：看历史版本时不该报一个属于别一版的数。
  const harnessLength = [
    ...harnessPreview({
      ...agent,
      name: shown.name,
      description: shown.description,
      outcome: shown.outcome,
      boundary: shown.boundary,
      askUserWhen: linesOf(shown.askText),
      steps: linesOf(shown.stepsText),
      constraints: linesOf(shown.constraintsText),
      completion: {
        result: shown.completionResult,
        evidence: linesOf(shown.evidenceText),
      },
    }),
  ].length;
  const harnessTooLong = harnessLength > AGENT_HARNESS_LIMIT;
  const valid =
    agent.name.trim() !== "" &&
    (!customModel || agent.model.trim() !== "") &&
    !harnessTooLong;

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent
        zIndex="top"
        // 新建时左边多一栅工作室，两栅并列才看得清「刚说的那句」变成了哪些字段。
        className={isNew ? "h-[76vh] max-w-4xl" : "max-w-lg"}
        aria-describedby={undefined}
      >
        <DialogHeader className="px-6 pt-5">
          <DialogTitle>
            {isNew
              ? t("tasks.router.agentDialogTitle")
              : t("tasks.router.agentEditTitle", { name: draft.name })}
          </DialogTitle>
          <DialogDescription>
            {isNew
              ? t("tasks.router.agentCreateHint")
              : t("tasks.router.agentDialogHint")}
          </DialogDescription>
        </DialogHeader>

        <DialogBody
          className={cn(
            "flex flex-col gap-3 py-3",
            isNew && "md:flex-row md:gap-5 md:overflow-hidden",
          )}
        >
          {isNew ? (
            <AgentStudioPanel
              appId={agent.appId}
              routerAvatar={routerAvatar}
              current={studioAgent}
              activeVersion={preview ?? cursor}
              previewing={locked}
              previewLabel={versionLabel(preview ?? cursor)}
              onContinueFromView={() => continueFrom(preview ?? cursor)}
              onDraft={applyDraft}
              onSelectVersion={selectVersion}
              // 一列会话一列表单：左边加宽到 336px，气泡才不至于刚写两句就折行。
              className="md:min-h-0 md:w-[336px] md:shrink-0"
            />
          ) : null}

          <div
            className={cn(
              "flex flex-col gap-3",
              // 两栅时表单自己滚：工作室那份对话要一直看得见。
              // 右侧是一份长表单：滚动条只在指针进来时浮出来，
              // 常显的滑块会让这一列看着总像「下面还有一大段」。
              isNew &&
                "scroll-implicit md:min-h-0 md:flex-1 md:overflow-y-auto md:pe-1",
            )}
          >
            {/* 还没落过一版时不摆版本条：一个只有「初始」的条只会多占一屏。 */}
            {isNew && versions.length > 1 ? (
              <AgentDraftRail
                versions={versions}
                cursor={cursor}
                preview={preview}
                edited={edited}
                onSelect={selectVersion}
                onContinue={() => continueFrom(preview ?? cursor)}
                onBack={() => setPreview(null)}
              />
            ) : null}

            <AgentSection>
              <div className="flex flex-col gap-1">
                <Label htmlFor="router-agent-name">
                  {t("tasks.router.agentName")}
                </Label>
                <Input
                  id="router-agent-name"
                  value={shown.name}
                  maxLength={160}
                  disabled={locked}
                  placeholder={t("tasks.router.agentNamePlaceholder")}
                  onChange={(event) =>
                    setAgent({ ...agent, name: event.target.value })
                  }
                />
              </div>

              <div className="flex flex-col gap-1">
                <Label htmlFor="router-agent-description">
                  {t("tasks.router.agentPurpose")}
                </Label>
                {/* 判官按这句选人，那就把这条规则写在打字的地方，
                    而不是打完再看下面一行灰字。 */}
                <Input
                  id="router-agent-description"
                  value={shown.description}
                  maxLength={400}
                  disabled={locked}
                  placeholder={t("tasks.router.agentPurposePlaceholder")}
                  onChange={(event) =>
                    setAgent({ ...agent, description: event.target.value })
                  }
                />
              </div>
            </AgentSection>

            <AgentSection title={t("tasks.router.agentSectionLaunch")}>
              <div className="grid grid-cols-2 gap-2">
                <div className="flex flex-col gap-1">
                  <span className="text-caption text-fg-2">
                    {t("tasks.router.agentApp")}
                  </span>
                  <Select
                    value={agent.appId}
                    disabled={locked}
                    onValueChange={(value) => {
                      // 换应用等于换一份模型名单，自定义那格也跟着退回去。
                      setCustom(false);
                      setAgent({ ...agent, appId: value, model: "" });
                    }}
                  >
                    <SelectTrigger
                      className="h-8"
                      aria-label={t("tasks.router.agentApp")}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="z-[120]">
                      {terminalApps.map((appId) => (
                        <SelectItem key={appId} value={appId}>
                          {getAppDisplayName(appId)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-caption text-fg-2">
                    {t("tasks.router.agentModel")}
                  </span>
                  <Select
                    value={
                      customModel ? CUSTOM_MODEL : agent.model || FOLLOW_APP
                    }
                    disabled={!overridable || locked}
                    onValueChange={(value) => {
                      if (value === CUSTOM_MODEL) {
                        setCustom(true);
                        return;
                      }
                      setCustom(false);
                      setAgent({
                        ...agent,
                        model: value === FOLLOW_APP ? "" : value,
                      });
                    }}
                  >
                    <SelectTrigger
                      className="h-8"
                      aria-label={t("tasks.router.agentModel")}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="z-[120]">
                      <SelectItem value={FOLLOW_APP}>
                        {t("tasks.router.agentFollowApp")}
                      </SelectItem>
                      {listed.map((model) => (
                        <SelectItem key={model} value={model}>
                          {model}
                        </SelectItem>
                      ))}
                      <SelectItem value={CUSTOM_MODEL}>
                        {t("tasks.router.agentModelCustom")}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              {customModel ? (
                <div className="flex flex-col gap-1">
                  <Input
                    id="router-agent-model"
                    value={agent.model}
                    maxLength={128}
                    disabled={locked}
                    className="h-8"
                    aria-label={t("tasks.router.agentModelCustomLabel")}
                    aria-describedby={
                      missingModel ? "router-agent-model-hint" : undefined
                    }
                    placeholder={t("tasks.router.agentModelCustomPlaceholder")}
                    onChange={(event) =>
                      setAgent({ ...agent, model: event.target.value })
                    }
                  />
                  {/* 只有「已经不在名单里」这一种要说：能填、不选就跟随时怎么走，
                      框里的说明已经交代完了，再多一行只是噪声。 */}
                  {missingModel ? (
                    <FieldHint id="router-agent-model-hint">
                      {t("tasks.router.agentModelMissing")}
                    </FieldHint>
                  ) : null}
                </div>
              ) : choices !== null && !overridable ? (
                // 「跟随应用」「自定义模型…」这两个选项本身就说清了怎么用；
                // 只有真的不能按会话指定模型时才需要一句解释。
                <FieldHint>{t("tasks.router.agentModelUnsupported")}</FieldHint>
              ) : null}

              <AgentArgumentsField
                appId={agent.appId}
                value={argsText}
                disabled={locked}
                onChange={setArgsText}
              />

              <div className="flex flex-col gap-1">
                <Label htmlFor="router-agent-prompt">
                  {t("tasks.router.agentPrompt")}
                </Label>
                <Textarea
                  id="router-agent-prompt"
                  value={agent.prompt}
                  maxLength={2000}
                  rows={3}
                  className="field-multiline"
                  disabled={locked}
                  placeholder={t("tasks.router.agentPromptPlaceholder")}
                  onChange={(event) =>
                    setAgent({ ...agent, prompt: event.target.value })
                  }
                />
              </div>
            </AgentSection>

            {/* 五段式：它是谁、负责什么、能问谁、怎么做、怎样算完成。
              全部留空时派发行为与老智能体一字不差，填了才进 harness。 */}
            <AgentSection title={t("tasks.router.agentSectionResponsibility")}>
              <div className="flex flex-col gap-1">
                <Label htmlFor="router-agent-outcome">
                  {t("tasks.router.agentOutcome")}
                </Label>
                <Textarea
                  id="router-agent-outcome"
                  value={shown.outcome}
                  rows={2}
                  className="field-multiline"
                  maxLength={2000}
                  disabled={locked}
                  placeholder={t("tasks.router.agentOutcomePlaceholder")}
                  onChange={(event) =>
                    setAgent({ ...agent, outcome: event.target.value })
                  }
                />
              </div>

              <div className="flex flex-col gap-1">
                <Label htmlFor="router-agent-boundary">
                  {t("tasks.router.agentBoundary")}
                </Label>
                <Textarea
                  id="router-agent-boundary"
                  value={shown.boundary}
                  rows={2}
                  className="field-multiline"
                  maxLength={2000}
                  disabled={locked}
                  placeholder={t("tasks.router.agentBoundaryPlaceholder")}
                  onChange={(event) =>
                    setAgent({ ...agent, boundary: event.target.value })
                  }
                />
              </div>

              <div className="flex flex-col gap-1">
                <Label htmlFor="router-agent-ask">
                  {t("tasks.router.agentAskUser")}
                </Label>
                <Textarea
                  id="router-agent-ask"
                  value={shown.askText}
                  rows={2}
                  className="field-multiline"
                  disabled={locked}
                  placeholder={t("tasks.router.agentAskUserPlaceholder")}
                  onChange={(event) => setAskText(event.target.value)}
                />
              </div>
            </AgentSection>

            <AgentSection title={t("tasks.router.agentSectionMethod")}>
              <div className="flex flex-col gap-1">
                <Label htmlFor="router-agent-steps">
                  {t("tasks.router.agentSteps")}
                </Label>
                <Textarea
                  id="router-agent-steps"
                  value={shown.stepsText}
                  rows={3}
                  className="field-multiline"
                  disabled={locked}
                  placeholder={t("tasks.router.agentStepsPlaceholder")}
                  onChange={(event) => setStepsText(event.target.value)}
                />
              </div>

              <div className="flex flex-col gap-1">
                <Label htmlFor="router-agent-constraints">
                  {t("tasks.router.agentConstraints")}
                </Label>
                <Textarea
                  id="router-agent-constraints"
                  value={shown.constraintsText}
                  rows={2}
                  className="field-multiline"
                  disabled={locked}
                  placeholder={t("tasks.router.agentConstraintsPlaceholder")}
                  onChange={(event) => setConstraintsText(event.target.value)}
                />
              </div>
            </AgentSection>

            <AgentSection title={t("tasks.router.agentSectionCompletion")}>
              <div className="flex flex-col gap-1">
                <Label htmlFor="router-agent-completion">
                  {t("tasks.router.agentCompletion")}
                </Label>
                <Textarea
                  id="router-agent-completion"
                  value={shown.completionResult}
                  rows={2}
                  className="field-multiline"
                  maxLength={2000}
                  disabled={locked}
                  placeholder={t("tasks.router.agentCompletionPlaceholder")}
                  onChange={(event) =>
                    setAgent({
                      ...agent,
                      completion: {
                        ...agent.completion,
                        result: event.target.value,
                      },
                    })
                  }
                />
              </div>

              <div className="flex flex-col gap-1">
                <Label htmlFor="router-agent-evidence">
                  {t("tasks.router.agentEvidence")}
                </Label>
                <Textarea
                  id="router-agent-evidence"
                  value={shown.evidenceText}
                  rows={2}
                  className="field-multiline"
                  disabled={locked}
                  placeholder={t("tasks.router.agentEvidencePlaceholder")}
                  onChange={(event) => setEvidenceText(event.target.value)}
                />
              </div>

              <p
                className={cn(
                  "m-0 text-[11px] tabular-nums",
                  harnessTooLong ? "text-danger-text" : "text-fg-3",
                )}
              >
                {harnessTooLong
                  ? t("tasks.router.agentErrorHarness", {
                      count: harnessLength,
                    })
                  : t("tasks.router.agentHarness", { count: harnessLength })}
              </p>
              <FieldHint>{t("tasks.router.agentDefinitionHint")}</FieldHint>
            </AgentSection>
          </div>
        </DialogBody>

        <DialogFooter className="px-6">
          <Button variant="neutral" size="compact" onClick={onCancel}>
            {t("tasks.router.agentCancel")}
          </Button>
          <Button
            variant="solid"
            size="compact"
            // 预览历史版本时屏幕上那份不是要存的那份，不给保存。
            disabled={!valid || locked}
            onClick={() =>
              onSave({
                ...agent,
                name: agent.name.trim(),
                description: agent.description.trim(),
                prompt: agent.prompt.trim(),
                model: agent.model.trim(),
                arguments: argsText.split(/\s+/).filter(Boolean),
                askUserWhen: linesOf(askText),
                steps: linesOf(stepsText),
                constraints: linesOf(constraintsText),
                completion: {
                  ...agent.completion,
                  evidence: linesOf(evidenceText),
                },
              })
            }
          >
            {t("tasks.router.agentSave")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
