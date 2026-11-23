import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
} from "react";
import { useTranslation } from "react-i18next";
import {
  Inbox,
  MessageSquarePlus,
  MessagesSquare,
  Pencil,
  Play,
  Plus,
  Send,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { HoverTip } from "@/components/ui/hover-tip";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { getAppDisplayName } from "@/components/shell/AppGlyph";
import {
  WIRE_FAN_GAP,
  sameBoxes,
  wirePath,
  wirePathTo,
  type NodeBox,
} from "@/components/flow/flowWires";
import type { RouterAgent, RouterTaskRun } from "@/lib/api/superAgent";
import type { TaskCard } from "@/lib/api/tasks";
import { cn } from "@/lib/utils";
import { ROUTER_AVATAR_ID } from "./AgentAvatar";
import { AgentAvatarPicker } from "./AgentAvatarPicker";
import { resolveAssignee } from "./agentSettings";
import { scheduleLabel } from "./schedule";
import { RunStateBadge } from "./RunStateBadge";
import {
  ScheduleFields,
  useTaskTiming,
  type NewTaskTiming,
} from "./TaskComposer";

/** 一栏里默认留几张已完成的卡。三张够看出「它最近干了什么」，再多就是日志。 */
const DONE_IN_LANE = 3;

/** 一栏的卡超过这个数就自己滚：图的高度要有上限，别被一个人的活拉长。 */
const LANE_SCROLL_AFTER = 6;

type FlowGeometry = {
  width: number;
  height: number;
  boxes: Map<string, NodeBox>;
};

type Load = { running: number; waiting: number; failed: number };

type LaneKind = "agent" | "unassigned" | "discussion";

/** 一栏 = 一个节点 + 它手上的卡。讨论卡没有归属，所以它这一栏也拖不出去。 */
interface Lane {
  key: string;
  kind: LaneKind;
  agent: RouterAgent | null;
  name: string;
  meta: string | null;
  /** 这一栏接不接受指派。讨论栏不接受，未分配栏接受（拖回来就等于取消指派）。 */
  droppable: boolean;
  open: TaskCard[];
  done: TaskCard[];
  all: TaskCard[];
  load: Load;
}

function isDone(task: TaskCard): boolean {
  return task.status.trim().toLowerCase() === "done";
}

/** 这张卡现在真的在跑吗。影子模式下没有真的派发，不算。 */
function runningNow(run: RouterTaskRun | undefined): boolean {
  if (!run || run.shadow) return false;
  return run.state === "dispatched" || run.state === "working";
}

/** 一张卡最多算一次；同一份判断，节点上的计数与卡上的连线用的都是它。 */
function loadOf(
  list: TaskCard[],
  runsByTask: Map<string, RouterTaskRun>,
): Load {
  const load = { running: 0, waiting: 0, failed: 0 };
  for (const task of list) {
    if (isDone(task)) continue;
    const run = runsByTask.get(task.id);
    if (!run || run.shadow) continue;
    if (runningNow(run)) load.running += 1;
    else if (run.state === "needs-you") load.waiting += 1;
    else if (run.state === "failed") load.failed += 1;
  }
  return load;
}

/** 未完成的在前、最近动过的在前：打开一栏先看到该看的。 */
function sortLane(list: TaskCard[]): TaskCard[] {
  return [...list].sort((left, right) => {
    const done = Number(isDone(left)) - Number(isDone(right));
    if (done !== 0) return done;
    return (right.updatedDate ?? "").localeCompare(left.updatedDate ?? "");
  });
}

/** 一栏里现在真的画出来的卡：展开状态决定带不带更早的已完成。 */
function visibleCards(lane: Lane, showAll: boolean): TaskCard[] {
  return showAll
    ? lane.all
    : [...lane.open, ...lane.done.slice(0, DONE_IN_LANE)];
}

/** 一栏的成型过程：排序、分未完成/已完成、算负载。任务栏与讨论栏共用。 */
function buildLane(
  key: string,
  kind: LaneKind,
  list: TaskCard[],
  name: string,
  meta: string | null,
  agent: RouterAgent | null,
  droppable: boolean,
  runsByTask: Map<string, RouterTaskRun>,
): Lane {
  const all = sortLane(list);
  return {
    key,
    kind,
    agent,
    name,
    meta,
    droppable,
    all,
    open: all.filter((task) => !isDone(task)),
    done: all.filter(isDone),
    load: loadOf(all, runsByTask),
  };
}

const LOAD_CHIP = {
  running: "bg-action-soft text-action-text",
  waiting: "bg-warning-soft text-warning-text",
  failed: "bg-danger-soft text-danger-text",
} as const;

/** 节点上的负载：几张在跑、几张等你、几张没跑成。为零的不写。 */
function LoadChips({ load }: { load: Load }) {
  const { t } = useTranslation();
  const kinds = (["running", "waiting", "failed"] as const).filter(
    (kind) => load[kind] > 0,
  );
  if (kinds.length === 0) return null;
  return (
    <span className="agent-node-chips">
      {kinds.map((kind) => (
        <span
          key={kind}
          className={cn(
            "inline-flex items-center gap-1 rounded-full px-1.5 py-[1px] text-[10px] leading-4",
            LOAD_CHIP[kind],
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              "size-1.5 rounded-full bg-current",
              kind === "running" && "motion-safe:animate-pulse",
            )}
          />
          {t(`tasks.agentView.${kind}`, { count: load[kind] })}
        </span>
      ))}
    </span>
  );
}

/** 非智能体的节点（输入、未分配、讨论）没有脸，用图标顶上同一个位置。 */
function IconFace({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <span className="agent-node-face" aria-hidden="true">
      <Icon className="h-4 w-4" strokeWidth={1.5} />
    </span>
  );
}

interface AgentFlowViewProps {
  /** 当前仓库的全部卡片（含 Done 与讨论卡） */
  tasks: TaskCard[];
  /** 设置里的全部智能体（含老配置里按应用补出来的那些） */
  agents: RouterAgent[];
  /** 允许参与派发的智能体 id，顺序即优先级 */
  allowed: string[];
  runsByTask: Map<string, RouterTaskRun>;
  busy: boolean;
  onOpenTask: (task: TaskCard) => void;
  /** 拖放只做指派：改归属不等于授权起跑 */
  onAssign: (task: TaskCard, agentId: string | null) => void;
  /** 卡上的 ▶ 才是第二个动作：指派并开工 */
  onAssignAndStart: (task: TaskCard, agentId: string) => void;
  onEditAgent: (agent: RouterAgent) => void;
  onAddAgent: () => void;
  /** 启停一个智能体的派发（允许名单） */
  onToggleAgent: (agent: RouterAgent, enabled: boolean) => void;
  /** Lead 的头像键；空 = 按固定 id 派生一张。 */
  routerAvatar: string;
  onSetRouterAvatar: (avatar: string) => void;
  /** 一栏里的 + ：建一张卡，建好就归这一栏（直接指派，不代它开工）。 */
  onCreateForAgent: (
    agentId: string,
    title: string,
    timing: NewTaskTiming,
  ) => Promise<boolean>;
  /** 不写归属地建一张卡：交出去，由 Lead 照常挑人。 */
  onCreateTask: (title: string, timing: NewTaskTiming) => Promise<boolean>;
  /** 讨论栏的 + ：记一张还没想清楚的草稿。 */
  onCreateDraft: (title: string) => Promise<boolean>;
  /** 换头像：传头像键，空串表示回到按 id 派生。 */
  onSetAgentAvatar: (agent: RouterAgent, avatar: string) => void;
  /** 删除定义：卡片留在看板上，归属会变成「未注册」 */
  onDeleteAgent: (agent: RouterAgent) => void;
  /** Lead 自己的调度模型；空 = 不用模型，只按确定性规则判断。 */
  leadModel?: string | null;
}

/**
 * 智能体视图：一张编制图，回答「这一队人现在什么状态」。
 *
 * 从左往右是活的流向，不是列表换皮：
 *
 * ```text
 *   输入                 Lead                   智能体            任务
 *   ┌──────────────┐   ┌────────────┐    ┌──────────────┐
 *   │ 与 Lead 讨论 │──▶│   头像      │───▶│ ●2 在跑 调研员 │──┐  启用 编辑 删除 +新建
 *   └──────┬───────┘   │   Lead      │    ├──────────────┤  └─▶┌──────────┐
 *      讨论卡(展开)    └────────────┘    │ ○ 审查员      │     │ TASK-23  │
 *                                       ├──────────────┤     │ TASK-26  │
 *                                       │ 未分配  3 张   │     └──────────┘
 *                                       └──────────────┘
 * ```
 *
 * 三件事是这张图必须说清的：
 *
 * 1. **输入这一列就是你和 Lead 谈的地方。** 它面向你：谈定之前谁都不动手，
 *    所以它自己单独一列、用紫色画出，不参与派发链，也不接受拖放。它的卡就展在
 *    它下面——那是一堆还没想清楚的东西，不该占着「某个人手上的活」那一栏。
 *    Lead 自己读什么（会话、MCP）不在图上复述：那是它的上下文，不是一条边走出来的。
 * 2. **Lead 的右边是派发链。** 谁在接活、谁手上压着几张卡，一眼看到底。
 * 3. **卡落在哪一栏由 `assignee` 决定。** 认不出来的归属落到「未分配」并标明
 *    未注册，不静默消失——那张卡需要人来决定归谁。
 * 4. **智能体与它的每一张卡之间都有线。** 那些线不是派发（派发从 Lead 出来），
 *    而是「这张卡归它」，所以一张卡各接一根：正在跑的那一根才走主题色。
 *    任务列本身不再重复一张智能体卡，只留操作（启用 / 编辑 / 删除 / ＋）与卡。
 *
 * 节点和连线的样式与流转图（网关那页）共用，位置则由实测盒子算：行高随卡片、
 * 语言、窗口变化，手摆的坐标下一次就错位。
 */
export function AgentFlowView({
  tasks,
  agents,
  allowed,
  runsByTask,
  busy,
  onOpenTask,
  onAssign,
  onAssignAndStart,
  onEditAgent,
  onAddAgent,
  onToggleAgent,
  routerAvatar,
  onSetRouterAvatar,
  onCreateForAgent,
  onCreateTask,
  onCreateDraft,
  onSetAgentAvatar,
  onDeleteAgent,
  leadModel = null,
}: AgentFlowViewProps) {
  const { t } = useTranslation();
  const [picked, setPicked] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [dragging, setDragging] = useState<string | null>(null);
  const [hoverDrop, setHoverDrop] = useState<string | null>(null);
  /** 删除不可撤销：先在同一栏里问一句，不用整页弹窗。 */
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  /** 哪一栏在新建卡片：输入框落在这一栏的卡上方。 */
  const [composer, setComposer] = useState<string | null>(null);
  /** 讨论那一栏默认展开：这是你和 Lead 谈的那一路，进来就能看见谈了什么。 */
  const [talkOpen, setTalkOpen] = useState(true);
  /** 讨论栏里的新建：讨论卡不排期，任务卡排期、建好交给 Lead。 */
  const [talkComposer, setTalkComposer] = useState<"draft" | "task" | null>(
    null,
  );

  const { discussion, byAgent, unassigned, unknown } = useMemo(() => {
    const discussions: TaskCard[] = [];
    const byAgent = new Map<string, TaskCard[]>();
    const unassigned: TaskCard[] = [];
    const unknown = new Map<string, string>();
    for (const task of tasks) {
      if (task.kind === "discussion") {
        discussions.push(task);
        continue;
      }
      const resolved = resolveAssignee(task, agents, allowed);
      if (resolved.agentId) {
        const list = byAgent.get(resolved.agentId) ?? [];
        list.push(task);
        byAgent.set(resolved.agentId, list);
      } else {
        unassigned.push(task);
        if (resolved.unknown) unknown.set(task.id, resolved.unknown);
      }
    }
    return { discussion: discussions, byAgent, unassigned, unknown };
  }, [tasks, agents, allowed]);

  // 能聚焦的栏只有「谁手上有活」这两种：智能体与未分配。讨论不在这里——
  // 它挂在 Lead 下面展开，右栏永远是「某个人手上有什么」。
  const lanes = useMemo<Lane[]>(() => {
    return [
      ...agents.map((agent) =>
        buildLane(
          `agent:${agent.id}`,
          "agent",
          byAgent.get(agent.id) ?? [],
          agent.name,
          [getAppDisplayName(agent.appId), agent.model]
            .filter(Boolean)
            .join(" · ") || null,
          agent,
          allowed.includes(agent.id),
          runsByTask,
        ),
      ),
      buildLane(
        "unassigned",
        "unassigned",
        unassigned,
        t("tasks.agentView.unassigned"),
        t("tasks.agentView.unassignedHint"),
        null,
        true,
        runsByTask,
      ),
    ];
  }, [agents, allowed, byAgent, runsByTask, t, unassigned]);

  /** 讨论这一栏：不在右栏里，展开在 Lead 节点下面。 */
  const talkLane = useMemo<Lane>(
    () =>
      buildLane(
        "discussion",
        "discussion",
        discussion,
        t("tasks.agentView.discussionRow"),
        t("tasks.agentView.discussionBypass"),
        null,
        false,
        runsByTask,
      ),
    [discussion, runsByTask, t],
  );

  const laneByKey = useMemo(
    () => new Map(lanes.map((lane) => [lane.key, lane])),
    [lanes],
  );

  /**
   * 打开时先看该看的：有未指派的就看未指派，否则看第一个手上有活的人。
   * 都空时留在讨论栏——那一栏永远存在，不会出现一张空图对着人。
   */
  const fallbackFocus = useMemo(() => {
    const loose = laneByKey.get("unassigned");
    if (loose && loose.open.length > 0) return loose.key;
    const busyAgent = lanes.find(
      (lane) => lane.kind === "agent" && lane.open.length > 0,
    );
    if (busyAgent) return busyAgent.key;
    return lanes[0]?.key ?? null;
  }, [laneByKey, lanes]);

  // 点过的栏若已经不在了（智能体被删），退回默认：不留下一个空栏。
  const focus = picked && laneByKey.has(picked) ? picked : fallbackFocus;
  const focused = focus ? (laneByKey.get(focus) ?? null) : null;

  const runningTotal = lanes.reduce(
    (sum, lane) => (lane.kind === "discussion" ? sum : sum + lane.load.running),
    0,
  );

  // ── 连线 ────────────────────────────────────────────────────────────────
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [geometry, setGeometry] = useState<FlowGeometry | null>(null);
  const measure = useCallback(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const stageBox = stage.getBoundingClientRect();
    const boxes = new Map<string, NodeBox>();
    stage.querySelectorAll<HTMLElement>("[data-flow-node]").forEach((node) => {
      const key = node.dataset.flowNode;
      if (!key) return;
      const rect = node.getBoundingClientRect();
      boxes.set(key, {
        left: rect.left - stageBox.left,
        top: rect.top - stageBox.top,
        right: rect.right - stageBox.left,
        bottom: rect.bottom - stageBox.top,
        cy: rect.top + rect.height / 2 - stageBox.top,
      });
    });
    setGeometry((current) => {
      const width = stageBox.width;
      const height = stageBox.height;
      if (
        current &&
        current.width === width &&
        current.height === height &&
        sameBoxes(current.boxes, boxes)
      ) {
        return current;
      }
      return { width, height, boxes };
    });
  }, []);

  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    measure();
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    if (observer) {
      observer.observe(stage);
      stage
        .querySelectorAll("[data-flow-node]")
        .forEach((node) => observer.observe(node));
    }
    // 卡多时那一栏在自己的框里滚：卡换了位置，线必须跟着重算，否则线还贴在
    // 滚动前的那几个点上（滚出去的那几张甚至会留下一根伸到空处的毛刺）。
    // 滚动事件不冒泡，所以在画布上用捕获接住所有内层滚动；画布之外那种横向滚
    // 动会连 svg 一起移动，相对位置不变，不需要处理。
    const onScroll = () => measure();
    stage.addEventListener("scroll", onScroll, {
      passive: true,
      capture: true,
    });
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      stage.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", measure);
    };
    // 卡的增减、聚焦栏的切换、讨论栏的展开都会改变节点高度：量完后连线才贴边。
  }, [
    measure,
    lanes,
    focused?.key,
    expanded,
    composer,
    talkOpen,
    talkComposer,
  ]);

  const box = (key: string) => geometry?.boxes.get(key);
  const leadBox = box("lead");
  // 分派边的落点：智能体 + 未分配。讨论不在其中，它是旁路。
  const dispatchTargets = lanes;

  const wires: { key: string; d: string; state: string }[] = [];
  if (leadBox) {
    // 讨论就在 Lead 的左边：一根横向的紫线就说清「这一路是你跟它谈」，
    // 不需要再绕一道弧——绕路只能说明它原本挂在 Lead 下面。
    const talk = box("discussion");
    if (talk) {
      wires.push({
        key: "bypass",
        d: wirePath(talk, leadBox),
        state: "human",
      });
    }
    dispatchTargets.forEach((lane, index) => {
      const to = box(lane.key);
      if (!to) return;
      const offset = (index - (dispatchTargets.length - 1) / 2) * WIRE_FAN_GAP;
      wires.push({
        key: lane.key,
        d: wirePath(leadBox, to, offset),
        state:
          lane.kind === "unassigned"
            ? // 未分配不是一条派发边：这些卡还没有主人，等你去指。
              "off"
            : !lane.droppable
              ? "off"
              : lane.load.running > 0
                ? "busy"
                : "idle",
      });
    });
  }

  // 归属边：聚焦那一支 → 它手上的**每一张**卡。
  //
  // 一根线落到「卡堆中间」会把这些卡说成一个集合：看不出哪张归它，也看不出
  // 哪张正在跑。所以一张卡接一根：在节点这一侧散开（否则几条线叠成一条），
  // 到卡那里各自落一个点；正在跑的那张才走主题色。
  if (focused) {
    const from = box(focused.key);
    const cards = visibleCards(focused, expanded[focused.key] === true);
    // 卡多时这一栏自己滚：滚出去的那几张卡的中心已经不在看得见的范围里，
    // 再给它们画线就是几根伸到栏外空处去的毛刺。没量到（高度为零）时不裁。
    const clipBox = box("lane:clip");
    const clip =
      clipBox && clipBox.bottom - clipBox.top > 4
        ? { top: clipBox.top + 2, bottom: clipBox.bottom - 2 }
        : null;
    if (from) {
      cards.forEach((task, index) => {
        const to = box(`card:${task.id}`);
        if (!to) return;
        if (clip && (to.cy < clip.top || to.cy > clip.bottom)) return;
        // 从上往下依次散开：源端与卡端的顺序一致，所以这些线不会交叉。
        const offset = (index - (cards.length - 1) / 2) * WIRE_FAN_GAP;
        wires.push({
          key: `own:${task.id}`,
          d: wirePathTo(from, to, offset),
          state: runningNow(runsByTask.get(task.id)) ? "busy" : "own",
        });
      });
    }
  }

  // ── 拖放 ────────────────────────────────────────────────────────────────
  /** 只有「能指派」的卡拖得动：讨论卡没有归属，已完成的卡不该被重新分配。 */
  const draggable = (task: TaskCard) =>
    !isDone(task) && task.kind !== "discussion";

  const dropHandlers = (
    key: string,
    accept: boolean,
    onDrop: (taskId: string | null) => void,
  ) =>
    accept
      ? {
          onDragOver: (event: DragEvent) => {
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            setHoverDrop(key);
          },
          onDragLeave: () =>
            setHoverDrop((current) => (current === key ? null : current)),
          onDrop: (event: DragEvent) => {
            event.preventDefault();
            setHoverDrop(null);
            // 卡 id 先看 dataTransfer（跨窗口、跨组件都靠它），再退回本地状态：
            // 有的合成拖拽不写 payload，只要拖动是从这张卡起的，仍然能落位。
            const payload = event.dataTransfer?.getData("text/plain") ?? "";
            onDrop(payload || dragging);
            setDragging(null);
          },
        }
      : {};

  const dropAssign = (agentId: string | null, taskId: string | null) => {
    const task = tasks.find((entry) => entry.id === taskId);
    // 讨论卡没有归属，已完成的卡也不该被重新指派：两者都不接。
    if (task && draggable(task)) onAssign(task, agentId);
  };

  // ── 卡片 ────────────────────────────────────────────────────────────────
  // `wired` 只在聚焦那一栏打开：只有那一栏的卡有归属边。
  const renderLaneCards = (lane: Lane, wired = false) => {
    const showAll = expanded[lane.key] === true;
    const visible = visibleCards(lane, showAll);
    if (visible.length === 0) {
      return (
        <p className="m-0 text-[11px] leading-5 text-fg-3">
          {lane.kind === "discussion"
            ? t("tasks.agentView.discussionEmpty")
            : t("tasks.agentView.laneEmpty")}
        </p>
      );
    }
    return (
      <>
        <div
          className="agent-lane-cards"
          /* 这一栏的可见范围：卡片比它高时自己滚，连线得知道哪儿是边界。 */
          data-flow-node={wired ? "lane:clip" : undefined}
          data-scroll={visible.length > LANE_SCROLL_AFTER ? "true" : undefined}
        >
          {visible.map((task) => {
            const run = runsByTask.get(task.id);
            const doneCard = isDone(task);
            const unknownId = unknown.get(task.id);
            return (
              <article
                key={task.id}
                /* 每张卡就是一个连线落点：归属边按这个键找它。 */
                data-flow-node={wired ? `card:${task.id}` : undefined}
                draggable={draggable(task)}
                onDragStart={(event) => {
                  setDragging(task.id);
                  event.dataTransfer.setData("text/plain", task.id);
                  event.dataTransfer.effectAllowed = "move";
                }}
                onDragEnd={() => {
                  setDragging(null);
                  setHoverDrop(null);
                }}
                className={cn(
                  "group relative rounded-control border border-border bg-surface px-2.5 py-2 shadow-v7-card",
                  dragging === task.id && "opacity-50",
                  doneCard && "bg-subtle",
                )}
              >
                <button
                  type="button"
                  onClick={() => onOpenTask(task)}
                  className="block w-full text-start"
                >
                  <span
                    className={cn(
                      "block truncate text-caption font-medium text-fg-1",
                      doneCard && "text-fg-2",
                    )}
                    title={task.title}
                  >
                    {task.title}
                  </span>
                  <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-fg-3">
                    <RunStateBadge run={run} />
                    <span className="font-mono">{task.id}</span>
                    {unknownId ? (
                      <span className="rounded-full bg-danger-soft px-1.5 py-[1px] text-danger-text">
                        {t("tasks.agentView.unknownAgent", { id: unknownId })}
                      </span>
                    ) : null}
                    {scheduleLabel(t, task.schedule) ? (
                      <span className="rounded-full bg-subtle px-1.5 py-[1px]">
                        {scheduleLabel(t, task.schedule)}
                      </span>
                    ) : null}
                    {/* 这张卡会接着某段对话干：不写出来，人就不知道它为什么
                        不像别的卡那样从零开始。 */}
                    {task.session ? (
                      <span
                        className="rounded-full bg-subtle px-1.5 py-[1px]"
                        title={t("tasks.session.cardBadgeTitle", {
                          id: task.session,
                        })}
                      >
                        {t("tasks.session.cardBadge")}
                      </span>
                    ) : null}
                  </span>
                </button>
                {lane.agent && !doneCard ? (
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={t("tasks.agentView.start")}
                    title={t("tasks.agentView.start")}
                    onClick={() => onAssignAndStart(task, lane.agent!.id)}
                    className="absolute end-1.5 top-1.5 flex size-6 items-center justify-center rounded-control text-fg-3 opacity-0 transition-opacity hover:bg-subtle hover:text-fg-1 focus-visible:opacity-100 group-hover:opacity-100 disabled:opacity-40"
                  >
                    <Play
                      aria-hidden="true"
                      className="h-3.5 w-3.5"
                      strokeWidth={1.5}
                    />
                  </button>
                ) : null}
              </article>
            );
          })}
        </div>
        {lane.done.length > DONE_IN_LANE ? (
          <button
            type="button"
            onClick={() =>
              setExpanded((current) => ({
                ...current,
                [lane.key]: !showAll,
              }))
            }
            className="self-start rounded-control px-1.5 py-1 text-[11px] text-fg-3 hover:bg-subtle hover:text-fg-1"
          >
            {showAll
              ? t("tasks.agentView.showLess")
              : t("tasks.agentView.doneCount", { count: lane.done.length })}
          </button>
        ) : lane.done.length > 0 ? (
          <span className="text-[11px] text-fg-3">
            {t("tasks.agentView.doneCount", { count: lane.done.length })}
          </span>
        ) : null}
      </>
    );
  };

  const activeComposer = composer;
  /** 「＋」只有一句适要说：给这个人加活，还是在未分配里起一张没主的卡。 */
  const addTaskLabel = (lane: Lane) =>
    lane.kind === "unassigned"
      ? t("tasks.agentView.addUnassigned")
      : t("tasks.agentView.addTask", { name: lane.name });

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto scroll-stable">
      {/* 视图名不占一行：这一屏只有「谁在给谁派活」一件事。区域仍需一个名字，
          所以留一行只给读屏。 */}
      <h2 className="sr-only">{t("tasks.agentView.title")}</h2>
      <div
        className="overflow-x-auto pb-2"
        tabIndex={0}
        role="group"
        aria-label={t("tasks.agentView.title")}
      >
        <div
          className="phi-flow-stage"
          data-layout="agents"
          data-talk={talkOpen ? "open" : undefined}
          ref={stageRef}
        >
          {/* 第一列 · 输入。Lead 读什么（会话、MCP）是它的上下文，不在图上复述；
              这一列留给唯一一条真的走出来的输入：你和 Lead 谈。 */}
          <div className="phi-flow-col">
            <p className="phi-flow-col-label">{t("tasks.agentView.inputs")}</p>
            {/* 讨论：面向你的那一条。它自己占一列、用紫色单独画，
                不接派发边，也不接受拖放——谈定之前谁都不该被派活。
                这一列默认展开（讨论卡 + 两个新建入口），点节点可以收起来。 */}
            <div
              className="phi-flow-node"
              data-kind="discussion"
              data-flow-node="discussion"
              data-open={talkOpen ? "true" : undefined}
            >
              <IconFace icon={MessagesSquare} />
              <button
                type="button"
                className="phi-flow-hit"
                aria-expanded={talkOpen}
                aria-controls="agent-talk"
                aria-label={t("tasks.agentView.discussionRow")}
                onClick={() => setTalkOpen((current) => !current)}
              >
                <span className="agent-node-name">{talkLane.name}</span>
                <span className="agent-node-meta">
                  {talkLane.all.length > 0
                    ? t("tasks.agentView.discussionCount", {
                        count: talkLane.all.length,
                      })
                    : talkLane.meta}
                </span>
              </button>
            </div>
            {talkOpen ? (
              <section
                id="agent-talk"
                className="agent-talk-panel"
                aria-label={t("tasks.agentView.discussionRow")}
              >
                {renderLaneCards(talkLane)}
                {/* 两个新建入口也是图标：一张讨论卡、一张任务卡。
                    区别写在下面的提示里，不靠把两枚胶囊并排。 */}
                <div className="agent-lane-tools">
                  <HoverTip content={t("tasks.agentView.discussionNewDraft")}>
                    <Button
                      variant="ghost"
                      size="icon-compact"
                      aria-label={t("tasks.agentView.discussionNewDraft")}
                      aria-expanded={talkComposer === "draft"}
                      onClick={() =>
                        setTalkComposer((current) =>
                          current === "draft" ? null : "draft",
                        )
                      }
                    >
                      <MessageSquarePlus
                        data-icon
                        className="h-3.5 w-3.5"
                        strokeWidth={1.5}
                      />
                    </Button>
                  </HoverTip>
                  <HoverTip content={t("tasks.agentView.discussionNewTask")}>
                    <Button
                      variant="ghost"
                      size="icon-compact"
                      aria-label={t("tasks.agentView.discussionNewTask")}
                      aria-expanded={talkComposer === "task"}
                      onClick={() =>
                        setTalkComposer((current) =>
                          current === "task" ? null : "task",
                        )
                      }
                    >
                      <Plus data-icon className="h-4 w-4" strokeWidth={1.75} />
                    </Button>
                  </HoverTip>
                </div>
                {/* 两枚按钮的区别只有一句：任务卡建好就交出去。 */}
                <p className="agent-talk-hint">
                  {t("tasks.agentView.discussionTaskHint")}
                </p>
                {talkComposer ? (
                  <LaneComposer
                    /* 换一种就换一个输入框：草稿的排期控件不能带到任务卡上 */
                    key={talkComposer}
                    label={
                      talkComposer === "draft"
                        ? t("tasks.agentView.discussionNewDraft")
                        : t("tasks.agentView.discussionNewTask")
                    }
                    placeholder={
                      talkComposer === "draft"
                        ? t("tasks.agentView.routerAddPlaceholder")
                        : t("tasks.agentView.addTaskPlaceholder")
                    }
                    /* 草稿不排期：还在讨论，先不承诺什么时候跑。 */
                    withSchedule={talkComposer === "task"}
                    onCreate={(title, timing) =>
                      talkComposer === "draft"
                        ? onCreateDraft(title)
                        : onCreateTask(title, timing)
                    }
                    onClose={() => setTalkComposer(null)}
                  />
                ) : null}
              </section>
            ) : null}
          </div>

          {/* 第二列 · Lead。派发的起点：往右是派发链，往左是你和它谈的那一路。 */}
          <div className="phi-flow-col">
            <p className="phi-flow-col-label">
              {t("tasks.agentView.routerName")}
            </p>
            <div
              className="phi-flow-node phi-flow-hub agent-flow-hub"
              data-flow-node="lead"
              data-kind="lead"
            >
              <AgentAvatarPicker
                agentId={ROUTER_AVATAR_ID}
                agentName={t("tasks.agentView.routerName")}
                avatar={routerAvatar}
                onPick={onSetRouterAvatar}
                size={36}
              />
              <span className="agent-node-name">
                {t("tasks.agentView.routerName")}
              </span>
              <span className="agent-node-meta">
                {leadModel
                  ? t("tasks.agentView.leadModel", {
                      // 设置里存的是路由组别名（`group/路由2`）。组前缀是给网关看的，
                      // 写在节点上只会让人以为是模型名的一部分。
                      model: leadModel.replace(/^group\//, ""),
                    })
                  : t("tasks.agentView.leadRules")}
              </span>
              {runningTotal > 0 ? (
                <span className="agent-node-chips">
                  <span className="inline-flex items-center gap-1 rounded-full bg-action-soft px-1.5 py-[1px] text-[10px] leading-4 text-action-text">
                    {t("tasks.agentView.running", { count: runningTotal })}
                  </span>
                </span>
              ) : null}
            </div>
          </div>

          {/* 第三列 · 智能体。每个节点是一个「谁能接活」，边上是它现在手上的活。 */}
          <div className="phi-flow-col">
            <p className="phi-flow-col-label">{t("tasks.agentView.agents")}</p>
            <ul
              className="phi-flow-group-list"
              aria-label={t("tasks.agentView.agents")}
            >
              {lanes.map((lane) => {
                const muted = focus && focus !== lane.key;
                const droppable = lane.droppable;
                return (
                  <li
                    key={lane.key}
                    className="phi-flow-node"
                    data-kind={lane.kind}
                    data-flow-node={lane.key}
                    data-focus={focus === lane.key ? "true" : undefined}
                    data-muted={muted ? "true" : undefined}
                    data-drop={hoverDrop === lane.key ? "true" : undefined}
                    {...dropHandlers(lane.key, droppable, (taskId) =>
                      dropAssign(lane.agent?.id ?? null, taskId),
                    )}
                  >
                    {lane.agent ? (
                      <AgentAvatarPicker
                        agentId={lane.agent.id}
                        agentName={lane.agent.name}
                        avatar={lane.agent.avatar}
                        onPick={(next) => onSetAgentAvatar(lane.agent!, next)}
                        size={28}
                      />
                    ) : (
                      <IconFace icon={Inbox} />
                    )}
                    <button
                      type="button"
                      className="phi-flow-hit"
                      aria-pressed={focus === lane.key}
                      aria-label={t("tasks.agentView.focusNode", {
                        name: lane.name,
                      })}
                      onClick={() => setPicked(lane.key)}
                    >
                      <span className="agent-node-name">{lane.name}</span>
                      <span className="agent-node-meta">
                        {lane.meta ?? t("tasks.agentView.laneEmpty")}
                      </span>
                      {lane.kind === "agent" && !droppable ? (
                        <span className="agent-node-chips">
                          <span className="rounded-full bg-subtle px-1.5 py-[1px] text-[10px] leading-4 text-fg-3">
                            {t("tasks.agentView.notAllowed")}
                          </span>
                        </span>
                      ) : lane.load.running > 0 ||
                        lane.load.waiting > 0 ||
                        lane.load.failed > 0 ? (
                        <LoadChips load={lane.load} />
                      ) : lane.open.length > 0 ? (
                        <span className="agent-node-chips">
                          <span className="rounded-full bg-subtle px-1.5 py-[1px] text-[10px] leading-4 text-fg-3">
                            {t("tasks.agentView.openTasks", {
                              count: lane.open.length,
                            })}
                          </span>
                        </span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
            {/* 唯一的创建入口：想让人起草，就在「添加智能体」里说。 */}
            <button type="button" className="phi-flow-add" onClick={onAddAgent}>
              <Plus aria-hidden="true" />
              {t("tasks.agentView.add")}
            </button>
          </div>

          {/* 第四列 · 聚焦那一支手上的卡。点节点换这一栏。
              这一列不重复写「这是谁」——上面那个节点已经带着头像与名字了，
              所以只管两件事：能对它做什么（启用 / 编辑 / 删除 / 新建任务），
              以及它手上现在有哪几张卡。 */}
          <div className="phi-flow-col" data-lane={focused?.key ?? ""}>
            <p className="phi-flow-col-label">
              {focused
                ? t("tasks.agentView.laneTasksFor", { name: focused.name })
                : t("tasks.agentView.laneTasks")}
            </p>
            {focused ? (
              <>
                {/* 操作与卡同一行右上角：四个控件同一档尺寸、同一种无框样式，
                    数量不再靠「新建任务」那枚带框的胶囊撑着——它就是一枚 ＋。 */}
                <div className="agent-lane-tools">
                  {focused.agent && pendingDelete === focused.agent.id ? (
                    <>
                      <Button
                        variant="destructive"
                        size="compact"
                        aria-label={t("tasks.agentView.deleteConfirm", {
                          name: focused.name,
                        })}
                        onClick={() => {
                          setPendingDelete(null);
                          onDeleteAgent(focused.agent!);
                        }}
                      >
                        {t("tasks.agentView.deleteConfirmShort")}
                      </Button>
                      <Button
                        variant="ghost"
                        size="compact"
                        onClick={() => setPendingDelete(null)}
                      >
                        {t("tasks.agentView.deleteCancel")}
                      </Button>
                    </>
                  ) : (
                    <>
                      {focused.agent ? (
                        <>
                          <HoverTip
                            content={t("tasks.agentView.enableAgent", {
                              name: focused.name,
                            })}
                          >
                            <span className="agent-tool-switch">
                              <Switch
                                checked={focused.droppable}
                                aria-label={t("tasks.agentView.enableAgent", {
                                  name: focused.name,
                                })}
                                onCheckedChange={(checked) =>
                                  onToggleAgent(focused.agent!, checked)
                                }
                              />
                            </span>
                          </HoverTip>
                          <HoverTip
                            content={t("tasks.agentView.edit", {
                              name: focused.name,
                            })}
                          >
                            <Button
                              variant="ghost"
                              size="icon-compact"
                              aria-label={t("tasks.agentView.edit", {
                                name: focused.name,
                              })}
                              onClick={() => onEditAgent(focused.agent!)}
                            >
                              <Pencil
                                data-icon
                                className="h-3.5 w-3.5"
                                strokeWidth={1.5}
                              />
                            </Button>
                          </HoverTip>
                          <HoverTip content={t("tasks.agentView.deleteHint")}>
                            <Button
                              variant="ghost"
                              size="icon-compact"
                              aria-label={t("tasks.agentView.delete", {
                                name: focused.name,
                              })}
                              onClick={() =>
                                setPendingDelete(focused.agent!.id)
                              }
                            >
                              <Trash2
                                data-icon
                                className="h-3.5 w-3.5"
                                strokeWidth={1.5}
                              />
                            </Button>
                          </HoverTip>
                        </>
                      ) : null}
                      {/* 建卡就归这一栏：一枚 ＋ 就够了，名字在提示与读屏里。 */}
                      <HoverTip
                        content={
                          focused.kind === "agent" && !focused.droppable
                            ? t("tasks.agentView.addTaskBlocked")
                            : addTaskLabel(focused)
                        }
                      >
                        {/* 禁用时按钮收不到指针事件，提示包在外层才看得见。 */}
                        <span className="agent-tool-slot">
                          <Button
                            variant="ghost"
                            size="icon-compact"
                            disabled={
                              focused.kind === "agent" && !focused.droppable
                            }
                            aria-label={addTaskLabel(focused)}
                            aria-expanded={activeComposer === focused.key}
                            onClick={() =>
                              setComposer((current) =>
                                current === focused.key ? null : focused.key,
                              )
                            }
                          >
                            <Plus
                              data-icon
                              className="h-4 w-4"
                              strokeWidth={1.75}
                            />
                          </Button>
                        </span>
                      </HoverTip>
                    </>
                  )}
                </div>

                {activeComposer === focused.key ? (
                  <LaneComposer
                    label={
                      focused.kind === "unassigned"
                        ? t("tasks.agentView.addUnassigned")
                        : t("tasks.agentView.addTask", { name: focused.name })
                    }
                    placeholder={t("tasks.agentView.addTaskPlaceholder")}
                    withSchedule
                    onCreate={(title, timing) =>
                      focused.agent
                        ? onCreateForAgent(focused.agent.id, title, timing)
                        : /* 不写归属：建好交给 Lead 照常挑人 */
                          onCreateTask(title, timing)
                    }
                    onClose={() => setComposer(null)}
                  />
                ) : null}

                {/* 卡的落点：每张卡自己带 data-flow-node，归属边一张一根。 */}
                <div
                  {...dropHandlers(
                    `lane:${focused.key}`,
                    focused.droppable,
                    (taskId) => dropAssign(focused.agent?.id ?? null, taskId),
                  )}
                  className="agent-lane-stack"
                >
                  {renderLaneCards(focused, true)}
                </div>
              </>
            ) : (
              <p className="m-0 text-[11px] leading-5 text-fg-3">
                {t("tasks.agentView.focusHint")}
              </p>
            )}
          </div>

          {/* 连线覆盖层。位置由实测盒子算，节点怎么长线就怎么贴。 */}
          <svg
            className="agent-flow-wires"
            width={geometry?.width ?? 0}
            height={geometry?.height ?? 0}
            viewBox={`0 0 ${geometry?.width ?? 0} ${geometry?.height ?? 0}`}
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            {wires.map((wire) => (
              <path key={wire.key} d={wire.d} data-state={wire.state} />
            ))}
          </svg>
        </div>
      </div>
    </div>
  );
}

/** 正在拖的卡：拖起时记在组件的 state 里，松手时用它找卡。 */

/**
 * 一栏里的新建卡：一个输入框 + 任务类型，建好就落在这张栏下。
 *
 * 它与列头那个快速新建是同一件事，所以排期控件用的是同一份；不同的是这栏知道
 * 「归谁」——卡片写 `assignee` 就是直接指派，不再需要先建再拖。
 */
function LaneComposer({
  label,
  placeholder,
  withSchedule,
  onCreate,
  onClose,
}: {
  label: string;
  placeholder: string;
  /** 草稿（讨论栏）不排期：还在讨论，先不承诺什么时候跑。 */
  withSchedule: boolean;
  onCreate: (title: string, timing: NewTaskTiming) => Promise<boolean>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [title, setTitle] = useState("");
  const [pending, setPending] = useState(false);
  const timing = useTaskTiming();

  const submit = async () => {
    const value = title.trim();
    if (!value || pending || (withSchedule && !timing.valid)) return;
    setPending(true);
    try {
      const next = withSchedule
        ? timing.timing()
        : { recurrence: null, schedule: null };
      if (await onCreate(value, next)) {
        setTitle("");
        timing.reset();
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="space-y-1.5 rounded-control border border-border bg-surface p-2 shadow-v7-card">
      <div className="flex items-center gap-1.5">
        <Input
          autoFocus
          value={title}
          aria-label={label}
          placeholder={placeholder}
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={(event) => {
            // 回车只是换行位：与列头一样，Ctrl+Enter 才发，避免输入法误发
            if (
              event.key === "Enter" &&
              event.ctrlKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              void submit();
            } else if (event.key === "Escape") {
              setTitle("");
              onClose();
            }
          }}
        />
        <HoverTip content={t("tasks.newTaskSend")}>
          <Button
            variant="solid"
            size="icon-compact"
            aria-label={t("tasks.newTaskSend")}
            disabled={
              !title.trim() || pending || (withSchedule && !timing.valid)
            }
            onClick={() => void submit()}
          >
            <Send data-icon className="h-3.5 w-3.5" strokeWidth={1.5} />
          </Button>
        </HoverTip>
        <Button
          variant="ghost"
          size="icon-compact"
          aria-label={t("tasks.agentView.addTaskClose")}
          onClick={onClose}
        >
          <X data-icon className="h-3.5 w-3.5" strokeWidth={1.5} />
        </Button>
      </div>
      {withSchedule ? (
        <ScheduleFields timing={timing} pending={pending} />
      ) : null}
    </div>
  );
}
