import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Pause,
  Play,
  RotateCcw,
  SquareTerminal,
  UserCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { getAppDisplayName } from "@/components/shell/AppGlyph";
import type {
  RouterAgent,
  RouterHumanDecision,
  RouterTaskRun,
} from "@/lib/api/superAgent";
import { cn } from "@/lib/utils";
import { resolveAssignee } from "./agentSettings";
import { runStateKey } from "./RunStateBadge";

interface AutoRouterSectionProps {
  run?: RouterTaskRun;
  busy: boolean;
  onStart: () => void;
  onPause: () => void;
  onResume: () => void;
  onResolve: (decision: RouterHumanDecision) => void;
  /**
   * 打开 worker 的终端：后台派发的进程不会自己出现在界面上。
   *
   * 两个后端的说法不一样（托管终端 / zellij pane），归一放在上层：
   * 这里只负责把「想看它」这件事交出去。
   */
  onOpenWorker?: () => void;
  /** 这张卡的归属人（frontmatter 的 assignee） */
  assignees?: string[];
  /** 设置里的全部智能体；下拉只列允许参与派发的那些 */
  agents?: RouterAgent[];
  allowedAgents?: string[];
  /** 这张卡在看板上的列（`Done` 之后不再给开工入口） */
  taskStatus?: string;
  /** 指派（`start` 才是第二个动作「指派并开工」） */
  onAssign?: (agentId: string | null, start: boolean) => void;
}

const STATE_DOT: Record<string, string> = {
  queued: "bg-action",
  dispatched: "bg-action motion-safe:animate-pulse",
  working: "bg-action motion-safe:animate-pulse",
  needsYou: "bg-warning-text",
  failed: "bg-danger-text",
  paused: "bg-fg-3",
  done: "bg-fg-3",
  idle: "bg-fg-3/40",
};

/**
 * 详情抽屉里的「自动调度」一节。
 *
 * 只放和这张卡有关的事实：谁在跑、第几次、卡在哪、下一步能做什么。
 * 全局开关与配额在头部那个面板里，这里不重复。
 * 执行计划也不在这里：规则版调度不拆子任务，`plan_task` 还没实现，
 * 放一行永远为空的「执行计划 · 这一轮没有拆分子任务」只是噪音。
 */
export function AutoRouterSection({
  run,
  busy,
  onStart,
  onPause,
  onResume,
  onResolve,
  onOpenWorker,
  assignees = [],
  agents = [],
  allowedAgents = [],
  taskStatus = "",
  onAssign,
}: AutoRouterSectionProps) {
  const { t } = useTranslation();
  const [decision, setDecision] = useState<RouterHumanDecision>("continue");
  const state = run?.state ?? "idle";
  const key = runStateKey(state);
  const running = state === "dispatched" || state === "working";
  // 「完成」有两种写法：运行态说 done，或者卡片自己在 Done 列（可能从没跑过）。
  // 只看运行态会让一张 Done 卡还挂着「开始 / 指派并开工」。
  const finished =
    state === "done" || taskStatus.trim().toLowerCase() === "done";

  // 归属用原生 select：它是一项配置，不是一次「动作」，用不着一套弹层。
  const assignment = resolveAssignee({ assignees }, agents, allowedAgents);
  const [choice, setChoice] = useState(
    assignment.agentId ?? assignment.unknown ?? "",
  );
  useEffect(() => {
    setChoice(assignment.agentId ?? assignment.unknown ?? "");
  }, [assignment.agentId, assignment.unknown]);
  const chosen = choice === "" ? null : choice;
  const choices = agents.filter((agent) => allowedAgents.includes(agent.id));

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="m-0 text-body font-medium text-fg-1">
          {t("tasks.router.section")}
        </h3>
        <span className="inline-flex items-center gap-1.5 text-caption text-fg-2">
          <span
            aria-hidden="true"
            className={cn("size-1.5 rounded-full", STATE_DOT[key] ?? "bg-fg-3")}
          />
          {t(`tasks.router.state.${key}`)}
        </span>
      </div>

      {run ? (
        <p className="m-0 flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-fg-3">
          {run.workerApp ? (
            <span>
              {run.agentName
                ? t("tasks.router.workerLineAgent", {
                    agent: run.agentName,
                    app: getAppDisplayName(run.workerApp),
                  })
                : t("tasks.router.workerLine", {
                    app: getAppDisplayName(run.workerApp),
                  })}
            </span>
          ) : null}
          {/* 模型只是「这次派发给谁」的一部分：没有应用就没有主语。 */}
          {run.workerApp && run.agentModel ? (
            <span>
              {t("tasks.router.workerLineModel", { model: run.agentModel })}
            </span>
          ) : null}
          {run.attempts > 0 ? (
            <span>{t("tasks.router.attempts", { count: run.attempts })}</span>
          ) : null}
        </p>
      ) : (
        <p className="m-0 text-caption text-fg-3">
          {t("tasks.router.idleHint")}
        </p>
      )}

      {run?.detail ? (
        <p className="m-0 whitespace-pre-wrap rounded-control bg-subtle px-2.5 py-1.5 text-caption leading-relaxed text-fg-2">
          {run.detail}
        </p>
      ) : null}

      {/* 归属：拖到某一行与这里选一下是同一件事——只改「归谁」，不等于起跑。 */}
      {onAssign ? (
        <div className="space-y-1.5 rounded-control border border-border p-2.5">
          <label className="block text-caption text-fg-2">
            {t("tasks.router.assignTitle")}
            <select
              className="mt-1.5 block w-full rounded-control border border-border bg-surface p-1.5 text-caption"
              value={choice}
              disabled={busy}
              onChange={(event) => setChoice(event.target.value)}
            >
              <option value="">{t("tasks.router.assignNone")}</option>
              {assignment.unknown ? (
                <option value={assignment.unknown}>
                  {t("tasks.router.unknownAssignee", {
                    id: assignment.unknown,
                  })}
                </option>
              ) : null}
              {choices.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="neutral"
              size="compact"
              disabled={busy || (assignees[0] ?? "") === (chosen ?? "")}
              onClick={() => onAssign(chosen, false)}
            >
              <UserCheck data-icon className="h-3.5 w-3.5" strokeWidth={1.5} />
              {t("tasks.router.assign")}
            </Button>
            {!running && !finished && chosen ? (
              <Button
                variant="solid"
                size="compact"
                disabled={busy}
                onClick={() => onAssign(chosen, true)}
              >
                <Play data-icon className="h-3.5 w-3.5" strokeWidth={1.5} />
                {t("tasks.router.assignAndStart")}
              </Button>
            ) : null}
          </div>
          <p className="m-0 text-[11px] leading-relaxed text-fg-3">
            {assignment.unknown
              ? t("tasks.router.assignUnknownHint", {
                  id: assignment.unknown,
                })
              : t("tasks.router.assignHint")}
          </p>
        </div>
      ) : null}

      {/* worker 不在 phi 自己的终端表里（zellij 里跑着的），不切过去就完全
          看不到它在干什么。这一行是「显示运行中但找不到终端」的出口。 */}
      {onOpenWorker ? (
        <div>
          <Button
            variant="neutral"
            size="compact"
            disabled={busy}
            onClick={onOpenWorker}
          >
            <SquareTerminal
              data-icon
              className="h-3.5 w-3.5"
              strokeWidth={1.5}
            />
            {t("tasks.openSession")}
          </Button>
        </div>
      ) : null}

      {state === "needs-you" ? (
        <form
          className="space-y-2 rounded-control border border-border p-3"
          onSubmit={(event) => {
            event.preventDefault();
            onResolve(decision);
          }}
        >
          <label className="block text-caption text-fg-1">
            {t("tasks.router.confirmDecision")}
            <select
              className="mt-2 block w-full rounded-control border border-border bg-surface p-2"
              value={decision}
              disabled={busy}
              onChange={(event) =>
                setDecision(event.target.value as RouterHumanDecision)
              }
            >
              <option value="continue">
                {t("tasks.router.confirmContinue")}
              </option>
              <option value="complete">
                {t("tasks.router.confirmComplete")}
              </option>
              <option value="pause">{t("tasks.router.pause")}</option>
            </select>
          </label>
          <Button type="submit" variant="solid" size="compact" disabled={busy}>
            {t("tasks.router.confirmSubmit")}
          </Button>
        </form>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {running || state === "queued" ? (
            <Button
              variant="neutral"
              size="compact"
              disabled={busy}
              onClick={onPause}
            >
              <Pause data-icon className="h-3.5 w-3.5" strokeWidth={1.5} />
              {t("tasks.router.pause")}
            </Button>
          ) : state === "paused" ? (
            <Button
              variant="neutral"
              size="compact"
              disabled={busy}
              onClick={onResume}
            >
              <RotateCcw data-icon className="h-3.5 w-3.5" strokeWidth={1.5} />
              {t("tasks.router.resume")}
            </Button>
          ) : finished ? null : (
            <>
              <Button
                variant="neutral"
                size="compact"
                disabled={busy}
                onClick={onStart}
              >
                <Play data-icon className="h-3.5 w-3.5" strokeWidth={1.5} />
                {t("tasks.router.start")}
              </Button>
              {/* 这句描述的是「点开始」之后的行为；没按钮时它没有主语，不单独留着。 */}
              <span className="text-caption text-fg-3">
                {t("tasks.router.startHint")}
              </span>
            </>
          )}
        </div>
      )}
    </section>
  );
}
