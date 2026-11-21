import { useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  Inbox,
  Lightbulb,
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
import type {
  AgentSuggestion,
  RouterAgent,
  RouterTaskRun,
} from "@/lib/api/superAgent";
import type { TaskCard } from "@/lib/api/tasks";
import { cn } from "@/lib/utils";
import { AgentAvatarPicker } from "./AgentAvatarPicker";
import { resolveAssignee } from "./agentSettings";
import { RunStateBadge } from "./RunStateBadge";
import {
  ScheduleFields,
  useTaskTiming,
  type NewTaskTiming,
} from "./TaskComposer";

/** 行内默认留几张已完成的卡。三张够看出「它最近干了什么」，再多就是日志。 */
const DONE_IN_ROW = 3;

/**
 * Router 的头像 id。
 *
 * 它不是智能体、也不会有 id 冲突（智能体 id 由名称派生，全是可读文字），
 * 所以给一个固定值就够了：没选过头像时按它哈希出一张，重启、改名都不换脸。
 */
const ROUTER_AVATAR_ID = "router";

/** 非智能体的两行（讨论区、未分配）没有脸，用图标顶上同一个位置。 */
function IconAvatar({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <span className="flex size-8 shrink-0 items-center justify-center rounded-full border border-border bg-subtle text-fg-3">
      <Icon aria-hidden="true" className="h-4 w-4" strokeWidth={1.5} />
    </span>
  );
}

interface RowHeadProps {
  avatar: ReactNode;
  /** 行名，也是这一行的可访问名称。 */
  title: string;
  /** 名称同一行的小字：应用 · 模型、在跑几张、不参与派发。 */
  meta?: ReactNode;
  /** 名称下面那句用途；长了就截断，细节留给编辑弹窗。 */
  description?: string | null;
  children?: ReactNode;
}

/**
 * 行头：头像 ｜ 名称，卡片跟在下面。
 *
 * 一行的第一眼应当是「这是谁」，所以头像与名称同一行、卡片另起一行。
 * 行头本身不套卡片：它压在自己那几张卡的左上方，是标题而不是卡里的标题栏；
 * 行操作收在右侧，不与名称抢位置。
 */
function RowHead({ avatar, title, meta, description, children }: RowHeadProps) {
  return (
    <header className="mb-2 flex items-start gap-2.5">
      {avatar}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <h3 className="m-0 min-w-0 truncate text-body font-medium text-fg-1">
            {title}
          </h3>
          {meta}
        </div>
        {description ? (
          <p className="m-0 truncate text-[11px] text-fg-3" title={description}>
            {description}
          </p>
        ) : null}
      </div>
      {children ? (
        <div className="flex shrink-0 items-center gap-1.5">{children}</div>
      ) : null}
    </header>
  );
}

interface AgentBoardViewProps {
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
  /** 行内 ▶ 才是第二个动作：指派并开工 */
  onAssignAndStart: (task: TaskCard, agentId: string) => void;
  onEditAgent: (agent: RouterAgent) => void;
  onAddAgent: () => void;
  /** 启停一个智能体的派发（允许名单） */
  onToggleAgent: (agent: RouterAgent, enabled: boolean) => void;
  /** Router 的头像键；空 = 按固定 id 派生一张。 */
  routerAvatar: string;
  onSetRouterAvatar: (avatar: string) => void;
  /** 行里的 + ：建一张卡，建好就归到这一行（直接指派，不代他开工）。 */
  onCreateForAgent: (
    agentId: string,
    title: string,
    timing: NewTaskTiming,
  ) => Promise<boolean>;
  /** Router 那一行的 + ：记一张还没想清楚的草稿。 */
  onCreateDraft: (title: string) => Promise<boolean>;
  /** 换头像：传头像键，空串表示回到按 id 派生。 */
  onSetAgentAvatar: (agent: RouterAgent, avatar: string) => void;
  /** 删除定义：卡片留在看板上，归属会变成「未注册」 */
  onDeleteAgent: (agent: RouterAgent) => void;
  suggestion: AgentSuggestion | null;
  onUseSuggestion: (suggestion: AgentSuggestion) => void;
  onDismissSuggestion: () => void;
}

function isDone(task: TaskCard): boolean {
  return task.status.trim().toLowerCase() === "done";
}

/**
 * 智能体视图：一行一个智能体，第一行是「与 Router 讨论」。
 *
 * 列回答「现在该谁动」，行回答「谁在干什么、谁闲着」。所以这不是把看板换个画法，
 * 而是补上归属这一维：卡片落在哪一行，由它的 `assignee` 决定；认不出来的归属
 * 落到「未分配」并标明未注册，不静默消失。
 */
export function AgentBoardView({
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
  onCreateDraft,
  onSetAgentAvatar,
  onDeleteAgent,
  suggestion,
  onUseSuggestion,
  onDismissSuggestion,
}: AgentBoardViewProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [dragging, setDragging] = useState<string | null>(null);
  const [hoverRow, setHoverRow] = useState<string | null>(null);
  /** 删除不可撤销：先在同一行问一句，不用整页弹窗。 */
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  /** 哪一行在新建卡片；+ 就摆在这一行的行头里，输入框落在卡片上方。 */
  const [composer, setComposer] = useState<string | null>(null);

  const { discussions, byAgent, unassigned, unknown } = useMemo(() => {
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
    const order = (list: TaskCard[]) =>
      list.sort((left, right) => {
        const done = Number(isDone(left)) - Number(isDone(right));
        if (done !== 0) return done;
        return (right.updatedDate ?? "").localeCompare(left.updatedDate ?? "");
      });
    for (const list of byAgent.values()) order(list);
    order(unassigned);
    return { discussions, byAgent, unassigned, unknown };
  }, [tasks, agents, allowed]);

  const renderCards = (
    key: string,
    list: TaskCard[],
    agent: RouterAgent | null,
  ) => {
    const open = list.filter((task) => !isDone(task));
    const done = list.filter(isDone);
    const showAll = expanded[key] === true;
    const visible = showAll
      ? [...open, ...done]
      : [...open, ...done.slice(0, DONE_IN_ROW)];
    // 空行只剩行头：一句「没有卡片」在七行里重复七遍，比空着更吵。
    if (visible.length === 0) return null;
    return (
      <div className="flex flex-wrap gap-2">
        {visible.map((task) => {
          const run = runsByTask.get(task.id);
          const doneCard = isDone(task);
          const unknownId = unknown.get(task.id);
          return (
            <article
              key={task.id}
              // 讨论卡没有归属：既不该被拖走，也不该被拖给某个智能体。
              draggable={!doneCard && task.kind !== "discussion"}
              onDragStart={(event) => {
                setDragging(task.id);
                event.dataTransfer.setData("text/plain", task.id);
                event.dataTransfer.effectAllowed = "move";
              }}
              onDragEnd={() => {
                setDragging(null);
                setHoverRow(null);
              }}
              className={cn(
                "group relative w-[220px] rounded-control border border-border bg-surface px-2.5 py-2 shadow-v7-card",
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
                </span>
              </button>
              {agent && !doneCard ? (
                <button
                  type="button"
                  disabled={busy}
                  aria-label={t("tasks.agentView.start")}
                  title={t("tasks.agentView.start")}
                  onClick={() => onAssignAndStart(task, agent.id)}
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
        {done.length > DONE_IN_ROW ? (
          <button
            type="button"
            onClick={() =>
              setExpanded((current) => ({ ...current, [key]: !showAll }))
            }
            className="self-center rounded-control px-2 py-1 text-[11px] text-fg-3 hover:bg-subtle hover:text-fg-1"
          >
            {showAll
              ? t("tasks.agentView.showLess")
              : t("tasks.agentView.doneCount", { count: done.length })}
          </button>
        ) : done.length > 0 ? (
          <span className="self-center text-[11px] text-fg-3">
            {t("tasks.agentView.doneCount", { count: done.length })}
          </span>
        ) : null}
      </div>
    );
  };

  /**
   * 一行不是一张卡：头像与名称是这一行的标题，卡片才是它的内容。
   *
   * 所以行本身不画边框和底色，只用一道细线与上一行分开；被拖着经过时才浮一层
   * 底色表示「放这里」。行自己的边框会让人以为「标题在卡里」。
   */
  const rowClass = (key: string, first = false) =>
    cn(
      "rounded-panel p-1 transition-colors",
      !first && "border-t border-border/60 pt-3",
      // 主题色是纯 var()，`bg-action-soft/60` 这类透明度修饰不会生成样式：
      // 拖拽经过时那一层提示底色会静默消失（见 LESSONS「主题色是 var() 时」）。
      hoverRow === key && "bg-action-soft",
    );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto scroll-stable py-1">
      {/* 视图名不再占一行：这一屏只有「智能体 ｜ 它的卡片」两件事。
          区域仍需一个名字，所以留一行只给读屏。 */}
      <h2 className="sr-only">{t("tasks.agentView.title")}</h2>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[11px] text-fg-3">
          {t("tasks.agentView.dragHint")}
        </span>
        {/* 只有一个入口：想让人起草，就在「添加智能体」里说；不必先分清两个按钮。 */}
        <Button variant="neutral" size="compact" onClick={onAddAgent}>
          <Plus data-icon className="h-3.5 w-3.5" strokeWidth={1.5} />
          {t("tasks.agentView.add")}
        </Button>
      </div>

      {suggestion ? (
        <div className="flex items-start gap-3 rounded-panel border border-action bg-action-soft p-3">
          <Lightbulb
            aria-hidden="true"
            className="mt-0.5 h-4 w-4 shrink-0 text-action-text"
            strokeWidth={1.5}
          />
          <div className="min-w-0 flex-1">
            <p className="m-0 text-caption font-medium text-fg-1">
              {t("tasks.agentView.suggestion")}
            </p>
            <p className="m-0 mt-1 text-caption leading-relaxed text-fg-2">
              {suggestion.summary}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              variant="neutral"
              size="compact"
              onClick={() => onUseSuggestion(suggestion)}
            >
              {t("tasks.agentView.suggestionUse", { name: suggestion.name })}
            </Button>
            <Button
              variant="ghost"
              size="icon-compact"
              aria-label={t("tasks.agentView.suggestionDismiss")}
              onClick={onDismissSuggestion}
            >
              <X data-icon className="h-3.5 w-3.5" strokeWidth={1.5} />
            </Button>
          </div>
        </div>
      ) : null}

      <section className={rowClass("discussion", true)}>
        {/* Router 与智能体同一套行头：头像 ｜ 名称，卡片跟在下边。 */}
        <RowHead
          avatar={
            <AgentAvatarPicker
              agentId={ROUTER_AVATAR_ID}
              agentName={t("tasks.agentView.routerName")}
              avatar={routerAvatar}
              onPick={onSetRouterAvatar}
            />
          }
          title={t("tasks.agentView.discussionRow")}
          description={t("tasks.agentView.routerPurpose")}
        >
          <HoverTip content={t("tasks.agentView.routerAdd")}>
            <Button
              variant="ghost"
              size="icon-compact"
              aria-label={t("tasks.agentView.routerAdd")}
              aria-expanded={composer === "discussion"}
              onClick={() =>
                setComposer((current) =>
                  current === "discussion" ? null : "discussion",
                )
              }
            >
              <Plus data-icon className="h-3.5 w-3.5" strokeWidth={1.5} />
            </Button>
          </HoverTip>
        </RowHead>
        {composer === "discussion" ? (
          <RowTaskComposer
            label={t("tasks.agentView.routerAdd")}
            placeholder={t("tasks.agentView.routerAddPlaceholder")}
            /* 草稿不排期：还在讨论，先不承诺什么时候跑。 */
            withSchedule={false}
            onCreate={(title) => onCreateDraft(title)}
            onClose={() => setComposer(null)}
          />
        ) : null}
        {renderCards("discussion", discussions, null)}
      </section>

      {agents.map((agent) => {
        const list = byAgent.get(agent.id) ?? [];
        const running = list.filter((task) => {
          const state = runsByTask.get(task.id)?.state;
          return state === "dispatched" || state === "working";
        }).length;
        const available = allowed.includes(agent.id);
        return (
          <section
            key={agent.id}
            onDragOver={(event) => {
              if (!available) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              setHoverRow(agent.id);
            }}
            onDragLeave={() =>
              setHoverRow((key) => (key === agent.id ? null : key))
            }
            onDrop={(event) => {
              event.preventDefault();
              setHoverRow(null);
              if (!available) return;
              const taskId = event.dataTransfer.getData("text/plain");
              const task = tasks.find((entry) => entry.id === taskId);
              // 讨论卡没有归属，已完成的卡也不该被重新指派：两者都不接。
              if (task && task.kind !== "discussion" && !isDone(task)) {
                onAssign(task, agent.id);
              }
              setDragging(null);
            }}
            className={rowClass(agent.id)}
          >
            <RowHead
              avatar={
                <AgentAvatarPicker
                  agentId={agent.id}
                  agentName={agent.name}
                  avatar={agent.avatar}
                  onPick={(next) => onSetAgentAvatar(agent, next)}
                />
              }
              title={agent.name}
              meta={
                <>
                  <span className="text-[11px] text-fg-3">
                    {getAppDisplayName(agent.appId)}
                    {agent.model ? ` · ${agent.model}` : ""}
                  </span>
                  {running > 0 ? (
                    <span className="text-[11px] font-medium text-action-text">
                      {t("tasks.agentView.running", { count: running })}
                    </span>
                  ) : null}
                  {available ? null : (
                    <span className="rounded-full bg-subtle px-1.5 py-[1px] text-[11px] text-fg-3">
                      {t("tasks.agentView.notAllowed")}
                    </span>
                  )}
                </>
              }
              description={agent.description || null}
            >
              {/* + 与拖放同一个意思：这张卡归他。建完就能直接开工，不必先拖再点。 */}
              <HoverTip
                content={
                  available
                    ? t("tasks.agentView.addTask", { name: agent.name })
                    : t("tasks.agentView.addTaskBlocked")
                }
              >
                <span>
                  <Button
                    variant="ghost"
                    size="icon-compact"
                    disabled={!available}
                    aria-label={t("tasks.agentView.addTask", {
                      name: agent.name,
                    })}
                    aria-expanded={composer === agent.id}
                    onClick={() =>
                      setComposer((current) =>
                        current === agent.id ? null : agent.id,
                      )
                    }
                  >
                    <Plus data-icon className="h-3.5 w-3.5" strokeWidth={1.5} />
                  </Button>
                </span>
              </HoverTip>
              {/* 允许名单就在这里改：指派是「谁做」，这里是「这个人上不上班」。
                  开关本身就是标签（开关打开时行头不会多一个「不参与派发」），
                  所以不再排一遍文字。 */}
              <Switch
                checked={available}
                aria-label={t("tasks.agentView.allow", { name: agent.name })}
                title={t("tasks.agentView.allow", { name: agent.name })}
                onCheckedChange={(checked) => onToggleAgent(agent, checked)}
              />
              <Button
                variant="ghost"
                size="icon-compact"
                aria-label={t("tasks.agentView.edit", { name: agent.name })}
                onClick={() => onEditAgent(agent)}
              >
                <Pencil data-icon className="h-3.5 w-3.5" strokeWidth={1.5} />
              </Button>
              {pendingDelete === agent.id ? (
                <span className="flex items-center gap-1">
                  <Button
                    variant="destructive"
                    size="compact"
                    aria-label={t("tasks.agentView.deleteConfirm", {
                      name: agent.name,
                    })}
                    onClick={() => {
                      setPendingDelete(null);
                      onDeleteAgent(agent);
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
                </span>
              ) : (
                <Button
                  variant="ghost"
                  size="icon-compact"
                  aria-label={t("tasks.agentView.delete", {
                    name: agent.name,
                  })}
                  title={t("tasks.agentView.deleteHint")}
                  onClick={() => setPendingDelete(agent.id)}
                >
                  <Trash2 data-icon className="h-3.5 w-3.5" strokeWidth={1.5} />
                </Button>
              )}
            </RowHead>
            {composer === agent.id ? (
              <RowTaskComposer
                label={t("tasks.agentView.addTask", { name: agent.name })}
                placeholder={t("tasks.agentView.addTaskPlaceholder")}
                withSchedule
                onCreate={(title, timing) =>
                  onCreateForAgent(agent.id, title, timing)
                }
                onClose={() => setComposer(null)}
              />
            ) : null}
            {renderCards(agent.id, list, agent)}
          </section>
        );
      })}

      <section
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          setHoverRow("unassigned");
        }}
        onDragLeave={() =>
          setHoverRow((key) => (key === "unassigned" ? null : key))
        }
        onDrop={(event) => {
          event.preventDefault();
          setHoverRow(null);
          const taskId = event.dataTransfer.getData("text/plain");
          const task = tasks.find((entry) => entry.id === taskId);
          if (task && task.kind !== "discussion" && !isDone(task)) {
            onAssign(task, null);
          }
          setDragging(null);
        }}
        className={rowClass("unassigned")}
      >
        <RowHead
          avatar={<IconAvatar icon={Inbox} />}
          title={t("tasks.agentView.unassigned")}
        />
        {renderCards("unassigned", unassigned, null)}
      </section>
    </div>
  );
}

/**
 * 行里的新建卡：一个输入框 + 任务类型，建好就落在这张行下。
 *
 * 它与列头那个快速新建是同一件事，所以排期控件用的是同一份；不同的是这行知道
 * 「归谁」——卡片写 `assignee` 就是直接指派，不再需要先建再拖。
 */
function RowTaskComposer({
  label,
  placeholder,
  withSchedule,
  onCreate,
  onClose,
}: {
  label: string;
  placeholder: string;
  /** 草稿（Router 那一行）不排期：还在讨论，先不承诺什么时候跑。 */
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
    <div className="mb-2 w-full max-w-[460px] space-y-1.5 rounded-control border border-border bg-surface p-2 shadow-v7-card">
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
