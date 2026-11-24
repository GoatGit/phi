import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useSessionsQuery } from "@/lib/query/queries";
import type { TaskCard } from "@/lib/api/tasks";
import type { RouterAgent } from "@/lib/api/superAgent";
import type { SessionMeta } from "@/types";

/**
 * 能按会话 id 续接的应用。
 *
 * 与后端 `terminal::resume_arguments` 一一对应：claude 收 `--resume <uuid>`，
 * opencode 收 `run -s <id>`。gemini 的 `--resume` 认的是项目内序号、codex 的
 * `exec resume` 是子命令且沙箱参数挂在父命令上，两边都没把握，所以这里不列。
 */
export const RESUME_APPS = ["claude", "opencode"] as const;

/** 「新起一个」这一项的值：不能与真实会话 id 撞上。 */
const NEW_SESSION = "__new__";

interface ResumeSessionFieldProps {
  task: TaskCard;
  /** 设置里的全部智能体：从归属推出这张卡会跑在哪个应用上 */
  agents: RouterAgent[];
  /** 仓库根：会话记录里记的是 cwd，只列这个仓库里开的会话 */
  repoRoot?: string | null;
  busy?: boolean;
  onSave: (session: string | null) => void;
}

/**
 * 续接会话：这张卡要接着哪一次对话干下去。
 *
 * 默认是「新建会话」——每次派发带一句本次任务说明、互不串味。选了一段会话之后，
 * 派发会把它的 id 翻译成那个应用自己的 resume 参数，智能体在一个已经聊过上下文的
 * 对话里继续；同一段对话同时只会有一张卡在跑（后端拦着）。
 *
 * 只有归属到「支持按 id 续接」的智能体上才有这一项：应用不支持时给一句说明，
 * 而不是摆一个选了也不会生效的下拉。
 */
export function ResumeSessionField({
  task,
  agents,
  repoRoot,
  busy,
  onSave,
}: ResumeSessionFieldProps) {
  const { t } = useTranslation();
  const assignee = task.assignees[0];
  const agent = assignee
    ? agents.find((item) => item.id === assignee || item.name === assignee)
    : undefined;
  const appId = agent?.appId ?? "";
  const supported = (RESUME_APPS as readonly string[]).includes(appId);
  // 用不上清单时不必去扫一遍各应用的会话记录。
  const { data: sessions = [] } = useSessionsQuery({
    enabled: supported && Boolean(repoRoot),
  });

  const options = sessions
    .filter((session) => session.providerId === appId)
    .filter((session) => Boolean(repoRoot) && session.projectDir === repoRoot)
    .sort(
      (left, right) =>
        (right.lastActiveAt ?? right.createdAt ?? 0) -
        (left.lastActiveAt ?? left.createdAt ?? 0),
    )
    .slice(0, 40);

  const label = (session: SessionMeta) =>
    session.title?.trim() ||
    session.summary?.trim() ||
    session.sessionId.slice(0, 12);

  const current = task.session ?? NEW_SESSION;
  // 选中的会话可能已经不在清单里（被删、换了机器、别的项目）：仍然要显示出来，
  // 否则下拉会空着，看起来像没选。
  const currentMissing =
    task.session !== null && !options.some((s) => s.sessionId === task.session);

  return (
    <section
      className="space-y-2"
      aria-labelledby={`resume-session-${task.id}`}
    >
      <Label
        id={`resume-session-${task.id}`}
        className="text-caption text-fg-3"
      >
        {t("tasks.session.title")}
      </Label>
      {!supported && task.session ? (
        <>
          <p className="m-0 break-words text-caption text-fg-2">
            {t("tasks.session.blocked", { id: task.session })}
          </p>
          <Button
            type="button"
            variant="neutral"
            size="compact"
            disabled={busy}
            onClick={() => onSave(null)}
          >
            {t("tasks.session.clear")}
          </Button>
        </>
      ) : !agent ? (
        <p className="m-0 text-[11px] leading-relaxed text-fg-3">
          {t("tasks.session.needsAgent")}
        </p>
      ) : !supported ? (
        <p className="m-0 text-[11px] leading-relaxed text-fg-3">
          {t("tasks.session.unsupported", { app: appId })}
        </p>
      ) : (
        <>
          <Select
            value={current}
            disabled={busy}
            onValueChange={(value) =>
              onSave(value === NEW_SESSION ? null : value)
            }
          >
            <SelectTrigger
              aria-label={t("tasks.session.title")}
              className="w-full"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NEW_SESSION}>
                {t("tasks.session.new")}
              </SelectItem>
              {currentMissing ? (
                <SelectItem value={task.session!}>
                  {t("tasks.session.missing", { id: task.session })}
                </SelectItem>
              ) : null}
              {options.map((session) => (
                <SelectItem key={session.sessionId} value={session.sessionId}>
                  {label(session)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="m-0 text-[11px] leading-relaxed text-fg-3">
            {options.length === 0 && task.session === null
              ? t("tasks.session.empty")
              : t("tasks.session.hint")}
          </p>
        </>
      )}
    </section>
  );
}
