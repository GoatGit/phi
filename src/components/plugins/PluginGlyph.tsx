import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { pluginIdentity } from "./pluginIdentity";

/**
 * 插件身份方块：图标 + 底色。
 *
 * 卡片、插件页页头共用，所以从卡片点进页面时图标不会换脸。
 * `soft` 是默认的浅色底方块；`plain` 只给已经很挤的地方用，避免再叠一层色块。
 */
export function PluginGlyph({
  pluginId,
  size = "md",
  tone = "soft",
}: {
  pluginId: string;
  size?: "sm" | "md" | "lg";
  tone?: "soft" | "plain";
}) {
  const identity = pluginIdentity(pluginId);
  const Icon = identity.icon;
  const box =
    size === "lg" ? "h-10 w-10" : size === "sm" ? "h-7 w-7" : "h-8 w-8";
  const icon =
    size === "lg"
      ? "h-[18px] w-[18px]"
      : size === "sm"
        ? "h-3.5 w-3.5"
        : "h-4 w-4";

  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex shrink-0 items-center justify-center rounded-control",
        box,
        tone === "soft" ? identity.tint : "bg-transparent",
        identity.ink,
      )}
    >
      <Icon className={icon} />
    </span>
  );
}

/**
 * 插件页底部的说明块：作用 / 怎么用 / 注意事项。
 *
 * 固定放在内容之后、保存栏之上——保存类按钮仍然是页面最后一项操作。
 * 左侧一道插件身份色的细条，让人一眼认出「这是说明，不是设置项」。
 */
export function PluginGuide({
  pluginId,
  what,
  steps,
  notes,
  collapsible = false,
  defaultCollapsed = false,
}: {
  pluginId: string;
  what: ReactNode;
  steps: ReactNode[];
  notes?: ReactNode;
  /** 让「这个插件做什么」收成一行：给把整屏都用来做事的页（任务看板） */
  collapsible?: boolean;
  defaultCollapsed?: boolean;
}) {
  const { t } = useTranslation();
  const identity = pluginIdentity(pluginId);
  const [open, setOpen] = useState(!defaultCollapsed);

  const body = (
    <dl className="space-y-2 text-body">
      <div className="flex gap-3">
        <dt className="w-12 shrink-0 text-caption leading-[20px] text-fg-3">
          {t("pluginCenter.guide.what")}
        </dt>
        <dd className="min-w-0 flex-1 text-fg-2">{what}</dd>
      </div>
      <div className="flex gap-3">
        <dt className="w-12 shrink-0 text-caption leading-[20px] text-fg-3">
          {t("pluginCenter.guide.steps")}
        </dt>
        <dd className="min-w-0 flex-1">
          <ol className="space-y-1 text-fg-2">
            {steps.map((step, index) => (
              <li key={index} className="flex gap-2">
                <span className="w-3 shrink-0 text-end tabular-nums text-fg-3">
                  {index + 1}
                </span>
                <span className="min-w-0 flex-1">{step}</span>
              </li>
            ))}
          </ol>
        </dd>
      </div>
      {notes && (
        <div className="flex gap-3">
          <dt className="w-12 shrink-0 text-caption leading-[20px] text-fg-3">
            {t("pluginCenter.guide.notes")}
          </dt>
          <dd className="min-w-0 flex-1 text-caption leading-[20px] text-fg-2">
            {notes}
          </dd>
        </div>
      )}
    </dl>
  );

  if (collapsible) {
    return (
      <section
        aria-labelledby={`plugin-guide-${pluginId}`}
        className="relative overflow-hidden rounded-panel border border-border"
      >
        <span
          aria-hidden="true"
          className={cn(
            "absolute inset-y-0 start-0 w-[3px] bg-current",
            identity.ink,
          )}
        />
        <button
          type="button"
          aria-expanded={open}
          aria-controls={`plugin-guide-body-${pluginId}`}
          onClick={() => setOpen(!open)}
          className="flex w-full items-center justify-between gap-2 px-4 py-2.5 text-start text-strong font-medium text-fg-1 hover:bg-subtle"
        >
          <span id={`plugin-guide-${pluginId}`}>
            {t("pluginCenter.guide.title")}
          </span>
          <ChevronRight
            aria-hidden="true"
            className={cn(
              "size-3.5 shrink-0 text-fg-3 transition-transform",
              open && "rotate-90",
            )}
            strokeWidth={1.5}
          />
        </button>
        {open ? (
          <div
            id={`plugin-guide-body-${pluginId}`}
            className="border-t border-border px-4 py-3 pe-4 ps-[19px]"
          >
            {body}
          </div>
        ) : null}
      </section>
    );
  }

  return (
    <section
      aria-labelledby={`plugin-guide-${pluginId}`}
      className="relative overflow-hidden rounded-panel border border-border py-3.5 pe-4 ps-[19px]"
    >
      <span
        aria-hidden="true"
        className={cn(
          "absolute inset-y-0 start-0 w-[3px] bg-current",
          identity.ink,
        )}
      />
      <h3
        id={`plugin-guide-${pluginId}`}
        className="mb-2 text-strong font-medium text-fg-1"
      >
        {t("pluginCenter.guide.title")}
      </h3>
      {body}
    </section>
  );
}
