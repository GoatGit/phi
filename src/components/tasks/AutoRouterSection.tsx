import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pause, Play, RotateCcw, SquareTerminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getAppDisplayName } from "@/components/shell/AppGlyph";
import type {
  RouterHumanDecision,
  RouterPlanNode,
  RouterTaskRun,
} from "@/lib/api/superAgent";
import { cn } from "@/lib/utils";
import { runStateKey } from "./RunStateBadge";

interface AutoRouterSectionProps {
  run?: RouterTaskRun;
  plan: RouterPlanNode[];
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
 */
export function AutoRouterSection({
  run,
  plan,
  busy,
  onStart,
  onPause,
  onResume,
  onResolve,
  onOpenWorker,
}: AutoRouterSectionProps) {
  const { t } = useTranslation();
  const [decision, setDecision] = useState<RouterHumanDecision>("continue");
  const state = run?.state ?? "idle";
  const key = runStateKey(state);
  const running = state === "dispatched" || state === "working";

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
              {t("tasks.router.workerLine", {
                app: getAppDisplayName(run.workerApp),
              })}
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
          ) : state === "done" ? null : (
            <Button
              variant="neutral"
              size="compact"
              disabled={busy}
              onClick={onStart}
            >
              <Play data-icon className="h-3.5 w-3.5" strokeWidth={1.5} />
              {t("tasks.router.start")}
            </Button>
          )}
          <span className="text-caption text-fg-3">
            {t("tasks.router.startHint")}
          </span>
        </div>
      )}

      <div className="space-y-1.5">
        <h4 className="m-0 text-caption font-medium text-fg-2">
          {t("tasks.router.planTitle")}
        </h4>
        {plan.length === 0 ? (
          <p className="m-0 text-caption text-fg-3">
            {t("tasks.router.planEmpty")}
          </p>
        ) : (
          <ol className="m-0 flex list-none flex-col p-0">
            {plan.map((node, index) => (
              <li key={node.nodeId} className="relative ps-4 pb-2 last:pb-0">
                <span
                  aria-hidden="true"
                  className={cn(
                    "absolute start-0 top-[6px] size-1.5 rounded-full",
                    STATE_DOT[
                      node.state === "needs-you" ? "needsYou" : node.state
                    ] ?? "bg-fg-3",
                  )}
                />
                {index < plan.length - 1 ? (
                  <span
                    aria-hidden="true"
                    className="absolute bottom-0 start-[2.5px] top-4 w-px bg-border"
                  />
                ) : null}
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-caption text-fg-1">{node.title}</span>
                  {node.workerApp ? (
                    <span className="text-[11px] text-fg-3">
                      {getAppDisplayName(node.workerApp)}
                    </span>
                  ) : null}
                </div>
                {node.dependsOn.length > 0 ? (
                  <p className="m-0 text-[11px] text-fg-3">
                    {t("tasks.router.planDeps", {
                      deps: node.dependsOn.join(", "),
                    })}
                  </p>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}
