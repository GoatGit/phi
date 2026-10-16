import { useTranslation } from "react-i18next";
import { AppGlyph } from "@/components/shell/AppGlyph";
import { cn } from "@/lib/utils";

/** 应用筛选 chips：与用量页同款样式（图标 chips + 滑块省略），供各统计面板复用 */
export function AppFilterChips({
  appTypes,
  value,
  onChange,
  ariaLabel,
  className,
}: {
  /** 可选的应用列表 */
  appTypes: readonly string[];
  value: string;
  onChange: (next: string) => void;
  ariaLabel?: string;
  className?: string;
}) {
  const { t } = useTranslation();
  const chip = (pressed: boolean) =>
    cn(
      "inline-flex h-[26px] items-center justify-center rounded-[5px] px-2 text-body transition-colors duration-150",
      pressed
        ? "font-semibold text-fg-1"
        : "font-medium text-fg-2 hover:text-fg-1",
    );

  return (
    <div
      role="group"
      aria-label={ariaLabel ?? t("usage.appFilter.label")}
      className={cn(
        "flex h-8 shrink-0 items-center gap-0.5 rounded-[8px] bg-subtle p-[3px]",
        className,
      )}
    >
      <button
        type="button"
        aria-pressed={value === "all"}
        className={chip(value === "all")}
        onClick={() => onChange("all")}
      >
        {t("usage.appFilter.all")}
      </button>
      {appTypes.map((app) => (
        <button
          key={app}
          type="button"
          aria-pressed={value === app}
          aria-label={app}
          className={cn(chip(value === app), "w-[30px] justify-center px-0")}
          onClick={() => onChange(app)}
        >
          <AppGlyph
            app={app as never}
            size={16}
            badgeClassName={value === app ? "bg-surface" : "bg-subtle"}
          />
        </button>
      ))}
    </div>
  );
}
