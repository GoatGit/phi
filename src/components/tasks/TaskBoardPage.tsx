import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import {
  FolderPlus,
  GripVertical,
  MoreHorizontal,
  Plus,
  RefreshCw,
  SquareKanban,
} from "lucide-react";
import { AppPageHeader } from "@/components/shell/AppPageHeader";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Notice } from "@/components/ui/notice";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { orchestrationApi, type RelayView } from "@/lib/api/orchestration";
import { settingsApi } from "@/lib/api/settings";
import {
  taskErrorMessage,
  tasksApi,
  type TaskBoard,
  type TaskCard,
  type TaskDetail,
  type TaskWorkspace,
} from "@/lib/api/tasks";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { TaskDetailSheet } from "./TaskDetailSheet";

const ROOT_STORAGE_KEY = "phi.task.workspace";
const PRIORITIES = ["high", "medium", "low"] as const;

interface TaskBoardPageProps {
  /** 能开本地终端会话的应用（为空表示当前平台不支持） */
  terminalApps: string[];
  /** 在指定应用、指定目录开一个会话，返回会话 ID；失败时抛错 */
  onStartSession: (root: string, appId: string) => Promise<string>;
}

function readStoredRoot() {
  try {
    return localStorage.getItem(ROOT_STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * 侧栏一级入口「任务」：直接读仓库里的 Backlog.md 任务文件。
 *
 * 阶段一只做三件事——看板、把任务变成终端会话、把会话与用量回挂到任务。
 * 任务本身永远是用户仓库里的 markdown，phi 不替它建第二份数据。
 */
export function TaskBoardPage({
  terminalApps,
  onStartSession,
}: TaskBoardPageProps) {
  const { t } = useTranslation();
  const [workspaces, setWorkspaces] = useState<TaskWorkspace[]>([]);
  const [activeRoot, setActiveRoot] = useState<string | null>(() =>
    readStoredRoot(),
  );
  const [board, setBoard] = useState<TaskBoard | null>(null);
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  /** 编排接力视图：跟着详情一起读，详情关掉就清 */
  const [relay, setRelay] = useState<RelayView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [initTarget, setInitTarget] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<string | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<TaskCard | null>(null);
  const [dragging, setDragging] = useState<TaskCard | null>(null);

  const active = workspaces.find((entry) => entry.root === activeRoot) ?? null;

  const loadWorkspaces = useCallback(async () => {
    const list = await tasksApi.workspaces();
    setWorkspaces(list);
    return list;
  }, []);

  const loadBoard = useCallback(async (root: string) => {
    const next = await tasksApi.board(root);
    setBoard(next);
    return next;
  }, []);

  useEffect(() => {
    let disposed = false;
    void (async () => {
      try {
        const list = await loadWorkspaces();
        if (disposed) return;
        const stored = readStoredRoot();
        const preferred =
          list.find((entry) => entry.root === stored && entry.valid) ??
          list.find((entry) => entry.valid) ??
          null;
        if (preferred) {
          setActiveRoot(preferred.root);
          await loadBoard(preferred.root);
        }
      } catch (error) {
        if (!disposed) toast.error(taskErrorMessage(error, t));
      } finally {
        if (!disposed) setLoading(false);
      }
    })();
    return () => {
      disposed = true;
    };
  }, [loadWorkspaces, loadBoard, t]);

  const selectWorkspace = async (root: string) => {
    setActiveRoot(root);
    setDetail(null);
    setRelay(null);
    try {
      localStorage.setItem(ROOT_STORAGE_KEY, root);
    } catch {
      // 存不了就算了：下次启动用第一个工作区
    }
    try {
      await loadBoard(root);
    } catch (error) {
      setBoard(null);
      toast.error(taskErrorMessage(error, t));
    }
  };

  /**
   * 接力面板是详情页的附加视图。读不到时只报错、返回 null，
   * 不能让整个卡片打不开（工作区没登记、卡片 frontmatter 坏了都可能命中）。
   */
  const readRelay = async (root: string, taskId: string) => {
    try {
      return await orchestrationApi.relay(root, taskId);
    } catch (error) {
      toast.error(taskErrorMessage(error, t));
      return null;
    }
  };

  const reload = async (root: string | null = activeRoot) => {
    if (!root) return;
    try {
      await loadBoard(root);
      if (detail) {
        const [fresh, view] = await Promise.all([
          tasksApi.detail(root, detail.task.id),
          readRelay(root, detail.task.id),
        ]);
        setDetail(fresh);
        setRelay(view);
      }
    } catch (error) {
      if (String(error) === "stale-fingerprint") {
        toast.info(t("tasks.errors.stale"));
        await loadBoard(root);
      } else {
        toast.error(taskErrorMessage(error, t));
      }
    }
  };

  const handleAddWorkspace = async () => {
    const directory = await settingsApi.pickDirectory().catch(() => null);
    if (!directory) return;
    try {
      const info = await tasksApi.addWorkspace(directory);
      await loadWorkspaces();
      await selectWorkspace(info.root);
    } catch (error) {
      if (String(error) === "no-backlog") {
        setInitTarget(directory);
        return;
      }
      toast.error(taskErrorMessage(error, t));
    }
  };

  const handleInit = async (root: string) => {
    setInitTarget(null);
    try {
      const info = await tasksApi.initWorkspace(root);
      await loadWorkspaces();
      await selectWorkspace(info.root);
      toast.success(t("tasks.initDone"));
    } catch (error) {
      toast.error(taskErrorMessage(error, t));
    }
  };

  const handleRemove = async (root: string) => {
    setRemoveTarget(null);
    try {
      await tasksApi.removeWorkspace(root);
      const list = await loadWorkspaces();
      const next = list.find((entry) => entry.valid) ?? null;
      setBoard(null);
      setDetail(null);
      setRelay(null);
      if (next) await selectWorkspace(next.root);
      else setActiveRoot(null);
    } catch (error) {
      toast.error(taskErrorMessage(error, t));
    }
  };

  const handleSetStatus = async (task: TaskCard, status: string) => {
    if (!activeRoot || task.status === status) return;
    setBusy(true);
    try {
      const fresh = await tasksApi.setStatus(
        activeRoot,
        task.id,
        status,
        task.fingerprint,
      );
      setDetail((current) =>
        current && current.task.id === fresh.task.id ? fresh : current,
      );
      await loadBoard(activeRoot);
    } catch (error) {
      toast.error(taskErrorMessage(error, t));
      if (String(error) === "stale-fingerprint") await loadBoard(activeRoot);
    } finally {
      setBusy(false);
    }
  };

  const handleArchive = (task: TaskCard) => setArchiveTarget(task);

  const confirmArchive = async () => {
    const task = archiveTarget;
    setArchiveTarget(null);
    if (!task || !activeRoot) return;
    setBusy(true);
    try {
      await tasksApi.archive(activeRoot, task.id, task.fingerprint);
      setDetail((current) => (current?.task.id === task.id ? null : current));
      setRelay(null);
      await loadBoard(activeRoot);
      toast.success(t("tasks.archived"));
    } catch (error) {
      toast.error(taskErrorMessage(error, t));
      if (String(error) === "stale-fingerprint") await loadBoard(activeRoot);
    } finally {
      setBusy(false);
    }
  };

  const handleStartSession = async (task: TaskCard, appId: string) => {
    if (!activeRoot) return;
    setBusy(true);
    try {
      const sessionId = await onStartSession(activeRoot, appId);
      await tasksApi.linkSession(activeRoot, task.id, sessionId, appId);
      const fresh = await tasksApi.detail(activeRoot, task.id);
      setDetail((current) =>
        current && current.task.id === task.id ? fresh : current,
      );
    } catch (error) {
      toast.error(taskErrorMessage(error, t));
    } finally {
      setBusy(false);
    }
  };

  const handleUnlink = async (sessionId: string) => {
    if (!activeRoot || !detail) return;
    setBusy(true);
    try {
      await tasksApi.unlinkSession(activeRoot, detail.task.id, sessionId);
      setDetail(await tasksApi.detail(activeRoot, detail.task.id));
    } catch (error) {
      toast.error(taskErrorMessage(error, t));
    } finally {
      setBusy(false);
    }
  };

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor),
  );
  const tasksById = useMemo(() => {
    const map = new Map<string, TaskCard>();
    for (const column of board?.columns ?? []) {
      for (const task of column.tasks) map.set(task.id, task);
    }
    return map;
  }, [board]);

  const handleDragEnd = (event: DragEndEvent) => {
    const overId = event.over?.id;
    if (typeof overId !== "string" || !overId.startsWith("column:")) return;
    const task = tasksById.get(String(event.active.id));
    if (!task) return;
    void handleSetStatus(task, overId.slice("column:".length));
  };

  const renderEmptyState = () => (
    <div className="flex min-h-0 flex-1 items-center justify-center p-8">
      <div className="max-w-md text-center">
        <SquareKanban
          aria-hidden="true"
          strokeWidth={1.5}
          className="mx-auto size-8 text-fg-3"
        />
        <h2 className="mt-3 text-section font-medium">
          {t("tasks.emptyTitle")}
        </h2>
        <p className="mt-2 text-caption leading-relaxed text-fg-2">
          {t("tasks.emptyHint")}
        </p>
        <Button
          variant="solid"
          className="mt-4"
          onClick={() => void handleAddWorkspace()}
        >
          <FolderPlus data-icon className="h-3.5 w-3.5" strokeWidth={1.5} />
          {t("tasks.addWorkspace")}
        </Button>
      </div>
    </div>
  );

  const renderBody = () => {
    if (loading) {
      return (
        <div className="p-6 text-caption text-fg-3">{t("tasks.loading")}</div>
      );
    }
    if (workspaces.length === 0) {
      return renderEmptyState();
    }
    if (active && !active.valid) {
      return (
        <div className="p-4">
          <Notice
            tone="danger"
            title={t("tasks.errors.invalidWorkspace")}
            actions={
              <>
                <Button
                  variant="neutral"
                  size="compact"
                  onClick={() => setInitTarget(active.root)}
                >
                  {t("tasks.initWorkspace")}
                </Button>
                <Button
                  variant="ghost"
                  size="compact"
                  onClick={() => setRemoveTarget(active.root)}
                >
                  {t("tasks.removeWorkspace")}
                </Button>
              </>
            }
          >
            {active.root}
          </Notice>
        </div>
      );
    }
    if (!board) {
      // 登记过但一个都打不开时，不要停在「正在读取」上
      return active ? (
        <div className="p-6 text-caption text-fg-3">{t("tasks.loading")}</div>
      ) : (
        renderEmptyState()
      );
    }
    return (
      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={(event: DragStartEvent) => {
          setDragging(tasksById.get(String(event.active.id)) ?? null);
        }}
        onDragCancel={() => setDragging(null)}
        onDragEnd={(event) => {
          setDragging(null);
          handleDragEnd(event);
        }}
      >
        <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto scroll-stable p-4">
          {board.columns.map((column) => (
            <BoardColumnView
              key={column.status}
              status={column.status}
              tasks={column.tasks}
              draggingId={dragging?.id ?? null}
              onOpen={(task) => void openDetail(task)}
            />
          ))}
        </div>
        <DragOverlay dropAnimation={null}>
          {dragging ? <CardPreview task={dragging} /> : null}
        </DragOverlay>
      </DndContext>
    );
  };

  const openDetail = async (task: TaskCard) => {
    if (!activeRoot) return;
    try {
      const [nextDetail, nextRelay] = await Promise.all([
        tasksApi.detail(activeRoot, task.id),
        readRelay(activeRoot, task.id),
      ]);
      setDetail(nextDetail);
      setRelay(nextRelay);
    } catch (error) {
      toast.error(taskErrorMessage(error, t));
    }
  };

  /** 门判定会往卡片里回写结论，所以判完必须重读详情与看板。 */
  const handleRunGate = async (gate: 2 | 3) => {
    if (!activeRoot || !detail) return;
    const taskId = detail.task.id;
    setBusy(true);
    try {
      const run = await orchestrationApi.runGate(activeRoot, taskId, gate);
      const [fresh, view] = await Promise.all([
        tasksApi.detail(activeRoot, taskId),
        readRelay(activeRoot, taskId),
      ]);
      setDetail((current) => (current?.task.id === taskId ? fresh : current));
      setRelay(view);
      await loadBoard(activeRoot);
      const status = t(`tasks.relay.status.${run.status}`, {
        defaultValue: run.status,
      });
      const message = t("tasks.relay.gateDone", { gate, status });
      if (run.status === "pass") toast.success(message);
      else toast.info(message);
    } catch (error) {
      toast.error(taskErrorMessage(error, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <AppPageHeader
        variant="page"
        icon={<SquareKanban className="size-[22px]" strokeWidth={1.5} />}
        title={t("tasks.title")}
        titleExtra={
          board ? (
            <span className="rounded-full bg-subtle px-2 py-0.5 text-caption text-fg-2">
              {board.projectName}
            </span>
          ) : null
        }
        actions={
          workspaces.length > 0 ? (
            <>
              <Select
                value={activeRoot ?? undefined}
                onValueChange={(root) => void selectWorkspace(root)}
              >
                <SelectTrigger
                  className="w-[180px]"
                  aria-label={t("tasks.workspace")}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {workspaces.map((entry) => (
                    <SelectItem
                      key={entry.root}
                      value={entry.root}
                      disabled={!entry.valid}
                    >
                      {entry.projectName ?? entry.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                variant="ghost"
                size="icon-compact"
                aria-label={t("tasks.refresh")}
                title={t("tasks.refresh")}
                onClick={() => void reload()}
              >
                <RefreshCw
                  data-icon
                  className="h-3.5 w-3.5"
                  strokeWidth={1.5}
                />
              </Button>
              <Button
                variant="solid"
                size="compact"
                disabled={!board}
                onClick={() => setCreateOpen(true)}
              >
                <Plus data-icon className="h-3.5 w-3.5" strokeWidth={1.5} />
                {t("tasks.newTask")}
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-compact"
                    aria-label={t("tasks.moreActions")}
                  >
                    <MoreHorizontal
                      data-icon
                      className="h-3.5 w-3.5"
                      strokeWidth={1.5}
                    />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => void handleAddWorkspace()}>
                    {t("tasks.addWorkspace")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={!active}
                    onSelect={() => active && setRemoveTarget(active.root)}
                  >
                    {t("tasks.removeWorkspace")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          ) : null
        }
      />
      {renderBody()}

      <TaskDetailSheet
        detail={detail}
        relay={relay}
        statuses={board?.statuses ?? []}
        terminalApps={terminalApps}
        busy={busy}
        onClose={() => {
          setDetail(null);
          setRelay(null);
        }}
        onSetStatus={(status) => {
          if (detail) void handleSetStatus(detail.task, status);
        }}
        onArchive={() => {
          if (detail) handleArchive(detail.task);
        }}
        onStartSession={(appId) => {
          if (detail) void handleStartSession(detail.task, appId);
        }}
        onUnlink={(sessionId) => void handleUnlink(sessionId)}
        onRunGate={(gate) => void handleRunGate(gate)}
      />

      <CreateTaskDialog
        open={createOpen}
        statuses={board?.statuses ?? []}
        defaultStatus={board?.defaultStatus ?? "To Do"}
        onClose={() => setCreateOpen(false)}
        onSubmit={async (input) => {
          if (!activeRoot || !board) return null;
          const created = await tasksApi.create(activeRoot, input);
          await loadBoard(activeRoot);
          return created;
        }}
        onCreated={(created) => {
          setCreateOpen(false);
          setDetail(created);
          // 新卡还没读接力视图，等下次打开详情再读
          setRelay(null);
        }}
      />

      <ConfirmDialog
        isOpen={Boolean(initTarget)}
        variant="info"
        title={t("tasks.initTitle")}
        message={t("tasks.initMessage")}
        confirmText={t("tasks.initWorkspace")}
        onConfirm={() => {
          if (initTarget) void handleInit(initTarget);
          else setInitTarget(null);
        }}
        onCancel={() => setInitTarget(null)}
      />
      <ConfirmDialog
        isOpen={Boolean(removeTarget)}
        title={t("tasks.removeWorkspace")}
        message={t("tasks.removeWorkspaceMessage")}
        confirmText={t("tasks.removeWorkspace")}
        onConfirm={() => {
          if (removeTarget) void handleRemove(removeTarget);
          else setRemoveTarget(null);
        }}
        onCancel={() => setRemoveTarget(null)}
      />
      <ConfirmDialog
        isOpen={Boolean(archiveTarget)}
        title={t("tasks.archiveTitle")}
        message={t("tasks.archiveMessage")}
        confirmText={t("tasks.archive")}
        pending={busy}
        onConfirm={() => void confirmArchive()}
        onCancel={() => setArchiveTarget(null)}
      />
    </div>
  );
}

function BoardColumnView({
  status,
  tasks,
  draggingId,
  onOpen,
}: {
  status: string;
  tasks: TaskCard[];
  draggingId: string | null;
  onOpen: (task: TaskCard) => void;
}) {
  const { t } = useTranslation();
  const { setNodeRef, isOver } = useDroppable({ id: `column:${status}` });

  return (
    <section
      ref={setNodeRef}
      aria-label={status}
      className={cn(
        "flex w-[300px] shrink-0 flex-col rounded-panel border border-border bg-subtle/40 transition-colors",
        isOver && "border-border-strong bg-selected/40",
      )}
    >
      <header className="flex h-9 shrink-0 items-center gap-2 px-3">
        <h2 className="m-0 truncate text-body font-medium text-fg-1">
          {status}
        </h2>
        <span className="shrink-0 text-caption tabular-nums text-fg-3">
          {tasks.length}
        </span>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto scroll-stable px-2 pb-2">
        {tasks.length === 0 ? (
          <p className="m-0 px-2 py-3 text-caption text-fg-3">
            {t("tasks.columnEmpty")}
          </p>
        ) : (
          tasks.map((task) => (
            <TaskCardView
              key={task.id}
              task={task}
              dragging={draggingId === task.id}
              onOpen={onOpen}
            />
          ))
        )}
      </div>
    </section>
  );
}

function TaskCardView({
  task,
  dragging,
  onOpen,
}: {
  task: TaskCard;
  dragging: boolean;
  onOpen: (task: TaskCard) => void;
}) {
  const { t } = useTranslation();
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    isDragging,
  } = useDraggable({ id: task.id, data: { task } });

  return (
    <article
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform) }}
      className={cn(
        "group relative rounded-control border border-border bg-surface transition-shadow hover:shadow-v7-sm",
        (isDragging || dragging) && "opacity-40",
      )}
    >
      <button
        type="button"
        onClick={() => onOpen(task)}
        className="block w-full rounded-control p-2.5 pe-7 text-start"
        aria-label={task.title}
      >
        <span className="block text-caption font-medium leading-snug text-fg-1 [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:3] overflow-hidden">
          {task.title}
        </span>
        <span className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-fg-3">
          <span className="font-mono">{task.id}</span>
          {task.priority ? (
            <span
              className={cn(
                "rounded-full px-1.5 py-[1px]",
                task.priority === "high"
                  ? "bg-danger-soft text-danger-text"
                  : task.priority === "low"
                    ? "bg-subtle text-fg-3"
                    : "bg-warning-soft text-warning-text",
              )}
            >
              {t(`tasks.priorityLevel.${task.priority}`, {
                defaultValue: task.priority,
              })}
            </span>
          ) : null}
          {task.acceptanceTotal > 0 ? (
            <span className="tabular-nums">
              {task.acceptanceDone}/{task.acceptanceTotal}
            </span>
          ) : null}
          {task.assignees.map((assignee) => (
            <span key={assignee} className="truncate">
              {assignee}
            </span>
          ))}
        </span>
      </button>
      <button
        ref={setActivatorNodeRef}
        type="button"
        {...attributes}
        {...listeners}
        aria-label={t("tasks.dragHint")}
        title={t("tasks.dragHint")}
        className="absolute end-1 top-1 flex size-6 cursor-grab items-center justify-center rounded-control text-fg-3 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 active:cursor-grabbing"
      >
        <GripVertical
          aria-hidden="true"
          className="h-3.5 w-3.5"
          strokeWidth={1.5}
        />
      </button>
    </article>
  );
}

/** 拖拽时跟随指针的卡片副本：列本身是滚动容器，不套 DragOverlay 会被裁掉。 */
function CardPreview({ task }: { task: TaskCard }) {
  return (
    <div className="w-[284px] rounded-control border border-border bg-surface p-2.5 shadow-v7-md">
      <span className="block text-caption font-medium leading-snug text-fg-1 [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:3] overflow-hidden">
        {task.title}
      </span>
      <span className="mt-1.5 block font-mono text-[11px] text-fg-3">
        {task.id}
      </span>
    </div>
  );
}

function CreateTaskDialog({
  open,
  statuses,
  defaultStatus,
  onClose,
  onSubmit,
  onCreated,
}: {
  open: boolean;
  statuses: string[];
  defaultStatus: string;
  onClose: () => void;
  onSubmit: (input: {
    title: string;
    description: string;
    status: string;
    priority: string;
    acceptance: string[];
  }) => Promise<TaskDetail | null>;
  onCreated: (detail: TaskDetail) => void;
}) {
  const { t } = useTranslation();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState(defaultStatus);
  const [priority, setPriority] = useState("medium");
  const [acceptance, setAcceptance] = useState("");
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (open) {
      setTitle("");
      setDescription("");
      setStatus(defaultStatus);
      setPriority("medium");
      setAcceptance("");
    }
  }, [open, defaultStatus]);

  const submit = async () => {
    if (!title.trim() || pending) return;
    setPending(true);
    try {
      const created = await onSubmit({
        title: title.trim(),
        description,
        status,
        priority,
        acceptance: acceptance
          .split("\n")
          .map((line) => line.replace(/^\s*[-*]\s*\[[ xX]\]\s*/, "").trim())
          .filter(Boolean),
      });
      if (created) onCreated(created);
    } catch (error) {
      toast.error(taskErrorMessage(error, t));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="w-[520px] max-w-[92vw]">
        <DialogHeader>
          <DialogTitle>{t("tasks.create.title")}</DialogTitle>
          <DialogDescription>{t("tasks.create.description")}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="task-title">{t("tasks.create.titleLabel")}</Label>
            <Input
              id="task-title"
              autoFocus
              value={title}
              placeholder={t("tasks.create.titlePlaceholder")}
              onChange={(event) => setTitle(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="task-description">
              {t("tasks.create.descriptionLabel")}
            </Label>
            <Textarea
              id="task-description"
              rows={4}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="task-status">{t("tasks.status")}</Label>
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger id="task-status" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {statuses.map((item) => (
                    <SelectItem key={item} value={item}>
                      {item}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="task-priority">{t("tasks.priority")}</Label>
              <Select value={priority} onValueChange={setPriority}>
                <SelectTrigger id="task-priority" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PRIORITIES.map((item) => (
                    <SelectItem key={item} value={item}>
                      {t(`tasks.priorityLevel.${item}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="task-acceptance">
              {t("tasks.create.acceptanceLabel")}
            </Label>
            <Textarea
              id="task-acceptance"
              rows={3}
              value={acceptance}
              placeholder={t("tasks.create.acceptancePlaceholder")}
              onChange={(event) => setAcceptance(event.target.value)}
            />
          </div>
          <p className="m-0 text-caption text-fg-3">{t("tasks.create.hint")}</p>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" size="compact" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="solid"
            size="compact"
            disabled={!title.trim() || pending}
            onClick={() => void submit()}
          >
            {t("tasks.create.submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
