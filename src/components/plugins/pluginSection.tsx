import { type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * 插件页共用的小件。
 *
 * 插件中心里的每一页都长同一副骨架：一句说明、若干分节、页尾一个保存按钮。
 * 分节标题与卡片用设置页那套（`SettingsBlock` / `SettingsCard` / `SettingsRow`），
 * 这里只补插件页特有的三种：页首说明、带标签的字段、页尾保存栏。
 */

/** 页首那句「这页在管什么」。补充说明另起一行小字，不混进第一句。 */
export function PluginLede({
  children,
  hint,
}: {
  children: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <section className="space-y-1">
      <p className="text-body text-fg-2">{children}</p>
      {hint && <p className="text-caption text-fg-3">{hint}</p>}
    </section>
  );
}

/** 空态：虚线框 + 一句「为什么这里是空的」。 */
export function PluginEmpty({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-panel border border-dashed border-border px-6 py-8 text-center text-body text-fg-2">
      {children}
    </div>
  );
}

/**
 * 带可见标签的字段。
 *
 * 规则行、路由行都是几个输入框并排，只靠 placeholder 说不了「填完这一格是什么」；
 * 标签固定在上方，同一行的控件才对得齐，窄窗口折行也不会失去标签。
 */
export function PluginField({
  label,
  className,
  children,
}: {
  label: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <label className={cn("block min-w-0 space-y-1", className)}>
      <span className="block truncate text-caption text-fg-3">{label}</span>
      {children}
    </label>
  );
}

/**
 * 页尾保存栏。
 *
 * 一个视图只有一个实心按钮，所以「保存」永远在页尾同一条线上，
 * 不夹在分节之间，也不跟着内容左右漂。有未保存改动时左侧点一句。
 */
export function PluginSaveBar({
  onSave,
  label,
  savingLabel,
  saving = false,
  disabled = false,
  dirty = false,
  dirtyLabel,
}: {
  onSave: () => void;
  label: string;
  savingLabel: string;
  saving?: boolean;
  disabled?: boolean;
  dirty?: boolean;
  dirtyLabel?: string;
}) {
  return (
    <div className="flex items-center justify-end gap-3 border-t border-border pt-4">
      {dirty && dirtyLabel && (
        <span className="text-caption text-fg-3">{dirtyLabel}</span>
      )}
      <Button onClick={onSave} disabled={saving || disabled}>
        {saving ? savingLabel : label}
      </Button>
    </div>
  );
}
