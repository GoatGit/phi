import { useTranslation } from "react-i18next";
import type { RouterRunState, RouterTaskRun } from "@/lib/api/superAgent";
import { cn } from "@/lib/utils";

/**
 * 卡片上的自动调度标记。
 *
 * 只回答一个问题：这张卡现在需不需要我。四种状态里三种是「要人看」或「正在跑」；
 * 失败单独一档，因为它和「等你看」的区别是——等你看是机器在等你给一个答案，
 * 失败是机器试过但没成。混成一个标记，人就不知道该回答什么。
 */
type Tone = "running" | "attention" | "danger" | "muted";

const TONE: Record<Tone, string> = {
  running: "bg-action-soft text-action-text",
  attention: "bg-warning-soft text-warning-text",
  danger: "bg-danger-soft text-danger-text",
  muted: "bg-subtle text-fg-3",
};

const MARK: Partial<Record<RouterRunState, { tone: Tone; key: string }>> = {
  queued: { tone: "running", key: "queued" },
  dispatched: { tone: "running", key: "dispatched" },
  working: { tone: "running", key: "working" },
  "needs-you": { tone: "attention", key: "needsYou" },
  failed: { tone: "danger", key: "failed" },
  paused: { tone: "muted", key: "paused" },
};

/** 运行态 → 翻译键后缀（`needs-you` 与 `idle` 的键名不是状态名本身）。 */
export function runStateKey(state: RouterRunState): string {
  if (state === "needs-you") return "needsYou";
  return state;
}

export function runMark(
  run: RouterTaskRun | undefined,
): { tone: Tone; key: string } | null {
  if (!run) return null;
  // 影子模式下卡片其实没在跑，不能借用「排队中」——那会让人以为已经派出去了。
  if (run.shadow) return { tone: "muted", key: "shadow" };
  return MARK[run.state] ?? null;
}

export function RunStateBadge({
  run,
  className,
}: {
  run: RouterTaskRun | undefined;
  className?: string;
}) {
  const { t } = useTranslation();
  const mark = runMark(run);
  if (!mark) return null;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-1.5 py-[1px] text-[11px] leading-4",
        TONE[mark.tone],
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-1.5 rounded-full bg-current",
          mark.tone === "running" && "motion-safe:animate-pulse",
        )}
      />
      {t(`tasks.router.state.${mark.key}`)}
    </span>
  );
}

/** 详情页里用的整行状态文案。 */
export function runStateLabel(
  t: (key: string) => string,
  state: RouterRunState,
): string {
  return t(`tasks.router.state.${runStateKey(state)}`);
}
