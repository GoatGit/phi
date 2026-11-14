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
  Check,
  ChevronDown,
  FolderMinus,
  FolderPlus,
  GripVertical,
  Plus,
  RefreshCw,
  Send,
  SquareKanban,
} from "lucide-react";
import { AppPageHeader } from "@/components/shell/AppPageHeader";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { HoverTip } from "@/components/ui/hover-tip";
import { Input, fieldClass } from "@/components/ui/input";
import { Notice } from "@/components/ui/notice";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { PluginGuide } from "@/components/plugins/PluginGlyph";
import { settingsApi } from "@/lib/api/settings";
import {
  taskErrorMessage,
  tasksApi,
  type TaskBoard,
  type TaskCard,
  type TaskDetail,
  type TaskWorkspace,
} from "@/lib/api/tasks";
import {
  superAgentApi,
  type RouterPlanNode,
  type RouterTaskRun,
} from "@/lib/api/superAgent";
import { useRouterStatus } from "@/hooks/useRouterStatus";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { AutoRouterPanel } from "./AutoRouterPanel";
import { RunStateBadge } from "./RunStateBadge";
import { TaskDetailSheet } from "./TaskDetailSheet";

const ROOT_STORAGE_KEY = "phi.task.workspace";

interface TaskBoardPageProps {
  /** 能开本地终端会话的应用（为空表示当前平台不支持） */
  terminalApps: string[];
  /** 在指定应用、指定目录开一个会话，返回会话 ID；失败时抛错 */
  onStartSession: (root: string, appId: string) => Promise<string>;
  /** 作为插件中心的一个页签嵌入：不再画自己的页头，操作行放进内容顶部 */
  embedded?: boolean;
}

function readStoredRoot() {
  try {
    return localStorage.getItem(ROOT_STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * 任务看板：直接读仓库里的 Backlog.md 任务文件。
 *
 * 阶段一只做三件事——看板、把任务变成终端会话、把会话与用量回挂到任务。
 * 任务本身永远是用户仓库里的 markdown，phi 不替它建第二份数据。
 * 入口在插件中心（`plugin:task-board`），不再占用侧栏一级导航。
 */
export function TaskBoardPage({
  terminalApps,
  onStartSession,
  embedded = false,
}: TaskBoardPageProps) {
  const { t } = useTranslation();
  const [workspaces, setWorkspaces] = useState<TaskWorkspace[]>([]);
  const [activeRoot, setActiveRoot] = useState<string | null>(() =>
    readStoredRoot(),
  );
  const [board, setBoard] = useState<TaskBoard | null>(null);
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [initTarget, setInitTarget] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<string | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<TaskCard | null>(null);
  const [dragging, setDragging] = useState<TaskCard | null>(null);
  /** 详情里那张卡的执行计划（规划节点，规则版调度多半为空） */
  const [plan, setPlan] = useState<RouterPlanNode[]>([]);
  const router = useRouterStatus(activeRoot);

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

  /** 刷新看板；详情开着时一并重读，避免抽屉里显示旧状态。 */
  const reload = async (root: string | null = activeRoot) => {
    if (!root) return;
    try {
      await loadBoard(root);
      if (detail) {
        setDetail(await tasksApi.detail(root, detail.task.id));
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

  /** 快速新建：只收一个标题，状态走默认列、优先级走「中」，其余字段到详情里补。 */
  const createTask = async (title: string) => {
    if (!activeRoot) return false;
    try {
      await tasksApi.create(activeRoot, { title });
      await loadBoard(activeRoot);
      return true;
    } catch (error) {
      toast.error(taskErrorMessage(error, t));
      return false;
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
    // 快速新建落在默认列（To Do）；默认列不在看板上时退回第一列，入口不能消失
    const quickAddStatus =
      board.columns.find((column) => column.status === board.defaultStatus)
        ?.status ?? board.columns[0]?.status;
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
        <div
          className={cn(
            "flex min-h-0 flex-1 gap-3 overflow-x-auto scroll-stable",
            embedded ? "py-1" : "p-4",
          )}
        >
          {board.columns.map((column) => (
            <BoardColumnView
              key={column.status}
              status={column.status}
              tasks={column.tasks}
              runs={router.runsByTask}
              draggingId={dragging?.id ?? null}
              onOpen={(task) => void openDetail(task)}
              // 快速新建固定在默认列的第一条
              onCreate={
                column.status === quickAddStatus
                  ? (title) => createTask(title)
                  : undefined
              }
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
      setDetail(await tasksApi.detail(activeRoot, task.id));
      // 计划与运行态一起带出来：抽屉开着时不该等下一次轮询才看到状态。
      const nodes = await superAgentApi.plan(task.id).catch(() => []);
      setPlan(nodes);
      void router.refresh();
    } catch (error) {
      toast.error(taskErrorMessage(error, t));
    }
  };

  /** 自动调度的三个动作：只写运行态，不改仓库里的任务文件。 */
  const runRouterAction = async (action: () => Promise<void>) => {
    try {
      await action();
    } catch (error) {
      toast.error(
        t("tasks.router.actionFailed", {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      await router.refresh();
      if (activeRoot && detail) {
        const taskId = detail.task.id;
        setDetail(
          await tasksApi.detail(activeRoot, taskId).catch(() => detail),
        );
      }
    }
  };

  const handleAutoStart = () => {
    if (!activeRoot || !detail) return;
    const taskId = detail.task.id;
    void runRouterAction(async () => {
      await superAgentApi.start(activeRoot, taskId);
      await loadBoard(activeRoot);
      toast.success(t("tasks.router.started"));
    });
  };

  const handleAutoPause = () => {
    if (!activeRoot || !detail) return;
    const taskId = detail.task.id;
    void runRouterAction(() => superAgentApi.pause(activeRoot, taskId));
  };

  const handleAutoResume = () => {
    if (!activeRoot || !detail) return;
    const taskId = detail.task.id;
    void runRouterAction(() => superAgentApi.resume(activeRoot, taskId));
  };

  // 页头那排操作：独立页放在页头，嵌进插件中心时放在内容顶部。
  // 选仓库和管仓库是一件事，合成同一个下拉：仓库列表 + 添加 + 移出。
  const headerActions =
    workspaces.length > 0 ? (
      <>
        <AutoRouterPanel
          status={router.status}
          statuses={board?.statuses ?? []}
          terminalApps={terminalApps}
          error={router.error}
          onSave={router.saveSettings}
          onRunNow={router.runNow}
        />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={t("tasks.workspace")}
              className={cn(
                fieldClass,
                "flex h-8 w-[200px] items-center justify-between gap-2 text-start data-[state=open]:border-ring data-[state=open]:ring-[3px] data-[state=open]:ring-ring/20",
              )}
            >
              <span className="truncate">
                {active
                  ? (active.projectName ?? active.name)
                  : t("tasks.workspace")}
              </span>
              <ChevronDown
                aria-hidden="true"
                className="h-4 w-4 shrink-0 opacity-50"
                strokeWidth={1.5}
              />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[220px]">
            {workspaces.map((entry) => (
              <DropdownMenuItem
                key={entry.root}
                disabled={!entry.valid}
                onSelect={() => void selectWorkspace(entry.root)}
              >
                <Check
                  aria-hidden="true"
                  strokeWidth={2}
                  className={cn(
                    "h-3.5 w-3.5 shrink-0",
                    entry.root === activeRoot ? "opacity-100" : "opacity-0",
                  )}
                />
                <span className="truncate">
                  {entry.projectName ?? entry.name}
                </span>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void handleAddWorkspace()}>
              <FolderPlus
                aria-hidden="true"
                className="h-3.5 w-3.5 shrink-0"
                strokeWidth={1.5}
              />
              {t("tasks.addWorkspace")}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!active}
              onSelect={() => active && setRemoveTarget(active.root)}
            >
              <FolderMinus
                aria-hidden="true"
                className="h-3.5 w-3.5 shrink-0"
                strokeWidth={1.5}
              />
              {t("tasks.removeWorkspace")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <HoverTip content={t("tasks.refresh")}>
          <Button
            variant="ghost"
            size="icon-compact"
            aria-label={t("tasks.refresh")}
            onClick={() => void reload()}
          >
            <RefreshCw data-icon className="h-3.5 w-3.5" strokeWidth={1.5} />
          </Button>
        </HoverTip>
      </>
    ) : null;

  return (
    <div
      className={cn(
        "flex min-h-0 flex-col",
        embedded ? "w-full gap-3 px-6 pb-6" : "flex-1",
      )}
    >
      {embedded ? (
        <div className="flex flex-wrap items-center justify-end gap-2">
          {headerActions}
        </div>
      ) : (
        <AppPageHeader
          variant="page"
          icon={<SquareKanban className="size-[22px]" strokeWidth={1.5} />}
          title={t("tasks.title")}
          actions={headerActions}
        />
      )}
      {renderBody()}

      <div className={embedded ? "shrink-0" : "shrink-0 px-4 pb-4"}>
        <PluginGuide
          pluginId="task-board"
          what={t("tasks.about.what")}
          steps={[1, 2, 3, 4, 5].map((step) => t(`tasks.about.step${step}`))}
          notes={t("tasks.about.note")}
        />
      </div>

      <TaskDetailSheet
        detail={detail}
        statuses={board?.statuses ?? []}
        terminalApps={terminalApps}
        busy={busy}
        run={detail ? router.runsByTask.get(detail.task.id) : undefined}
        plan={plan}
        onAutoStart={handleAutoStart}
        onAutoPause={handleAutoPause}
        onAutoResume={handleAutoResume}
        onClose={() => {
          setDetail(null);
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
  runs,
  draggingId,
  onOpen,
  onCreate,
}: {
  status: string;
  tasks: TaskCard[];
  runs: Map<string, RouterTaskRun>;
  draggingId: string | null;
  onOpen: (task: TaskCard) => void;
  /** 只在默认列传：快速新建入口固定在该列第一条 */
  onCreate?: (title: string) => Promise<boolean>;
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
        {onCreate ? <NewTaskComposer onCreate={onCreate} /> : null}
        {tasks.length === 0 ? (
          <p className="m-0 px-2 py-3 text-caption text-fg-3">
            {t("tasks.columnEmpty")}
          </p>
        ) : (
          tasks.map((task) => (
            <TaskCardView
              key={task.id}
              task={task}
              run={runs.get(task.id)}
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
  run,
  dragging,
  onOpen,
}: {
  task: TaskCard;
  /** 这张卡的自动调度运行态；没有就是还没交给调度器 */
  run: RouterTaskRun | undefined;
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
          <RunStateBadge run={run} />
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

/** 默认列顶部的快速新建：只有一个输入框，回车或点发送就落成一张卡。 */
function NewTaskComposer({
  onCreate,
}: {
  onCreate: (title: string) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [pending, setPending] = useState(false);

  const submit = async () => {
    const value = title.trim();
    if (!value || pending) return;
    setPending(true);
    try {
      if (await onCreate(value)) setTitle("");
    } finally {
      setPending(false);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full items-center gap-1.5 rounded-control border border-dashed border-border-strong px-2.5 py-2 text-caption text-fg-3 transition-colors hover:bg-surface hover:text-fg-1"
      >
        <Plus aria-hidden="true" className="h-3.5 w-3.5" strokeWidth={1.5} />
        {t("tasks.newTask")}
      </button>
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      <Input
        autoFocus
        value={title}
        aria-label={t("tasks.newTask")}
        placeholder={t("tasks.newTaskPlaceholder")}
        onChange={(event) => setTitle(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void submit();
          } else if (event.key === "Escape") {
            setTitle("");
            setOpen(false);
          }
        }}
        onBlur={() => {
          // 空输入失焦就收起；已经写了字就不丢内容
          if (!title.trim()) setOpen(false);
        }}
      />
      <HoverTip content={t("tasks.newTaskSend")}>
        <Button
          variant="solid"
          size="icon-compact"
          aria-label={t("tasks.newTaskSend")}
          disabled={!title.trim() || pending}
          onClick={() => void submit()}
        >
          <Send data-icon className="h-3.5 w-3.5" strokeWidth={1.5} />
        </Button>
      </HoverTip>
    </div>
  );
}
