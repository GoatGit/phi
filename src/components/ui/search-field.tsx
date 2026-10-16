import * as React from "react";
import { Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { HoverTip } from "@/components/ui/hover-tip";
import { cn } from "@/lib/utils";

export interface SearchFieldProps
  extends Omit<
    React.InputHTMLAttributes<HTMLInputElement>,
    "value" | "onChange" | "type"
  > {
  value: string;
  onValueChange: (value: string) => void;
  /** 清除按钮的名字（悬停提示 + aria-label） */
  clearLabel: string;
  /** 外层容器（定宽、外边距）；输入框本身的样式跟 Input 走 */
  containerClassName?: string;
  /**
   * 折叠模式：无内容且未聚焦时收成一个安静的图标位（w-9），
   * 点击/聚焦或有内容时展开回 containerClassName 指定的宽度。
   * 用于降低常驻搜索框在低频搜索页面上的视觉占用。
   */
  collapsible?: boolean;
}

/**
 * 搜索框（docs/design-system.html「输入」）：高 32、圆角 6、左侧 14px 放大镜，
 * 有字时右侧出现清除按钮；Esc 先清空，空了才交给外层（关抽屉 / 对话框）。
 */
export const SearchField = React.forwardRef<HTMLInputElement, SearchFieldProps>(
  (
    {
      value,
      onValueChange,
      clearLabel,
      containerClassName,
      collapsible = false,
      className,
      onKeyDown,
      onFocus,
      onBlur,
      placeholder,
      ...props
    },
    ref,
  ) => {
    const inputRef = React.useRef<HTMLInputElement>(null);
    const [focused, setFocused] = React.useState(false);
    React.useImperativeHandle(ref, () => inputRef.current as HTMLInputElement);

    const collapsed = collapsible && !value && !focused;
    const collapsedTitle = collapsed
      ? String(props["aria-label"] ?? placeholder ?? "")
      : undefined;

    return (
      <div
        role="search"
        className={cn(
          "relative min-w-0 transition-[width] duration-200 ease-out",
          collapsed ? "w-9 shrink-0" : containerClassName,
        )}
      >
        <Search
          aria-hidden="true"
          strokeWidth={1.5}
          className={cn(
            "pointer-events-none absolute top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-3",
            collapsed ? "start-[11px]" : "start-2.5",
          )}
        />
        <Input
          ref={inputRef}
          type="text"
          value={value}
          title={collapsedTitle}
          placeholder={placeholder}
          onChange={(event) => onValueChange(event.target.value)}
          onFocus={(event) => {
            setFocused(true);
            onFocus?.(event);
          }}
          onBlur={(event) => {
            setFocused(false);
            onBlur?.(event);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape" && value) {
              event.stopPropagation();
              event.preventDefault();
              onValueChange("");
              return;
            }
            onKeyDown?.(event);
          }}
          spellCheck={false}
          className={cn(
            "ps-8 pe-8",
            collapsed &&
              "cursor-pointer pe-0 border-transparent bg-transparent placeholder:text-transparent hover:border-border",
            className,
          )}
          {...props}
        />
        {value && (
          <HoverTip content={clearLabel}>
            <button
              type="button"
              onClick={() => {
                onValueChange("");
                inputRef.current?.focus();
              }}
              aria-label={clearLabel}
              className="absolute end-1 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-control text-fg-3 transition-colors hover:bg-subtle hover:text-fg-1"
            >
              <X aria-hidden="true" className="h-3.5 w-3.5" strokeWidth={1.5} />
            </button>
          </HoverTip>
        )}
      </div>
    );
  },
);
SearchField.displayName = "SearchField";
