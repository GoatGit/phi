import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Archive,
  ChevronRight,
  Clock,
  FileText,
  FolderOpen,
  Link2Off,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getAppDisplayName } from "@/components/shell/AppGlyph";
import { fmtUsd } from "@/components/usage/format";
import type { TaskArtifact, TaskDetail, TaskSchedule } from "@/lib/api/tasks";
import type {
  RouterHumanDecision,
  RouterPlanNode,
  RouterTaskRun,
} from "@/lib/api/superAgent";
import { cn } from "@/lib/utils";
import { AutoRouterSection } from "./AutoRouterSection";
import {
  formatBytes,
  formatStamp,
  intervalText,
  nextRunLabel,
  parseIntervalText,
  scheduleKind,
  scheduleLabel,
  type ScheduleKind,
} from "./schedule";

interface TaskDetailSheetProps {
  detail: TaskDetail | null;
  statuses: string[];

  busy: boolean;
  /** 这张卡的自动调度运行态与执行计划 */
  run: RouterTaskRun | undefined;
  plan: RouterPlanNode[];
  /** 后端当前确实持有的会话 id；不在其中的链接表示会话已结束 */
  liveSessionIds?: ReadonlySet<string>;
  /** 打开一条已有关联会话（后台派发的 worker 不会自己出现在界面上） */
  onOpenSession?: (appId: string, sessionId: string) => void;
  /** 打开这次运行的 worker：跑在 zellij 里的 worker 不在会话链接里 */
  onOpenWorker?: () => void;
  /** 改排期：两个参数最多给一个，都给 `null` 就是取消排期 */
  onSetSchedule: (recurrence: string | null, schedule: string | null) => void;
  /** 在文件管理器中显示一个产物 */
  onRevealArtifact: (path: string) => void;
  onClose: () => void;
  onAutoStart: () => void;
  onAutoPause: () => void;
  onAutoResume: () => void;
  onSetStatus: (status: string) => void;
  onArchive: () => void;
  onResolve: (decision: RouterHumanDecision) => void;
  onUnlink: (sessionId: string) => void;
}

function Meta({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex min-w-0 items-baseline gap-2">
      <span className="shrink-0 text-caption text-fg-3">{label}</span>
      <span className="min-w-0 truncate text-caption text-fg-1">{value}</span>
    </div>
  );
}

/**
 * 任务详情抽屉：先给「交付了什么」，再给过程。
 *
 * 顺序是刻意的：结果与产物在最上面，自动调度的运行细节与执行记录在其后。
 * 用户打开一张已完成的卡，想知道的是「东西在哪」，不是「第几次、退出码几」。
 */
export function TaskDetailSheet({
  detail,
  statuses,
  busy,
  run,
  plan,
  liveSessionIds,
  onOpenSession,
  onOpenWorker,
  onSetSchedule,
  onRevealArtifact,
  onClose,
  onSetStatus,
  onArchive,
  onResolve,
  onUnlink,
  onAutoStart,
  onAutoPause,
  onAutoResume,
}: TaskDetailSheetProps) {
  const { t } = useTranslation();
  const task = detail?.task ?? null;
  // 任务可能处在 config 里已删掉的列上，把它自己补进去，避免下拉选不出当前值
  const statusOptions =
    task && !statuses.includes(task.status)
      ? [...statuses, task.status]
      : statuses;
  const processSections =
    detail?.sections.filter(
      (section) => section.title !== "Acceptance Criteria",
    ) ?? [];

  return (
    <Sheet open={Boolean(detail)} onOpenChange={(open) => !open && onClose()}>
      <SheetContent width={560} closeLabel={t("common.close")}>
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
            <SheetBody className="space-y-6">
              <ResultSection
                outcome={detail.outcome}
                artifacts={detail.artifacts}
                onRevealArtifact={onRevealArtifact}
              />

              <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                <Meta
                  label={t("tasks.status")}
                  value={
                    <span className="inline-flex items-center gap-1.5">
                      <span
                        aria-hidden="true"
                        className="size-1.5 rounded-full bg-fg-3"
                      />
                      {task.status}
                    </span>
                  }
                />
                <Meta
                  label={t("tasks.priority")}
                  value={
                    task.priority
                      ? t(`tasks.priorityLevel.${task.priority}`, {
                          defaultValue: task.priority,
                        })
                      : "—"
                  }
                />
                <Meta
                  label={t("tasks.assignee")}
                  value={
                    task.assignees.length ? task.assignees.join(", ") : "—"
                  }
                />
                <Meta
                  label={t("tasks.labels")}
                  value={task.labels.length ? task.labels.join(", ") : "—"}
                />
                <Meta
                  label={t("tasks.dependencies")}
                  value={
                    task.dependencies.length
                      ? task.dependencies.join(", ")
                      : "—"
                  }
                />
                <Meta
                  label={t("tasks.acceptance")}
                  value={t("tasks.acceptanceProgress", {
                    done: task.acceptanceDone,
                    total: task.acceptanceTotal,
                  })}
                />
              </div>

              <ScheduleSection
                schedule={task.schedule}
                busy={busy}
                onSave={onSetSchedule}
              />

              <AutoRouterSection
                run={run}
                plan={plan}
                busy={busy}
                onStart={onAutoStart}
                onPause={onAutoPause}
                onResume={onAutoResume}
                onResolve={onResolve}
                onOpenWorker={
                  onOpenWorker && run?.sessionId ? onOpenWorker : undefined
                }
              />

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
                        <span
                          className={cn(
                            item.done ? "text-fg-3 line-through" : "text-fg-1",
                          )}
                        >
                          {item.text}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

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
                        <p className="m-0 whitespace-pre-wrap text-caption leading-relaxed text-fg-3">
                          {section.body}
                        </p>
                      </section>
                    ))}
                  </div>
                </details>
              ) : null}

              <section className="space-y-2">
                <h3 className="m-0 text-body font-medium text-fg-1">
                  {t("tasks.sessions")}
                </h3>
                {detail.links.length === 0 ? (
                  <p className="m-0 text-caption text-fg-3">
                    {t("tasks.noSessions")}
                  </p>
                ) : (
                  <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
                    {detail.links.map((link) => {
                      // 应用重启后后端不再持有旧会话，链接还留在数据库里。
                      // 这种情况不说成「打不开」，而是如实写「会话已结束」。
                      const live =
                        !liveSessionIds || liveSessionIds.has(link.sessionId);
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
                )}
              </section>

              <p className="m-0 break-all font-mono text-[11px] text-fg-3">
                {task.file}
              </p>
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
        <p className="m-0 whitespace-pre-wrap text-body leading-relaxed text-fg-1">
          {outcome}
        </p>
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

const MODES: ScheduleKind[] = ["none", "interval", "daily", "once"];

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
  const [value, setValue] = useState(() => {
    if (current === "interval") return intervalText(schedule?.minutes ?? null);
    if (current === "daily") return schedule?.time ?? "";
    if (current === "once") return schedule?.at ?? "";
    return "";
  });

  const placeholder =
    mode === "interval"
      ? t("tasks.schedule.placeholderInterval")
      : mode === "daily"
        ? t("tasks.schedule.placeholderDaily")
        : t("tasks.schedule.placeholderOnce");
  const interval = mode === "interval" ? parseIntervalText(value) : null;
  const valid =
    mode === "none" ||
    (mode === "interval" ? interval !== null : value.trim().length > 0);
  const label = scheduleLabel(t, schedule);
  const next = nextRunLabel(t, schedule);

  const save = () => {
    if (busy || !valid) return;
    if (mode === "none") onSave(null, null);
    else if (mode === "interval") onSave(value.trim(), null);
    else onSave(null, value.trim());
  };

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
            setValue("");
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
            {MODES.map((item) => (
              <SelectItem key={item} value={item}>
                {t(`tasks.schedule.mode.${item}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {mode === "none" ? null : (
          <Input
            className="w-[168px]"
            value={value}
            aria-label={t("tasks.schedule.value")}
            placeholder={placeholder}
            disabled={busy}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                save();
              }
            }}
          />
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
