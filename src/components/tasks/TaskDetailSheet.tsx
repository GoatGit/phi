import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Archive,
  ChevronRight,
  Clock,
  FileText,
  FolderOpen,
  Link2Off,
  MessageSquare,
  Trash2,
  Repeat,
  SquareTerminal,
} from "lucide-react";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
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
import { SessionMarkdown } from "@/components/sessions/reader/SessionMarkdown";
import { getAppDisplayName } from "@/components/shell/AppGlyph";
import { fmtUsd } from "@/components/usage/format";
import type {
  DerivedDiscussion,
  DiscussionForm,
  DiscussionTurn,
  TaskArtifact,
  TaskCard,
  TaskDetail,
  TaskSchedule,
} from "@/lib/api/tasks";
import type {
  RouterAgent,
  RouterHumanDecision,
  RouterTaskRun,
} from "@/lib/api/superAgent";
import { cn } from "@/lib/utils";
import { AutoRouterSection } from "./AutoRouterSection";
import {
  INTERVAL_UNITS,
  MAX_INTERVAL_MINUTES,
  MIN_INTERVAL_MINUTES,
  SCHEDULE_MODES,
  UNIT_MINUTES,
  composeMoment,
  formatBytes,
  formatStamp,
  intervalParts,
  nextRunLabel,
  normalizeClock,
  scheduleKind,
  scheduleLabel,
  splitMoment,
  todayDate,
  type IntervalUnit,
  type ScheduleKind,
} from "./schedule";

/** 讨论卡正文里属于「讨论起点」的两段：直显示在讨论区上方，不进过程记录。 */
const DISCUSSION_CONTEXT_TITLES = ["讨论背景", "本轮讨论"];

interface TaskDetailSheetProps {
  detail: TaskDetail | null;
  statuses: string[];
  /** 默认列（待办）：只有这一列上的卡能讨论、能写回结论 */
  defaultStatus?: string | null;
  /**
   * 能开终端会话的应用。
   *
   * 讨论不再需要它：讨论由 Router 承接，不开终端会话。留着是因为其它区块
   * （会话链接、查看器）仍与这个能力同源。
   */
  terminalApps?: string[];

  busy: boolean;
  /** 这张卡的自动调度运行态 */
  run: RouterTaskRun | undefined;
  /** 后端当前确实持有的会话 id；不在其中的链接表示会话已结束 */
  liveSessionIds?: ReadonlySet<string>;
  /** 打开一条已有关联会话（后台派发的 worker 不会自己出现在界面上） */
  onOpenSession?: (appId: string, sessionId: string) => void;
  /** 打开这次运行的 worker：跑在 zellij 里的 worker 不在会话链接里 */
  onOpenWorker?: () => void;
  /** 改排期：两个参数最多给一个，都给 `null` 就是取消排期 */
  onSetSchedule: (recurrence: string | null, schedule: string | null) => void;
  /** 发送任务：讨论结束，这张卡转成执行卡进入执行列；返回是否发出去 */
  onSendDiscussion?: () => Promise<boolean>;
  /** 跟 Router 说一句：讨论由 Router 承接，不开终端会话。返回是否成功 */
  onSayDiscussion?: (message: string) => Promise<boolean>;
  /** 刚建出来的讨论卡，第一句已经发出去了，正在等 Router 回第一句 */
  discussionReplying?: boolean;
  /** 刚发出去、但还没进 timeline 的第一句：本地先把它显示成用户气泡 */
  discussionFirstMessage?: string | null;
  /** 从一张已完成的任务派生新一轮讨论；返回是否成功 */
  onDeriveDiscussion?: (note: string) => Promise<boolean>;
  /** 把一张待办卡就地转成讨论卡；讨论只在讨论卡里发生 */
  onConvertDiscussion?: () => Promise<boolean>;
  /** 关掉一张还没定下结论的讨论卡 */
  onDiscardDiscussion?: () => Promise<void>;
  /** 打开一张派生出去的讨论卡 */
  onOpenTask?: (taskId: string) => void;
  /** 刚派生出讨论卡：自动聚焦输入框 */
  focusDiscussion?: boolean;
  /** 在文件管理器中显示一个产物 */
  onRevealArtifact: (path: string) => void;
  onClose: () => void;
  onAutoStart: () => void;
  onAutoPause: () => void;
  onAutoResume: () => void;
  /** 设置里的全部智能体（下拉只列允许参与派发的那些） */
  agents?: RouterAgent[];
  allowedAgents?: string[];
  /** 指派（`start` = 指派并开工）；拖放与这里是同一套语义 */
  onAssign?: (agentId: string | null, start: boolean) => void;
  onSetStatus: (status: string) => void;
  onArchive: () => void;
  onResolve: (decision: RouterHumanDecision) => void;
  onUnlink: (sessionId: string) => void;
}

/**
 * 任务详情抽屉：先给「交付了什么」，再给过程。
 *
 * 顺序是刻意的：结果与产物在最上面，自动调度的运行细节与执行记录在其后。
 * 用户打开一张已完成的卡，想知道的是「东西在哪」，不是「第几次、退出码几」。
 * 每块只放一份事实：状态在页脚、优先级在卡片、验收进度在验收清单上。
 */
export function TaskDetailSheet({
  detail,
  statuses,
  defaultStatus = null,
  busy,
  run,
  liveSessionIds,
  onOpenSession,
  onOpenWorker,
  onSetSchedule,
  onSendDiscussion,
  onSayDiscussion,
  onDeriveDiscussion,
  onConvertDiscussion,
  onDiscardDiscussion,
  onOpenTask,
  focusDiscussion,
  discussionReplying,
  discussionFirstMessage,
  onRevealArtifact,
  onClose,
  onSetStatus,
  onArchive,
  onResolve,
  onUnlink,
  onAutoStart,
  onAutoPause,
  onAutoResume,
  agents = [],
  allowedAgents = [],
  onAssign,
}: TaskDetailSheetProps) {
  const { t } = useTranslation();
  const task = detail?.task ?? null;
  // 任务可能处在 config 里已删掉的列上，把它自己补进去，避免下拉选不出当前值
  const statusOptions =
    task && !statuses.includes(task.status)
      ? [...statuses, task.status]
      : statuses;
  // 标题只是一句概括：真正交代的事情在「Description」里。它不再跟着其它段落
  // 一起收进「执行记录」，而是单独摆在最上面。
  const description =
    detail?.sections.find((section) => section.title === "Description")?.body ??
    null;
  const processSections =
    detail?.sections.filter(
      (section) =>
        section.title !== "Acceptance Criteria" &&
        section.title !== "Description" &&
        // 讨论卡的背景与第一轮输入不属于「过程记录」：它们是这一轮讨论的起点，
        // 在讨论区上面直接可见，不用展开一个排障用的折叠块。
        !(
          task?.kind === "discussion" &&
          DISCUSSION_CONTEXT_TITLES.includes(section.title)
        ),
    ) ?? [];
  const discussionContext =
    task?.kind === "discussion"
      ? {
          background:
            detail?.sections.find((s) => s.title === "讨论背景")?.body ?? null,
          firstTurn:
            detail?.sections.find((s) => s.title === "本轮讨论")?.body ?? null,
        }
      : { background: null, firstTurn: null };

  return (
    <Sheet open={Boolean(detail)} onOpenChange={(open) => !open && onClose()}>
      <SheetContent width={880} closeLabel={t("common.close")}>
        {task && detail ? (
          <>
            <SheetHeader>
              <SheetDescription className="font-mono text-caption text-fg-3">
                {task.id}
              </SheetDescription>
              <SheetTitle className="pe-2 text-section leading-snug">
                {task.title}
              </SheetTitle>
            </SheetHeader>
            <SheetBody>
              {/* 两个区域：左边是「这张卡是什么、做出了什么」，右边是
                  「现在什么状态、下一步能做什么」。窄窗口回落成单栏。 */}
              <div
                className={cn(
                  "grid items-start gap-x-6 gap-y-6",
                  task.kind === "discussion"
                    ? "grid-cols-1"
                    : "grid-cols-[minmax(0,1fr)_288px] max-[920px]:grid-cols-1",
                )}
              >
                <div className="min-w-0 space-y-6">
                  {/* 先回答「任务是什么」，再回答「做出了什么」。 */}
                  <DescriptionSection
                    description={description}
                    showEmpty={task.kind !== "discussion"}
                  />

                  {/* 讨论卡不产出交付物，也没有排期与派发：结果、验收、自动调度
                      这几块对它都是空的，不摆一串「—」占位置。 */}
                  {task.kind === "discussion" ? null : (
                    <ResultSection
                      outcome={detail.outcome}
                      artifacts={detail.artifacts}
                      onRevealArtifact={onRevealArtifact}
                    />
                  )}

                  {/* 讨论卡本身就是这一页的主内容：背景、首轮、输入框与 timeline
                      都留在这里。非讨论卡的「已确认需求 / 派生轮次」是事实，
                      放在验收之后；「重新讨论 / 转为讨论卡」是动作，去右栏。 */}
                  {task.kind === "discussion" &&
                  onSendDiscussion &&
                  onSayDiscussion ? (
                    <DiscussionSection
                      task={task}
                      confirmed={detail.confirmed}
                      derived={detail.derived ?? []}
                      turns={detail.discussionTurns ?? []}
                      pending={
                        defaultStatus === null || task.status === defaultStatus
                      }
                      busy={busy}
                      focus={focusDiscussion}
                      replying={discussionReplying}
                      firstMessage={discussionFirstMessage}
                      background={discussionContext.background}
                      firstTurn={discussionContext.firstTurn}
                      onSend={onSendDiscussion}
                      onSay={onSayDiscussion}
                      onDeriveDiscussion={onDeriveDiscussion}
                      onConvertDiscussion={onConvertDiscussion}
                      onDiscard={onDiscardDiscussion}
                      onClose={onClose}
                      onOpenTask={onOpenTask}
                    />
                  ) : null}

                  {task.kind === "discussion" ? null : (
                    <section className="space-y-2">
                      <h3 className="m-0 text-body font-medium text-fg-1">
                        {t("tasks.acceptance")}
                      </h3>
                      {detail.acceptance.length === 0 ? (
                        <p className="m-0 text-caption text-fg-3">
                          {t("tasks.noAcceptance")}
                        </p>
                      ) : (
                        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
                          {detail.acceptance.map((item, index) => (
                            <li
                              key={`${item.text}-${index}`}
                              className="flex items-start gap-2 text-caption"
                            >
                              <span
                                aria-hidden="true"
                                className={cn(
                                  "mt-[3px] flex size-3.5 shrink-0 items-center justify-center rounded-[4px] border text-[9px] leading-none",
                                  item.done
                                    ? "border-action bg-action text-action-fg"
                                    : "border-border-strong text-transparent",
                                )}
                              >
                                ✓
                              </span>
                              <div className="min-w-0 flex-1">
                                <TaskMarkdown
                                  content={item.text}
                                  variant="note"
                                  className={cn(
                                    "[&_p]:my-0",
                                    item.done
                                      ? "text-fg-3 line-through"
                                      : "text-fg-1",
                                  )}
                                />
                              </div>
                            </li>
                          ))}
                        </ul>
                      )}
                    </section>
                  )}

                  {/* 讨论谈定过什么、派生过哪几轮：这是事实，按阅读顺序接在验收之后。
                      运行中的卡不摆这一块：讨论与运行互斥，结论已经跟着卡正文走了。 */}
                  {task.kind !== "discussion" &&
                  (task.status.toLowerCase() === "done" ||
                    defaultStatus === null ||
                    task.status === defaultStatus) ? (
                    <DiscussionFacts
                      confirmed={detail.confirmed}
                      derived={detail.derived ?? []}
                      onOpenTask={onOpenTask}
                    />
                  ) : null}

                  {/* 过程记录默认收起：它是排障用的，不是这一屏要回答的问题。 */}
                  {processSections.length > 0 ? (
                    <details className="group rounded-panel border border-border">
                      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 text-caption font-medium text-fg-2">
                        <span>
                          {t("tasks.process.title", {
                            count: processSections.length,
                          })}
                        </span>
                        <ChevronRight
                          aria-hidden="true"
                          className="size-3.5 shrink-0 transition-transform group-open:rotate-90"
                          strokeWidth={1.5}
                        />
                      </summary>
                      <div className="space-y-4 border-t border-border px-3 py-3">
                        {processSections.map((section) => (
                          <section key={section.title} className="space-y-1.5">
                            <h4 className="m-0 text-caption font-medium text-fg-2">
                              {section.title}
                            </h4>
                            <TaskMarkdown
                              content={section.body}
                              variant="note"
                              className="text-fg-3"
                            />
                          </section>
                        ))}
                      </div>
                    </details>
                  ) : null}

                  {/* 没有关联会话就不占一行：「还没有…」既不能点也不说明什么。 */}
                  {detail.links.length > 0 ? (
                    <section className="space-y-2">
                      <h3 className="m-0 text-body font-medium text-fg-1">
                        {t("tasks.sessions")}
                      </h3>
                      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
                        {detail.links.map((link) => {
                          // 应用重启后后端不再持有旧会话，链接还留在数据库里。
                          // 这种情况不说成「打不开」，而是如实写「会话已结束」。
                          const live =
                            !liveSessionIds ||
                            liveSessionIds.has(link.sessionId);
                          return (
                            <li
                              key={link.sessionId}
                              className="flex items-center gap-2 rounded-control border border-border px-2.5 py-1.5"
                            >
                              <SquareTerminal
                                aria-hidden="true"
                                className="size-3.5 shrink-0 text-fg-3"
                              />
                              <span className="min-w-0 flex-1 truncate text-caption text-fg-1">
                                {getAppDisplayName(link.appId)}
                              </span>
                              <span className="shrink-0 text-caption tabular-nums text-fg-3">
                                {t("tasks.sessionUsage", {
                                  cost: fmtUsd(link.costUsd, 2),
                                  count: link.requests,
                                })}
                              </span>
                              {onOpenSession && live ? (
                                <Button
                                  variant="ghost"
                                  size="compact"
                                  className="shrink-0"
                                  disabled={busy}
                                  onClick={() =>
                                    onOpenSession(link.appId, link.sessionId)
                                  }
                                >
                                  {t("tasks.openSession")}
                                </Button>
                              ) : (
                                <span className="shrink-0 text-caption text-fg-3">
                                  {t("tasks.sessionEnded")}
                                </span>
                              )}
                              <Button
                                variant="ghost"
                                size="icon-compact"
                                aria-label={t("tasks.unlinkSession")}
                                title={t("tasks.unlinkSession")}
                                disabled={busy}
                                onClick={() => onUnlink(link.sessionId)}
                              >
                                <Link2Off
                                  data-icon
                                  className="h-3.5 w-3.5"
                                  strokeWidth={1.5}
                                />
                              </Button>
                            </li>
                          );
                        })}
                      </ul>
                    </section>
                  ) : null}
                </div>

                {/* 状态与操作单独一列：看板列状态、运行状态、排期与
                    「下一步能点什么」放在一起，不散落在正文里。 */}
                {task.kind === "discussion" ? null : (
                  <aside
                    aria-label={t("tasks.operations.title")}
                    className="min-w-0 space-y-5 max-[920px]:border-t max-[920px]:border-border max-[920px]:pt-5"
                  >
                    <h2 className="m-0 text-caption font-medium tracking-wide text-fg-3">
                      {t("tasks.operations.title")}
                    </h2>

                    <AutoRouterSection
                      run={run}
                      busy={busy}
                      onStart={onAutoStart}
                      onPause={onAutoPause}
                      onResume={onAutoResume}
                      assignees={task.assignees}
                      taskStatus={task.status}
                      agents={agents}
                      allowedAgents={allowedAgents}
                      onAssign={onAssign}
                      onResolve={onResolve}
                      onOpenWorker={
                        onOpenWorker && run?.sessionId
                          ? onOpenWorker
                          : undefined
                      }
                    />

                    <ScheduleSection
                      schedule={task.schedule}
                      busy={busy}
                      onSave={onSetSchedule}
                    />

                    {/* 动作跟事实分家：「重新讨论 / 转为讨论卡」是下一步能做的事，
                        放在右栏；已确认的需求与派生记录留在左栏当事实读。 */}
                    {onSendDiscussion && onSayDiscussion ? (
                      <DiscussionActions
                        task={task}
                        busy={busy}
                        pending={
                          defaultStatus === null ||
                          task.status === defaultStatus
                        }
                        onDeriveDiscussion={onDeriveDiscussion}
                        onConvertDiscussion={onConvertDiscussion}
                      />
                    ) : null}
                  </aside>
                )}
              </div>
            </SheetBody>
            <SheetFooter>
              <Button
                variant="ghost"
                size="compact"
                disabled={busy}
                onClick={() => onArchive()}
              >
                <Archive data-icon className="h-3.5 w-3.5" strokeWidth={1.5} />
                {t("tasks.archive")}
              </Button>
              <div className="flex-1" />
              <Select
                value={task.status}
                onValueChange={(status) => onSetStatus(status)}
                disabled={busy}
              >
                <SelectTrigger
                  className="w-[132px]"
                  aria-label={t("tasks.status")}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {statusOptions.map((status) => (
                    <SelectItem key={status} value={status}>
                      {status}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SheetFooter>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

/**
 * 卡片里的 Markdown 正文。
 *
 * 任务卡本身就是仓库里的一个 `.md`：描述、结果、过程段、讨论发言都可能带
 * 列表、粗体、行内代码。这些内容此前按纯文本直出，于是 `**日期：**`、反引号
 * 这类标记原样落在面板上。这里复用会话阅读页那套渲染器，不另写一套解析。
 *
 * 面板比阅读页窄：段落间距收一档；作者写的单行换行仍然照旧断行，不会把
 * 分行列出的几条粘成一整段。
 */
function TaskMarkdown({
  content,
  variant = "body",
  className,
}: {
  content: string;
  /** body：描述与结果这类正文；note：过程段、讨论气泡这类次级信息 */
  variant?: "body" | "note";
  className?: string;
}) {
  return (
    <SessionMarkdown
      content={content}
      variant={variant}
      className={cn(
        "leading-relaxed [&_p]:my-1 [&_p]:whitespace-pre-line",
        className,
      )}
    />
  );
}

/** 任务描述：标题之外真正交代的事情，放在最前面。 */
function DescriptionSection({
  description,
  showEmpty,
}: {
  description: string | null;
  /** 没有描述时是否留一句说明；讨论卡由「讨论背景」承担，不摆空段 */
  showEmpty: boolean;
}) {
  const { t } = useTranslation();
  if (!description && !showEmpty) return null;

  return (
    <section aria-label={t("tasks.description.title")} className="space-y-2">
      <h3 className="m-0 text-body font-medium text-fg-1">
        {t("tasks.description.title")}
      </h3>
      {description ? (
        <TaskMarkdown content={description} />
      ) : (
        <p className="m-0 text-caption leading-relaxed text-fg-3">
          {t("tasks.description.empty")}
        </p>
      )}
    </section>
  );
}

/** 结果与产物：这一屏最该被先看到的东西。 */
function ResultSection({
  outcome,
  artifacts,
  onRevealArtifact,
}: {
  outcome: string | null;
  artifacts: TaskArtifact[];
  onRevealArtifact: (path: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <section
      aria-label={t("tasks.result.title")}
      className="space-y-3 rounded-panel border border-border bg-surface p-3.5 shadow-v7-card"
    >
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="m-0 text-body font-medium text-fg-1">
          {t("tasks.result.title")}
        </h3>
        {artifacts.length > 0 ? (
          <span className="text-caption tabular-nums text-fg-3">
            {t("tasks.result.artifactCount", { count: artifacts.length })}
          </span>
        ) : null}
      </div>
      {outcome ? (
        <TaskMarkdown content={outcome} />
      ) : (
        <p className="m-0 text-caption leading-relaxed text-fg-3">
          {t("tasks.result.empty")}
        </p>
      )}
      {artifacts.length > 0 ? (
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {artifacts.map((artifact) => (
            <li
              key={`${artifact.path}-${artifact.label}`}
              className="flex items-center gap-2.5 rounded-control border border-border bg-subtle px-2.5 py-2"
            >
              <FileText
                aria-hidden="true"
                className="size-4 shrink-0 text-action-text"
                strokeWidth={1.5}
              />
              <div className="min-w-0 flex-1">
                <span className="block truncate text-caption font-medium text-fg-1">
                  {artifact.label}
                </span>
                <span className="block truncate font-mono text-[11px] text-fg-3">
                  {artifact.path}
                </span>
              </div>
              {artifact.url ? (
                <span className="shrink-0 text-[11px] text-fg-3">
                  {t("tasks.result.link")}
                </span>
              ) : artifact.exists ? (
                <>
                  <span className="shrink-0 text-[11px] tabular-nums text-fg-3">
                    {formatBytes(artifact.size)}
                  </span>
                  <Button
                    variant="ghost"
                    size="compact"
                    onClick={() => onRevealArtifact(artifact.path)}
                  >
                    <FolderOpen
                      data-icon
                      className="h-3.5 w-3.5"
                      strokeWidth={1.5}
                    />
                    {t("tasks.result.reveal")}
                  </Button>
                </>
              ) : (
                <span className="shrink-0 text-[11px] text-warning-text">
                  {t("tasks.result.missing")}
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/** 任务类型：普通 / 持续（每隔一段时间）/ 定时（指定时刻）。 */
function ScheduleSection({
  schedule,
  busy,
  onSave,
}: {
  schedule: TaskSchedule | null;
  busy: boolean;
  onSave: (recurrence: string | null, schedule: string | null) => void;
}) {
  const { t } = useTranslation();
  const current = scheduleKind(schedule);
  const [mode, setMode] = useState<ScheduleKind>(current);
  /** 持续任务：多少 + 单位，两个选择框，不用手敲 `2h`。 */
  const [amount, setAmount] = useState<number | "">(() =>
    current === "interval"
      ? intervalParts(schedule?.minutes ?? null).amount
      : 30,
  );
  const [unit, setUnit] = useState<IntervalUnit>(() =>
    current === "interval"
      ? intervalParts(schedule?.minutes ?? null).unit
      : "m",
  );
  /** 定时任务：时分由时间选择器给，一次性任务再多一个日期。 */
  const [time, setTime] = useState(() =>
    current === "daily"
      ? (schedule?.time ?? "")
      : splitMoment(schedule?.at).time,
  );
  const [date, setDate] = useState(() =>
    current === "once"
      ? splitMoment(schedule?.at).date || todayDate()
      : todayDate(),
  );

  const interval =
    mode === "interval" ? Number(amount) * UNIT_MINUTES[unit] : null;
  const clock = normalizeClock(time);
  const moment = mode === "once" ? composeMoment(date, time) : null;
  const valid =
    mode === "none" ||
    (mode === "interval"
      ? Number.isInteger(amount) &&
        interval !== null &&
        interval >= MIN_INTERVAL_MINUTES &&
        interval <= MAX_INTERVAL_MINUTES
      : mode === "daily"
        ? clock !== null
        : moment !== null);
  const label = scheduleLabel(t, schedule);
  const next = nextRunLabel(t, schedule);

  const save = () => {
    if (busy || !valid) return;
    if (mode === "none") onSave(null, null);
    else if (mode === "interval") onSave(`${amount}${unit}`, null);
    else if (mode === "daily") onSave(null, clock);
    else onSave(null, moment);
  };

  const fieldLabel =
    mode === "interval"
      ? t("tasks.schedule.everyLabel")
      : mode === "once"
        ? t("tasks.schedule.dateLabel")
        : t("tasks.schedule.timeLabel");

  return (
    <section className="space-y-2">
      <h3 className="m-0 text-body font-medium text-fg-1">
        {t("tasks.schedule.title")}
      </h3>
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={mode}
          onValueChange={(nextMode) => {
            setMode(nextMode as ScheduleKind);
            // 切类型时只清掉不属于新类型的部分，避免把刚选的时间丢掉
            if (nextMode !== "interval") {
              setAmount(30);
              setUnit("m");
            }
            if (nextMode === "none") setTime("");
            if (nextMode === "once" && !date) setDate(todayDate());
          }}
          disabled={busy}
        >
          <SelectTrigger
            className="w-[132px]"
            aria-label={t("tasks.schedule.title")}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SCHEDULE_MODES.map((item) => (
              <SelectItem key={item} value={item}>
                {t(`tasks.schedule.mode.${item}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {mode === "none" ? null : (
          <span className="inline-flex items-center gap-1.5">
            <span className="text-caption text-fg-3">{fieldLabel}</span>
            {mode === "interval" ? (
              <>
                <Input
                  type="number"
                  min={1}
                  max={MAX_INTERVAL_MINUTES / UNIT_MINUTES[unit]}
                  step={1}
                  aria-invalid={!valid}
                  className="w-[64px] text-center"
                  value={amount}
                  aria-label={t("tasks.schedule.intervalAmount")}
                  disabled={busy}
                  onChange={(event) => {
                    const value = event.target.value;
                    setAmount(value === "" ? "" : Number(value));
                  }}
                />
                <Select
                  value={unit}
                  onValueChange={(nextUnit) =>
                    setUnit(nextUnit as IntervalUnit)
                  }
                  disabled={busy}
                >
                  <SelectTrigger
                    className="w-[86px]"
                    aria-label={t("tasks.schedule.intervalUnit")}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {INTERVAL_UNITS.map((item) => (
                      <SelectItem key={item} value={item}>
                        {t(`tasks.schedule.unit.${item}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </>
            ) : (
              <>
                {mode === "once" ? (
                  <Input
                    type="date"
                    className="w-[150px]"
                    value={date}
                    aria-label={t("tasks.schedule.dateLabel")}
                    disabled={busy}
                    onChange={(event) => setDate(event.target.value)}
                  />
                ) : null}
                <Input
                  type="time"
                  step={60}
                  className="w-[110px]"
                  value={time}
                  aria-label={t("tasks.schedule.timeLabel")}
                  disabled={busy}
                  onChange={(event) => setTime(event.target.value)}
                />
              </>
            )}
          </span>
        )}
        <Button
          variant="neutral"
          size="compact"
          disabled={busy || !valid}
          onClick={save}
        >
          {t("tasks.schedule.save")}
        </Button>
      </div>
      <p className="m-0 flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-fg-3">
        {label ? (
          <span className="inline-flex items-center gap-1 text-fg-2">
            {current === "interval" ? (
              <Repeat
                aria-hidden="true"
                className="size-3.5"
                strokeWidth={1.5}
              />
            ) : (
              <Clock
                aria-hidden="true"
                className="size-3.5"
                strokeWidth={1.5}
              />
            )}
            {label}
          </span>
        ) : null}
        {next ? <span>{next}</span> : null}
        {schedule?.lastRunAt ? (
          <span>
            {t("tasks.schedule.lastRun", {
              time: formatStamp(schedule.lastRunAt),
            })}
          </span>
        ) : null}
      </p>
      <p className="m-0 text-caption leading-relaxed text-fg-3">
        {t("tasks.schedule.hint")}
      </p>
    </section>
  );
}

/**
 * 需求讨论：讨论是决策动作，不是执行动作，所以它只属于 Router 那一层，
 * 也只发生在任务的详情页里——讨论引用的标题、验收、执行记录都在这一页。
 *
 * 两种形态，对应任务所处的状态：
 * - 讨论卡（或待办卡）：输入框 + 已确认结论 + 讨论会话；
 * - 已完成：不能回到讨论态，只能从它派生一张新的讨论卡。
 *
 * 已经在执行的任务不摆这一块：讨论与运行互斥，用户在这张卡上什么也做不了，
 * 一段「不能讨论」的说明只是占位置。要重新讨论就等它跑完，或从 To Do 另建一张。
 */
function DiscussionSection({
  task,
  confirmed,
  derived = [],
  turns = [],
  pending,
  busy,
  focus,
  replying,
  firstMessage,
  background,
  firstTurn,
  onSend,
  onSay,
  onDiscard,
  onClose,
  onOpenTask,
}: {
  task: TaskCard;
  confirmed: string | null;
  derived: DerivedDiscussion[];
  /** 这一轮讨论的对话记录（用户与 Router） */
  turns: DiscussionTurn[];
  /** 这张卡是否还在待办列 */
  pending: boolean;
  busy: boolean;
  /** 刚派生出的讨论卡：自动聚焦输入框 */
  focus?: boolean;
  /** 第一句已经发出去了，正在等 Router 回第一句 */
  replying?: boolean;
  /** 刚发出去、还没写进 timeline 的第一句 */
  firstMessage?: string | null;
  /** 派生时带过来的背景区块（只带结论与约束，不带过程） */
  background?: string | null;
  /** 用户发起这一轮讨论时写下的那句话（原样） */
  firstTurn?: string | null;
  /** 发送任务：讨论结束，卡片转成执行卡 */
  onSend: () => Promise<boolean>;
  onSay: (message: string) => Promise<boolean>;
  /** 从已完成的任务派生新一轮讨论，并在成功后跳到它的详情页 */
  onDeriveDiscussion?: (note: string) => Promise<boolean>;
  /** 把待办卡就地转成讨论卡，转换后本页就变成讨论卡 */
  onConvertDiscussion?: () => Promise<boolean>;
  /** 关掉一张还没定下结论的讨论卡 */
  onDiscard?: () => Promise<void>;
  /** 保存草稿退出：只关详情页，卡片和这一轮的记录都留着 */
  onClose?: () => void;
  onOpenTask?: (taskId: string) => void;
}) {
  const { t } = useTranslation();
  const discussion = task.kind === "discussion";

  const list = <DerivedList derived={derived} onOpenTask={onOpenTask} />;

  // 只有讨论卡提供输入框与 timeline。普通待办卡要先显式转类型，不在这里讨论。
  if (discussion) {
    return (
      <div className="space-y-6">
        {background ? (
          <section className="space-y-1.5 rounded-panel border border-border bg-subtle px-3 py-2">
            <h3 className="m-0 text-caption font-medium text-fg-2">
              {t("tasks.discussion.backgroundTitle")}
            </h3>
            <TaskMarkdown content={background} variant="note" />
          </section>
        ) : null}
        {firstTurn ? (
          <section className="space-y-1.5">
            <h3 className="m-0 text-caption font-medium text-fg-2">
              {t("tasks.discussion.firstTurnTitle")}
            </h3>
            <TaskMarkdown
              content={firstTurn}
              variant="note"
              className="rounded-panel border border-border px-3 py-2 text-fg-1"
            />
          </section>
        ) : null}
        {pending ? (
          <DiscussionEditor
            turns={turns}
            question={task.discussionQuestion}
            confirmed={confirmed}
            busy={busy}
            autoFocus={focus}
            replying={replying}
            firstMessage={firstMessage}
            round={discussion ? task.round : null}
            sourceTask={task.sourceTask}
            onSend={onSend}
            onSay={onSay}
            onDiscard={discussion ? onDiscard : undefined}
            onClose={onClose}
          />
        ) : (
          // 已经不在待办列的讨论卡（例如工作区的默认列被改过）：讨论已经不能继续，
          // 但谈定的结论还要能读到。这里不给输入框——后端会以 discussion-not-pending
          // 拒绝，界面给人一个只会报错的按钮比不给入口更糟。
          <section className="space-y-2">
            <h3 className="m-0 flex items-center gap-1.5 text-body font-medium text-fg-1">
              <MessageSquare
                aria-hidden="true"
                className="size-3.5 text-fg-3"
                strokeWidth={1.5}
              />
              {t("tasks.discussion.title")}
            </h3>
            <p className="m-0 text-caption leading-relaxed text-fg-3">
              {t("tasks.discussion.notPendingHint")}
            </p>
            {task.discussionQuestion ? (
              <div className="space-y-1.5">
                <span className="text-caption text-fg-3">
                  {t("tasks.discussion.questionLabel")}
                </span>
                <TaskMarkdown
                  content={task.discussionQuestion}
                  variant="note"
                  className="rounded-panel border border-border px-3 py-2"
                />
              </div>
            ) : null}
            {confirmed ? (
              <div className="space-y-1.5">
                <span className="text-caption text-fg-3">
                  {t("tasks.discussion.confirmedLabel")}
                </span>
                <TaskMarkdown
                  content={confirmed}
                  variant="note"
                  className="rounded-panel border border-border px-3 py-2"
                />
              </div>
            ) : null}
          </section>
        )}
        {list}
      </div>
    );
  }

  // 非讨论卡不在这里渲染：事实（已确认结论、派生轮次）与动作（重新讨论、
  // 转为讨论卡）已拆到 DiscussionFacts / DiscussionActions，各归左右栏。
  return null;
}

/** 派生过哪几轮讨论：这张卡的下游线索，按轮次能一直跟回去。 */
function DerivedList({
  derived,
  onOpenTask,
}: {
  derived: DerivedDiscussion[];
  onOpenTask?: (taskId: string) => void;
}) {
  const { t } = useTranslation();
  if (derived.length === 0) return null;

  return (
    <section className="space-y-2">
      <h3 className="m-0 text-body font-medium text-fg-1">
        {t("tasks.discussion.derivedTitle")}
      </h3>
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
        {derived.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              onClick={() => onOpenTask?.(item.id)}
              className="flex w-full items-baseline gap-2 rounded-control border border-border bg-subtle px-2.5 py-1.5 text-start hover:border-border-strong"
            >
              <span className="shrink-0 font-mono text-[11px] text-fg-3">
                {item.id}
              </span>
              {item.round ? (
                <span className="shrink-0 text-[11px] text-fg-3">
                  {t("tasks.discussion.round", { round: item.round })}
                </span>
              ) : null}
              <span className="min-w-0 flex-1 truncate text-caption text-fg-1">
                {item.question ?? item.title}
              </span>
              <span className="shrink-0 text-[11px] text-fg-3">
                {item.status}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * 左栏的「讨论说过什么」：只放事实。
 *
 * 已确认的需求跟卡走，执行体读到的就是它；派生轮次是这张卡的下游。
 * 两块都没有时整块不出现——不摆一串空标题占位置。
 */
function DiscussionFacts({
  confirmed,
  derived = [],
  onOpenTask,
}: {
  confirmed: string | null;
  derived: DerivedDiscussion[];
  onOpenTask?: (taskId: string) => void;
}) {
  const { t } = useTranslation();
  if (!confirmed && derived.length === 0) return null;

  return (
    <div className="space-y-6">
      {confirmed ? (
        <section className="space-y-2">
          <h3 className="m-0 text-body font-medium text-fg-1">
            {t("tasks.discussion.confirmedLabel")}
          </h3>
          <TaskMarkdown
            content={confirmed}
            variant="note"
            className="rounded-panel border border-border px-3 py-2"
          />
        </section>
      ) : null}
      <DerivedList derived={derived} onOpenTask={onOpenTask} />
    </div>
  );
}

/**
 * 右栏的「接下来还能怎么谈」：只放动作。
 *
 * 已完成卡用「重新讨论」派生一张带上下文的新讨论卡；待办普通卡用一次
 * 显式类型转换把这张卡变成讨论卡。运行中的卡两边都不给。
 */
function DiscussionActions({
  task,
  busy,
  pending,
  onDeriveDiscussion,
  onConvertDiscussion,
}: {
  task: TaskCard;
  busy: boolean;
  pending: boolean;
  onDeriveDiscussion?: (note: string) => Promise<boolean>;
  onConvertDiscussion?: () => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const done = task.status.toLowerCase() === "done";

  if (done && onDeriveDiscussion) {
    return (
      <section className="space-y-3">
        <h3 className="m-0 text-body font-medium text-fg-1">
          {t("tasks.discussion.title")}
        </h3>
        <p className="m-0 text-caption leading-relaxed text-fg-3">
          {t("tasks.discussion.deriveHint")}
        </p>
        <StartDiscussionCard
          busy={busy}
          label={t("tasks.discussion.derive")}
          onStart={onDeriveDiscussion}
        />
      </section>
    );
  }

  if (pending && onConvertDiscussion) {
    return (
      <section className="space-y-3">
        <h3 className="m-0 text-body font-medium text-fg-1">
          {t("tasks.discussion.title")}
        </h3>
        <p className="m-0 text-caption leading-relaxed text-fg-3">
          {t("tasks.discussion.pendingHint")}
        </p>
        <ConvertDiscussionCard
          busy={busy}
          label={t("tasks.discussion.pendingConvert")}
          onConvert={onConvertDiscussion}
        />
      </section>
    );
  }

  return null;
}

/** 把一张待办卡转成讨论卡：转换后它的详情页才会出现输入框。 */
function ConvertDiscussionCard({
  busy,
  label,
  onConvert,
}: {
  busy: boolean;
  label: string;
  onConvert: () => Promise<boolean>;
}) {
  const [working, setWorking] = useState(false);
  const disabled = busy || working;

  const submit = async () => {
    if (disabled) return;
    setWorking(true);
    try {
      await onConvert();
    } finally {
      setWorking(false);
    }
  };

  return (
    <Button
      variant="secondary"
      size="compact"
      disabled={disabled}
      onClick={() => void submit()}
    >
      {label}
    </Button>
  );
}

/** 「重新讨论」：一句话写清这一轮要定什么，再派生一张讨论卡。 */
function StartDiscussionCard({
  busy,
  label,
  onStart,
}: {
  busy: boolean;
  label: string;
  onStart: (note: string) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const [note, setNote] = useState("");
  const [working, setWorking] = useState(false);
  const disabled = busy || working || !note.trim();

  const submit = async () => {
    if (disabled) return;
    setWorking(true);
    try {
      if (await onStart(note)) setNote("");
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="space-y-1.5">
      <Label htmlFor="task-discussion-note" className="text-caption text-fg-2">
        {t("tasks.discussion.deriveLabel")}
      </Label>
      <Textarea
        id="task-discussion-note"
        value={note}
        maxLength={2000}
        disabled={busy || working}
        placeholder={t("tasks.discussion.derivePlaceholder")}
        onChange={(event) => setNote(event.target.value)}
        onKeyDown={(event) => {
          // 一句话就够：Ctrl/Cmd+Enter 提交，普通回车留给换行
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            void submit();
          }
        }}
      />
      <div className="flex items-center gap-2">
        <Button
          variant="secondary"
          size="compact"
          disabled={disabled}
          onClick={() => void submit()}
        >
          {label}
        </Button>
      </div>
    </div>
  );
}

/**
 * 讨论区：输入框 + timeline。
 *
 * 发言者只有两方——用户与 Router。Router 召集来的 worker 意见以它的名义出现
 * （并标注来源），所以这里没有「谁说」的选择，也没有应用下拉：讨论不开终端会话，
 * 它由 Router 承接。
 *
 * 下面那块是结论，不是对话：还没定的问题与已确认的需求。它们写回卡片之后
 * 才会被执行体读到——聊天记录本身不进卡片，也不进 git。
 */
function DiscussionEditor({
  turns,
  question,
  confirmed,
  busy,
  autoFocus,
  replying,
  firstMessage,
  round,
  sourceTask,
  onSend,
  onSay,
  onDiscard,
  onClose,
}: {
  /** 这一轮讨论的对话记录，按时间先后 */
  turns: DiscussionTurn[];
  question: string | null;
  confirmed: string | null;
  busy: boolean;
  autoFocus?: boolean;
  /** 第一句已经发出去了，正在等 Router 回第一句 */
  replying?: boolean;
  /** 刚发出去、还没写进 timeline 的第一句 */
  firstMessage?: string | null;
  round?: number | null;
  sourceTask?: string | null;
  /** 发送任务：讨论结束，卡片转成执行卡 */
  onSend: () => Promise<boolean>;
  /** 跟 Router 说一句；返回是否成功 */
  onSay: (message: string) => Promise<boolean>;
  onDiscard?: () => Promise<void>;
  /** 保存草稿退出：只关详情页，卡片与这一轮的记录都留着 */
  onClose?: () => void;
}) {
  const { t } = useTranslation();
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [committing, setCommitting] = useState(false);
  const endRef = useRef<HTMLDivElement | null>(null);
  // 等 Router 的两条路径（自己发的一句、看板带过来的第一句）要一起算，
  // 否则后者的那几十秒里输入框看起来是空闲的，用户会再发一遍。
  const waiting = sending || Boolean(replying);
  // 第一句只在它还没进 timeline 时才当本地气泡显示：轮询拉到后端已写入的那句之后，
  // 两边会同时出现，同一句话在对话里出现两遍。
  const pendingFirst = turns.length === 0 ? firstMessage : null;

  // 新回复到了就沉到底：这一块是聊天，最新一句应该在视线里。
  // `scrollIntoView` 在 jsdom 里不存在，用可选调用：测试环境不该因为它挂掉。
  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [turns.length, sending, replying]);

  /**
   * 一句发言交给 Router。手打与表单提交共用这一条：两者都要把界面同时推进等待态
   * （「Lead 正在回复…」、输入框与发送键锁住），否则在表单里点提交之后，屏幕上
   * 什么都没变，看着像没提交上，用户会再点一次或改用输入框重说一遍。
   */
  const say = async (text: string): Promise<boolean> => {
    setSending(true);
    try {
      return await onSay(text);
    } finally {
      setSending(false);
    }
  };

  const send = async () => {
    const text = message.trim();
    if (!text || waiting || busy) return;
    // 成功才清空：失败（模型没配、网关没起来）时这句话还在，按一次重发即可
    if (await say(text)) setMessage("");
  };

  const sendTask = async () => {
    if (committing || waiting || busy) return;
    setCommitting(true);
    try {
      await onSend();
    } finally {
      setCommitting(false);
    }
  };

  const disabled = busy || waiting || committing;

  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="m-0 flex items-center gap-1.5 text-body font-medium text-fg-1">
          <MessageSquare
            aria-hidden="true"
            className="size-3.5 text-fg-3"
            strokeWidth={1.5}
          />
          {t("tasks.discussion.title")}
          {round ? (
            <span className="text-caption font-normal text-fg-3">
              {t("tasks.discussion.round", { round })}
            </span>
          ) : null}
        </h3>
        <span className="text-caption text-fg-3">
          {sourceTask
            ? t("tasks.discussion.source", { id: sourceTask })
            : t("tasks.discussion.hint")}
        </span>
      </div>

      <div
        className="max-h-[300px] space-y-2 overflow-y-auto rounded-panel border border-border px-3 py-2"
        aria-live="polite"
      >
        {turns.length === 0 && !pendingFirst ? (
          <p className="m-0 text-caption leading-relaxed text-fg-3">
            {t("tasks.discussion.emptyTimeline")}
          </p>
        ) : null}
        {turns.map((turn, index) => {
          // 只有最新一轮的表单还能填：用户答过之后就有新的发言，那一轮不再是
          // 最后一条，表单自然收起，不用额外存一个「已提交」状态。
          // 等待回复期间仍然留着它（只是禁用），别让刚填的答案在「Lead 正在回复…」
          // 那几十秒里凭空消失。
          const pendingForm =
            turn.form && index === turns.length - 1 ? turn.form : null;
          return (
            <div
              key={`${turn.createdAt}-${index}`}
              className="flex flex-col gap-1.5"
            >
              <div
                className={cn(
                  "max-w-[85%] rounded-panel px-2.5 py-1.5",
                  turn.role === "user"
                    ? "self-end bg-selected text-fg-1"
                    : "self-start border border-border bg-subtle text-fg-1",
                )}
              >
                <span className="mb-0.5 block text-[11px] text-fg-3">
                  {turn.role === "user"
                    ? t("tasks.discussion.you")
                    : t("tasks.discussion.router")}
                </span>
                <TaskMarkdown
                  content={turn.text}
                  variant="note"
                  className="text-fg-1 [&_p]:my-0.5"
                />
              </div>
              {pendingForm ? (
                <DiscussionFormCard
                  form={pendingForm}
                  disabled={disabled}
                  onSubmit={say}
                />
              ) : null}
            </div>
          );
        })}
        {/* 第一句已经发出去了，但 Router 还没回：先把它显示出来。否则用户打开
            详情页看到的是一片空白，会以为那句话根本没发出去而重打一遍。 */}
        {pendingFirst ? (
          <div className="flex justify-end">
            <div className="max-w-[85%] rounded-panel bg-selected px-2.5 py-1.5 text-fg-1">
              <span className="mb-0.5 block text-[11px] text-fg-3">
                {t("tasks.discussion.you")}
              </span>
              <TaskMarkdown
                content={pendingFirst}
                variant="note"
                className="text-fg-1 [&_p]:my-0.5"
              />
            </div>
          </div>
        ) : null}
        {waiting ? (
          <p className="m-0 text-caption text-fg-3">
            {t("tasks.discussion.thinking")}
          </p>
        ) : null}
        <div ref={endRef} />
      </div>

      <div className="space-y-1.5">
        <Textarea
          id="task-discussion-message"
          value={message}
          maxLength={8000}
          disabled={busy || waiting}
          autoFocus={autoFocus}
          placeholder={t("tasks.discussion.sayPlaceholder")}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            // 一句话就够：Ctrl/Cmd+Enter 发送，普通回车留给换行
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              void send();
            }
          }}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="compact"
            disabled={busy || waiting || !message.trim()}
            onClick={() => void send()}
          >
            {t("tasks.discussion.send")}
          </Button>
          <span className="text-[11px] text-fg-3">
            {t("tasks.discussion.sendHint")}
          </span>
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 pt-1">
        <span className="text-caption font-medium text-fg-2">
          {t("tasks.discussion.conclusionTitle")}
        </span>
        <span className="text-[11px] text-fg-3">
          {t("tasks.discussion.conclusionHint")}
        </span>
      </div>

      {/* 结论由讨论产生，不让人手抄：上面说定的内容由 Router 每轮写回，
          这里只读。手写一遍等于把讨论重做一遍，而且两份必然对不上。 */}
      <div className="space-y-1.5">
        <span className="text-caption text-fg-2">
          {t("tasks.discussion.questionLabel")}
        </span>
        <TaskMarkdown
          content={question ?? t("tasks.discussion.questionEmpty")}
          variant="note"
          className={cn(
            "rounded-panel border border-border px-3 py-2",
            question ? "text-fg-1" : "text-fg-3",
          )}
        />
      </div>

      <div className="space-y-1.5">
        <span className="text-caption text-fg-2">
          {t("tasks.discussion.confirmedLabel")}
        </span>
        <TaskMarkdown
          content={confirmed ?? t("tasks.discussion.confirmedEmpty")}
          variant="note"
          className={cn(
            "rounded-panel border border-border px-3 py-2",
            confirmed ? "text-fg-1" : "text-fg-3",
          )}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {onDiscard ? (
          // 删除是这张卡最末的一条出路：留着当草稿、发送成任务都在它右边。
          // 用文字按钮而不是红色实心，避免和「发送任务」抢视线。
          <Button
            variant="ghost"
            size="compact"
            disabled={disabled}
            className="text-danger-text hover:bg-danger-soft hover:text-danger-text"
            onClick={() => void onDiscard()}
          >
            <Trash2 aria-hidden="true" data-icon />
            {t("tasks.discussion.discard")}
          </Button>
        ) : null}
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="compact"
          disabled={!onClose || waiting || committing}
          onClick={() => onClose?.()}
        >
          {t("tasks.discussion.closeDraft")}
        </Button>
        <Button
          size="compact"
          disabled={disabled}
          onClick={() => void sendTask()}
        >
          {t("tasks.discussion.sendTask")}
        </Button>
      </div>
    </section>
  );
}

/**
 * timeline 里的表单：Router 要把两三个具体取值问清楚时，用户在这里直接填、直接提交。
 *
 * 提交出去的是一句话，而不是一段 JSON：它和用户手写一样走 `onSay`，Router 那边的
 * 协议没变，历史记录里也是一句正常的话。用户仍然可以直接打字绕开表单——表单是
 * 少打几个字，不是新的必填关卡。
 */
function DiscussionFormCard({
  form,
  disabled,
  onSubmit,
}: {
  form: DiscussionForm;
  disabled: boolean;
  /** 跟 Router 说一句；返回是否成功 */
  onSubmit: (message: string) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  // 下拉框默认取第一项：Radix 的 Select 没有「未选」这个能显示的态，
  // 空白值只会让人以为它坏了。文本项保持空着，让人自己填。
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      form.fields.map((field) => [
        field.id,
        field.type === "choice" ? (field.options[0] ?? "") : "",
      ]),
    ),
  );
  const [sending, setSending] = useState(false);
  const missing = form.fields.some(
    (field) => field.required && !(values[field.id] ?? "").trim(),
  );
  const blocked = disabled || sending;

  const submit = async () => {
    if (blocked || missing) return;
    // 逐行「问题 答案」：和手打的一句话同构，Router 不需要第二个解析入口。
    const lines = form.fields.map(
      (field) => `${field.label} ${(values[field.id] ?? "").trim()}`,
    );
    setSending(true);
    try {
      await onSubmit(lines.join("\n"));
    } finally {
      setSending(false);
    }
  };

  return (
    <div
      className="space-y-2 rounded-panel border border-border bg-subtle px-3 py-2"
      // 填完不用回鼠标：Ctrl/⌘+Enter 提交，与下面的输入框是同一套键
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
          event.preventDefault();
          void submit();
        }
      }}
    >
      {form.title ? (
        <p className="m-0 text-caption font-medium text-fg-1">{form.title}</p>
      ) : null}
      {form.fields.map((field) => (
        <div key={field.id} className="space-y-1">
          <Label
            htmlFor={`discussion-form-${field.id}`}
            className="text-caption text-fg-2"
          >
            {field.label}
          </Label>
          {field.type === "choice" ? (
            <Select
              value={values[field.id] ?? ""}
              onValueChange={(value) =>
                setValues((current) => ({ ...current, [field.id]: value }))
              }
              disabled={blocked}
            >
              <SelectTrigger
                id={`discussion-form-${field.id}`}
                className="w-full"
                aria-label={field.label}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {field.options.map((option) => (
                  <SelectItem key={option} value={option}>
                    {option}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Input
              id={`discussion-form-${field.id}`}
              value={values[field.id] ?? ""}
              placeholder={field.placeholder ?? undefined}
              disabled={blocked}
              onChange={(event) =>
                setValues((current) => ({
                  ...current,
                  [field.id]: event.target.value,
                }))
              }
            />
          )}
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pt-0.5">
        <span className="text-[11px] text-fg-3">
          {t("tasks.discussion.formHint")}
        </span>
        <Button
          // 卡片自身就是 bg-subtle：只靠悬停底色的变体在这里既没有边、也没有
          // 悬停变化，看起来只是一行字。提交键用描边档，才看得出是个按钮。
          variant="neutral"
          size="compact"
          // 窄到换行时也贴右：`ms-auto` 比父容器的 justify-between 更稳（换行后
          // 单独一行的那一个仍会被推到右边）。
          className="ms-auto"
          disabled={blocked || missing}
          onClick={() => void submit()}
        >
          {t("tasks.discussion.formSubmit")}
        </Button>
      </div>
    </div>
  );
}
