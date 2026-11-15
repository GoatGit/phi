import { useTranslation } from "react-i18next";
import { Archive, Link2Off, SquareTerminal } from "lucide-react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getAppDisplayName } from "@/components/shell/AppGlyph";
import { fmtUsd } from "@/components/usage/format";
import type { TaskDetail } from "@/lib/api/tasks";
import type {
  RouterHumanDecision,
  RouterPlanNode,
  RouterTaskRun,
} from "@/lib/api/superAgent";
import { cn } from "@/lib/utils";
import { AutoRouterSection } from "./AutoRouterSection";

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

/** 任务详情抽屉：任务正文、统一调度操作与会话记录。 */
export function TaskDetailSheet({
  detail,
  statuses,
  busy,
  run,
  plan,
  liveSessionIds,
  onOpenSession,
  onOpenWorker,
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

              {detail.sections
                .filter((section) => section.title !== "Acceptance Criteria")
                .map((section) => (
                  <section key={section.title} className="space-y-2">
                    <h3 className="m-0 text-body font-medium text-fg-1">
                      {section.title}
                    </h3>
                    <p className="m-0 whitespace-pre-wrap text-caption leading-relaxed text-fg-2">
                      {section.body}
                    </p>
                  </section>
                ))}

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
