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
  Clock,
  FolderMinus,
  FolderPlus,
  GripVertical,
  MessageSquare,
  Paperclip,
  RefreshCw,
  Repeat,
  SquareKanban,
  Trash2,
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
import { fieldClass } from "@/components/ui/input";
import { Notice } from "@/components/ui/notice";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { PluginGuide } from "@/components/plugins/PluginGlyph";
import { pluginCardPageClass } from "@/components/plugins/pluginPage";
import { settingsApi } from "@/lib/api/settings";
import {
  taskErrorMessage,
  tasksApi,
  type NewTaskInput,
  type TaskBoard,
  type TaskCard,
  type TaskDetail,
  type TaskWorkspace,
} from "@/lib/api/tasks";
import {
  superAgentApi,
  type RouterAgent,
  type RouterRunState,
  type RouterTaskRun,
} from "@/lib/api/superAgent";
import { useRouterStatus } from "@/hooks/useRouterStatus";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { AgentFlowView } from "./AgentFlowView";
import { AutoRouterPanel, RouterAgentDialog } from "./AutoRouterPanel";
import { RunStateBadge } from "./RunStateBadge";
import {
  blankAgent,
  resolveRouterAgents,
  withAgentAvatar,
  withAgentDeleted,
  withAgentEnabled,
  withAgentSaved,
} from "./agentSettings";
import { nextRunHint, scheduleLabel } from "./schedule";
import { NewTaskComposer, type NewTaskTiming } from "./TaskComposer";
import { TaskDetailSheet } from "./TaskDetailSheet";

const ROOT_STORAGE_KEY = "phi.task.workspace";
/**
 * 看板自己会变：worker 改卡片、调度器挪列、排期到点。
 * 20 秒读一次文件，比盯着界面的人眼快，也不会把磁盘扫热。
 */
const BOARD_REFRESH_MS = 20_000;

interface TaskBoardPageProps {
  /** 能开本地终端会话的应用（为空表示当前平台不支持） */
  terminalApps: string[];
  /**
   * 在指定应用、指定目录开一个会话，返回会话 ID。
   *
   * 看板自己不再用它：讨论由 Router 承接（不开终端），普通任务开工走后端
   * `router_start_task`。宿主这份能力仍可能被其他页面用。
   */
  onStartSession: (
    root: string,
    appId: string,
    argumentsText?: string,
  ) => Promise<string>;
  /** 作为插件中心的一个页签嵌入：不再画自己的页头，操作行放进内容顶部 */
  embedded?: boolean;
  /** 打开一个已经存在的会话；后台派发的 worker 不会自己出现在界面上 */
  onOpenSession: (appId: string, sessionId: string) => Promise<boolean>;
  /**
   * 打开这次运行的 worker。
   *
   * 与 `onOpenSession` 分开是因为 worker 不一定在 phi 的终端表里：跑在 zellij
   * 里的 worker 要现开一个查看器挂上去，跑完了也还能看。返回 false 表示接不上。
   */
  onOpenWorker: (root: string, taskId: string) => Promise<boolean>;
  /** 后端当前确实持有的会话 id，用来区分「还能打开」与「会话已结束」 */
  liveSessionIds: string[];
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
 *
 * 讨论不在这里开终端：它是跟 Router 的对话，在卡片详情页的输入框与 timeline 里。
 */
export function TaskBoardPage({
  terminalApps,
  embedded = false,
  onOpenSession,
  onOpenWorker,
  liveSessionIds,
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
  /** 待确认关掉的讨论卡：删文件不可撤销，先问一句 */
  const [discardTarget, setDiscardTarget] = useState<TaskCard | null>(null);
  const [dragging, setDragging] = useState<TaskCard | null>(null);
  /** 刚派生出的讨论卡：详情打开后自动聚焦输入框 */
  const [focusDiscussion, setFocusDiscussion] = useState(false);
  /** 从看板建完卡后，第一句已经替用户发出去了：还在等 Router 回那一句 */
  const [replyingTask, setReplyingTask] = useState<{
    taskId: string;
    message: string;
  } | null>(null);
  const router = useRouterStatus(activeRoot);
  const liveSessions = useMemo(() => new Set(liveSessionIds), [liveSessionIds]);
  /**
   * 默认落在「智能体」视图：智能体是这套看板的一级单元，看板（阶段列）是另一种读法。
   *
   * 这个状态不落盘，也不跨会话记忆：每次进来先看到的是「这队人现在手上有什么」。
   */
  const [viewMode, setViewMode] = useState<"board" | "agents">("agents");
  const [agentEditor, setAgentEditor] = useState<{
    agent: RouterAgent;
    isNew: boolean;
  } | null>(null);

  const settings = router.status?.settings ?? null;
  const routerAgents = useMemo(() => resolveRouterAgents(settings), [settings]);
  const allowedAgents = useMemo(() => settings?.workerApps ?? [], [settings]);
  const allTasks = useMemo(
    () => board?.columns.flatMap((column) => column.tasks) ?? [],
    [board],
  );

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

  /** 快速新建：标题必填，任务类型（排期）可在建卡时一并选好。 */
  const createTask = async (title: string, timing: NewTaskTiming) => {
    if (!activeRoot) return false;
    const input: NewTaskInput = { title };
    // 没选类型就不传这两个字段：新建出来的就是普通任务，卡片上也不留排期痕迹
    if (timing.recurrence) input.recurrence = timing.recurrence;
    if (timing.schedule) input.schedule = timing.schedule;
    try {
      await tasksApi.create(activeRoot, input);
      await loadBoard(activeRoot);
      return true;
    } catch (error) {
      toast.error(taskErrorMessage(error, t));
      return false;
    }
  };

  /**
   * 智能体行里的 + ：建一张卡，建好就归到这一行。
   *
   * 归属落在卡片的 `assignee` 里，与把卡拖过去是同一种事实；开工仍是显式的那一下
   * （卡片上的 ▶），所以刚记下的一件活不会因为手滑就立刻起一个进程。
   */
  const createTaskForAgent = async (
    agentId: string,
    title: string,
    timing: NewTaskTiming,
  ) => {
    if (!activeRoot) return false;
    const input: NewTaskInput = { title, assignees: [agentId] };
    if (timing.recurrence) input.recurrence = timing.recurrence;
    if (timing.schedule) input.schedule = timing.schedule;
    try {
      await tasksApi.create(activeRoot, input);
      await loadBoard(activeRoot);
      return true;
    } catch (error) {
      toast.error(taskErrorMessage(error, t));
      return false;
    }
  };

  /**
   * 把用户写的第一句话直接交给 Router。
   *
   * 「讨论一下」与「重新讨论」都是这个形状：卡片一建好，这句话就是这一轮的
   * 第一句发言，不需要人再到详情页重打一遍。回答是异步等回来的（最多几十秒），
   * 失败也只影响这一轮回复。
   */
  const speakFirstTurn = (
    root: string,
    taskId: string,
    message: string,
    fingerprint: string,
  ) => {
    setReplyingTask({ taskId, message });
    void (async () => {
      try {
        const next = await tasksApi.discussionSay(
          root,
          taskId,
          message,
          fingerprint,
        );
        // 用户可能已经切到别的卡：只有还停在这张上才换成新内容
        setDetail((current) =>
          current?.task.id === next.task.id ? next : current,
        );
        await loadBoard(root);
      } catch (error) {
        toast.error(taskErrorMessage(error, t));
        // 这句话已经写进 timeline 了（后端先记发言再等 Router），刷新一次让它可见：
        // 否则用户看到的是一片空白，会以为那句话根本没发出去而重发一遍。
        const fresh = await tasksApi.detail(root, taskId).catch(() => null);
        if (fresh) {
          setDetail((current) =>
            current?.task.id === fresh.task.id ? fresh : current,
          );
        }
      } finally {
        setReplyingTask((current) =>
          current?.taskId === taskId ? null : current,
        );
      }
    })();
  };

  /**
   * 建一张卡并立刻开讨论。
   *
   * 想法还没成形时，用户不该被迫先把它写成一条能派发的任务：这一句就是卡片的
   * 标题，也是这一轮讨论的第一句发言。建卡成功就先把详情打开、输入框收起，
   * 回复到了再铺进 timeline——失败不会让用户以为卡没建成而再建一张。
   */
  const discussNewTask = async (title: string): Promise<boolean> => {
    if (!activeRoot) return false;
    const root = activeRoot;
    let created: TaskDetail;
    try {
      created = await tasksApi.create(root, {
        title,
        discussionHold: true,
      });
    } catch (error) {
      toast.error(taskErrorMessage(error, t));
      return false;
    }

    await loadBoard(root);
    setDetail(created);
    setFocusDiscussion(true);
    speakFirstTurn(root, created.task.id, title, created.task.fingerprint);
    return true;
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

  // 轮询只在看板/详情真的开着时跑；用户正在编辑输入框也不受影响——
  // 这里只替换 detail 数据，排期编辑器的本地状态留在组件里。
  const openTaskId = detail?.task.id ?? null;
  useEffect(() => {
    if (!activeRoot) return;
    const root = activeRoot;
    const timer = window.setInterval(() => {
      void tasksApi
        .board(root)
        .then(setBoard)
        .catch(() => {
          // 轮询失败不打扰用户：下一次刷新会再试，手动刷新仍有明确报错。
        });
      if (openTaskId) {
        void tasksApi
          .detail(root, openTaskId)
          .then(setDetail)
          .catch(() => {});
      }
    }, BOARD_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [activeRoot, openTaskId]);

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
    // 智能体视图：一张编制图，输入 → Lead → 智能体 → 聚焦那一栏的卡。
    if (viewMode === "agents") {
      return (
        <AgentFlowView
          tasks={allTasks}
          agents={routerAgents}
          allowed={allowedAgents}
          runsByTask={router.runsByTask}
          busy={busy}
          onOpenTask={(task) => void openDetail(task)}
          // 拖放只指派：改归属不等于授权起跑。
          onAssign={(task, agentId) => assignTask(task, agentId, false)}
          onAssignAndStart={(task, agentId) => assignTask(task, agentId, true)}
          onEditAgent={(agent) => setAgentEditor({ agent, isNew: false })}
          onAddAgent={() =>
            setAgentEditor({
              agent: blankAgent(terminalApps[0] ?? "claude"),
              isNew: true,
            })
          }
          onToggleAgent={(agent, enabled) => {
            if (!settings) return;
            void runRouterAction(async () => {
              await router.saveSettings({
                ...settings,
                ...withAgentEnabled(settings, agent.id, enabled),
              });
            });
          }}
          // Router 也有一张脸：与智能体同一种存储、同一个选择器，只是不参与派发。
          routerAvatar={settings?.routerAvatar ?? ""}
          onSetRouterAvatar={(avatar) => {
            if (!settings) return;
            void runRouterAction(async () => {
              await router.saveSettings({ ...settings, routerAvatar: avatar });
            });
          }}
          // 一栏里的 + ：建卡即归属，开工仍由卡片上的 ▶ 决定。
          onCreateForAgent={(agentId, title, timing) =>
            createTaskForAgent(agentId, title, timing)
          }
          // 讨论栏的「新建任务卡片」：不写归属，建好交给 Lead 照常挑人。
          onCreateTask={(title, timing) => createTask(title, timing)}
          onCreateDraft={(title) => discussNewTask(title)}
          // Lead 自己的模型：空表示只按规则判断，这一栏也要如实写。
          leadModel={settings?.episodeModel || null}
          // 点头像换一张：只改这一个字段，不动角色定义与允许名单。
          onSetAgentAvatar={(agent, avatar) => {
            if (!settings) return;
            void runRouterAction(async () => {
              await router.saveSettings({
                ...settings,
                ...withAgentAvatar(settings, agent.id, avatar),
              });
            });
          }}
          onDeleteAgent={(agent) => {
            if (!settings) return;
            void runRouterAction(async () => {
              await router.saveSettings({
                ...settings,
                ...withAgentDeleted(settings, agent.id),
              });
            });
          }}
        />
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
              key={`${board.root}:${column.status}`}
              status={column.status}
              tasks={column.tasks}
              runs={router.runsByTask}
              draggingId={dragging?.id ?? null}
              onOpen={(task) => void openDetail(task)}
              onDiscard={setDiscardTarget}
              // 快速新建固定在默认列的第一条
              onCreate={
                column.status === quickAddStatus
                  ? (title, timing) => createTask(title, timing)
                  : undefined
              }
              onDiscuss={
                column.status === quickAddStatus ? discussNewTask : undefined
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
      setFocusDiscussion(false);
      setDetail(await tasksApi.detail(activeRoot, task.id));
      // 运行态一起带出来：抽屉开着时不该等下一次轮询才看到状态。
      void router.refresh();
    } catch (error) {
      toast.error(taskErrorMessage(error, t));
    }
  };

  /** 调度动作统一反馈；开始/确认完成可能同步更新任务列。 */
  const runRouterAction = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await action();
    } catch (error) {
      toast.error(
        t("tasks.router.actionFailed", {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      setBusy(false);
      await router.refresh();
      if (activeRoot && detail) {
        const taskId = detail.task.id;
        setDetail(
          await tasksApi.detail(activeRoot, taskId).catch(() => detail),
        );
      }
    }
  };

  /** 打开一条已有关联会话。后端已经不持有它时说明应用重启过了，如实告知。 */
  const handleOpenSession = async (appId: string, sessionId: string) => {
    const opened = await onOpenSession(appId, sessionId).catch(() => false);
    if (!opened) toast.info(t("tasks.sessionClosed"));
  };

  /** 打开这次运行的 worker：后端决定是接回已有终端还是现开一个查看器。 */
  const handleOpenWorker = async () => {
    if (!activeRoot || !detail) return;
    const opened = await onOpenWorker(activeRoot, detail.task.id).catch(
      () => false,
    );
    if (!opened) toast.info(t("tasks.sessionClosed"));
  };

  /**
   * 发送任务：讨论到此结束，这张卡转成执行卡并进入执行列。
   *
   * 不再单独「写回」——结论每轮已经由 Router 写回卡片，这里只做那一步不可逆的
   * 动作：把卡从待办挪到下一列（`set_status` 顺手摘掉讨论卡类型，输入框随之消失）。
   */
  const handleSendDiscussion = async (): Promise<boolean> => {
    if (!activeRoot || !detail) return false;
    const root = activeRoot;
    const statuses = board?.statuses ?? [];
    const index = statuses.indexOf(detail.task.status);
    const next = index >= 0 ? statuses[index + 1] : undefined;
    if (!next) {
      // 只有一列或卡停在最后一列时没有「下一列」可去：这是看板配置问题，
      // 直接报错比悄悄把卡停在原地好。
      toast.error(t("tasks.discussion.noNextStatus"));
      return false;
    }
    setBusy(true);
    try {
      const fresh = await tasksApi.setStatus(
        root,
        detail.task.id,
        next,
        detail.task.fingerprint,
      );
      setDetail(fresh);
      setFocusDiscussion(false);
      await loadBoard(root);
      toast.success(t("tasks.discussion.sent"));
      return true;
    } catch (error) {
      toast.error(taskErrorMessage(error, t));
      if (String(error) === "stale-fingerprint") await loadBoard(root);
      return false;
    } finally {
      setBusy(false);
    }
  };

  /**
   * 跟 Router 说一句。
   *
   * 讨论的承载者是 Router，不是某个 worker 的终端：这里不开会话，只把这句话
   * 交给后端，拿回 Router 的回复和更新后的 timeline。失败时输入框里的字不丢。
   */
  const handleSayDiscussion = async (message: string): Promise<boolean> => {
    if (!activeRoot || !detail) return false;
    const root = activeRoot;
    const taskId = detail.task.id;
    try {
      // 刚写回结论时指纹已变：现读一次，再拿旧指纹发话只会得到 stale-fingerprint。
      const fresh = await tasksApi.detail(root, taskId);
      const next = await tasksApi.discussionSay(
        root,
        taskId,
        message,
        fresh.task.fingerprint,
      );
      setDetail(next);
      await loadBoard(root);
      return true;
    } catch (error) {
      toast.error(taskErrorMessage(error, t));
      // 卡片被外部改过：刷新一下，让下一次发话带上新指纹
      if (String(error) === "stale-fingerprint") await loadBoard(root);
      return false;
    }
  };

  /**
   * 从一张已完成的任务派生新一轮讨论。
   *
   * 已完成的任务不回退成讨论态：原卡的状态、结束时间与结论保持原样，
   * 新卡带着背景（目标、验收、结果、上轮结论）指回去。
   */
  const handleDeriveDiscussion = async (note: string): Promise<boolean> => {
    if (!activeRoot || !detail) return false;
    const root = activeRoot;
    try {
      const created = await tasksApi.deriveDiscussion(
        root,
        detail.task.id,
        note,
      );
      await loadBoard(root);
      setDetail(created);
      setFocusDiscussion(true);
      // 派生时写的这句话同样不该白写：它就是这一轮的第一句发言
      speakFirstTurn(root, created.task.id, note, created.task.fingerprint);
      return true;
    } catch (error) {
      toast.error(taskErrorMessage(error, t));
      return false;
    }
  };

  /**
   * 把待办列上的一张卡就地转成讨论卡。
   *
   * 讨论只在讨论卡里发生，所以普通待办卡要先转类型；转换只改卡片类型，
   * 标题与正文不动，刷新后同一张卡就带着输入框。
   */
  const handleConvertDiscussion = async (): Promise<boolean> => {
    if (!activeRoot || !detail) return false;
    const root = activeRoot;
    try {
      const next = await tasksApi.convertDiscussion(
        root,
        detail.task.id,
        detail.task.fingerprint,
      );
      setDetail(next);
      setFocusDiscussion(true);
      await loadBoard(root);
      return true;
    } catch (error) {
      toast.error(taskErrorMessage(error, t));
      if (String(error) === "stale-fingerprint") await loadBoard(root);
      return false;
    }
  };

  /** 删掉一张讨论卡：卡片、这一轮的记录与谈出的结论一起消失。 */
  const handleDiscardDiscussion = async () => {
    const target = discardTarget;
    setDiscardTarget(null);
    if (!activeRoot || !target) return;
    const root = activeRoot;
    try {
      await tasksApi.discardDiscussion(root, target.id, target.fingerprint);
      setDetail((current) => (current?.task.id === target.id ? null : current));
      setFocusDiscussion(false);
      await loadBoard(root);
      toast.success(t("tasks.discussion.discarded"));
    } catch (error) {
      toast.error(taskErrorMessage(error, t));
      if (String(error) === "stale-fingerprint") await loadBoard(root);
    }
  };

  /** 从原任务跳到它派生出的某一轮讨论。 */
  const openTaskById = async (taskId: string) => {
    if (!activeRoot) return;
    try {
      setFocusDiscussion(false);
      setDetail(await tasksApi.detail(activeRoot, taskId));
    } catch (error) {
      toast.error(taskErrorMessage(error, t));
    }
  };

  const handleAutoStart = () => {
    if (!activeRoot || !detail) return;
    const taskId = detail.task.id;
    const root = activeRoot;
    void runRouterAction(async () => {
      await superAgentApi.start(root, taskId);
      await loadBoard(root);
      toast.success(t("tasks.router.started"));
      // 派发成功就把人带到那张卡的会话上：worker 跑在自己的 PTY 里，界面不切过去
      // 就一点痕迹都没有，看起来完全是「显示运行中、却看不到终端」。
      const status = await superAgentApi.status().catch(() => null);
      const started = status?.runs.find(
        (entry) => entry.taskId === taskId && entry.root === root,
      );
      if (started?.sessionId && started.workerApp)
        await handleOpenSession(started.workerApp, started.sessionId);
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

  /** 改排期：持续任务（每隔一段时间）或定时任务（指定时刻）。 */
  const handleSetSchedule = (
    recurrence: string | null,
    schedule: string | null,
  ) => {
    if (!activeRoot || !detail) return;
    const taskId = detail.task.id;
    const fingerprint = detail.task.fingerprint;
    void runRouterAction(async () => {
      const fresh = await tasksApi.setSchedule(
        activeRoot,
        taskId,
        recurrence,
        schedule,
        fingerprint,
      );
      setDetail(fresh);
      await loadBoard(activeRoot);
      toast.success(t("tasks.schedule.saved"));
    });
  };

  /**
   * 指派（`start` = 指派并开工）。
   *
   * 拖放只调用前半截：改归属与授权起跑是两件事。改完立刻读一次看板，
   * 让卡片当场出现在新的一行，而不是等 20 秒轮询。
   */
  const assignTask = (
    task: TaskCard,
    agentId: string | null,
    start: boolean,
  ) => {
    if (!activeRoot) return;
    void runRouterAction(async () => {
      const result = await superAgentApi.assign(
        activeRoot,
        task.id,
        agentId,
        start,
        task.fingerprint,
      );
      await loadBoard(activeRoot);
      if (start) {
        toast.success(
          result.started
            ? t("tasks.router.assignStarted")
            : t("tasks.router.assignShadow"),
        );
      } else {
        toast.success(t("tasks.router.assignDone"));
      }
    });
  };

  /** 在文件管理器中显示产物。路径由后端校验必须在仓库内。 */
  const handleRevealArtifact = (path: string) => {
    if (!activeRoot) return;
    void tasksApi
      .revealArtifact(activeRoot, path)
      .catch((error) => toast.error(taskErrorMessage(error, t)));
  };

  // 页头那排操作：独立页放在页头，嵌进插件中心时放在内容顶部。
  // 选仓库和管仓库是一件事，合成同一个下拉：仓库列表 + 添加 + 移出。
  const headerActions =
    workspaces.length > 0 ? (
      <>
        {/* 智能体是一级入口：和自动调度、仓库同一排，而不是藏在调度弹窗里。 */}
        <div
          role="group"
          aria-label={t("tasks.agentView.switchLabel")}
          className="flex h-8 items-center rounded-control border border-border bg-surface p-0.5"
        >
          {(["agents", "board"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              aria-pressed={viewMode === mode}
              onClick={() => setViewMode(mode)}
              className={cn(
                "h-7 rounded-[6px] px-2.5 text-caption transition-colors",
                viewMode === mode
                  ? "bg-subtle font-medium text-fg-1"
                  : "text-fg-2 hover:text-fg-1",
              )}
            >
              {mode === "board"
                ? t("tasks.agentView.board")
                : t("tasks.agentView.agents")}
            </button>
          ))}
        </div>
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
        // 嵌进插件中心时用与其它插件页同一个版心：切页签时左右边缘不跳。
        // 还要接住外层给的高度（flex-1）：列行靠它才能铺满窗口、滚动交给列内，
        // 否则列高退化成最长列的内容高，窗口下方白白空出一条。
        embedded ? cn(pluginCardPageClass, "flex-1 gap-3 pb-4") : "flex-1",
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
        {/* 说明块是给第一次用的人看的：看板本身要占满一屏，这里默认收成一行。 */}
        <PluginGuide
          pluginId="task-board"
          collapsible
          defaultCollapsed
          what={t("tasks.about.what")}
          steps={[1, 2, 3, 4, 5].map((step) => t(`tasks.about.step${step}`))}
          notes={t("tasks.about.note")}
        />
      </div>

      <TaskDetailSheet
        key={detail?.task.id ?? "closed"}
        detail={detail}
        statuses={board?.statuses ?? []}
        defaultStatus={board?.defaultStatus ?? null}
        terminalApps={terminalApps}
        busy={busy}
        run={detail ? router.runsByTask.get(detail.task.id) : undefined}
        liveSessionIds={liveSessions}
        onOpenSession={(appId, sessionId) =>
          void handleOpenSession(appId, sessionId)
        }
        onOpenWorker={() => void handleOpenWorker()}
        onAutoStart={handleAutoStart}
        onAutoPause={handleAutoPause}
        onAutoResume={handleAutoResume}
        agents={routerAgents}
        allowedAgents={allowedAgents}
        onAssign={(agentId, start) => {
          if (detail) assignTask(detail.task, agentId, start);
        }}
        onResolve={(decision) => {
          if (!activeRoot || !detail) return;
          const run = router.runsByTask.get(detail.task.id);
          if (!run) return;
          void runRouterAction(async () => {
            await superAgentApi.resolve(
              activeRoot,
              detail.task.id,
              decision,
              run.updatedAt,
              detail.task.fingerprint,
            );
            await loadBoard(activeRoot);
          });
        }}
        onSetSchedule={handleSetSchedule}
        onSendDiscussion={() => handleSendDiscussion()}
        onSayDiscussion={(message) => handleSayDiscussion(message)}
        onDeriveDiscussion={(note) => handleDeriveDiscussion(note)}
        onConvertDiscussion={() => handleConvertDiscussion()}
        onDiscardDiscussion={async () => {
          if (detail) setDiscardTarget(detail.task);
        }}
        onOpenTask={(taskId) => void openTaskById(taskId)}
        focusDiscussion={focusDiscussion}
        discussionReplying={replyingTask?.taskId === detail?.task.id}
        discussionFirstMessage={
          replyingTask && replyingTask.taskId === detail?.task.id
            ? replyingTask.message
            : null
        }
        onRevealArtifact={handleRevealArtifact}
        onClose={() => {
          setDetail(null);
          setFocusDiscussion(false);
        }}
        onSetStatus={(status) => {
          if (detail) void handleSetStatus(detail.task, status);
        }}
        onArchive={() => {
          if (detail) handleArchive(detail.task);
        }}
        onUnlink={(sessionId) => void handleUnlink(sessionId)}
      />

      {agentEditor ? (
        <RouterAgentDialog
          draft={agentEditor.agent}
          isNew={agentEditor.isNew}
          terminalApps={terminalApps}
          routerAvatar={settings?.routerAvatar ?? ""}
          onCancel={() => setAgentEditor(null)}
          onSave={(agent) => {
            const isNew = agentEditor.isNew;
            setAgentEditor(null);
            if (!settings) return;
            void runRouterAction(async () => {
              await router.saveSettings({
                ...settings,
                ...withAgentSaved(settings, agent, isNew),
              });
            });
          }}
        />
      ) : null}

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
      <ConfirmDialog
        isOpen={Boolean(discardTarget)}
        title={t("tasks.discussion.discardTitle")}
        message={`${discardTarget?.title ?? ""}\n\n${t("tasks.discussion.discardMessage")}`}
        confirmText={t("tasks.discussion.discard")}
        pending={busy}
        onConfirm={() => void handleDiscardDiscussion()}
        onCancel={() => setDiscardTarget(null)}
      />
    </div>
  );
}

const DONE_PREVIEW_COUNT = 5;

function boardDate(task: TaskCard) {
  return task.updatedDate || task.createdDate || "";
}

function BoardColumnView({
  status,
  tasks,
  runs,
  draggingId,
  onOpen,
  onDiscard,
  onCreate,
  onDiscuss,
}: {
  status: string;
  tasks: TaskCard[];
  runs: Map<string, RouterTaskRun>;
  draggingId: string | null;
  onOpen: (task: TaskCard) => void;
  onDiscard: (task: TaskCard) => void;
  /** 只在默认列传：快速新建入口固定在该列第一条 */
  onCreate?: (title: string, timing: NewTaskTiming) => Promise<boolean>;
  /** 只在默认列传：一句话成卡并直接进入讨论 */
  onDiscuss?: (title: string) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const done = status.toLowerCase() === "done";
  const [expanded, setExpanded] = useState(false);
  const ordered = useMemo(
    () =>
      done
        ? [...tasks].sort(
            (a, b) =>
              boardDate(b).localeCompare(boardDate(a)) ||
              b.id.localeCompare(a.id, undefined, { numeric: true }),
          )
        : tasks,
    [done, tasks],
  );
  const visible =
    done && !expanded ? ordered.slice(0, DONE_PREVIEW_COUNT) : ordered;
  const { setNodeRef, isOver } = useDroppable({ id: `column:${status}` });

  return (
    <section
      ref={setNodeRef}
      aria-label={status}
      className={cn(
        // 列平分看板宽度，而不是各占 300 固定宽：这样整块的左右边缘与
        // 上方工具栏、下方说明块落在同一条线上，右侧不再空出一条。
        // 列是「托盘」：满色 bg-subtle、不描边。卡片要压在它上面，托盘自己不该带边框，
        // 否则两个有边的盒子叠在一起，谁在上看不出来。
        // 列多到放不下时（min-w 撑住）仍然走横向滚动。
        // 列高度必须被看板框住（min-h-0 + overflow-hidden），否则卡片一多整列跟着长高，
        // 页面变成一条长列表、各列底边错开，滚动条也无从出现——滚动交给列内的卡片区。
        "flex min-h-0 min-w-[240px] flex-1 basis-0 flex-col overflow-hidden rounded-panel bg-subtle transition-colors",
        // 拖动悬停：整列压深一档。注意不能用 bg-selected/70 这类透明度写法——
        // 主题色是 var(--bg-*) 形式，Tailwind 生成不出带 alpha 的类，会静默失效。
        isOver && "bg-selected",
      )}
    >
      {/* 内边距与卡片列表一致（px-2.5），列名和卡片左边缘才对得齐；也让卡片投影有地方落 */}
      <header className="flex h-9 shrink-0 items-center gap-2 px-2.5">
        <h2 className="m-0 truncate text-section text-fg-1">{status}</h2>
        <span className="shrink-0 text-caption tabular-nums text-fg-3">
          {tasks.length}
        </span>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto scroll-stable px-2.5 pb-2.5">
        {onCreate ? (
          <NewTaskComposer onCreate={onCreate} onDiscuss={onDiscuss} />
        ) : null}
        {tasks.length === 0 ? (
          <p className="m-0 px-2 py-3 text-caption text-fg-3">
            {t("tasks.columnEmpty")}
          </p>
        ) : (
          visible.map((task) => (
            <TaskCardView
              key={task.id}
              compact={done}
              task={task}
              run={runs.get(task.id)}
              dragging={draggingId === task.id}
              onOpen={onOpen}
              onDiscard={onDiscard}
            />
          ))
        )}
        {done && tasks.length > DONE_PREVIEW_COUNT && (
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
            className="rounded-control px-2 py-1 text-start text-caption text-fg-2 hover:bg-selected"
          >
            {expanded
              ? t("tasks.collapseDone")
              : t("tasks.expandDone", {
                  count: tasks.length - DONE_PREVIEW_COUNT,
                })}
          </button>
        )}
      </div>
    </section>
  );
}

/**
 * 这些状态下排期不会到点就跑：它在跑、排队、等人回话、被暂停，
 * 后端 `advance_schedules` 会跳过它。此时卡片不承诺「下次什么时候」，
 * 否则就成了一句看着确定、其实不会发生的时间。
 */
const SCHEDULE_HELD_STATES: ReadonlySet<RouterRunState> = new Set([
  "queued",
  "dispatched",
  "working",
  "needs-you",
  "paused",
]);

function TaskCardView({
  compact,
  task,
  run,
  dragging,
  onOpen,
  onDiscard,
}: {
  task: TaskCard;
  compact: boolean;
  /** 这张卡的自动调度运行态；没有就是还没交给调度器 */
  run: RouterTaskRun | undefined;
  dragging: boolean;
  onOpen: (task: TaskCard) => void;
  onDiscard: (task: TaskCard) => void;
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
  // 等待期的卡要靠这一行解释「在等下一轮」；看板 20 秒读一次，到点会自己变成「已到点」。
  const hint =
    task.schedule && !(run && SCHEDULE_HELD_STATES.has(run.state))
      ? nextRunHint(t, task.schedule)
      : null;

  return (
    <article
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform) }}
      className={cn(
        "group relative rounded-control border border-border bg-surface shadow-v7-card transition-shadow hover:shadow-v7-card-hover",
        (isDragging || dragging) && "opacity-40",
      )}
    >
      <button
        type="button"
        onClick={() => onOpen(task)}
        title={compact ? task.title : undefined}
        className={cn(
          "block w-full rounded-control text-start",
          compact ? "px-2 py-1 pe-7" : "p-2.5 pe-7",
          task.kind === "discussion" && "pe-14",
        )}
        aria-label={task.title}
      >
        <span
          className={cn(
            "block font-medium leading-snug text-fg-1",
            // 三档字号必须一眼分开：列头 15/600、卡标题 13/500、元信息 11。
            // 紧凑的 Done 行是回顾，不需要和待办卡一样重。
            compact
              ? "truncate text-caption"
              : "text-body [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:3] overflow-hidden",
          )}
        >
          {task.title}
        </span>
        {/* 待决定的问题就是这张卡现在唯一的内容：卡面不展示它，用户点开才知道要定什么。 */}
        {task.discussionQuestion ? (
          <span
            className={cn(
              "mt-1 flex items-start gap-1.5 text-[11px] leading-snug text-fg-2",
              compact && "truncate",
            )}
          >
            <MessageSquare
              aria-hidden="true"
              className="mt-[2px] h-3 w-3 shrink-0 text-fg-3"
              strokeWidth={1.5}
            />
            <span className={compact ? "truncate" : "line-clamp-2"}>
              {task.discussionQuestion}
            </span>
          </span>
        ) : null}
        <span
          className={cn(
            "flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-fg-3",
            !compact && "mt-1.5",
          )}
        >
          {(!compact || run?.state === "failed") && <RunStateBadge run={run} />}
          <span className="font-mono">{task.id}</span>
          {task.schedule && !compact ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-subtle px-1.5 py-[1px] text-fg-2">
              <Repeat
                aria-hidden="true"
                className="h-2.5 w-2.5"
                strokeWidth={1.5}
              />
              {scheduleLabel(t, task.schedule)}
            </span>
          ) : null}
          {hint ? (
            <span
              className={cn(
                "inline-flex items-center gap-0.5 tabular-nums",
                hint.due && "text-warning-text",
              )}
              title={hint.due ? t("tasks.schedule.due") : undefined}
            >
              <Clock
                aria-hidden="true"
                className="h-2.5 w-2.5"
                strokeWidth={1.5}
              />
              {hint.text}
            </span>
          ) : null}
          {task.artifactCount > 0 ? (
            <span className="inline-flex items-center gap-0.5 tabular-nums">
              <Paperclip
                aria-hidden="true"
                className="h-2.5 w-2.5"
                strokeWidth={1.5}
              />
              {task.artifactCount}
            </span>
          ) : null}
          {task.kind === "discussion" ? (
            <span className="inline-flex items-center gap-0.5 rounded-full bg-subtle px-1.5 py-[1px] text-fg-2">
              <MessageSquare
                aria-hidden="true"
                className="h-2.5 w-2.5"
                strokeWidth={1.5}
              />
              {task.round
                ? t("tasks.discussion.roundShort", { round: task.round })
                : t("tasks.discussion.held")}
            </span>
          ) : task.discussionHold ? (
            <span className="inline-flex items-center gap-0.5 rounded-full bg-subtle px-1.5 py-[1px] text-fg-2">
              <MessageSquare
                aria-hidden="true"
                className="h-2.5 w-2.5"
                strokeWidth={1.5}
              />
              {t("tasks.discussion.held")}
            </span>
          ) : null}
          {task.sourceTask ? (
            <span className="font-mono text-fg-3">
              {t("tasks.discussion.source", { id: task.sourceTask })}
            </span>
          ) : null}
          {compact && boardDate(task) && (
            <time className="ms-auto tabular-nums" title={boardDate(task)}>
              {boardDate(task).slice(0, 10)}
            </time>
          )}
          {/* 一行里不把每个指派人都铺开：卡面要读的是任务，不是名单。 */}
          {!compact && task.assignees.length > 0 ? (
            <span className="truncate">
              {task.assignees[0]}
              {task.assignees.length > 1
                ? ` +${task.assignees.length - 1}`
                : ""}
            </span>
          ) : null}
        </span>
      </button>
      {task.kind === "discussion" ? (
        <button
          type="button"
          onClick={() => onDiscard(task)}
          aria-label={`${t("tasks.discussion.discard")}：${task.title}`}
          title={t("tasks.discussion.discard")}
          className="absolute end-7 top-1 flex size-6 items-center justify-center rounded-control text-fg-3 opacity-0 transition-opacity hover:bg-danger-soft hover:text-danger-text focus-visible:text-danger-text focus-visible:opacity-100 group-hover:opacity-100"
        >
          <Trash2
            aria-hidden="true"
            className="h-3.5 w-3.5"
            strokeWidth={1.5}
          />
        </button>
      ) : null}
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
    <div className="w-[284px] rounded-control border border-border bg-surface p-2.5 shadow-v7-lg">
      <span className="block text-caption font-medium leading-snug text-fg-1 [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:3] overflow-hidden">
        {task.title}
      </span>
      <span className="mt-1.5 block font-mono text-[11px] text-fg-3">
        {task.id}
      </span>
    </div>
  );
}
