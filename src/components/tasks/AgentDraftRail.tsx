import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { AgentDraftVersion } from "./agentPersona";

interface AgentDraftRailProps {
  versions: AgentDraftVersion[];
  /** 右栏正在编辑的那一版：草稿填进去之后就是它。 */
  cursor: number;
  /** 正在看的历史版本；`null` = 在看右栏实时那一份。 */
  preview: number | null;
  /** 右栏在 cursor 这一版之后被手改过。 */
  edited: boolean;
  onSelect: (version: number) => void;
  onContinue: () => void;
  onBack: () => void;
}

/**
 * 草稿版本条：右栏的「第几版」入口。
 *
 * 它是左右两侧共同的锚点——左栏每轮发言挂着同一批版号，点哪一版两边一起亮。
 * 只存「它是谁」那半边的快照，所以切版本不会动摇人自己定的应用与模型。
 */
export function AgentDraftRail({
  versions,
  cursor,
  preview,
  edited,
  onSelect,
  onContinue,
  onBack,
}: AgentDraftRailProps) {
  const { t } = useTranslation();
  const label = (version: AgentDraftVersion, index: number) =>
    version.round === null
      ? t("tasks.router.agentVersionInitial")
      : t("tasks.router.agentVersionRound", { count: index });
  const active = preview ?? cursor;
  const shown = versions[active];

  let caption: string;
  if (preview !== null) {
    if (preview === cursor) {
      caption = edited
        ? t("tasks.router.agentVersionPreviewEdited")
        : t("tasks.router.agentVersionPreviewSame");
    } else {
      caption = t("tasks.router.agentVersionPreview", {
        version: label(shown, active),
      });
    }
  } else {
    caption =
      shown.round === null
        ? t("tasks.router.agentVersionInitialCaption")
        : shown.fields.length > 0
          ? t("tasks.router.agentVersionCaption", {
              round: shown.round,
              fields: shown.fields.join(
                t("tasks.router.agentStudioFieldSeparator"),
              ),
            })
          : t("tasks.router.agentVersionCaptionSame", { round: shown.round });
    // 手改不会另起一版：只在当前版后面点一句，免得人以为右栏还是 Router 那一份。
    if (edited) {
      caption = `${caption} · ${t("tasks.router.agentVersionEdited")}`;
    }
  }

  return (
    <div className="sticky top-0 z-[1] flex flex-col gap-1.5 rounded-panel border border-border bg-surface px-2.5 py-2">
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-badge text-fg-3">
          {t("tasks.router.agentVersionsTitle")}
        </span>
        <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
          {versions.map((version, index) => {
            const on = index === active;
            return (
              <button
                key={index}
                type="button"
                aria-pressed={on}
                title={t("tasks.router.agentStudioViewVersion", {
                  version: label(version, index),
                })}
                onClick={() => onSelect(index)}
                className={cn(
                  "shrink-0 rounded-control border border-transparent px-1.5 py-0.5 text-badge tabular-nums transition-colors",
                  on
                    ? "bg-action-soft text-action-text"
                    : "text-fg-2 hover:bg-subtle hover:text-fg-1",
                )}
              >
                {label(version, index)}
              </button>
            );
          })}
        </div>
        {preview !== null ? (
          <span className="flex shrink-0 items-center gap-1">
            <Button
              variant="ghost"
              size="compact"
              className="h-6 px-1.5 text-[11px]"
              onClick={onBack}
            >
              {t("tasks.router.agentVersionBack")}
            </Button>
            <Button
              variant="neutral"
              size="compact"
              className="h-6 px-2 text-[11px]"
              // 已经在看当前版、且右栏没被手改过时没有可恢复的东西。
              disabled={preview === cursor && !edited}
              onClick={onContinue}
            >
              {t("tasks.router.agentVersionContinue")}
            </Button>
          </span>
        ) : null}
      </div>
      <p className="m-0 text-[11px] leading-relaxed text-fg-3">{caption}</p>
      <p className="m-0 text-[10px] leading-relaxed text-fg-3">
        {t("tasks.router.agentVersionScope")}
      </p>
    </div>
  );
}
