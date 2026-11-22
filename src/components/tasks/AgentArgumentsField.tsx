import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  addArgumentTokens,
  agentArgumentGroups,
  parseArgumentText,
  removeArgumentTokens,
} from "./agentArguments";

interface AgentArgumentsFieldProps {
  /** 选中的执行应用：参数按应用列，换应用等于换一份可选清单。 */
  appId: string;
  /** 参数原文。界面上是若干可删的胶囊，落盘仍是一段可以被 shlex 拆开的文本。 */
  value: string;
  disabled?: boolean;
  onChange: (next: string) => void;
}

/**
 * 追加参数：从下拉里挑，不再背参数名。
 *
 * 原来的做法是一个空输入框加一行示例 `--verbose --effort high`，用人得先记住
 * 参数名、再记住它属于哪个应用；填错了要到点保存才被后端拒绝。现在按应用把可选项
 * 摊开，点一条就加一个胶囊，胶囊上就是它落到命令行的样子。
 *
 * 仍然留一条自定义通道：允许列表之外的东西（老配置里可能就有）不能被静默丢掉，
 * 认不出来的 token 也会以胶囊形式显示，所以「界面上有的」和「会真的传进去的」始终一致。
 */
export function AgentArgumentsField({
  appId,
  value,
  disabled,
  onChange,
}: AgentArgumentsFieldProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const groups = agentArgumentGroups(appId);
  const options = groups.flatMap((group) => group.options);
  const { picks, extra } = parseArgumentText(value, options);
  const extraText = extra.join(" ");
  // 认不出来的那一串要不要摆出原文输入框：有它就摆，人得看得见自己填的是什么。
  const [custom, setCustom] = useState(extra.length > 0);
  const hint = "router-agent-arguments-hint";

  const add = (tokens: string[]) => {
    onChange(addArgumentTokens(value, tokens));
    setOpen(false);
  };

  return (
    <div className="flex flex-col gap-1">
      <Label id="router-agent-arguments-label">
        {t("tasks.router.agentArguments")}
      </Label>
      {/* 胶囊和「添加参数」是并列的两个东西：删一枚是按钮，添加是另一个按钮，
          不把可点的东西套进同一个控件里。 */}
      <div
        role="group"
        aria-labelledby="router-agent-arguments-label"
        aria-describedby={hint}
        className="flex flex-wrap items-center gap-1"
      >
        {picks.map((option) => {
          const text = option.tokens.join(" ");
          return (
            <span
              key={text}
              className="inline-flex max-w-full items-center gap-1 rounded-control border border-border-strong bg-subtle py-0.5 pe-1 ps-1.5 font-mono text-[11px] leading-5 text-fg-1"
            >
              {text}
              <button
                type="button"
                disabled={disabled}
                aria-label={t("tasks.router.agentArgumentsRemove", {
                  argument: text,
                })}
                title={t("tasks.router.agentArgumentsRemove", {
                  argument: text,
                })}
                onClick={() =>
                  onChange(removeArgumentTokens(value, option.tokens))
                }
                className={cn(
                  "rounded-full p-0.5 text-fg-3 transition-colors",
                  "hover:bg-surface hover:text-fg-1",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                )}
              >
                <X data-icon className="h-2.5 w-2.5" strokeWidth={2} />
              </button>
            </span>
          );
        })}
        {/* 认不出来的那份也占一枚胶囊：不然界面上看着什么都没有，命令行里却带着它。 */}
        {extra.length > 0 ? (
          <span className="inline-flex max-w-full items-center gap-1 rounded-control border border-dashed border-border-strong bg-surface py-0.5 pe-1 ps-1.5 font-mono text-[11px] leading-5 text-fg-2">
            {extraText}
            <button
              type="button"
              disabled={disabled}
              aria-label={t("tasks.router.agentArgumentsRemove", {
                argument: extraText,
              })}
              title={t("tasks.router.agentArgumentsRemove", {
                argument: extraText,
              })}
              onClick={() => onChange(removeArgumentTokens(value, extra))}
              className={cn(
                "rounded-full p-0.5 text-fg-3 transition-colors",
                "hover:bg-subtle hover:text-fg-1",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
              )}
            >
              <X data-icon className="h-2.5 w-2.5" strokeWidth={2} />
            </button>
          </span>
        ) : null}
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              disabled={disabled}
              className={cn(
                "inline-flex items-center gap-1 rounded-control border border-dashed border-border-strong px-1.5 py-0.5 text-[11px] leading-5 text-fg-2 transition-colors",
                "hover:border-solid hover:bg-subtle hover:text-fg-1",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                "disabled:cursor-not-allowed disabled:opacity-60",
              )}
            >
              <Plus data-icon className="h-3 w-3" strokeWidth={1.5} />
              {t("tasks.router.agentArgumentsAdd")}
            </button>
          </PopoverTrigger>
          {/* z 与编辑器里其它弹层同一档：Popover 是挂到 body 上的，
              不抬起来就会钻到这一层弹窗底下。 */}
          <PopoverContent align="start" className="z-[120] w-[300px] p-1.5">
            {groups.length === 0 ? (
              <p className="m-0 px-1.5 py-1.5 text-[11px] leading-relaxed text-fg-3">
                {t("tasks.router.agentArgumentsNone")}
              </p>
            ) : (
              groups.map((group) => {
                const left = group.options.filter(
                  (option) => !picks.includes(option),
                );
                // 全加过了就不再摆一个空标题：下拉里只剩「自定义」也不算坏。
                if (left.length === 0) return null;
                return (
                  <div key={group.titleKey} className="flex flex-col">
                    <span className="px-1.5 pb-0.5 pt-1 text-[10px] leading-4 text-fg-3">
                      {t(group.titleKey)}
                    </span>
                    {left.map((option) => {
                      const text = option.tokens.join(" ");
                      return (
                        <button
                          key={text}
                          type="button"
                          aria-label={text}
                          onClick={() => add(option.tokens)}
                          className={cn(
                            "flex flex-col items-start gap-0.5 rounded-control px-1.5 py-1 text-start transition-colors",
                            "hover:bg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                          )}
                        >
                          <span className="font-mono text-[11px] leading-4 text-fg-1">
                            {text}
                          </span>
                          <span className="text-[11px] leading-relaxed text-fg-3">
                            {t(option.hintKey)}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                );
              })
            )}
            <button
              type="button"
              onClick={() => {
                setCustom(true);
                setOpen(false);
              }}
              className={cn(
                "mt-1 flex w-full items-center rounded-control border-t border-border px-1.5 py-1 text-start text-[11px] leading-5 text-fg-2 transition-colors",
                "hover:bg-subtle hover:text-fg-1",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
              )}
            >
              {t("tasks.router.agentArgumentsCustom")}
            </button>
            {/* 审批模式与会话续接由 phi 在派发时定，这一句已经写在字段下面；
                下拉里不再重复一遍。 */}
          </PopoverContent>
        </Popover>
      </div>
      {/* 自定义通道：认不出来的 token 存在时自动展开，否则点下拉最后一项才出现。 */}
      {custom ? (
        <Input
          id="router-agent-arguments"
          value={value}
          disabled={disabled}
          aria-label={t("tasks.router.agentArguments")}
          aria-describedby={hint}
          placeholder={t("tasks.router.agentArgumentsPlaceholder")}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : null}
      <p id={hint} className="m-0 text-[11px] leading-relaxed text-fg-3">
        {t("tasks.router.agentArgumentsHint")}
      </p>
    </div>
  );
}
