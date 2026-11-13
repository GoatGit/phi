import { useTranslation } from "react-i18next";
import { Archive, Link2Off, Play, SquareTerminal } from "lucide-react";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getAppDisplayName } from "@/components/shell/AppGlyph";
import { fmtUsd } from "@/components/usage/format";
import type { RelayView } from "@/lib/api/orchestration";
import type { TaskDetail } from "@/lib/api/tasks";
import { cn } from "@/lib/utils";
import { TaskRelayPanel } from "./TaskRelayPanel";

interface TaskDetailSheetProps {
  detail: TaskDetail | null;
  /** 编排接力视图：卡片没有契约时也可能有（会提示缺什么） */
  relay: RelayView | null;
  statuses: string[];
  /** 可以开终端会话的应用；空数组表示这台机器 / 平台不支持 */
  terminalApps: string[];
  busy: boolean;
  onClose: () => void;
  onSetStatus: (status: string) => void;
  onArchive: () => void;
  onStartSession: (appId: string) => void;
  onUnlink: (sessionId: string) => void;
  onRunGate: (gate: 2 | 3) => void;
}

function Meta({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex min-w-0 items-baseline gap-2">
      <span className="shrink-0 text-caption text-fg-3">{label}</span>
      <span className="min-w-0 truncate text-caption text-fg-1">{value}</span>
    </div>
  );
}

/** 任务详情抽屉：只读正文 + 三个写操作（改状态、归档、开始会话）。 */
export function TaskDetailSheet({
  detail,
  relay,
  statuses,
  terminalApps,
  busy,
  onClose,
  onSetStatus,
  onArchive,
  onStartSession,
  onUnlink,
  onRunGate,
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
                    {detail.links.map((link) => (
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
                    ))}
                  </ul>
                )}
              </section>

              {relay && relay.taskId === task.id ? (
                <TaskRelayPanel
                  relay={relay}
                  busy={busy}
                  onRunGate={onRunGate}
                />
              ) : null}

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
              {terminalApps.length === 0 ? (
                <Button
                  variant="solid"
                  size="compact"
                  disabled
                  title={t("tasks.errors.terminalUnsupported")}
                >
                  <Play data-icon className="h-3.5 w-3.5" strokeWidth={1.5} />
                  {t("tasks.startSession")}
                </Button>
              ) : (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="solid"
                      size="compact"
                      disabled={busy}
                      aria-label={t("tasks.startSession")}
                    >
                      <Play
                        data-icon
                        className="h-3.5 w-3.5"
                        strokeWidth={1.5}
                      />
                      {t("tasks.startSession")}
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuLabel>
                      {t("tasks.startSessionIn")}
                    </DropdownMenuLabel>
                    {terminalApps.map((appId) => (
                      <DropdownMenuItem
                        key={appId}
                        onSelect={() => onStartSession(appId)}
                      >
                        {getAppDisplayName(appId)}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </SheetFooter>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
